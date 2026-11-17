import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

class LineInvalid extends Schema.TaggedError<LineInvalid, { readonly brand: unique symbol }>()("LineInvalid", {
	source: Schema.String,
	line: Schema.Int,
	message: Schema.String,
}) {}

interface JsonLines<Decoded> {
	readonly schema: Schema.Codec<Decoded, string>;
	readonly source: string;
	readonly text: string;
}

/** Decodes every non-blank line, failing on the first bad one with its 1-based line number. */
export const decodeJsonLines = <Decoded>({ schema, source, text }: JsonLines<Decoded>) => {
	const numbered = Arr.map(Str.split("\n")(text), (content, index) => ({ content, line: index + 1 }));

	return Effect.forEach(
		Arr.filter(numbered, ({ content }) => Str.isNonEmpty(Str.trim(content))),
		({ content, line }) =>
			Schema.decodeEffect(schema)(content).pipe(
				Effect.mapError((error) =>
					LineInvalid.make({ source, line, message: `${source} line ${line}: ${error.message}` }),
				),
			),
	);
};
