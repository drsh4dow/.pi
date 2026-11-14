import * as Option from "effect/Option";
import * as Str from "effect/String";

import type { Answer } from "./work.ts";

export const answerCap = 6000;

const paragraphBreak = "\n\n";

const count = (characters: number) => characters.toLocaleString("en-US");

const closingLine = (kept: number, total: number, file: string) =>
	`[The answer is cut at ${count(kept)} of ${count(total)} characters. Read the whole answer in ${file}]`;

export const answerOf =
	(file: string) =>
	(text: string): Answer => {
		if (text.length <= answerCap) {
			return { text, cut: false, file };
		}

		const room = answerCap - paragraphBreak.length - closingLine(answerCap, text.length, file).length;
		const head = Str.slice(0, room)(text);

		const kept = Option.match(Str.lastIndexOf(paragraphBreak)(head), {
			onNone: () => head,
			onSome: (at) => Str.slice(0, at)(head),
		});

		return { text: `${kept}${paragraphBreak}${closingLine(kept.length, text.length, file)}`, cut: true, file };
	};
