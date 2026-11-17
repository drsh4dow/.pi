/**
 * The lane log, one JSONL file per session. Every field is a literal, a number, an id or a rule id, kind or failure
 * reason, so no line holds content. Content keys stay out too: the hash of a short value such as a bare SSN can be
 * reversed.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { LaneLog } from "#src/client/phi-lane-log/index.ts";
import { baaProviders, personalProviders } from "./gate.ts";
import { type ClearedBy, Finding, Usage, Verdict } from "./policy/engine.ts";
import type { Decision } from "./route.ts";
import { Why } from "./store.ts";

const Id = Schema.String.check(Schema.isPattern(/^[\w-]{1,64}$/u));

const Carrier = Schema.Literals([...personalProviders, ...baaProviders]);

/** A model id. Ids contain dots, such as `gpt-6.1-sol`. */
const ModelId = Schema.String.check(Schema.isPattern(/^[\w.-]{1,64}$/u));

const Count = Schema.Finite;

const LineFinding = Schema.Union([
	Schema.Struct({ rule: Why }),
	Schema.Struct({ kind: Why, score: Schema.Finite }),
	Schema.Struct({ failure: Why }),
	Schema.Struct({ quote: Schema.Literal("sealed-line") }),
]);

const Sources = Schema.Struct({
	cache: Count,
	rule: Count,
	judge: Count,
	personalReply: Count,
	fixture: Count,
	empty: Count,
	failure: Count,
});

type Sources = typeof Sources.Type;

const RouteLine = Schema.Struct({
	type: Schema.Literal("route"),
	time: Schema.Finite,
	session: Id,
	reason: Schema.Literals(["user", "continuation", "retry", "direct"]),
	mode: Schema.Literals(["shadow", "enforce", "force-baa", "baa-repo", "bad-settings"]),
	why: Schema.Literals(["cleared", "sealed", "direct", "pinned", "force-baa", "baa-repo", "bad-settings"]),
	wouldBe: Carrier,
	dispatched: Carrier,
	/** The physical model id the request ran on. */
	model: ModelId,
	sources: Sources,
	findings: Schema.Array(LineFinding),
	judge: Usage,
	wouldStub: Count,
});

/** What the border did to one request to a personal account. `stubbedUnknown` above zero means the keys drifted. */
const BorderLine = Schema.Struct({
	type: Schema.Literal("border"),
	time: Schema.Finite,
	session: Id,
	account: Schema.Literals(personalProviders),
	stubbedSealed: Count,
	stubbedUnknown: Count,
	refused: Schema.Boolean,
});

const LaneLine = Schema.Union([RouteLine, BorderLine]);

type LaneLine = typeof LaneLine.Type;

export const LaneJson = Schema.fromJsonString(LaneLine);

const clearedSources = {
	judge: "judge",
	"rules-only": "personalReply",
	fixture: "fixture",
	empty: "empty",
} as const satisfies Record<ClearedBy, keyof Sources>;

const sealedSources = { Rule: "rule", Judge: "judge", Failure: "failure", Quote: "rule" } as const satisfies Record<
	Finding["_tag"],
	keyof Sources
>;

const sourceOf = Verdict.$match({
	Cleared: ({ by }) => clearedSources[by],
	Sealed: ({ finding }) => sealedSources[finding._tag],
});

const findingOf = Finding.$match({
	Rule: ({ rule }) => ({ rule }),
	Judge: ({ kind, score }) => ({ kind, score }),
	Failure: ({ why }) => ({ failure: why }),
	Quote: () => ({ quote: "sealed-line" as const }),
});

export const judgedOf = ({ found, cached, usage, wouldStub, why }: Decision) => {
	const sources: Record<keyof Sources, number> = {
		cache: cached,
		rule: 0,
		judge: 0,
		personalReply: 0,
		fixture: 0,
		empty: 0,
		failure: 0,
	};

	for (const [, verdict] of found) {
		sources[sourceOf(verdict)] += 1;
	}

	const findings = Arr.flatMap(found, ([, verdict]) =>
		Verdict.$is("Sealed")(verdict) ? [findingOf(verdict.finding)] : [],
	);

	return { why, sources, findings, judge: usage, wouldStub };
};

export const appendLane = Effect.fn("appendLane")(function* (line: LaneLine) {
	const log = yield* LaneLog;
	const json = yield* Schema.encodeEffect(LaneJson)(line);

	yield* log.append({ session: line.session, json });
});
