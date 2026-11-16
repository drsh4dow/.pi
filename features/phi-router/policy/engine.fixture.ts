import { expect } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";

import { sha256 } from "./digest.ts";
import { ContentKey, Judge, JudgeFailed, type JudgeInput, type Piece, type Verdict, verdictsFor } from "./engine.ts";
import type { IdentifierKind } from "./policy.ts";

type Answer<Value> = Value | "error" | "refused";

export type Question = "identifier" | "kind";

export interface Script {
	readonly score: (input: JudgeInput) => Answer<number>;
	readonly kind?: (input: JudgeInput) => Answer<IdentifierKind | "none">;
}

const usage = { calls: 1, inputTokens: 10, cost: 0.001, ms: 5 };

const answered = <Value>(answer: Answer<Value>) => {
	if (answer === "error" || answer === "refused") {
		return Effect.fail(JudgeFailed.make({ why: answer === "error" ? "judge-error" : "judge-refused" }));
	}

	return Effect.succeed(answer);
};

/** A judge that answers from `script` and records every question it is asked. */
const scripted = ({ score, kind = () => "none" }: Script) => {
	const asked: Array<{ readonly question: Question; readonly input: JudgeInput }> = [];

	const judge = Judge.of({
		identifier: (input) => {
			asked.push({ question: "identifier", input });

			return Effect.map(answered(score(input)), (found) => ({ score: found, usage }));
		},
		kind: (input) => {
			asked.push({ question: "kind", input });

			return Effect.map(answered(kind(input)), (found) => ({ kind: found, usage }));
		},
	});

	return { judge, asked };
};

export const pieceOf = (text: string): Piece => ({
	key: ContentKey.make(sha256(text)),
	kind: "user",
	texts: [text],
	images: [],
	context: [],
	seam: "",
});

export const judgeAll = ({
	pieces,
	script,
	known = () => false,
}: {
	readonly pieces: ReadonlyArray<Piece>;
	readonly script: Script;
	readonly known?: (key: ContentKey) => boolean;
}) => {
	const { judge, asked } = scripted(script);

	return Effect.map(Effect.provideService(verdictsFor(pieces, known), Judge, judge), (judged) => ({
		...judged,
		asked,
	}));
};

/** One piece's verdicts, the questions the judge was asked, and the piece text each question carried. */
export const judgedOne = ({ piece, script }: { readonly piece: Piece; readonly script: Script }) =>
	Effect.map(judgeAll({ pieces: [piece], script }), ({ found, asked }) => ({
		verdicts: Arr.map(found, ([, verdict]) => verdict),
		questions: Arr.map(asked, ({ question }) => question),
		fresh: Arr.map(asked, ({ input }) => input.piece),
	}));

export const run = (body: Effect.Effect<void>) => Effect.runPromise(body);

export const expectJudged = Effect.fn("expectJudged")(function* (
	piece: Piece,
	script: Script,
	expected: { readonly verdicts: ReadonlyArray<Verdict>; readonly questions: ReadonlyArray<Question> },
) {
	const { verdicts, questions } = yield* judgedOne({ piece, script });

	expect({ verdicts, questions }).toEqual({ verdicts: [...expected.verdicts], questions: [...expected.questions] });
});
