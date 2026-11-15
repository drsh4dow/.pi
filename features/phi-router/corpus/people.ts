import type * as Arr from "effect/Array";
import * as Function from "effect/Function";
import * as Str from "effect/String";

import type { Random } from "./random.ts";

export type Lang = "en" | "es" | "de" | "fr" | "pt" | "vi";

export type ByLang<Value> = Readonly<Record<Lang, Value>>;

export const foreignLangs: Arr.NonEmptyReadonlyArray<Lang> = ["es", "de", "fr", "pt", "vi"];

type Syllables = Arr.NonEmptyReadonlyArray<string>;

interface NameParts {
	readonly givenStarts: Syllables;
	readonly givenEnds: Syllables;
	readonly familyStarts: Syllables;
	readonly familyEnds: Syllables;
}

const parts = {
	en: {
		givenStarts: ["Mar", "Tal", "Bren", "Cor", "Del", "Jor", "Kel", "Lor", "Nal", "Quin", "Ros", "Sel", "Vel", "Wyn"],
		givenEnds: ["a", "ena", "iel", "on", "ia", "ett", "ard", "ine", "ley", "is", "wyn", "ora"],
		familyStarts: ["Tov", "Quill", "Brann", "Hask", "Pell", "Strand", "Wick", "Ald", "Dunn", "Fenn", "Kest", "Thorn"],
		familyEnds: ["anek", "ford", "ley", "mere", "wick", "stone", "berry", "ton", "well", "gard", "holt", "ridge"],
	},
	es: {
		givenStarts: ["Mar", "Lu", "Car", "Ro", "Fer", "Gua", "Ine", "Iso", "Ra", "Vale", "Eus", "Cle"],
		givenEnds: ["ela", "isa", "iano", "ita", "ando", "encia", "ino", "una"],
		familyStarts: ["Gar", "Quin", "Bel", "Mon", "Tor", "Var", "Esc", "Lar", "Cav", "Zam"],
		familyEnds: ["ández", "ero", "alles", "illo", "aza", "edo", "ueña", "arro"],
	},
	de: {
		givenStarts: ["Ger", "Hil", "Wal", "Lie", "Fri", "Ul", "Ans", "Ott", "Hel", "Rein"],
		givenEnds: ["trud", "degard", "bert", "sel", "mar", "rike", "helm", "wig"],
		familyStarts: ["Brau", "Kess", "Lind", "Stoll", "Wern", "Holz", "Falk", "Rieg", "Mahl", "Dorn"],
		familyEnds: ["mann", "ler", "berger", "hof", "bach", "inger", "stein", "rath"],
	},
	fr: {
		givenStarts: ["Aur", "Bén", "Gas", "Hél", "Mar", "Sol", "Thi", "Év", "Lé", "Ros"],
		givenEnds: ["élie", "édicte", "ément", "ton", "oïse", "ceau", "ange", "baut"],
		familyStarts: ["Ber", "Dum", "Lef", "Mor", "Rou", "Vau", "Char", "Delac", "Fon", "Gir"],
		familyEnds: ["ançon", "ollet", "èvre", "eau", "ier", "ault", "ette", "oux"],
	},
	pt: {
		givenStarts: ["Jo", "Ma", "Ra", "Ter", "Lu", "Gil", "Cel", "Al", "Ro", "Dal"],
		givenEnds: ["ana", "rcia", "imundo", "esa", "ciana", "berto", "ina", "valdo"],
		familyStarts: ["Ca", "Bran", "Fer", "Sou", "Ma", "Pe", "Al", "Gui", "Ri", "Va"],
		familyEnds: ["rvalho", "dão", "reira", "sa", "ttos", "ixoto", "meida", "marães", "beiro"],
	},
	vi: {
		givenStarts: ["Thị", "Văn", "Ngọc", "Minh", "Đức", "Thanh", "Quốc", "Hữu", "Bảo", "Gia"],
		givenEnds: ["Khuê", "Lan", "Hải", "Phúc", "Tâm", "Long", "Yến", "Trung", "Nhung", "Vy"],
		familyStarts: ["Nguyễn", "Trần", "Lê", "Phạm", "Hoàng", "Huỳnh", "Võ", "Đặng", "Bùi", "Đỗ"],
		familyEnds: [""],
	},
} satisfies ByLang<NameParts>;

interface PersonName {
	readonly given: string;
	readonly family: string;
	readonly lang: Lang;
}

export const drawName =
	(lang: Lang) =>
	(rng: Random): PersonName => {
		const { givenStarts, givenEnds, familyStarts, familyEnds } = parts[lang];

		const given =
			lang === "vi"
				? `${rng.pick(givenStarts)} ${rng.pick(givenEnds)}`
				: rng.pick(givenStarts) + rng.pick(givenEnds);

		return { given, family: rng.pick(familyStarts) + rng.pick(familyEnds), lang };
	};

export const fullName = ({ given, family, lang }: PersonName) =>
	lang === "vi" ? `${family} ${given}` : `${given} ${family}`;

export const ascii = (text: string) =>
	Function.pipe(
		text,
		Str.normalize("NFD"),
		Str.replaceAll(/\p{M}/gu, ""),
		Str.replaceAll("đ", "d"),
		Str.replaceAll("Đ", "D"),
	);

export const slug = (separator: string) => (text: string) =>
	Function.pipe(
		ascii(text),
		Str.toLowerCase,
		Str.replaceAll(/[^a-z0-9]+/gu, " "),
		Str.trim,
		Str.replaceAll(" ", separator),
	);
