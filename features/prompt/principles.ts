import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { Role } from "../owned-work/index.ts";

/** One line the agent matches against its task. No angle brackets, since it renders inside `<when>`. */
const When = Schema.NonEmptyString.pipe(Schema.check(Schema.isPattern(/^[^\n<>]+$/u)));

const Roles = Role.pipe(Schema.NonEmptyArray);

const Frontmatter = Schema.Struct({
	when: When,
	/** The roles the principle fits. Every role when absent. */
	for: Schema.optionalKey(Roles),
});

const decodeFrontmatter = Schema.decodeUnknownEffect(Frontmatter, { onExcessProperty: "error" });

const PrincipleName = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/u)));

/** One `agent/principles/<name>.md`. The file name is its only name. */
export interface Principle {
	readonly name: string;
	readonly when: string;
	readonly roles: ReadonlyArray<Role>;
	readonly file: string;
}

export interface Problem {
	readonly file: string;
	readonly why: string;
}

const parsePrinciple = Effect.fn("parsePrinciple")(function* (file: string, text: string) {
	const name = yield* Schema.decodeEffect(PrincipleName)(Str.replaceAll(/^.*\/|\.md$/gu, "")(file));
	const { frontmatter, body } = yield* Effect.try({ try: () => parseFrontmatter(text), catch: String });
	const fields = yield* decodeFrontmatter(frontmatter);

	if (Str.isEmpty(Str.trim(body))) {
		return yield* Effect.fail("the body is empty");
	}

	const principle: Principle = { name, when: fields.when, roles: fields.for ?? Role.literals, file };

	return principle;
});

/** Every principle in `dir`, by name. A broken file is left out and reported, so one typo never drops the rest. */
export const loadPrinciples = Effect.fn("loadPrinciples")(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem;
	const listed = yield* fs.readDirectory(dir);
	const files = Arr.sort(Arr.filter(listed, Str.endsWith(".md")), Order.String);

	const [principles, problems] = yield* Effect.partition(files, (name) =>
		fs.readFileString(`${dir}/${name}`).pipe(
			Effect.flatMap((text) => parsePrinciple(`${dir}/${name}`, text)),
			Effect.mapError((error): Problem => ({ file: `${dir}/${name}`, why: String(error) })),
		),
	);

	return { principles, problems };
});

const entry = ({ name, when, file }: Principle) =>
	`<principle>\n<name>${name}</name>\n<when>${when}</when>\n<location>${file}</location>\n</principle>`;

/** The `<principles>` index for `role`: each fitting principle's name, trigger and file, never its body. */
export const principleIndex = (role: Role) => (principles: ReadonlyArray<Principle>) => {
	const fitting = Arr.filter(principles, (principle) => principle.roles.includes(role));

	return Arr.isReadonlyArrayNonEmpty(fitting)
		? Option.some(`<principles>\n${Arr.join(Arr.map(fitting, entry), "\n")}\n</principles>`)
		: Option.none();
};
