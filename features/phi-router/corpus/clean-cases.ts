import * as Arr from "effect/Array";

import { converse, type Sample } from "./conversation.ts";
import { lookAlikes } from "./look-alikes.ts";
import { type CleanCase, Entry, Negative } from "./manifest.ts";
import { medicalTerms } from "./medical-terms.ts";
import { publicFigures } from "./public-figures.ts";
import type { Random } from "./random.ts";
import { schemaOnly } from "./schema-only.ts";
import { testFixtures } from "./test-fixtures.ts";

const samplers = {
	"schema-only": schemaOnly,
	"medical-terms": medicalTerms,
	"public-figure": publicFigures,
	"look-alike": lookAlikes,
	"test-fixture": testFixtures,
} satisfies Record<typeof Negative.Type, Arr.NonEmptyReadonlyArray<(rng: Random) => Sample>>;

const perNegative = 32;

export const planNegatives = () =>
	Arr.flatMap(Negative.literals, (negative) => Arr.makeBy(perNegative, (turn) => ({ negative, turn })));

const nth = <Item>(items: Arr.NonEmptyReadonlyArray<Item>, index: number) =>
	items[index % items.length] ?? Arr.headNonEmpty(items);

interface CleanCaseRequest {
	readonly id: string;
	readonly negative: typeof Negative.Type;
	readonly turn: number;
	readonly rng: Random;
}

export const cleanCase = ({ id, negative, turn, rng }: CleanCaseRequest): typeof CleanCase.Type => {
	const { scene, payload } = nth(samplers[negative], turn)(rng);

	const messages = converse({
		entry: nth(Entry.literals, turn),
		scene,
		parts: [payload],
		image: false,
		rng,
	});

	return { id, expect: "clean", strata: { negative }, canaries: [], messages };
};
