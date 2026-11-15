import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { cleanCase, planNegatives } from "./clean-cases.ts";
import { type Case, CaseFromJsonLine } from "./manifest.ts";
import { phiCase } from "./phi-cases.ts";
import { planStrata } from "./plan.ts";
import { seeded } from "./random.ts";

export const defaultSeed = 1729;

const caseId = (index: number) => `h-${Str.padStart(4, "0")(String(index + 1))}`;

/** The whole corpus for `seed`: the same seed always gives the same cases, in the same order. */
export const generate = (seed: number): ReadonlyArray<Case> => {
	const rng = seeded(seed);
	const used = new Set<string>();

	const phi = Arr.map(planStrata(rng), (strata, index) => phiCase({ id: caseId(index), strata, rng, used }));

	const clean = Arr.map(planNegatives(), ({ negative, turn }, index) =>
		cleanCase({ id: caseId(phi.length + index), negative, turn, rng }),
	);

	return [...phi, ...clean];
};

const encodeCase = Schema.encodeEffect(CaseFromJsonLine);

/** The corpus as a JSONL manifest, one case per line, each encoded through the manifest schema. */
export const encodeCorpus = (cases: ReadonlyArray<Case>) =>
	Effect.map(
		Effect.forEach(cases, (item) => encodeCase(item)),
		(lines) => `${Arr.join(lines, "\n")}\n`,
	);

class UsageError extends Schema.TaggedError<UsageError, { readonly brand: unique symbol }>()("UsageError", {
	message: Schema.String,
}) {}

const usage = "usage: bun features/phi-router/corpus/generate.ts <out.jsonl> [--seed N]";

const Seed = Schema.NumberFromString.check(Schema.isInt());

/** Parses `<out.jsonl> [--seed N]`. */
const argsOf = Effect.fn("argsOf")(function* (argv: ReadonlyArray<string>) {
	const seedFlag = Arr.findFirstIndex(argv, (arg) => arg === "--seed");

	const positional = Option.match(seedFlag, {
		onNone: () => argv,
		onSome: (at) => Arr.remove(Arr.remove(argv, at + 1), at),
	});

	const seedText = Option.flatMap(seedFlag, (at) => Arr.get(argv, at + 1));

	const [out, ...extra] = positional;

	if (out === undefined || extra.length > 0 || (Option.isSome(seedFlag) && Option.isNone(seedText))) {
		return yield* UsageError.make({ message: usage });
	}

	const seed = yield* Option.match(seedText, {
		onNone: () => Effect.succeed(defaultSeed),
		onSome: (text) => Effect.mapError(Schema.decodeEffect(Seed)(text), () => UsageError.make({ message: usage })),
	});

	return { out, seed };
});

const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const { out, seed } = yield* argsOf(Arr.drop(process.argv, 2));
	const cases = generate(seed);

	const manifest = yield* encodeCorpus(cases);

	yield* fs.writeFileString(out, manifest);
	yield* Effect.log(`wrote ${String(cases.length)} cases with seed ${String(seed)} to ${out}`);
});

if (import.meta.main) {
	NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
}
