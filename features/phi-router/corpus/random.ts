import * as Arr from "effect/Array";

/** A seeded draw source, so one seed always yields the same corpus byte for byte. */
export interface Random {
	/** An integer in `[0, bound)`. */
	readonly int: (bound: number) => number;
	/** An integer in `[low, high]`. */
	readonly between: (low: number, high: number) => number;
	readonly chance: (probability: number) => boolean;
	readonly pick: <Item>(items: Arr.NonEmptyReadonlyArray<Item>) => Item;
	readonly shuffle: <Item>(items: ReadonlyArray<Item>) => Array<Item>;
	readonly chars: (alphabet: string, count: number) => string;
	readonly digits: (count: number) => string;
	readonly hex: (count: number) => string;
}

export const seeded = (seed: number): Random => {
	let state = seed >>> 0;

	const float = () => {
		state = (state + 1_831_565_813) >>> 0;

		const mixed = Math.imul(state ^ (state >>> 15), state | 1);
		const remixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)) ^ mixed;

		return ((remixed ^ (remixed >>> 14)) >>> 0) / 4_294_967_296;
	};

	const int = (bound: number) => Math.floor(float() * bound);

	const pick = <Item>(items: Arr.NonEmptyReadonlyArray<Item>) => items[int(items.length)] ?? Arr.headNonEmpty(items);

	const shuffle = <Item>(items: ReadonlyArray<Item>) => {
		const shuffled = Arr.copy(items);

		for (let index = shuffled.length - 1; index > 0; index -= 1) {
			const other = int(index + 1);
			const [here, there] = [shuffled[index], shuffled[other]];

			if (here !== undefined && there !== undefined) {
				shuffled[index] = there;
				shuffled[other] = here;
			}
		}

		return shuffled;
	};

	const chars = (alphabet: string, count: number) =>
		Arr.join(
			Arr.makeBy(count, () => alphabet[int(alphabet.length)] ?? ""),
			"",
		);

	return {
		int,
		between: (low, high) => low + int(high - low + 1),
		chance: (probability) => float() < probability,
		pick,
		shuffle,
		chars,
		digits: (count) => chars("0123456789", count),
		hex: (count) => chars("0123456789abcdef", count),
	};
};

/** Draws until the value is not in `used`, then records it, so every planted value is unique across the file. */
export const unique = ({ used, draw }: { readonly used: Set<string>; readonly draw: () => string }) => {
	let value = draw();

	while (used.has(value)) {
		value = draw();
	}

	used.add(value);

	return value;
};
