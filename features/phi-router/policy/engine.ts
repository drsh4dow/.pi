/**
 * The pi-free engine: from pieces of new content to verdicts. A harness adapter supplies the pieces and a `Judge`.
 * Owns the order (fixtures, synthetic blanking, decoding, rules, judge), the borderline band and failure sealing.
 */
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Function from "effect/Function";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { Fixtures, sha256 } from "./digest.ts";
import { expand } from "./expand.ts";
import { judgeLimits, thresholds, type IdentifierKind } from "./policy.ts";
import { firstHit, type RuleId } from "./rules.ts";
import { blankerOf, Synthetic } from "./synthetic.ts";

/** SHA-256 over one part's role and content. A retry, a resend and a repeated file read share a key (`parts.ts`). */
export const ContentKey = Schema.String.pipe(Schema.brand("ContentKey"));

export type ContentKey = typeof ContentKey.Type;

export interface Image {
	readonly mimeType: string;
	/** Base64. */
	readonly data: string;
}

/**
 * How the policy treats a piece. `system` seals only on a rule, a failure, or a high score with a named kind.
 * `reply-personal` is an assistant message a personal account wrote, so rules alone decide it. `reply-other` came from
 * `ent` or another provider and is judged.
 */
export type PieceKind = "system" | "user" | "tool-result" | "reply-personal" | "reply-other";

export interface Piece {
	readonly key: ContentKey;
	readonly kind: PieceKind;
	/** The text parts as sent, one by one, so a registered fixture matches a whole part. */
	readonly texts: ReadonlyArray<string>;
	readonly images: ReadonlyArray<Image>;
	/** At most `window` preceding rendered items, already cleared, for the judge to read. */
	readonly context: ReadonlyArray<string>;
	/** The cleared end of the previous message of the same role, when this one goes on from it mid-word; else empty. */
	readonly seam: string;
}

type FailureWhy = "binary" | "undecodable" | "judge-error" | "judge-timeout" | "judge-refused" | "too-large";

export type Finding = Data.TaggedEnum<{
	Rule: { readonly rule: RuleId; readonly kind: IdentifierKind };
	Judge: { readonly score: number; readonly kind: IdentifierKind | "unlabelled" };
	Failure: { readonly why: FailureWhy };
	Quote: { readonly of: ContentKey };
}>;

export const Finding = Data.taggedEnum<Finding>();

/** `empty` is a piece with no text and no image left to judge. */
export type ClearedBy = "judge" | "rules-only" | "fixture" | "empty";

/** A fact about content under one policy version. */
export type Verdict = Data.TaggedEnum<{
	Cleared: { readonly by: ClearedBy };
	Sealed: { readonly finding: Finding };
}>;

export const Verdict = Data.taggedEnum<Verdict>();

/** What judge calls cost, summed for the lane log and the replay. */
export const Usage = Schema.Struct({
	calls: Schema.Finite,
	inputTokens: Schema.Finite,
	cost: Schema.Finite,
	ms: Schema.Finite,
});

export type Usage = typeof Usage.Type;

const noUsage: Usage = { calls: 0, inputTokens: 0, cost: 0, ms: 0 };

const plus = (sum: Usage, more: Usage): Usage => ({
	calls: sum.calls + more.calls,
	inputTokens: sum.inputTokens + more.inputTokens,
	cost: sum.cost + more.cost,
	ms: sum.ms + more.ms,
});

export interface JudgeInput {
	readonly piece: string;
	readonly context: ReadonlyArray<string>;
	/** At most `judgeLimits.maxImages`. */
	readonly images: ReadonlyArray<Image>;
}

export class JudgeFailed extends Schema.TaggedError<JudgeFailed, { readonly brand: unique symbol }>()("JudgeFailed", {
	why: Schema.Literals(["judge-error", "judge-timeout", "judge-refused"]),
	usage: Schema.optionalKey(Usage),
}) {}

/**
 * The transport-free judge. `identifier` asks the policy's one question, `kind` the kind question. The engine owns the
 * thresholds and the timeout, so every adapter seals the same way.
 */
export class Judge extends Context.Service<
	Judge,
	{
		readonly identifier: (
			input: JudgeInput,
		) => Effect.Effect<{ readonly score: number; readonly usage: Usage }, JudgeFailed>;
		readonly kind: (
			input: JudgeInput,
		) => Effect.Effect<{ readonly kind: IdentifierKind | "none"; readonly usage: Usage }, JudgeFailed>;
	}
>()("pi-harness/features/phi-router/policy/engine/Judge") {}

interface Call {
	readonly spent: Ref.Ref<Usage>;
	readonly retries: number;
}

/**
 * One judge question under the policy's timeout, asked again up to `retries` times, its cost added to `spent`. A failed
 * call still counts as a call, with the usage it carries when it billed. An interruption is not a failure, so it propagates.
 */
const ask = <Answer extends { readonly usage: Usage }>(
	question: () => Effect.Effect<Answer, JudgeFailed>,
	{ spent, retries }: Call,
) => {
	const timedOut = Effect.fail(JudgeFailed.make({ why: "judge-timeout" }));

	const attempt = Effect.suspend(question).pipe(
		Effect.timeoutOrElse({ duration: judgeLimits.timeoutMs, orElse: () => timedOut }),
		Effect.result,
		Effect.timed,
		Effect.flatMap(([elapsed, answer]) => {
			const measured = { ...noUsage, calls: 1, ms: Duration.toMillis(elapsed) };
			const usage = Result.isSuccess(answer) ? answer.success.usage : (answer.failure.usage ?? measured);

			return Effect.andThen(
				Ref.update(spent, (sum) => plus(sum, usage)),
				Effect.fromResult(answer),
			);
		}),
	);

	return Effect.result(Effect.retry(attempt, { times: retries }));
};

const sealedBy = (finding: Finding) => Verdict.Sealed({ finding });

const clearedByJudge = Verdict.Cleared({ by: "judge" });

/**
 * The verdict once a score reached the band. A high score seals any piece but a system part, and the kind only labels
 * it. Otherwise the kind decides: a named kind seals, `none` clears, a failed kind call seals as a failure.
 */
const verdictOfLabel = ({
	score,
	label,
	system,
}: {
	readonly score: number;
	readonly label: Result.Result<{ readonly kind: IdentifierKind | "none" }, JudgeFailed>;
	readonly system: boolean;
}) => {
	if (!system && score >= thresholds.sealAtOrAbove) {
		const kind = Result.isSuccess(label) && label.success.kind !== "none" ? label.success.kind : "unlabelled";

		return sealedBy(Finding.Judge({ score, kind }));
	}

	if (Result.isFailure(label)) {
		return sealedBy(Finding.Failure({ why: label.failure.why }));
	}

	const { kind } = label.success;

	return kind === "none" ? clearedByJudge : sealedBy(Finding.Judge({ score, kind }));
};

const judged = Effect.fn("judged")(function* ({
	input,
	system,
	call,
}: {
	readonly input: JudgeInput;
	readonly system: boolean;
	readonly call: Call;
}) {
	const judge = yield* Judge;
	const answer = yield* ask(() => judge.identifier(input), call);

	if (Result.isFailure(answer)) {
		return sealedBy(Finding.Failure({ why: answer.failure.why }));
	}

	const { score } = answer.success;
	const bar = system ? thresholds.sealAtOrAbove : thresholds.clearBelow;

	if (score < bar) {
		return clearedByJudge;
	}

	const label = yield* ask(() => judge.kind(input), call);

	return verdictOfLabel({ score, label, system });
});

/** Settles a piece before the judge. Failing with a verdict ends the piece there. */
const textOf = Effect.fn("textOf")(function* (piece: Piece, blank: (text: string) => string) {
	const fixtures = yield* Fixtures;
	const texts = Arr.filter(piece.texts, (text) => !fixtures.has(sha256(text)));

	if (Arr.every(texts, (text) => Str.trim(text) === "") && piece.images.length === 0) {
		return yield* Effect.fail(Verdict.Cleared({ by: texts.length < piece.texts.length ? "fixture" : "empty" }));
	}

	const readings = yield* Effect.mapError(expand(Arr.map(texts, blank)), (why) => sealedBy(Finding.Failure({ why })));
	const text = blank(piece.seam) + Arr.join(readings, "\n");
	const hit = firstHit(text);

	if (Option.isSome(hit)) {
		return yield* Effect.fail(sealedBy(Finding.Rule(hit.value)));
	}

	return text;
});

/** The judge's verdict on a piece's text. Images beyond one call's limit go in further calls with the same text. */
const judgedPiece = Effect.fn("judgedPiece")(function* ({
	kind,
	input,
	spent,
}: {
	readonly kind: PieceKind;
	readonly input: JudgeInput;
	readonly spent: Ref.Ref<Usage>;
}) {
	const system = kind === "system";
	const call = { spent, retries: system ? 1 : 0 };
	const hasImages = Arr.isReadonlyArrayNonEmpty(input.images);
	const imageSets = hasImages ? Arr.chunksOf(input.images, judgeLimits.maxImages) : [input.images];

	for (const images of imageSets) {
		const verdict = yield* judged({ input: { ...input, images }, system, call });

		if (Verdict.$is("Sealed")(verdict)) {
			return verdict;
		}
	}

	return clearedByJudge;
});

const verdictOf = (piece: Piece, spent: Ref.Ref<Usage>) =>
	Effect.gen(function* () {
		const added = yield* Synthetic;
		const blank = blankerOf(added);
		const text = yield* textOf(piece, blank);

		if (piece.kind === "reply-personal") {
			return Verdict.Cleared({ by: "rules-only" });
		}

		const context = Arr.map(piece.context, blank);
		const chars = Arr.reduce(context, text.length, (sum, item) => sum + item.length);

		if (chars > judgeLimits.maxChars) {
			return sealedBy(Finding.Failure({ why: "too-large" }));
		}

		return yield* judgedPiece({ kind: piece.kind, input: { piece: text, context, images: piece.images }, spent });
	}).pipe(Effect.match({ onFailure: Function.identity, onSuccess: Function.identity }));

/**
 * Verdicts for the pieces whose keys `known` does not hold, each key judged once. Never fails: a judge error, timeout,
 * refusal or unreadable input seals that one piece. An interruption propagates. Callers persist `found` themselves.
 */
export const verdictsFor = Effect.fn("verdictsFor")(function* (
	pieces: ReadonlyArray<Piece>,
	known: (key: ContentKey) => boolean,
) {
	const unknown = Arr.filter(pieces, (piece) => !known(piece.key));
	const byKey = new Map(Arr.map(unknown, (piece) => [piece.key, piece] as const));
	const spent = yield* Ref.make(noUsage);

	const found = yield* Effect.forEach(
		byKey.values(),
		(piece) => Effect.map(verdictOf(piece, spent), (verdict) => [piece.key, verdict] as const),
		{ concurrency: 8 },
	);

	return { found, usage: yield* Ref.get(spent) };
});
