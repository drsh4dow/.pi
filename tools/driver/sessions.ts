/**
 * Reads a run's session files and probe records into `Sessions`. Read only, and never through pi's SessionManager,
 * which can rewrite a file it migrates while pi is still appending to it.
 */
import { parseSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { ScenarioFailed } from "./failed.ts";
import { Probed } from "./probe.ts";

/** What one pi loaded when its session started, as the run's probe saw it. */
export interface Loaded {
	/** The running pi's own `VERSION`. */
	readonly version: string;
	/** `provider/id`. */
	readonly model: string;
	/** The model's context window, after any `modelOverrides` of the setup. */
	readonly contextWindow: number;
	/** Extension files that registered a tool or a command, links resolved, sorted, distinct. */
	readonly extensions: ReadonlyArray<string>;
}

/** One pi session file as it stood when read. */
export interface Session {
	/** The id in the file's header, the one owned-work records as `child_session_id`. */
	readonly id: string;
	readonly file: string;
	/** The file's entries in order, header left out. A line pi was still writing is left out until the next read. */
	readonly entries: ReadonlyArray<SessionEntry>;
	/**
	 * What the pi running this session loaded, as of its latest session start or agent start. Extensions that register
	 * tools in their own `session_start` handler show from the first agent start on. None until it started.
	 */
	readonly loaded: Option.Option<Loaded>;
	/**
	 * Every string of each provider payload this session built, one line each, oldest first. Recorded before any other
	 * extension's `before_provider_request` handler, so not always the text the provider received.
	 */
	readonly requests: ReadonlyArray<string>;
}

/** Every session of one run. */
export interface Sessions {
	/** No entries until pi writes the file at the root's first message. */
	readonly root: Session;
	/** Every delegate's session at any depth (`delegates/` under the session folder, and theirs), oldest first. */
	readonly delegates: ReadonlyArray<Session>;
}

/** The text up to its last LF: a line after it is still being written. */
const completeLines = (text: string) =>
	Option.match(Str.lastIndexOf("\n")(text), { onNone: () => "", onSome: (last) => Str.slice(0, last + 1)(text) });

const decodeProbed = Schema.decodeUnknownOption(Schema.fromJsonString(Probed));

/** Pure. Every complete probe record in a probe file's text. A line that is not a record is skipped. */
export const probedIn = (text: string): ReadonlyArray<Probed> => {
	const lines = Str.split(completeLines(text), "\n");

	return Arr.getSomes(Arr.map(lines, (line) => decodeProbed(line)));
};

const probedOf = (id: string, probed: ReadonlyArray<Probed>) => {
	const mine = Arr.filter(probed, (record) => record.session === id);

	return {
		loaded: Option.map(
			Arr.findLast(mine, (record) => record.type === "loaded"),
			({ version, model, contextWindow, extensions }): Loaded => ({ version, model, contextWindow, extensions }),
		),
		requests: Arr.flatMap(mine, (record) => (record.type === "request" ? [record.text] : [])),
	};
};

const isEntry = (entry: ReturnType<typeof parseSessionEntries>[number]): entry is SessionEntry =>
	entry.type !== "session";

/** Pure. One session file's text with its probe records. None when the header is not written yet. */
export const sessionIn = ({
	file,
	text,
	probed,
}: {
	readonly file: string;
	readonly text: string;
	readonly probed: ReadonlyArray<Probed>;
}): Option.Option<Session> => {
	const entries = parseSessionEntries(completeLines(text));
	const [header] = entries;

	if (header?.type !== "session") {
		return Option.none();
	}

	return Option.some({ id: header.id, file, entries: Arr.filter(entries, isEntry), ...probedOf(header.id, probed) });
};

const byName = Order.mapInput(Order.String, (file: string) => Str.replace(/^.*\//u, "")(file));

/**
 * Reads the root's file, every `*.jsonl` below `<sessionDir>/delegates` sorted by file name (pi's timestamp), and the
 * probe folder. Fails only on an unreadable folder, which means the run itself broke.
 */
export const readSessions = ({
	root,
	sessionDir,
	probeDir,
}: {
	readonly root: { readonly id: string; readonly file: string };
	readonly sessionDir: string;
	readonly probeDir: string;
}): Effect.Effect<Sessions, ScenarioFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		const jsonlIn = (folder: string) =>
			fs.exists(folder).pipe(
				Effect.flatMap((exists) => (exists ? fs.readDirectory(folder, { recursive: true }) : Effect.succeed([]))),
				Effect.map((names) => Arr.map(Arr.filter(names, Str.endsWith(".jsonl")), (name) => `${folder}/${name}`)),
			);

		const textOf = (file: string) =>
			Effect.flatMap(fs.exists(file), (exists) => (exists ? fs.readFileString(file) : Effect.succeed("")));

		const probeFiles = yield* jsonlIn(probeDir);
		const probeTexts = yield* Effect.forEach(probeFiles, textOf);
		const probed = Arr.flatMap(probeTexts, probedIn);
		const rootText = yield* textOf(root.file);
		const delegateFiles = yield* jsonlIn(`${sessionDir}/delegates`);

		const delegates = yield* Effect.forEach(Arr.sort(delegateFiles, byName), (file) =>
			Effect.map(textOf(file), (text) => sessionIn({ file, text, probed })),
		);

		return {
			root: Option.getOrElse(sessionIn({ file: root.file, text: rootText, probed }), () => ({
				...root,
				entries: [],
				...probedOf(root.id, probed),
			})),
			delegates: Arr.getSomes(delegates),
		};
	}).pipe(
		Effect.mapError((error) => ScenarioFailed.make({ message: `cannot read the run's sessions: ${error.message}` })),
	);
