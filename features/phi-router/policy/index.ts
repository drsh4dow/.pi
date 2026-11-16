import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { digestsOf, withoutFixtures } from "./digest.ts";
import { expand } from "./expand.ts";
import { firstHit } from "./rules.ts";

export type Role = "system" | "user" | "assistant" | "tool";

export type Part =
	| { readonly kind: "text"; readonly text: string }
	/** `data` is the base64 payload. The engine never decodes an image; an image taints on sight. */
	| { readonly kind: "image"; readonly mimeType: string; readonly data: string };

export interface Turn {
	readonly role: Role;
	readonly parts: ReadonlyArray<Part>;
}

/** Everything the next model call carries, in order, system turns included. */
export type Transcript = ReadonlyArray<Turn>;

/** Hex SHA-256. */
const Digest = Schema.String.pipe(Schema.brand("Digest"));

/** The 18 Safe Harbor classes, the same strings the corpus manifest uses for `identifier`. */
export const SafeHarbor = Schema.Literals([
	"name",
	"geographic",
	"date",
	"phone",
	"fax",
	"email",
	"ssn",
	"mrn",
	"health-plan",
	"account",
	"license",
	"vehicle",
	"device",
	"url",
	"ip",
	"biometric",
	"photo",
	"other-id",
]);

export type SafeHarbor = typeof SafeHarbor.Type;

export const Phi = Schema.TaggedStruct("Phi", {
	detector: Schema.Literals(["rule", "judge"]),
	/** The rule's id when a rule found it: a literal from the rule list, never content. */
	rule: Schema.optionalKey(Schema.String),
	category: Schema.optionalKey(SafeHarbor),
});

export const Unscannable = Schema.TaggedStruct("Unscannable", {
	what: Schema.Literals(["image", "binary", "undecodable"]),
});

/** Why a request goes to the BAA account. */
export const Taint = Schema.Union([Phi, Unscannable]);

export type Taint = typeof Taint.Type;

/**
 * What has been cleared, as content digests rather than a bare index, because compaction, `/tree` and context edits
 * renumber messages. `turns` is trusted only while the chain digest over the first `turns` non-system turns of the new
 * transcript equals `chain`; a mismatch rescans the conversation.
 */
export const Unscanned = Schema.TaggedStruct("Unscanned", {});

const Cleared = Schema.TaggedStruct("Cleared", {
	/** Digest of all system turns together, so a changed system prompt rescans on its own. */
	system: Digest,
	turns: Schema.Int,
	/** The cleared prefix: chain(n) = sha256(chain(n-1) || sha256(turn n)), chain(0) = sha256(""). */
	chain: Digest,
});

export const Cursor = Schema.Union([Unscanned, Cleared]);

export type Cursor = typeof Cursor.Type;

interface ScanStats {
	readonly newChars: number;
	readonly judgeCalls: number;
	readonly judgeMs: number;
}

/**
 * What a scan found. Tainted and Unsure send this request to the BAA account. The cursor to store next is `cursor`
 * when clean and the old one otherwise, so the next request rescans.
 */
export type ScanResult = Data.TaggedEnum<{
	Clean: { readonly cursor: Cursor; readonly stats: ScanStats };
	Tainted: { readonly taint: Taint; readonly stats: ScanStats };
	/** Transient. This request goes to the BAA account and the cursor stays, so the next request rescans. */
	Unsure: {
		readonly why: "judge-error" | "judge-timeout" | "too-large" | "engine-defect";
		readonly stats: ScanStats;
	};
}>;

export const ScanResult = Data.taggedEnum<ScanResult>();

export interface JudgeInput {
	/** Already-cleared conversation, never system turns. The judge rules on `fresh` and may use `seen` for context. */
	readonly seen: string;
	readonly fresh: string;
}

export interface JudgeAnswer {
	/** Probability that `fresh` carries PHI. */
	readonly pPhi: number;
	readonly category: Option.Option<SafeHarbor>;
}

export class JudgeFailed extends Schema.TaggedError<JudgeFailed, { readonly brand: unique symbol }>()("JudgeFailed", {
	why: Schema.Literals(["error", "timeout"]),
}) {}

/** One classifier call. Transport-free: the engine owns the threshold and what an answer means. */
export class Judge extends Context.Service<
	Judge,
	{
		/** Largest `seen.length + fresh.length` one call accepts. A call beyond it is Unsure, never judged in pieces. */
		readonly maxChars: number;
		readonly ask: (input: JudgeInput) => Effect.Effect<JudgeAnswer, JudgeFailed>;
	}
>()("pi-harness/features/phi-router/policy/Judge") {}

/** At or above this probability the judge's answer taints. */
export const threshold = 0.2;

const none: ScanStats = { newChars: 0, judgeCalls: 0, judgeMs: 0 };

const isSystem = (turn: Turn) => turn.role === "system";

const hasImage = (transcript: Transcript) =>
	Arr.some(transcript, ({ parts }) => Arr.some(parts, (part) => part.kind === "image"));

const textOf = (turn: Turn) =>
	Arr.join(
		Arr.flatMap(turn.parts, (part) => (part.kind === "text" ? [part.text] : [])),
		"\n",
	);

interface Rendered {
	readonly turn: Turn;
	readonly text: string;
}

const renderTurn = (turn: Turn, text: string): Rendered => ({ turn, text: `[${turn.role}] ${text}` });

const joined = (rendered: ReadonlyArray<Rendered>) =>
	Arr.join(
		Arr.map(rendered, ({ text }) => text),
		"\n",
	);

const render = Effect.fn("render")(function* (transcript: Transcript) {
	if (hasImage(transcript)) {
		return yield* Effect.fail(Unscannable.make({ what: "image" }));
	}

	const texts = yield* Effect.mapError(expand(Arr.map(transcript, textOf)), (what) => Unscannable.make({ what }));
	const rendered = Arr.zipWith(transcript, texts, renderTurn);

	const hit = firstHit(Arr.map(rendered, ({ text }) => text));

	if (Option.isSome(hit)) {
		return yield* Effect.fail(Phi.make({ detector: "rule", rule: hit.value.id, category: hit.value.category }));
	}

	return rendered;
});

/** The conversation turns the cursor's chain still matches, and whether the system turns are the ones it cleared. */
const vouchedBy = (cursor: Cursor, now: { readonly system: string; readonly chains: ReadonlyArray<string> }) => {
	const cleared = Schema.is(Cleared)(cursor);
	const chainHolds = cleared && Option.contains(Arr.get(now.chains, cursor.turns), cursor.chain);

	return { turns: chainHolds ? cursor.turns : 0, system: cleared && cursor.system === now.system };
};

const split = Effect.fn("split")(function* (rendered: ReadonlyArray<Rendered>, cursor: Cursor) {
	const system = Arr.filter(rendered, ({ turn }) => isSystem(turn));
	const conversation = Arr.filter(rendered, ({ turn }) => !isSystem(turn));

	const now = yield* digestsOf(
		Arr.map(system, ({ turn }) => turn),
		Arr.map(conversation, ({ turn }) => turn),
	);

	const vouched = vouchedBy(cursor, now);
	const [seen, fresh] = Arr.splitAt(conversation, vouched.turns);
	const systemCall = { seen: "", fresh: vouched.system ? "" : joined(system) };
	const conversationCall = { seen: joined(seen), fresh: joined(fresh) };

	return {
		calls: Arr.filter([systemCall, conversationCall], (call) => call.fresh !== ""),
		cleared: Cleared.make({
			system: Digest.make(now.system),
			turns: conversation.length,
			chain: Digest.make(Arr.lastNonEmpty(now.chains)),
		}),
	};
});

const judgeTaint = (category: Option.Option<SafeHarbor>) =>
	Option.match(category, {
		onNone: () => Phi.make({ detector: "judge" }),
		onSome: (found) => Phi.make({ detector: "judge", category: found }),
	});

const judged = Effect.fn("judged")(function* (input: JudgeInput, cleared: typeof Cleared.Type) {
	const judge = yield* Judge;

	if (input.seen.length + input.fresh.length > judge.maxChars) {
		return ScanResult.Unsure({ why: "too-large", stats: { ...none, newChars: input.fresh.length } });
	}

	const [elapsed, answer] = yield* judge.ask(input).pipe(Effect.result, Effect.timed);
	const stats = { newChars: input.fresh.length, judgeCalls: 1, judgeMs: Duration.toMillis(elapsed) };

	return Result.match(answer, {
		onFailure: ({ why }) => ScanResult.Unsure({ why: why === "timeout" ? "judge-timeout" : "judge-error", stats }),
		onSuccess: ({ pPhi, category }) =>
			pPhi >= threshold
				? ScanResult.Tainted({ taint: judgeTaint(category), stats })
				: ScanResult.Clean({ cursor: cleared, stats }),
	});
});

const total = (results: ReadonlyArray<ScanResult>) =>
	Arr.reduce(results, none, (sum, { stats }) => ({
		newChars: sum.newChars + stats.newChars,
		judgeCalls: sum.judgeCalls + stats.judgeCalls,
		judgeMs: sum.judgeMs + stats.judgeMs,
	}));

/** Runs the system and conversation calls side by side. A taint from either wins, then a failure of either. */
const certify = Effect.fn("certify")(function* (calls: ReadonlyArray<JudgeInput>, cleared: typeof Cleared.Type) {
	const results = yield* Effect.forEach(calls, (call) => judged(call, cleared), { concurrency: "unbounded" });
	const stats = total(results);

	const tainted = Arr.findFirst(results, ScanResult.$is("Tainted"));

	if (Option.isSome(tainted)) {
		return ScanResult.Tainted({ ...tainted.value, stats });
	}

	const unsure = Arr.findFirst(results, ScanResult.$is("Unsure"));

	if (Option.isSome(unsure)) {
		return ScanResult.Unsure({ why: unsure.value.why, stats });
	}

	return ScanResult.Clean({ cursor: cleared, stats });
});

/**
 * The whole engine behind one call. Never fails: every failure is a result (fail closed).
 *
 * The judge rules on the conversation turns the cursor does not vouch for, with the ones it does as context, and on the
 * system turns in a call of their own whenever their digest changes, so a long harness prompt cannot dilute a fragment.
 */
export const scan = Effect.fn("scan")(
	function* (transcript: Transcript, cursor: Cursor) {
		const rendered = yield* Effect.result(Effect.flatMap(withoutFixtures(transcript), render));

		if (Result.isFailure(rendered)) {
			return ScanResult.Tainted({ taint: rendered.failure, stats: none });
		}

		const { calls, cleared } = yield* split(rendered.success, cursor);

		return yield* certify(calls, cleared);
	},
	Effect.catchDefect(() => Effect.succeed(ScanResult.Unsure({ why: "engine-defect", stats: none }))),
);
