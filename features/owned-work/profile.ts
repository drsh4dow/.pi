import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

const Frontmatter = Schema.Struct({
	/** A model alias or `provider/id`. */
	model: Schema.optionalKey(Schema.NonEmptyString),
	thinking: Schema.optionalKey(Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"])),
	readonly: Schema.optionalKey(Schema.Boolean),
});

const decodeFrontmatter = Schema.decodeUnknownEffect(Frontmatter, { onExcessProperty: "error" });

/** Who a delegate is, from its instructions file: the frontmatter picks its model, thinking level and tools, and the body is its `<instructions>`. */
export interface Profile {
	readonly model: Option.Option<string>;
	readonly thinking: Option.Option<string>;
	/** A read-only delegate starts without the `edit` and `write` tools. */
	readonly readOnly: boolean;
	readonly text: string;
}

/**
 * A file with no frontmatter is all body. An unknown key fails, and so does a block pi leaves in the body because it is
 * unclosed or starts below the first line, so a misspelt or misplaced `readonly` never passes as the default.
 */
export const parseProfile = Effect.fn("parseProfile")(function* (text: string) {
	const { frontmatter, body } = yield* Effect.try({ try: () => parseFrontmatter(text), catch: String });

	if (Str.startsWith("---")(Str.trimStart(body))) {
		return yield* Effect.fail("the frontmatter block must open on the first line and close with ---");
	}

	const fields = yield* Effect.mapError(decodeFrontmatter(frontmatter), String);

	const profile: Profile = {
		model: Option.fromUndefinedOr(fields.model),
		thinking: Option.fromUndefinedOr(fields.thinking),
		readOnly: fields.readonly ?? false,
		text: body,
	};

	return profile;
});
