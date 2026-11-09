import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/encoding";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { createJiti } from "jiti";

import type { Self } from "./child.ts";

export const DelegateName = Schema.String.pipe(
	Schema.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,19}$/u)),
	Schema.brand("DelegateName"),
);

export type DelegateName = typeof DelegateName.Type;

const Names = Schema.Array(Schema.NonEmptyString);

const Seconds = Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0)));

const common = {
	/** One line. Shown to the parent next to the name in the `delegate` tool's description. */
	description: Schema.NonEmptyString,
	/** `provider/id`, checked against the model registry at load. */
	model: Schema.String.pipe(
		Schema.check(Schema.isPattern(/^[^/]+\/.+$/u)),
		Schema.withDecodingDefaultKey(Effect.succeed("anthropic/claude-opus-5-5")),
	),
	/** Tool names the child declares, such as `read`, `bash`, `edit`. Every child also gets codemode, and owned-work tools come from the role. */
	tools: Names,
	/** Extension paths the child loads besides `childExtensions` and the built-in extensions its `tools` need. The child starts with `--no-extensions`, so none by default. */
	extensions: Schema.optionalKey(Names),
	/** Skill paths the child may load. The child starts with `--no-skills`, so none by default. */
	skills: Schema.optionalKey(Names),
	/** Load AGENTS.md / CLAUDE.md context files. Off by default (`--no-context-files`): the prompt and message carry the context. */
	contextFiles: Schema.optionalKey(Schema.Boolean),
	/** What this delegate does, shown to it as `<instructions>`. With them and the one message, the child must have everything it needs. How a delegate deals with its parent comes from `agent/roles/delegate.md`. */
	instructions: Schema.NonEmptyString,
	/** Seconds. A child still running then is killed and fails with `deadline`. No deadline by default. */
	deadline: Schema.optionalKey(Seconds),
};

export const Delegate = Schema.Union([
	Schema.Struct({ role: Schema.Literal("leaf"), ...common }),
	Schema.Struct({
		role: Schema.Literal("owner"),
		...common,
		/** Names of leaf delegates this owner may start. */
		delegates: Schema.NonEmptyArray(Schema.NonEmptyString),
	}),
]);

export type Delegate = typeof Delegate.Type;

/** A delegate file's default export, before load fills in defaults such as `model`. */
export type DelegateFile = typeof Delegate.Encoded;

export interface Entry {
	readonly name: DelegateName;
	readonly config: Delegate;
	readonly source: "harness" | "project";
	readonly file: string;
	readonly hash: string;
}

export interface Rejected {
	readonly file: string;
	readonly why: string;
}

export interface Registry {
	readonly entries: ReadonlyMap<DelegateName, Entry>;
	readonly rejected: ReadonlyArray<Rejected>;
}

export interface Folders {
	readonly harness: string;
	readonly project: string | undefined;
}

export interface RegistrySource {
	readonly folders: Folders;
	readonly hasModel: (provider: string, id: string) => boolean;
}

export const harnessFolder = `${import.meta.dirname}/../../agent/delegates`;

const attempt = <Value>(run: () => Promise<Value>) => Effect.tryPromise({ try: run, catch: String });

const listFiles = Effect.fn("listFiles")(function* (folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const files = (yield* fs.exists(folder)) ? yield* fs.readDirectory(folder) : [];

	return Arr.filter(files, Str.endsWith(".ts"));
});

const loadFile = Effect.fn("loadFile")(function* (folder: string, fileName: string, source: Entry["source"]) {
	const file = `${folder}/${fileName}`;
	const text = yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFile(file));
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	const exported = yield* attempt(() => jiti.import(file, { default: true }));
	const config = yield* Schema.decodeUnknownEffect(Delegate)(exported);
	const name = yield* Schema.decodeEffect(DelegateName)(Str.replace(/\.ts$/u, "")(fileName));
	const digest = yield* attempt(() => crypto.subtle.digest("SHA-256", new Uint8Array(text)));
	const hash = Encoding.Hex.encode(new Uint8Array(digest));

	return { name, config, source, file, hash } satisfies Entry;
});

const loadFolder = (folder: string, source: Entry["source"]) =>
	listFiles(folder).pipe(
		Effect.flatMap(
			Effect.partition((fileName) =>
				loadFile(folder, fileName, source).pipe(
					Effect.mapError((error): Rejected => ({ file: `${folder}/${fileName}`, why: String(error) })),
				),
			),
		),
		Effect.match({
			onFailure: (error) => ({ entries: Arr.empty<Entry>(), rejected: [{ file: folder, why: error.message }] }),
			onSuccess: ([entries, rejected]) => ({ entries, rejected }),
		}),
	);

const modelProblem = (entry: Entry, hasModel: RegistrySource["hasModel"]) => {
	const [provider, ...id] = Str.split(entry.config.model, "/");

	return hasModel(provider, Arr.join(id, "/"))
		? Option.none()
		: Option.some(`model ${entry.config.model} is not in the model registry`);
};

const ownerProblem = (entry: Entry, entries: ReadonlyMap<string, Entry>) =>
	Match.value(entry.config).pipe(
		Match.discriminatorsExhaustive("role")({
			leaf: () => Option.none(),
			owner: (config) =>
				Arr.findFirst(config.delegates, (name) => entries.get(name)?.config.role !== "leaf").pipe(
					Option.map((name) => `delegates names ${name}, which is not a known leaf`),
				),
		}),
	);

const keepWhere = (entries: ReadonlyMap<DelegateName, Entry>, problem: (entry: Entry) => Option.Option<string>) => {
	const kept = new Map<DelegateName, Entry>();
	const rejected: Array<Rejected> = [];

	for (const entry of entries.values()) {
		Option.match(problem(entry), {
			onNone: () => kept.set(entry.name, entry),
			onSome: (why) => rejected.push({ file: entry.file, why }),
		});
	}

	return { kept, rejected };
};

const noFolder = { entries: Arr.empty<Entry>(), rejected: Arr.empty<Rejected>() };

export const loadRegistry = Effect.fn("loadRegistry")(function* ({ folders, hasModel }: RegistrySource) {
	const path = yield* Path.Path;
	const harness = yield* loadFolder(path.resolve(folders.harness), "harness");

	const project =
		folders.project === undefined ? noFolder : yield* loadFolder(path.resolve(folders.project), "project");

	const merged = new Map(Arr.map([...harness.entries, ...project.entries], (entry) => [entry.name, entry] as const));
	const models = keepWhere(merged, (entry) => modelProblem(entry, hasModel));
	const owners = keepWhere(models.kept, (entry) => ownerProblem(entry, models.kept));

	return {
		entries: owners.kept,
		rejected: [...harness.rejected, ...project.rejected, ...models.rejected, ...owners.rejected],
	} satisfies Registry;
});

export const choices =
	(self: Self) =>
	(registry: Registry): ReadonlyArray<Entry> =>
		Match.value(self).pipe(
			Match.tag("Root", () => [...registry.entries.values()]),
			Match.tag("Child", (child) =>
				Arr.filter([...registry.entries.values()], (entry) => child.delegates.includes(entry.name)),
			),
			Match.exhaustive,
		);
