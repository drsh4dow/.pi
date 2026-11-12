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
import { actionItemProblems, type FormatProblem, requiredLabels } from "./action-items.ts";

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

/**
 * Every state folder, `~/.local/state/pi-agent/<project>/<work>`, that a tool call's input names, as an absolute path.
 * With a `file`, only the folders the input names that file in.
 */
const foldersIn = ({
	home,
	input,
	file = "",
}: {
	readonly home: string;
	readonly input: string;
	readonly file?: string;
}): ReadonlyArray<string> => {
	const homes = Arr.join([escaped(home), "~", String.raw`\$HOME`, String.raw`\$\{HOME\}`], "|");
	const tail = file === "" ? "" : escaped(`/${file}`);
	const pattern = new RegExp(`(?:${homes})${escaped(statePath)}(${segment}/${segment})${tail}`, "gu");
	const named = Arr.getSomes(Arr.map([...Str.matchAll(pattern)(input)], (match) => Option.fromNullishOr(match[1])));

	return Arr.dedupe(Arr.map(named, (folder) => `${home}${statePath}${folder}`));
};

/** The names, sizes and modification times of a folder's own entries, empty when it is missing. Any write to the folder changes it. */
const fingerprint = Effect.fn("fingerprint")(function* (folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const names = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

	const stamps = yield* Effect.forEach(names, (name) =>
		fs.stat(`${folder}/${name}`).pipe(
			Effect.map((info) => `${name} ${String(info.size)} ${String(Option.getOrUndefined(info.mtime)?.getTime())}`),
			Effect.orElseSucceed(() => name),
		),
	);

	return Arr.join(Arr.sort(stamps, Order.String), "\n");
});

/** Each running tool call's named state folders, with each folder's fingerprint from before the call ran. */
export type Watched = Map<string, ReadonlyArray<readonly [folder: string, before: string]>>;

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

/**
 * The state folder a finished tool call wrote to: one it named whose fingerprint changed while it ran, the last such
 * when there are several. A call that only read a folder leaves it unchanged, so reading another work never counts.
 */
export const wroteTo = Effect.fn("wroteTo")(function* (watched: Watched, toolCallId: string) {
	const seen = watched.get(toolCallId) ?? [];

	watched.delete(toolCallId);

	const changed = yield* Effect.filter(seen, ([folder, before]) =>
		Effect.map(fingerprint(folder), (after) => after !== before),
	);

	return Option.map(Arr.last(changed), ([folder]) => folder);
});

const actionItems = "USER_ACTION_ITEMS.md";

const formatPointer = `The format is in the ${actionItems} bullet of ~/.pi/agent/roles/root.md: each item is a "## <title>" line, then a line starting with each of ${Arr.join(requiredLabels, ", ")}.`;

const problemReport = (path: string, problems: ReadonlyArray<FormatProblem>) =>
	Arr.match(problems, {
		onEmpty: () => Option.none<string>(),
		onNonEmpty: (found) =>
			Option.some(
				Arr.join(
					[
						`${path} breaks the action item format:`,
						...Arr.map(found, ({ line, message }) => `line ${String(line)}: ${message}`),
					],
					"\n",
				),
			),
	});

export const checkedResult = Effect.fn("checkedResult")(function* ({
	home,
	result,
}: {
	readonly home: string;
	readonly result: Pick<ToolResultEvent, "input" | "content">;
}) {
	const fs = yield* FileSystem.FileSystem;
	const input = yield* encodeInput(result.input);
	const paths = Arr.map(foldersIn({ home, input, file: actionItems }), (folder) => `${folder}/${actionItems}`);

	const reports = yield* Effect.forEach(paths, (path) =>
		Effect.map(
			Effect.option(fs.readFileString(path)),
			Option.flatMap((file) => problemReport(path, actionItemProblems(file))),
		),
	);

	return Arr.match(Arr.getSomes(reports), {
		onEmpty: () => Option.none<ToolResultEventResult>(),
		// With no structuredContent here pi drops the tool's own, so a codemode script that made the call gets the error.
		onNonEmpty: (found) =>
			Option.some<ToolResultEventResult>({
				content: [...result.content, { type: "text", text: Arr.join([...found, formatPointer], "\n\n") }],
				isError: true,
			}),
	});
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

const check = Effect.fn("check")(function* (result: ToolResultEvent) {
	const home = yield* Config.String("HOME");

	const checked = yield* checkedResult({ home, result });

	return Option.getOrUndefined(checked);
});

const settle = Effect.fn("settle")(function* (
	tracker: Tracker,
	{ pi, toolCallId }: { readonly pi: Pick<ExtensionAPI, "appendEntry">; readonly toolCallId: string },
) {
	const wrote = yield* wroteTo(tracker.watched, toolCallId);

	if (Option.isNone(wrote) || Option.contains(tracker.folder, wrote.value)) {
		return;
	}

	tracker.folder = wrote;
	pi.appendEntry(entryKind, { folder: wrote.value });
	yield* publish(tracker);
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
 * it. No folder, no label. Outside herdr-core it only records. A tool call that names a state folder's
 * `USER_ACTION_ITEMS.md` gets the file's format problems in its result.
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
	pi.on("tool_result", (event) => run(check(event)));
	pi.on("tool_execution_end", ({ toolCallId }) => run(settle(tracker, { pi, toolCallId })));
	pi.on("session_shutdown", () => {
		tracker.folder = Option.none();

		return run(publish(tracker));
	});
};
