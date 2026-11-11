import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { labelTerminal, TerminalAddress } from "../../clients/hc/index.ts";
import { type GuideKind, guidesOf, type Index, indexOf, inContext, Loaded } from "./context.ts";

export { type GuideKind, guidesOf, type Index, indexOf, inContext, Loaded } from "./context.ts";

export interface GuideFile {
	readonly kind: GuideKind;
	readonly name: string;
	readonly path: string;
}

/** The hc label on an agent's own terminal that holds its `ContextLabel`, which herdr-app's Skills panel reads. */
export const labelKey = "pi.context";

const Count = Schema.Finite;

/** What an agent's label holds: the guides in its context now, and how many of each kind it could load. */
export const ContextLabel = Schema.Struct({
	loaded: Schema.Array(Loaded),
	available: Schema.Struct({ skill: Count, principle: Count }),
});

export type ContextLabel = typeof ContextLabel.Type;

const encodeLabel = Schema.encodeEffect(Schema.fromJsonString(ContextLabel));

/** Reads each guide file. One that cannot be read is left out, so a deleted skill never hides the rest. */
export const loadGuides = Effect.fn("loadGuides")(function* (files: ReadonlyArray<GuideFile>) {
	const fs = yield* FileSystem.FileSystem;

	const read = yield* Effect.forEach(
		files,
		(file) =>
			fs.readFileString(file.path).pipe(
				Effect.map((text) => [{ ...file, text }]),
				Effect.orElseSucceed(() => []),
			),
		{ concurrency: "unbounded" },
	);

	return indexOf(guidesOf(Arr.flatten(read)));
});

/** Every `<name>.md` principle in `dir`. */
export const principleFiles = Effect.fn("principleFiles")(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem;
	const names = yield* fs.readDirectory(dir);

	return Arr.map(Arr.filter(names, Str.endsWith(".md")), (name): GuideFile => ({
		kind: "principle",
		name: Str.slice(0, -3)(name),
		path: `${dir}/${name}`,
	}));
});

const skillPrefix = "skill:";

const skillFiles = (commands: ReadonlyArray<SlashCommandInfo>) =>
	Arr.map(
		Arr.filter(commands, (command) => command.source === "skill"),
		(command): GuideFile => ({
			kind: "skill",
			name: Str.startsWith(skillPrefix)(command.name) ? Str.slice(skillPrefix.length)(command.name) : command.name,
			path: command.sourceInfo.path,
		}),
	);

const countOf = (index: Index, kind: GuideKind) => Arr.length(Arr.filter(index.guides, (guide) => guide.kind === kind));

const labelOf = (index: Index, ctx: ExtensionContext): ContextLabel => ({
	loaded: inContext({ index, entries: ctx.sessionManager.buildSessionProjection().entries }),
	available: { skill: countOf(index, "skill"), principle: countOf(index, "principle") },
});

/** The guides this agent can load, and the label text it last set, so an unchanged context sends nothing. */
interface Publisher {
	index: Option.Option<Index>;
	published: string;
}

const ownTerminal = Effect.map(Effect.option(Config.String("HC_TERMINAL_ID")), Option.map(TerminalAddress));

/** Reads the guides pi can load now: its skill commands' files and the harness principles. */
const load = Effect.fn("load")(function* (publisher: Publisher, commands: ReadonlyArray<SlashCommandInfo>) {
	const principles = yield* principleFiles(`${getAgentDir()}/principles`);
	const index = yield* loadGuides([...skillFiles(commands), ...principles]);

	publisher.index = Option.some(index);
});

const refresh = Effect.fn("refresh")(function* (publisher: Publisher, ctx: ExtensionContext) {
	const terminal = yield* ownTerminal;

	if (Option.isNone(terminal) || Option.isNone(publisher.index)) {
		return;
	}

	const text = yield* encodeLabel(labelOf(publisher.index.value, ctx));

	if (text !== publisher.published) {
		yield* labelTerminal({ terminal: terminal.value, labels: { [labelKey]: text } });
		publisher.published = text;
	}
});

const clear = Effect.fn("clear")(function* (publisher: Publisher) {
	const terminal = yield* ownTerminal;

	if (Option.isSome(terminal) && publisher.published !== "") {
		yield* labelTerminal({ terminal: terminal.value, labels: { [labelKey]: "" } });
		publisher.published = "";
	}
});

const run = <Failure>(effect: Effect.Effect<void, Failure, FileSystem.FileSystem>) =>
	Effect.runPromise(effect.pipe(Effect.ignore({ log: "Warn" }), Effect.provide(NodeServices.layer)));

/**
 * Keeps the `pi.context` label on this agent's hc terminal equal to the skills and principles its model sees now. It
 * recomputes after each turn, a `/tree` move and a compaction, and clears the label when the session ends. Outside
 * herdr-core it does nothing.
 */
export const loaded = (pi: Pick<ExtensionAPI, "on" | "getCommands">) => {
	const publisher: Publisher = { index: Option.none(), published: "" };

	pi.on("session_start", (_event, ctx) => {
		const start = Effect.andThen(load(publisher, pi.getCommands()), refresh(publisher, ctx));

		return run(start);
	});

	pi.on("turn_end", (_event, ctx) => run(refresh(publisher, ctx)));
	pi.on("agent_end", (_event, ctx) => run(refresh(publisher, ctx)));
	pi.on("session_tree", (_event, ctx) => run(refresh(publisher, ctx)));
	pi.on("session_compact", (_event, ctx) => run(refresh(publisher, ctx)));
	pi.on("session_shutdown", () => run(clear(publisher)));
};
