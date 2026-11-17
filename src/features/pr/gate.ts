import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { Gh, type PrView, type StackMember } from "#src/client/gh/index.ts";
import { MergeRequest } from "./merge-request.ts";
import { type VerdictRecord, verdictsOf } from "./verdict.ts";

/** `pin` holds the arguments that bind the real merge to the head the gate checked. */
export type Authorization = Data.TaggedEnum<{
	Allow: { readonly pin: ReadonlyArray<string> };
	Refuse: { readonly why: string };
}>;

export const Authorization = Data.taggedEnum<Authorization>();

interface Reading {
	readonly view: PrView;
	readonly patchId: string;
	readonly verdicts: ReadonlyArray<VerdictRecord>;
}

const shortSha = Str.slice(0, 7);

const isPass = ({ result }: VerdictRecord) => result === "pass" || result === "pass+notes";

const placeOf = ({ view, patchId }: Reading, verdict: VerdictRecord) => {
	if (verdict.head === view.head) {
		return "this head";
	}

	return verdict.patchId === patchId ? "the same patch" : "another patch";
};

const refusalOf = (reading: Reading): Option.Option<string> => {
	const { view, verdicts } = reading;

	if (Option.contains(view.reviewDecision, "CHANGES_REQUESTED")) {
		return Option.some(
			`${view.ref} has changes requested on GitHub. Address them, push, and get a new review. The gate refuses while they stand.`,
		);
	}

	if (Arr.some(verdicts, (verdict) => isPass(verdict) && placeOf(reading, verdict) !== "another patch")) {
		return Option.none();
	}

	const found = Arr.map(
		verdicts,
		(verdict) =>
			`- ${verdict.result} by ${verdict.verifier.name} at ${shortSha(verdict.head)}, ${placeOf(reading, verdict)}.`,
	);

	return Option.some(
		Arr.join(
			[
				`${view.ref} has no pass at its head ${shortSha(view.head)}, nor at an older head with the same patch.`,
				...(Arr.isReadonlyArrayNonEmpty(found)
					? ["Verdicts found:", ...found]
					: ["No verdict is recorded for it."]),
				`Fix: start a verifier with the delegate tool, with role "leaf" and reviews "${view.url}". Merge again after it passes.`,
			],
			"\n",
		),
	);
};

const decide = (header: string, readings: ReadonlyArray<Reading>, pin: ReadonlyArray<string>): Authorization => {
	const refusals = Arr.getSomes(Arr.map(readings, refusalOf));

	return Arr.isReadonlyArrayNonEmpty(refusals)
		? Authorization.Refuse({ why: Arr.join([header, ...refusals], "\n") })
		: Authorization.Allow({ pin });
};

const readingOf = (root: string) => (pr: string) =>
	Effect.gen(function* () {
		const gh = yield* Gh;
		const view = yield* gh.view(pr);
		const patchId = yield* gh.patchId(pr);
		const verdicts = yield* verdictsOf(root)(view);
		const reading: Reading = { view, patchId, verdicts };

		return reading;
	});

const landedBy = (members: ReadonlyArray<StackMember>, ceiling: string) => {
	const landing = Option.match(
		Arr.findFirstIndex(members, ({ number }) => number === ceiling),
		{ onNone: () => members, onSome: (index) => Arr.take(members, index + 1) },
	);

	return Arr.flatMap(landing, ({ number, state }) => (state === "open" ? [number] : []));
};

const stackMerge = (root: string, ceiling: string) =>
	Effect.gen(function* () {
		const gh = yield* Gh;
		const members = yield* gh.stackOf(ceiling);

		const readings = yield* Effect.forEach(landedBy(members, ceiling), readingOf(root), {
			concurrency: "unbounded",
		});

		const refs = Arr.join(
			Arr.map(readings, ({ view }) => view.ref),
			", ",
		);

		return decide(`merge gate: stack merge refused. It lands ${refs}.`, readings, []);
	});

const merge = (root: string, pr: string) =>
	Effect.map(readingOf(root)(pr), (reading) =>
		decide("merge gate: merge refused.", [reading], ["--match-head-commit", reading.view.head]),
	);

/** Reads the pull requests a merge lands and their verdicts under `root`, and refuses when any read fails. */
export const gate =
	(root: string) =>
	(request: MergeRequest): Effect.Effect<Authorization, never, Gh | FileSystem.FileSystem> =>
		MergeRequest.$match(request, {
			Refuse: ({ why }) => Effect.succeed(Authorization.Refuse({ why })),
			Merge: ({ pr }) => merge(root, pr),
			StackMerge: ({ ceiling }) => stackMerge(root, ceiling),
		}).pipe(
			Effect.catchTag("GhError", ({ args, why }) =>
				Effect.succeed(
					Authorization.Refuse({
						why: `merge gate: merge refused, because the gate could not read what it lands. ${Arr.join(args, " ")} failed: ${why}`,
					}),
				),
			),
		);
