import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { cleanCase, planNegatives } from "./clean-cases.ts";
import { cleanImageCases, type Images, imageCases, loadImages } from "./images.ts";
import { type Case, CaseFromJsonLine, Synthetic } from "./manifest.ts";
import { phiCase } from "./phi-cases.ts";
import { planStrata } from "./plan.ts";
import { seeded } from "./random.ts";
import { synthetic } from "./synthetic.ts";

export const defaultSeed = 1729;

const caseId = (index: number) => `h-${Str.padStart(4, "0")(String(index + 1))}`;

export const generate = ({ seed, images }: { readonly seed: number; readonly images: Images }): ReadonlyArray<Case> => {
	const rng = seeded(seed);
	const used = new Set<string>();
	const text = Arr.map(planStrata(rng), (strata) => phiCase({ strata, rng, used }));
	const pictured = imageCases({ images, rng, used });
	const clean = Arr.map(planNegatives(), ({ negative, turn }) => cleanCase({ negative, turn, rng, used }));
	const cleanPictured = cleanImageCases({ images, rng });

	return Arr.map([...text, ...pictured, ...clean, ...cleanPictured], (item, index): Case => ({
		id: caseId(index),
		...item,
	}));
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

const usage = "usage: bun src/features/phi-router/corpus/generate.ts <out.jsonl> [--seed N]";

const encodeSynthetic = Schema.encodeEffect(Schema.fromJsonString(Synthetic));

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

const writeSynthetic = Effect.fn("writeSynthetic")(function* (out: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const syntheticPath = path.join(path.dirname(out), "synthetic.json");
	const json = yield* encodeSynthetic(synthetic);

	yield* fs.writeFileString(syntheticPath, `${json}\n`);

	return syntheticPath;
});

const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const { out, seed } = yield* argsOf(Arr.drop(process.argv, 2));
	const images = yield* loadImages;
	const cases = generate({ seed, images });
	const manifest = yield* encodeCorpus(cases);

	yield* fs.writeFileString(out, manifest);

	const syntheticPath = yield* writeSynthetic(out);

	yield* Effect.log(`wrote ${String(cases.length)} cases with seed ${String(seed)} to ${out}, and ${syntheticPath}`);
});

if (import.meta.main) {
	NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
}
