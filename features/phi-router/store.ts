/**
 * The verdict store. The router extension is its one writer; the border reads it through `lookup`.
 *
 * Session verdicts persist as `phi-verdicts` custom entries. The book folds every such entry in the session file, all
 * branches included: a verdict is a fact about content, so the union is correct and a fork carries its entries. System
 * verdicts persist in a global folder per policy version, one append-only file per pi process, so the harness prompt
 * is judged once per policy rather than once per session.
 */
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import type { Lookup, Seal } from "./border.ts";
import { ContentKey, Finding, type Piece, Verdict } from "./policy/engine.ts";
import { PolicyVersion, policyVersion } from "./policy/policy.ts";

export const verdictsEntryType = "phi-verdicts";

/** A rule id, identifier kind, failure reason or clearing source. It starts with a letter, so no bare number fits. */
export const Why = Schema.String.check(Schema.isPattern(/^[a-z][a-z\d-]{0,31}$/u));

const Stored = Schema.Tuple([ContentKey, Schema.Literals(["c", "s"]), Why]);

type Stored = typeof Stored.Type;

/** The data of one `phi-verdicts` entry. Only keys and literals, never content. */
export const VerdictsEntry = Schema.Struct({ policy: PolicyVersion, verdicts: Schema.Array(Stored) });

export type VerdictsEntry = typeof VerdictsEntry.Type;

export interface VerdictBook {
	/** What the border reads. Synchronous, no I/O. */
	readonly lookup: Lookup;
	/** What `verdictsFor` reads. */
	readonly known: (key: ContentKey) => boolean;
	/**
	 * Memory first, so the border sees the verdicts before pi streams. System verdicts go to this process's cache file.
	 * The rest come back as the entry the router appends with `pi.appendEntry(verdictsEntryType, entry)`, none when
	 * there are none.
	 */
	readonly record: (judged: {
		readonly found: ReadonlyArray<readonly [ContentKey, Verdict]>;
		readonly pieces: ReadonlyArray<Pick<Piece, "key" | "kind">>;
	}) => Effect.Effect<Option.Option<VerdictsEntry>>;
}

const whyOf = Verdict.$match({
	Cleared: ({ by }) => by,
	Sealed: ({ finding }) =>
		Finding.$match(finding, {
			Rule: ({ rule }) => rule,
			Judge: ({ kind }) => kind,
			Failure: ({ why }) => why,
		}),
});

const storedOf = ([key, verdict]: readonly [ContentKey, Verdict]): Stored => [
	key,
	Verdict.$is("Sealed")(verdict) ? "s" : "c",
	whyOf(verdict),
];

/** A failed judgment may pass on retry, so only the process that saw it keeps it. */
const isFailure = (verdict: Verdict) => Verdict.$is("Sealed")(verdict) && Finding.$is("Failure")(verdict.finding);

const decodeEntry = Schema.decodeUnknownOption(VerdictsEntry);

/** Entries of another policy version and malformed ones are skipped, so their keys are judged again. */
const sessionVerdicts = (entries: ReadonlyArray<SessionEntry>) =>
	Arr.flatMap(entries, (entry) => {
		if (entry.type !== "custom" || entry.customType !== verdictsEntryType) {
			return [];
		}

		const current = Option.filter(decodeEntry(entry.data), ({ policy }) => policy === policyVersion);

		return Option.match(current, { onNone: () => [], onSome: ({ verdicts }) => verdicts });
	});

const Line = Schema.fromJsonString(Stored);

const decodeLine = Schema.decodeUnknownOption(Line);

const encodeLine = Schema.encodeEffect(Line);

const systemFolder = Effect.map(
	Config.String("HOME"),
	(home) => `${home}/.local/state/pi-phi-router/system/${policyVersion}`,
);

/** Every process's file merged. A line cut short by a crash fails to decode and is skipped. */
const systemVerdicts = Effect.fn("systemVerdicts")(
	function* (fs: FileSystem.FileSystem, folder: string) {
		const files = yield* fs
			.readDirectory(folder)
			.pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])));

		const texts = yield* Effect.forEach(files, (file) => fs.readFileString(`${folder}/${file}`));

		return Arr.flatMap(texts, (text) => Arr.getSomes(Arr.map(Str.split("\n")(text), (line) => decodeLine(line))));
	},
	Effect.catchCause((cause) =>
		Effect.as(
			Effect.logWarning(
				"phi-router: the system verdict cache is unreadable, so system parts are judged again",
				cause,
			),
			[],
		),
	),
);

/** Each line starts with a newline, so a line cut short by a crash never swallows the next one. */
const appendLines = Effect.fn("appendLines")(
	function* ({
		folder,
		pid,
		lines,
	}: {
		readonly folder: string;
		readonly pid: number;
		readonly lines: ReadonlyArray<Stored>;
	}) {
		const fs = yield* FileSystem.FileSystem;
		const encoded = yield* Effect.forEach(lines, (line) => encodeLine(line));

		const text = Arr.join(
			Arr.map(encoded, (line) => `\n${line}`),
			"",
		);

		yield* fs.makeDirectory(folder, { recursive: true });
		yield* fs.writeFileString(`${folder}/${String(pid)}.jsonl`, text, { flag: "a" });
	},
	Effect.ignore({ log: "Warn" }),
);

/** Sealed wins: a cleared verdict never reopens a sealed key. */
const mergeInto =
	(seals: Map<ContentKey, Seal>) =>
	([key, mark]: Stored) => {
		if (seals.get(key) !== "sealed") {
			seals.set(key, mark === "s" ? "sealed" : "cleared");
		}
	};

/** A book over `verdicts` in memory. `keepSystem` persists the system verdicts each `record` finds. */
const bookWith = ({
	verdicts,
	keepSystem,
}: {
	readonly verdicts: ReadonlyArray<Stored>;
	readonly keepSystem: (lines: ReadonlyArray<Stored>) => Effect.Effect<void>;
}): VerdictBook => {
	const seals = new Map<ContentKey, Seal>();
	const merge = mergeInto(seals);

	Arr.forEach(verdicts, merge);

	const record: VerdictBook["record"] = ({ found, pieces }) => {
		Arr.forEach(Arr.map(found, storedOf), merge);

		const systemKeys = new Set(Arr.flatMap(pieces, ({ key, kind }) => (kind === "system" ? [key] : [])));
		const session = Arr.filter(found, ([key]) => !systemKeys.has(key));
		const cached = Arr.filter(found, ([key, verdict]) => systemKeys.has(key) && !isFailure(verdict));

		const entry = Arr.isReadonlyArrayNonEmpty(session)
			? Option.some({ policy: policyVersion, verdicts: Arr.map(session, storedOf) })
			: Option.none();

		if (!Arr.isReadonlyArrayNonEmpty(cached)) {
			return Effect.succeed(entry);
		}

		return Effect.as(keepSystem(Arr.map(cached, storedOf)), entry);
	};

	return {
		lookup: (key) => seals.get(key),
		known: (key) => seals.has(key),
		record,
	};
};

/** An empty book that lives only in memory and writes no file, for one corpus case or one replayed session. */
export const memoryBook = (): VerdictBook => bookWith({ verdicts: [], keepSystem: () => Effect.void });

/**
 * The book for one session: every `phi-verdicts` entry in the session file, then the system cache. `pid` names this
 * process's cache file, so no two processes share a write target.
 */
export const bookOf = Effect.fn("bookOf")(function* ({
	sessionManager,
	pid,
}: {
	readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getEntries">;
	readonly pid: number;
}) {
	const fs = yield* FileSystem.FileSystem;
	const folder = yield* systemFolder;
	const system = yield* systemVerdicts(fs, folder);

	return bookWith({
		verdicts: [...sessionVerdicts(sessionManager.getEntries()), ...system],
		keepSystem: (lines) => Effect.provideService(appendLines({ folder, pid, lines }), FileSystem.FileSystem, fs),
	});
});
