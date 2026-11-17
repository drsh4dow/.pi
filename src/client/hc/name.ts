import * as Brand from "effect/Brand";
import * as Option from "effect/Option";
import * as Str from "effect/String";

/** What hc accepts as a name: 1-32 of `[a-z0-9_.-]`, starting with a letter or digit, and not shaped like an address. */
export type TerminalName = string & Brand.Brand<"TerminalName">;

const nameLength = 32;

const TerminalName = Brand.nominal<TerminalName>();

const looksLikeAddress = /^t\d[0-9a-z]*$/u;

const trimmed = (slug: string) => Str.replace(/[^a-z0-9]+$/u, "")(Str.replace(/^[^a-z0-9]+/u, "")(slug));

/** A slug longer than a name ends at the last whole word that fits, unless that leaves fewer than 8 chars. */
const cut = (slug: string): string => {
	if (slug.length <= nameLength) {
		return slug;
	}

	const head = Str.slice(0, nameLength + 1)(slug);
	const lastBreak = Option.filter(Str.lastIndexOf("-")(head), (index) => index >= 8);
	const end = Option.getOrElse(lastBreak, () => nameLength);

	return Str.slice(0, end)(head);
};

/** The closest name hc accepts to `text`, such as `bun-test` for `bun test`. */
export const terminalNameOf = (text: string): TerminalName => {
	const words = Str.replaceAll(/[^a-z0-9_.]+/gu, "-")(Str.toLowerCase(text));
	const slug = trimmed(cut(trimmed(words)));

	if (Str.isEmpty(slug)) {
		return TerminalName("work");
	}

	return TerminalName(looksLikeAddress.test(slug) ? `${slug}-1` : slug);
};

/** The `attempt`th name to try, such as `bun-test-2` once `bun-test` is taken by another live terminal. */
export const nameAt =
	(attempt: number) =>
	(name: TerminalName): TerminalName => {
		if (attempt === 1) {
			return name;
		}

		const suffix = `-${String(attempt)}`;

		return terminalNameOf(`${Str.slice(0, nameLength - suffix.length)(name)}${suffix}`);
	};
