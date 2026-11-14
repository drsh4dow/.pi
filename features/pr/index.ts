import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { Gh, type GhError, type PrView, type Review, type ReviewDecision } from "../../clients/gh/index.ts";

export { ghLayer } from "../../clients/gh/index.ts";

const changed = (label: string, from: string, to: string) => (from === to ? [] : [`${label} ${from} -> ${to}`]);

const shortSha = Str.slice(0, 7);

const newHead = (before: PrView, after: PrView) =>
	before.head === after.head ? [] : [`head ${shortSha(before.head)} -> ${shortSha(after.head)}`];

const decisionOf = (decision: Option.Option<ReviewDecision>) => Option.getOrElse(decision, () => "none");

const keyOf = ({ author, submittedAt, state }: Review) => `${author} ${submittedAt} ${state}`;

const newReviews = (before: PrView, after: PrView) => {
	const seen = new Set(Arr.map(before.reviews, keyOf));

	return Arr.flatMap(after.reviews, (review) =>
		seen.has(keyOf(review)) ? [] : [`review by ${review.author}: ${review.state}`],
	);
};

/** What changed between two readings of one pull request, one line each, or none. Pure. */
export const changes = ({
	before,
	after,
}: {
	readonly before: PrView;
	readonly after: PrView;
}): ReadonlyArray<string> => [
	...newHead(before, after),
	...changed("review decision", decisionOf(before.reviewDecision), decisionOf(after.reviewDecision)),
	...newReviews(before, after),
	...changed("checks", before.checks, after.checks),
	...changed("state", before.state, after.state),
];

/** Retries after the first failed round, so the third failed round in a row ends the wait. */
const retriedRounds = 2;

const untilChanged = <Services>(
	round: Effect.Effect<ReadonlyArray<string>, GhError, Services>,
): Effect.Effect<Arr.NonEmptyReadonlyArray<string>, GhError, Services> =>
	Effect.filterOrElse(Effect.retry(round, { times: retriedRounds }), Arr.isReadonlyArrayNonEmpty, () =>
		untilChanged(round),
	);

/**
 * Reads every pull request, then re-reads all of them every 60 s until one changes. Returns the change lines, each
 * prefixed by the ref. A pull request already merged or closed ends the wait at once, since nothing will change on it.
 */
export const prWait = (
	prs: Arr.NonEmptyReadonlyArray<string>,
): Effect.Effect<Arr.NonEmptyReadonlyArray<string>, GhError, Gh> =>
	Effect.gen(function* () {
		const gh = yield* Gh;

		const first = yield* Effect.forEach(prs, (pr) => Effect.map(gh.view(pr), (view) => ({ pr, view })), {
			concurrency: "unbounded",
		});

		const ended = Arr.flatMap(first, ({ view }) =>
			view.state === "OPEN" ? [] : [`${view.ref} state ${view.state}`],
		);

		if (Arr.isReadonlyArrayNonEmpty(ended)) {
			return ended;
		}

		const round = Effect.forEach(
			first,
			({ pr, view }) =>
				Effect.map(gh.view(pr), (after) =>
					Arr.map(changes({ before: view, after }), (line) => `${view.ref} ${line}`),
				),
			{ concurrency: "unbounded" },
		).pipe(Effect.map(Arr.flatten), Effect.delay("60 seconds"));

		return yield* untilChanged(round);
	});
