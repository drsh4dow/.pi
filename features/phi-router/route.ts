import type { ModelRouteReason } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Hash from "effect/Hash";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type AccountId, fallbackChain, isBaaAccount } from "../claude-accounts/index.ts";
import type { Lane } from "./lanes.ts";
import {
	Cursor,
	MalformedState,
	scan,
	ScanResult,
	type Taint,
	TaintedCursor,
	type Transcript,
	Unscanned,
} from "./policy/index.ts";
import type { Mode } from "./settings.ts";

const Personal = Schema.Literals(["ultra-a", "ultra-b"]);

type Personal = typeof Personal.Type;

const Stamp = Schema.Struct({ account: Personal, at: Schema.Finite });

/**
 * What the router keeps on the session branch. The lane is not stored: a Tainted cursor is the BAA lane for good, any
 * other cursor routes by `home` and `limited`.
 */
export const RouterState = Schema.Struct({
	cursor: Cursor,
	/** The personal account the session starts on, from a hash of its id, so sessions spread over both subscriptions. */
	home: Personal,
	limited: Schema.Array(Stamp),
});

export type RouterState = typeof RouterState.Type;

const limitedForMs = 30 * 60 * 1000;

export type Stored =
	| { readonly kind: "missing" }
	| { readonly kind: "malformed" }
	| { readonly kind: "found"; readonly state: RouterState };

export const homeOf = (session: string): Personal =>
	Personal.literals[Math.abs(Hash.string(session)) % Personal.literals.length] ?? "ultra-a";

interface Failure {
	readonly account: string;
	readonly rateLimited: boolean;
}

export interface RouteRequest {
	readonly session: string;
	readonly leaf: string | null;
	readonly reason: ModelRouteReason;
	readonly failed: Option.Option<Failure>;
	readonly stored: Stored;
	readonly transcript: Transcript;
	readonly mode: Mode;
	/** Whether the account has the dispatch model and a login, so the chain skips one that cannot answer. */
	readonly usable: (account: AccountId) => boolean;
	/**
	 * Pi compacts a routed request whose context passes `at` tokens before sending it, and sends the summary to the
	 * routed model unscanned. `known` is pi's own count, zero when it has none; the scan's characters bound it too.
	 */
	readonly compaction: { readonly at: Option.Option<number>; readonly known: number };
}

interface Decision {
	readonly dispatch: AccountId;
	/** The state to store, only when it changed, since pi appends an entry for every new state object. */
	readonly state: Option.Option<RouterState>;
	readonly lane: Lane;
}

const charsOf = (transcript: Transcript) =>
	Arr.reduce(transcript, 0, (sum, { parts }) =>
		Arr.reduce(parts, sum, (inner, part) => inner + (part.kind === "text" ? part.text.length : 0)),
	);

/** Pi's estimate is a quarter token per character, so the larger of it and pi's count decides as pi would. */
const compactsBeforeSend = ({ compaction, transcript }: RouteRequest) =>
	Option.exists(compaction.at, (at) => Math.max(compaction.known, Math.ceil(charsOf(transcript) / 4)) > at);

const detectorOf = (taint: Taint) =>
	Match.valueTags(taint, {
		Phi: ({ detector, category }) => (category === undefined ? { detector } : { detector, category }),
		Unscannable: ({ what }) => ({ detector: what }),
		MalformedState: () => ({ detector: "malformed-state" as const }),
	});

const noScan = { newChars: 0, judgeCalls: 0, judgeMs: 0 };

const outcomeOf = (result: ScanResult, prior: Cursor) =>
	ScanResult.$match(result, {
		Clean: ({ cursor, stats }) => ({ cursor, personal: true, found: { verdict: "clean" as const }, stats }),
		Tainted: ({ taint, fresh, stats }) => ({
			cursor: TaintedCursor.make({ taint }),
			personal: false,
			found: { verdict: "tainted" as const, ...detectorOf(taint), fresh },
			stats,
		}),
		Unsure: ({ why, stats }) => ({
			cursor: prior,
			personal: false,
			found: { verdict: "unsure" as const, detector: why },
			stats,
		}),
	});

const isLimited = (limited: RouterState["limited"], now: number) => (account: AccountId) =>
	Arr.some(limited, (stamp) => stamp.account === account && now - stamp.at < limitedForMs);

const pick = (state: RouterState, now: number, usable: RouteRequest["usable"]): AccountId => {
	const chain = [state.home, ...Arr.map(fallbackChain(state.home), ({ id }) => id)];
	const limited = isLimited(state.limited, now);

	return Option.getOrElse(
		Arr.findFirst(chain, (account) => usable(account) && !limited(account)),
		(): AccountId => "ent",
	);
};

const stampedAfter = (limited: RouterState["limited"], failed: Option.Option<Failure>, now: number) =>
	Option.filter(failed, ({ rateLimited }) => rateLimited).pipe(
		Option.map(({ account }) => account),
		Option.filter(Schema.is(Personal)),
		Option.map((account) => [...Arr.filter(limited, (stamp) => stamp.account !== account), { account, at: now }]),
	);

const priorOf = (stored: Stored, session: string): RouterState => {
	switch (stored.kind) {
		case "missing": {
			return { cursor: Unscanned.make({}), home: homeOf(session), limited: [] };
		}

		case "malformed": {
			return { cursor: TaintedCursor.make({ taint: MalformedState.make({}) }), home: homeOf(session), limited: [] };
		}

		case "found": {
			return stored.state;
		}

		default: {
			const unhandled: never = stored;

			return unhandled;
		}
	}
};

const sameCursor = Schema.toEquivalence(Cursor);

const routed = Effect.fn("routed")(function* (request: RouteRequest, now: number) {
	const failed = request.mode === "shadow" ? Option.none() : request.failed;
	const prior = priorOf(request.stored, request.session);
	const stamped = stampedAfter(prior.limited, failed, now);
	const result = yield* scan(request.transcript, prior.cursor);
	const { cursor, personal, found, stats } = outcomeOf(result, prior.cursor);
	const next = { ...prior, cursor, limited: Option.getOrElse(stamped, () => prior.limited) };
	const failedOnBaa = Option.exists(failed, ({ account }) => isBaaAccount(account));
	const changed = request.stored.kind !== "found" || Option.isSome(stamped) || !sameCursor(prior.cursor, cursor);

	return {
		wouldBe: personal && !failedOnBaa ? pick(next, now, request.usable) : "ent",
		state: changed ? Option.some(next) : Option.none(),
		found,
		stats,
	};
});

/**
 * Where one request goes. `direct` and every mode that forces the BAA account skip the scan. Otherwise the scan decides:
 * Clean picks a personal account from the chain, Tainted and Unsure send the request to the BAA account. `shadow`
 * decides all of it and stores the would-be state, but dispatches the BAA account.
 */
export const decide = Effect.fn("decide")(function* (request: RouteRequest) {
	const now = yield* Clock.currentTimeMillis;

	const lane = {
		time: now,
		session: request.session,
		leaf: request.leaf,
		reason: request.reason,
		mode: request.mode,
		chars: charsOf(request.transcript),
	};

	if (request.reason === "direct" || (request.mode !== "shadow" && request.mode !== "enforce")) {
		return {
			dispatch: "ent",
			state: Option.none(),
			lane: { ...lane, verdict: "skipped", wouldBe: "ent", dispatched: "ent", ...noScan },
		} satisfies Decision;
	}

	const { wouldBe, state, found, stats } = yield* routed(request, now);
	const dispatched = request.mode === "shadow" || compactsBeforeSend(request) ? "ent" : wouldBe;

	return {
		dispatch: dispatched,
		state,
		lane: { ...lane, ...found, ...stats, wouldBe, dispatched },
	} satisfies Decision;
});
