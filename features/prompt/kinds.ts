import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { Role, Roles } from "../owned-work/index.ts";

/** A kind of prompt file the prompt lists by name and trigger: its folder under the agent dir, and the tag of its index. */
export type Kind = "principles" | "playbooks";

/** One line the agent matches against its task. No angle brackets, since it renders inside the index tag. */
const When = Schema.NonEmptyString.pipe(Schema.check(Schema.isPattern(/^[^\n<>]+$/u)));

const Frontmatter = Schema.Struct({
	when: When,
	/** The roles the file fits. Every role when absent. */
	for: Schema.optionalKey(Roles),
});

const decodeFrontmatter = Schema.decodeUnknownEffect(Frontmatter, { onExcessProperty: "error" });

const EntryName = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/u)));

/** One `<name>.md` directly in a kind's folder. The file name is its only name. */
export interface Entry {
	readonly name: string;
	readonly when: string;
	readonly roles: ReadonlyArray<Role>;
}

export interface Problem {
	readonly file: string;
	readonly why: string;
}

const parseEntry = Effect.fn("parseEntry")(function* (file: string, text: string) {
	const name = yield* Schema.decodeEffect(EntryName)(Str.replaceAll(/^.*\/|\.md$/gu, "")(file));
	const { frontmatter, body } = yield* Effect.try({ try: () => parseFrontmatter(text), catch: String });
	const fields = yield* decodeFrontmatter(frontmatter);

	if (Str.isEmpty(Str.trim(body))) {
		return yield* Effect.fail("the body is empty");
	}

	const entry: Entry = { name, when: fields.when, roles: fields.for ?? Role.literals };

	return entry;
});

/**
 * Every entry in `dir`, by name: none when the folder is missing. Files in its subfolders are reference files, not
 * entries. A broken file is left out and reported, so one typo never drops the rest.
 */
export const loadEntries = Effect.fn("loadEntries")(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem;
	const listed = (yield* fs.exists(dir)) ? yield* fs.readDirectory(dir) : [];
	const files = Arr.sort(Arr.filter(listed, Str.endsWith(".md")), Order.String);

	const [entries, problems] = yield* Effect.partition(files, (name) =>
		fs.readFileString(`${dir}/${name}`).pipe(
			Effect.flatMap((text) => parseEntry(`${dir}/${name}`, text)),
			Effect.mapError((error): Problem => ({ file: `${dir}/${name}`, why: String(error) })),
		),
	);

	return { entries, problems };
});

const line = ({ name, when }: Entry) => `- ${name}: ${when}`;

/** The index of `kind` for `role`: the folder once, then each fitting entry's name and trigger, never its body. */
export const entryIndex = ({
	kind,
	role,
	dir,
	entries,
}: {
	kind: Kind;
	role: Role;
	dir: string;
	entries: ReadonlyArray<Entry>;
}) => {
	const fitting = Arr.filter(entries, (entry) => entry.roles.includes(role));

	return Arr.isReadonlyArrayNonEmpty(fitting)
		? Option.some(`<${kind} dir="${dir}">\n${Arr.join(Arr.map(fitting, line), "\n")}\n</${kind}>`)
		: Option.none();
};
