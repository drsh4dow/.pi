import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

const quoted = /(?<quoted>'[^']*'|"(?:[^"\\]|\\.)*"|\\.)/u;

const comment = /(?:^|\s)#.*$/gmu;

const redirect = /(?:^|[^\d&<>=-])(?:1|&)?>[>|]?\s*(?<to>[^\s;&|()]+)/u;

const outsideQuotes = (command: string) =>
	Arr.join(
		Arr.map(Str.split(command, quoted), (part, index) => (index % 2 === 1 && /[>#]/u.test(part) ? "''" : part)),
		"",
	);

export const stdoutRedirectOf = (command: string): Option.Option<string> => {
	const code = Str.replaceAll(comment, "")(outsideQuotes(command));

	return Option.fromNullishOr(redirect.exec(code)?.groups?.["to"]);
};
