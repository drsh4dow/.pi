import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { ChildRole } from "./child.ts";
import { type ModelName, modelNameOf } from "./models.ts";

const Frontmatter = Schema.Struct({
	model: Schema.optionalKey(Schema.NonEmptyString),
	thinking: Schema.optionalKey(Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"])),
	readonly: Schema.optionalKey(Schema.Boolean),
	role: Schema.optionalKey(ChildRole),
});

const decodeFrontmatter = Schema.decodeUnknownEffect(Frontmatter, { onExcessProperty: "error" });

export interface Profile {
	readonly model: Option.Option<ModelName>;
	readonly thinking: Option.Option<string>;
	readonly readOnly: boolean;
	readonly role: Option.Option<ChildRole>;
	readonly text: string;
}

/** A block that never closes or starts below the first line stays in the body, because pi's `parseFrontmatter` leaves it there. */
export const parseProfile = Effect.fn("parseProfile")(function* (text: string) {
	const { frontmatter, body } = yield* Effect.try({ try: () => parseFrontmatter(text), catch: String });

	if (Str.startsWith("---")(Str.trimStart(body))) {
		return yield* Effect.fail("the frontmatter block must open on the first line and close with ---");
	}

	const fields = yield* Effect.mapError(decodeFrontmatter(frontmatter), String);

	const profile: Profile = {
		model: Option.map(Option.fromUndefinedOr(fields.model), modelNameOf),
		thinking: Option.fromUndefinedOr(fields.thinking),
		readOnly: fields.readonly ?? false,
		role: Option.fromUndefinedOr(fields.role),
		text: body,
	};

	return profile;
});
