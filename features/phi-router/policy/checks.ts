import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

const digitAt = (digits: string, index: number) => Number(Str.slice(index, index + 1)(digits));

const vinLetters = "ABCDEFGHJKLMNPRSTUVWXYZ";
const vinLetterValues = "12345678123457923456789";
const vinWeights = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

const vinValue = (char: string) =>
	Option.match(Str.indexOf(char)(vinLetters), {
		onNone: () => Number(char),
		onSome: (letter) => digitAt(vinLetterValues, letter),
	});

/** A VIN's ninth character is its check digit, `X` for 10. Its tenth, the model year, is never 0, U or Z. */
export const isVin = (vin: string) => {
	const values = Arr.map(Str.split("")(vin), vinValue);
	const sum = Arr.reduce(Arr.zip(values, vinWeights), 0, (total, [value, weight]) => total + value * weight);
	const check = sum % 11 === 10 ? "X" : String(sum % 11);

	return (
		/[A-Z]/u.test(vin) && /\d/u.test(vin) && Str.slice(8, 9)(vin) === check && !/[0UZ]/u.test(Str.slice(9, 10)(vin))
	);
};

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
