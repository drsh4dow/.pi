import * as Arr from "effect/Array";
import * as Str from "effect/String";

export const digitsOf = Str.replaceAll(/\D/gu, "");

/** The SSA never issues area 000, 666 or 9xx, group 00 or serial 0000. */
export const isSsn = (digits: string) => {
	const area = Str.slice(0, 3)(digits);
	const group = Str.slice(3, 5)(digits);
	const serial = Str.slice(5)(digits);

	return !/^(?:000|666|9\d\d)$/u.test(area) && group !== "00" && serial !== "0000";
};

export const hasDigit = (value: string) => /\d/u.test(value);

const nameWord = /^(?:Mc|O'|D')?[A-Z][a-z]+(?:-[A-Z][a-z]+)?$/u;

const nonValues = new Set(
	Str.split(" ")(
		"User Admin Patient Person Name Unknown Anonymous Null None Undefined String Text Varchar Char Integer Number Date Boolean Optional First Last Firstname Lastname",
	),
);

/** At least `fewest` capitalized name words lead `name`, and none of them stands in for a missing value. */
export const namesSomeone = ({ name, fewest }: { readonly name: string; readonly fewest: number }) => {
	const words = Arr.takeWhile(Str.split(/,? /u)(name), (word) => nameWord.test(word));

	return words.length >= fewest && !Arr.some(words, (word) => nonValues.has(word));
};
