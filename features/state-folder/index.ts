import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	ToolCallEvent,
	ToolResultEvent,
	ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { labelTerminal, TerminalAddress } from "../../clients/hc/index.ts";
import type { FormatProblem } from "./action-items.ts";
import { checks } from "./checks.ts";

/** The hc label on an agent's own terminal that names the state folder it last wrote to, which herdr-app's Trace and Actions panels read. */
export const labelKey = "pi.state";

/** The `customType` of the session entry that records each new state folder, so a resumed or reloaded session labels it again. */
export const entryKind = "pi.state";

const StateEntry = Schema.Struct({
	type: Schema.Literal("custom"),
	customType: Schema.Literal(entryKind),
	data: Schema.Struct({ folder: Schema.String }),
});

const decodeEntry = Schema.decodeUnknownOption(StateEntry);
const encodeInput = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const statePath = "/.local/state/pi-agent/";
const segment = "[^/\\s\"'`$\\\\;|&<>()*?{}]+";
const escaped = Str.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/** Every state folder, `~/.local/state/pi-agent/<project>/<work>`, that a tool call's input names, as an absolute path. */
const foldersIn = ({ home, input }: { readonly home: string; readonly input: string }): ReadonlyArray<string> => {
	const homes = Arr.join([escaped(home), "~", String.raw`\$HOME`, String.raw`\$\{HOME\}`], "|");
	const pattern = new RegExp(`(?:${homes})${escaped(statePath)}(${segment}/${segment})`, "gu");
	const named = Arr.getSomes(Arr.map([...Str.matchAll(pattern)(input)], (match) => Option.fromNullishOr(match[1])));

	return Arr.dedupe(Arr.map(named, (folder) => `${home}${statePath}${folder}`));
};

/** Each of a folder's own entries by name, with its size and modification time, empty when the folder is missing. */
type Fingerprint = ReadonlyMap<string, string>;

const fingerprint = Effect.fn("fingerprint")(function* (folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const names = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

	const stamps = yield* Effect.forEach(names, (name) =>
		fs.stat(`${folder}/${name}`).pipe(
			Effect.map((info) => `${String(info.size)} ${String(Option.getOrUndefined(info.mtime)?.getTime())}`),
			Effect.orElseSucceed(() => ""),
			Effect.map((stamp) => [name, stamp] as const),
		),
	);

	const stamped: Fingerprint = new Map(stamps);

	return stamped;
});

/** Each running tool call's named state folders, with each folder's fingerprint from before the call ran. */
export type Watched = Map<string, ReadonlyArray<readonly [folder: string, before: Fingerprint]>>;

/** Fingerprints the state folders a tool call names in its input, the call's arguments as JSON text, before it runs. */
export const watchCall = Effect.fn("watchCall")(function* (
	watched: Watched,
	{ home, toolCallId, input }: { readonly home: string; readonly toolCallId: string; readonly input: string },
) {
	const seen = yield* Effect.forEach(foldersIn({ home, input }), (folder) =>
		Effect.map(fingerprint(folder), (before) => [folder, before] as const),
	);

	if (seen.length > 0) {
		watched.set(toolCallId, seen);
	}
});

/** The names of the entries a call added, changed or removed. */
const changedNames = (before: Fingerprint, after: Fingerprint) =>
	Arr.filter(Arr.dedupe([...before.keys(), ...after.keys()]), (name) => before.get(name) !== after.get(name));

const byLine = Order.mapInput(Order.Number, ({ line }: FormatProblem) => line);

/** The problems a changed state file's check finds, as a report, none when the file has no check or is gone. */
const reportOn = Effect.fn("reportOn")(function* (folder: string, name: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = `${folder}/${name}`;
	const check = checks.get(name);

	if (check === undefined) {
		return Option.none<string>();
	}

	const text = yield* Effect.option(fs.readFileString(path));

	if (Option.isNone(text)) {
		return Option.none<string>();
	}

	const problems = yield* check.problems(text.value);

	return Arr.match(Arr.sort(problems, byLine), {
		onEmpty: () => Option.none<string>(),
		onNonEmpty: (found) =>
			Option.some(
				Arr.join(
					[
						`${path} changed on disk, so the call went through, but the file breaks its rules. Fix the file rather than redo the call.`,
						...Arr.map(found, ({ line, message }) => `line ${String(line)}: ${message}`),
						check.fix,
					],
					"\n",
				),
			),
	});
});

/**
 * Ends the watch on a tool call that ran. `wrote` is the state folder it wrote to: one it named whose fingerprint
 * changed while it ran, the last such when there are several. A call that only read a folder leaves it unchanged, so
 * reading another work never counts. `checked` is the call's result with the problems of each state file it changed
 * appended, as an error, none when those files have none.
 */
export const finishCall = Effect.fn("finishCall")(function* (
	watched: Watched,
	{ result }: { readonly result: Pick<ToolResultEvent, "toolCallId" | "content"> },
) {
	const seen = watched.get(result.toolCallId) ?? [];

	watched.delete(result.toolCallId);

	const changes = yield* Effect.forEach(seen, ([folder, before]) =>
		Effect.map(fingerprint(folder), (after) => ({ folder, names: changedNames(before, after) })),
	);

	const changed = Arr.filter(changes, ({ names }) => names.length > 0);

	const reports = yield* Effect.forEach(changed, ({ folder, names }) =>
		Effect.forEach(names, (name) => reportOn(folder, name)),
	);

	const checked = Arr.match(Arr.getSomes(Arr.flatten(reports)), {
		onEmpty: () => Option.none<ToolResultEventResult>(),
		// With no structuredContent here pi drops the tool's own, so a codemode script that made the call gets the error.
		onNonEmpty: (found) =>
			Option.some<ToolResultEventResult>({
				content: [...result.content, { type: "text", text: Arr.join(found, "\n\n") }],
				isError: true,
			}),
	});

	return { wrote: Option.map(Arr.last(changed), ({ folder }) => folder), checked };
});

/** The state folder this branch of the session last wrote to, from the entries `stateFolder` appends. */
export const lastFolder = (branch: ReadonlyArray<SessionEntry>): Option.Option<string> => {
	const recorded = Arr.getSomes(Arr.map(branch, (entry) => decodeEntry(entry)));

	return Option.map(Arr.last(recorded), ({ data }) => data.folder);
};

const ownTerminal = Effect.map(Effect.option(Config.String("HC_TERMINAL_ID")), Option.map(TerminalAddress));

/** The tool calls being watched, the state folder the session last wrote to, and the label text last set for it. */
interface Tracker {
	readonly watched: Watched;
	folder: Option.Option<string>;
	published: string;
}

const publish = Effect.fn("publish")(function* (tracker: Tracker) {
	const terminal = yield* ownTerminal;
	const text = Option.getOrElse(tracker.folder, () => "");

	if (Option.isSome(terminal) && text !== tracker.published) {
		yield* labelTerminal({ terminal: terminal.value, labels: { [labelKey]: text } });
		tracker.published = text;
	}
});

const watch = Effect.fn("watch")(function* (tracker: Tracker, { toolCallId, input }: ToolCallEvent) {
	const home = yield* Config.String("HOME");
	const text = yield* encodeInput(input);

	yield* watchCall(tracker.watched, { home, toolCallId, input: text });
});

/** Ends the watch on a tool call, records the state folder it wrote to, and returns its result with the problems it left. */
const finish = Effect.fn("finish")(function* (
	tracker: Tracker,
	{ pi, result }: { readonly pi: Pick<ExtensionAPI, "appendEntry">; readonly result: ToolResultEvent },
) {
	const { wrote, checked } = yield* finishCall(tracker.watched, { result });

	if (Option.isSome(wrote) && !Option.contains(tracker.folder, wrote.value)) {
		tracker.folder = wrote;
		pi.appendEntry(entryKind, { folder: wrote.value });
		yield* publish(tracker).pipe(Effect.catchCause((cause) => Effect.logWarning(cause)));
	}

	return Option.getOrUndefined(checked);
});

const run = <Value, Failure>(effect: Effect.Effect<Value, Failure, FileSystem.FileSystem>) =>
	Effect.runPromise(
		effect.pipe(
			Effect.catchCause((cause) => Effect.logWarning(cause)),
			Effect.provide(NodeServices.layer),
		),
	);

/**
 * Keeps the `pi.state` label on this agent's hc terminal equal to the state folder its session last wrote to, found by
 * watching its own tool calls, and records each new folder in the session so `/resume`, `/reload` and `/tree` restore
 * it. No folder, no label. Outside herdr-core it only records. A tool call that changes a state file with a check, such
 * as `STATE.md` or `USER_ACTION_ITEMS.md`, gets the file's problems in its result as an error.
 */
export const stateFolder = (pi: Pick<ExtensionAPI, "on" | "appendEntry">) => {
	const tracker: Tracker = { watched: new Map(), folder: Option.none(), published: "" };

	const restore = (ctx: ExtensionContext) => {
		tracker.folder = lastFolder(ctx.sessionManager.getBranch());

		return run(publish(tracker));
	};

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("tool_call", (event) => run(watch(tracker, event)));
	pi.on("tool_result", (result) => run(finish(tracker, { pi, result })));
	// A call another extension blocked never reaches tool_result, so its watch ends here.
	pi.on("tool_execution_end", ({ toolCallId }) => {
		tracker.watched.delete(toolCallId);
	});
	pi.on("session_shutdown", () => {
		tracker.folder = Option.none();

		return run(publish(tracker));
	});
};
