/**
 * The routing core: the lane a request takes, then the account that serves it. pi's `route()`, the corpus eval and the
 * savings replay call `decide`, so the lane rule lives in one place.
 */
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { ModelRouteReason, SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Hash from "effect/Hash";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type AccountId, fallbackChain } from "../claude-accounts/index.ts";
import { piecesOf } from "./pieces.ts";
import { type ContentKey, Finding, type Piece, type Usage, Verdict, verdictsFor } from "./policy/engine.ts";
import { quotingReplies } from "./policy/quotes.ts";
import type { Mode } from "./settings.ts";
import type { VerdictBook, VerdictsEntry } from "./store.ts";

/** Why a request runs on `ent` with nothing judged. The pin is the session's; the rest come from settings. */
export type Hold = "pinned" | "force-baa" | "baa-repo" | "bad-settings";

export type Lane = "personal" | "ent";

export interface DecideRequest {
	readonly messages: ReadonlyArray<Message>;
	readonly reason: ModelRouteReason;
	readonly book: VerdictBook;
	readonly hold: Option.Option<Hold>;
	readonly producedOnPersonal?: (message: AssistantMessage) => boolean;
	readonly window?: number;
}

interface Judged {
	/** This request's new verdicts, already in the book's memory. */
	readonly found: ReadonlyArray<readonly [ContentKey, Verdict]>;
	readonly usage: Usage;
	/** Distinct parts the book already knew. */
	readonly cached: number;
	/** Parts a personal account would receive as a stub, after this request's verdicts. */
	readonly wouldStub: number;
	/** The `phi-verdicts` entry the caller appends to the session, none when nothing new was found. */
	readonly entry: Option.Option<VerdictsEntry>;
}

export type Decision = Judged &
	(
		| { readonly lane: "personal"; readonly why: "cleared" }
		| { readonly lane: "ent"; readonly why: "sealed" | "direct" | Hold }
	);

const isSealed = Verdict.$is("Sealed");

const noUsage: Usage = { calls: 0, inputTokens: 0, cost: 0, ms: 0 };

type Pieces = ReturnType<typeof piecesOf>;

const distinctKeys = (pieces: Pieces) => new Set(Arr.map(pieces, ({ piece }) => piece.key)).size;

const stubbedIn = (pieces: Pieces, book: VerdictBook) =>
	Arr.filter(pieces, ({ piece }) => book.lookup(piece.key) !== "cleared").length;

/**
 * `ent` when a part of the request's own new content is sealed, by the book or by this request's verdicts, or when any
 * part sealed during this request. A repeated read of sealed content is sealed own content, and so is a retry.
 */
const laneOf = ({
	pieces,
	found,
	book,
}: {
	readonly pieces: Pieces;
	readonly found: Judged["found"];
	readonly book: VerdictBook;
}) => {
	const sealedNow = Arr.some(found, ([, verdict]) => isSealed(verdict));
	const ownSealed = Arr.some(pieces, ({ piece, own }) => own && book.lookup(piece.key) === "sealed");

	return sealedNow || ownSealed
		? ({ lane: "ent", why: "sealed" } as const)
		: ({ lane: "personal", why: "cleared" } as const);
};

const unjudged = ({
	pieces,
	book,
	why,
}: {
	readonly pieces: Pieces;
	readonly book: VerdictBook;
	readonly why: Hold | "direct";
}): Decision => ({
	found: [],
	usage: noUsage,
	cached: distinctKeys(pieces),
	entry: Option.none(),
	wouldStub: stubbedIn(pieces, book),
	lane: "ent",
	why,
});

/** A new `ent` reply that repeats a line of sealed content seals, whatever the judge said of it alone. */
const withQuotes = ({
	judged,
	found,
	book,
}: {
	readonly judged: ReadonlyArray<Piece>;
	readonly found: Judged["found"];
	readonly book: VerdictBook;
}): Judged["found"] => {
	const sealedNow = new Set(Arr.flatMap(found, ([key, verdict]) => (isSealed(verdict) ? [key] : [])));
	const isSealedKey = (key: ContentKey) => sealedNow.has(key) || book.lookup(key) === "sealed";
	const quoting = quotingReplies({ pieces: judged, isSealed: isSealedKey });

	return Arr.map(found, ([key, verdict]) => {
		const source = quoting.get(key);

		return [
			key,
			source === undefined ? verdict : Verdict.Sealed({ finding: Finding.Quote({ of: source }) }),
		] as const;
	});
};

/**
 * The lane of one request. A hold and a `direct` request go to `ent` with nothing judged: a `direct` request carries the
 * whole transcript serialized into one message. Otherwise every part the book does not know is judged and recorded in
 * the book's memory before the lane is chosen.
 */
export const decide = Effect.fn("decide")(function* (request: DecideRequest) {
	const { book, hold } = request;
	const pieces = piecesOf({ ...request, sealed: (key) => book.lookup(key) === "sealed" });

	if (Option.isSome(hold) || request.reason === "direct") {
		return unjudged({ pieces, book, why: Option.getOrElse(hold, () => "direct" as const) });
	}

	const judged = Arr.map(pieces, ({ piece }) => piece);

	const { found, usage } = yield* Effect.map(verdictsFor(judged, book.known), (verdicts) => ({
		...verdicts,
		found: withQuotes({ judged, found: verdicts.found, book }),
	}));

	const entry = yield* book.record({ found, pieces: judged });
	const cached = distinctKeys(pieces) - found.length;

	return {
		found,
		usage,
		cached,
		entry,
		wouldStub: stubbedIn(pieces, book),
		...laneOf({ pieces, found, book }),
	} satisfies Decision;
});

export const pinEntryType = "phi-pin";

const PinData = Schema.Struct({ pinned: Schema.Boolean });

const decodePin = Schema.decodeUnknownOption(PinData);

const pinOf = (entry: SessionEntry) =>
	entry.type === "custom" && entry.customType === pinEntryType ? decodePin(entry.data) : Option.none();

/** The latest `phi-pin` entry on the branch decides. */
export const pinnedOn = (branch: ReadonlyArray<SessionEntry>) => {
	const pins = Arr.getSomes(Arr.map(branch, pinOf));

	return Option.exists(Arr.last(pins), ({ pinned }) => pinned);
};

export const holdOf = ({ mode, pinned }: { readonly mode: Mode; readonly pinned: boolean }): Option.Option<Hold> => {
	if (mode === "force-baa" || mode === "baa-repo" || mode === "bad-settings") {
		return Option.some(mode);
	}

	return pinned ? Option.some("pinned") : Option.none();
};

const Personal = Schema.Literals(["ultra-a", "ultra-b"]);

type Personal = typeof Personal.Type;

const Stamp = Schema.Struct({ account: Personal, at: Schema.Finite });

/** What `phi/auto` keeps in pi's virtual-model state. Verdicts live in `phi-verdicts` entries, not here. */
export const RouterState = Schema.Struct({
	/** The personal account the session starts on, from a hash of its id, so sessions spread over both subscriptions. */
	home: Personal,
	/** When each personal account last answered 429. */
	limited: Schema.Array(Stamp),
});

export type RouterState = typeof RouterState.Type;

export const homeOf = (session: string): Personal =>
	Personal.literals[Math.abs(Hash.string(session)) % Personal.literals.length] ?? "ultra-a";

const limitedForMs = 30 * 60 * 1000;

/** Whether an account answered 429 within the last 30 minutes. */
export const limitedAt =
	({ limited, now }: { readonly limited: RouterState["limited"]; readonly now: number }) =>
	(account: AccountId) =>
		Arr.some(limited, (stamp) => stamp.account === account && now - stamp.at < limitedForMs);

/** The stamps after a 429 on a personal account, none when the failure was anything else. */
export const stampedAfter = ({
	limited,
	failed,
	now,
}: {
	readonly limited: RouterState["limited"];
	readonly failed: Option.Option<{ readonly account: string; readonly rateLimited: boolean }>;
	readonly now: number;
}) =>
	Option.filter(failed, ({ rateLimited }) => rateLimited).pipe(
		Option.map(({ account }) => account),
		Option.filter(Schema.is(Personal)),
		Option.map((account) => [...Arr.filter(limited, (stamp) => stamp.account !== account), { account, at: now }]),
	);

export interface AccountChoice {
	readonly lane: Lane;
	readonly home: Personal;
	readonly limited: (account: AccountId) => boolean;
	/** Whether the account has the dispatch model and a login. */
	readonly usable: (account: AccountId) => boolean;
	/** The request retries one that failed on `ent`. */
	readonly failedOnBaa: boolean;
}

/**
 * The account for a lane. `personal` takes home, then the other personal account, then `ent`, skipping a limited or
 * unusable one. `ent` never fails over to a personal account, and a retry after a failure on `ent` stays there.
 */
export const accountFor = ({ lane, home, limited, usable, failedOnBaa }: AccountChoice): AccountId => {
	if (lane === "ent" || failedOnBaa) {
		return "ent";
	}

	const chain = [home, ...Arr.map(fallbackChain(home), ({ id }) => id)];

	return Option.getOrElse(
		Arr.findFirst(chain, (account) => usable(account) && !limited(account)),
		(): AccountId => "ent",
	);
};
