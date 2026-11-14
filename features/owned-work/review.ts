import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { Type } from "typebox";

import type { Gh } from "../../clients/gh/index.ts";
import { pin, type ReviewTarget, VerdictResult } from "../pr/index.ts";
import { answerOf } from "./answer.ts";
import type { Brief } from "./child.ts";
import type { LedgerState } from "./step.ts";
import { BadDelegate, Outcome, type Reviewed, Work, type WorkRef } from "./work.ts";

export const reviewsParam = Type.String({
	pattern: String.raw`\S`,
	description:
		"Leaves only: the pull request, as a number or URL, that this leaf verifies at its current head; your ledger records the `VERDICT:` line its answer ends with.",
});

export const withReview =
	(reviews: string | undefined) =>
	(brief: Brief): Effect.Effect<Brief, BadDelegate, Gh> => {
		if (reviews === undefined) {
			return Effect.succeed(brief);
		}

		if (brief.role === "owner") {
			return Effect.fail(
				BadDelegate.make({ why: "`reviews` starts a verifier, which is a leaf: name role `leaf`" }),
			);
		}

		return Effect.mapBoth(pin(reviews), {
			onSuccess: (review) => ({ ...brief, review }),
			onFailure: ({ why }) => BadDelegate.make({ why: `cannot pin pull request ${reviews}: ${why}` }),
		});
	};

const verdictPattern = /^[\s*_`]*VERDICT:\s*(?<word>PASS\+NOTES|PASS|FAIL|INCOMPLETE)[\s*_`.]*$/iu;

const decodeResult = Schema.decodeUnknownOption(VerdictResult);

export const lastLineVerdict = (text: string): Option.Option<VerdictResult> => {
	const last = Arr.findLast(Str.split(text, "\n"), (line) => Str.isNonEmpty(Str.trim(line)));
	const word = Option.flatMap(last, (line) => Option.fromNullishOr(verdictPattern.exec(line)?.groups?.["word"]));

	return Option.flatMap(word, (found) => decodeResult(Str.toLowerCase(found)));
};

const escalationOf = (fails: number, { repo, number, head }: ReviewTarget): Option.Option<string> => {
	const pr = `${repo}#${String(number)}`;

	if (fails === 2) {
		return Option.some(
			`This is the second failed review of ${pr}. Run interrogate on head ${head} before a third serial review.`,
		);
	}

	return fails > 2
		? Option.some(
				`This is failed review ${String(fails)} of ${pr}. Stop patching: redesign the part that keeps failing, or report the work as blocked with what remains.`,
			)
		: Option.none();
};

const isFailOn =
	({ repo, number }: ReviewTarget) =>
	(work: Work): boolean =>
		Option.exists(work.settled, ({ outcome }) =>
			Outcome.$is("Done")(outcome)
				? Option.exists(
						outcome.verdict,
						({ record }) => record.repo === repo && record.number === number && record.result === "fail",
					)
				: false,
		);

interface Reply {
	readonly state: LedgerState;
	readonly ref: WorkRef;
	readonly text: string;
	readonly file: string;
}

const reviewedOf = ({ state, ref, text, file }: Reply): Option.Option<Reviewed> => {
	const delegate = Option.filter(Option.fromNullishOr(state.work.get(ref)), Work.$is("Delegate"));

	return Option.flatMap(delegate, ({ brief, childSession }) =>
		Option.map(Option.fromUndefinedOr(brief.review), (target) => {
			const result = Option.getOrElse(lastLineVerdict(text), (): VerdictResult => "incomplete");
			const verifier = { name: brief.name, session: childSession.id, model: brief.model };
			const fails = result === "fail" ? Arr.filter([...state.work.values()], isFailOn(target)).length + 1 : 0;

			return { record: { ...target, result, verifier, answer: file }, escalation: escalationOf(fails, target) };
		}),
	);
};

export const doneOf = (reply: Reply): Outcome =>
	Outcome.Done({ answer: answerOf(reply.file)(reply.text), verdict: reviewedOf(reply) });
