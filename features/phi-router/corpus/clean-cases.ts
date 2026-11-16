import * as Arr from "effect/Array";
import * as Option from "effect/Option";

import { converse, type Sample } from "./conversation.ts";
import { counts } from "./counts.ts";
import { fragmentSamples } from "./fragments.ts";
import { internalIdHealth, internalIds } from "./internal-ids.ts";
import { lookAlikes } from "./look-alikes.ts";
import { type CleanCase, Entry, Negative } from "./manifest.ts";
import { medicalTerms } from "./medical-terms.ts";
import { publicFigures } from "./public-figures.ts";
import type { Random } from "./random.ts";
import { schemaOnly } from "./schema-only.ts";
import { staffContacts } from "./staff-contacts.ts";
import { syntheticListed } from "./synthetic.ts";

const samplers = {
	"schema-only": schemaOnly,
	"medical-terms": medicalTerms,
	"public-figure": publicFigures,
	"look-alike": lookAlikes,
	"internal-id": internalIds,
	"internal-id-health": internalIdHealth,
	"synthetic-listed": syntheticListed,
	"staff-contact": staffContacts,
	fragment: fragmentSamples,
	count: counts,
} satisfies Record<TextNegative, Arr.NonEmptyReadonlyArray<(rng: Random) => Sample>>;

/** The negative classes whose content is text. `images.ts` makes the clean screenshots. */
type TextNegative = Exclude<typeof Negative.Type, "clean-screenshot">;

const perNegative = 32;

const textNegatives: ReadonlyArray<TextNegative> = Arr.filter(
	Negative.literals,
	(negative): negative is TextNegative => negative !== "clean-screenshot",
);

export const planNegatives = () =>
	Arr.flatMap(textNegatives, (negative) => Arr.makeBy(perNegative, (turn) => ({ negative, turn })));

const nth = <Item>(items: Arr.NonEmptyReadonlyArray<Item>, index: number) =>
	items[index % items.length] ?? Arr.headNonEmpty(items);

/** Draws until no fragment repeats one already planted, then records them, so fragments are unique across the file. */
const freshSample = (draw: () => Sample, used: Set<string>): Sample => {
	const sample = draw();
	const fragments = sample.fragments ?? [];

	if (Arr.some(fragments, (fragment) => used.has(fragment))) {
		return freshSample(draw, used);
	}

	for (const fragment of fragments) {
		used.add(fragment);
	}

	return sample;
};

interface CleanCaseRequest {
	readonly negative: TextNegative;
	readonly turn: number;
	readonly rng: Random;
	readonly used: Set<string>;
}

export const cleanCase = ({ negative, turn, rng, used }: CleanCaseRequest): Omit<typeof CleanCase.Type, "id"> => {
	const sample = freshSample(() => nth(samplers[negative], turn)(rng), used);

	const messages = converse({
		entry: nth(Entry.literals, turn),
		scene: sample.scene,
		parts: [sample.payload],
		image: Option.none(),
		quotes: [],
		rng,
	});

	return { expect: "clean", strata: { negative }, canaries: [], fragments: sample.fragments ?? [], messages };
};
