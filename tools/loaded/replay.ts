/**
 * `bun tools/loaded/replay.ts [since]` replays saved sessions and checks `inContext` against a second, independent
 * reading: the guide files each tool call or `/skill:` expansion named by path. Sessions older than the guides' last
 * edit hold older text that no longer matches, so pass that edit's date as `since`.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import { type ProjectedSessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { type GuideFile, guideFilesIn, inContext, type Index, loadGuides } from "../../features/loaded/index.ts";

const root = Str.replace(/\/tools\/loaded$/u, "")(import.meta.dirname);
const since = Date.parse(process.argv[2] ?? "1970-01-01");

const skillFilesIn = Effect.fn("skillFilesIn")(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem;
	const names = yield* fs.readDirectory(dir);

	return Arr.map(names, (name): GuideFile => ({ kind: "skill", name, path: `${dir}/${name}/SKILL.md` }));
});

/** The arguments of a call that can name a file: a read's path or a shell command. */
const Naming = Schema.Struct({ path: Schema.optional(Schema.String), command: Schema.optional(Schema.String) });

const NestedCalls = Schema.Struct({ calls: Schema.Array(Schema.Struct({ arguments: Naming })) });

const decodeNaming = Schema.decodeUnknownOption(Naming);
const decodeNested = Schema.decodeUnknownOption(Schema.Struct({ nestedCalls: NestedCalls }));

const namingText = ({ path, command }: typeof Naming.Type) =>
	Arr.getSomes([Option.fromUndefinedOr(path), Option.fromUndefinedOr(command)]);

const callTexts = (message: AgentMessage) =>
	message.role === "assistant"
		? Arr.flatMap(message.content, (block) => {
				const naming = decodeNaming(block.type === "toolCall" ? block.arguments : undefined);

				return block.type === "toolCall"
					? [[block.id, Option.match(naming, { onNone: () => [], onSome: namingText })] as const]
					: [];
			})
		: [];

const skillLocation = /<skill name="[^"]+" location="(?<location>[^"]+)">/gu;

/** What a successful tool result's call and the calls it nested name, or the files a `/skill:` expansion holds. */
const namedBy = (message: AgentMessage, calls: ReadonlyMap<string, ReadonlyArray<string>>) => {
	if (message.role === "toolResult" && !message.isError) {
		const nested = Option.match(decodeNested(message), {
			onNone: () => [],
			onSome: ({ nestedCalls }) => Arr.flatMap(nestedCalls.calls, (call) => namingText(call.arguments)),
		});

		return [...(calls.get(message.toolCallId) ?? []), ...nested];
	}

	if (message.role === "user") {
		const text = contentText(message.content, "\n");

		return Arr.map([...Str.matchAll(skillLocation)(text)], (match) => match.groups?.["location"] ?? "");
	}

	return [];
};

/** The guide files whose absolute or `~` path a projected call names. */
const byPath = (entries: ReadonlyArray<ProjectedSessionEntry>, files: ReadonlyArray<GuideFile>, home: string) => {
	const messages = Arr.flatMap(entries, (entry) => entry.messages);
	const calls = new Map(Arr.flatMap(messages, callTexts));
	const texts = Arr.flatMap(messages, (message) => namedBy(message, calls));

	const names = (path: string) =>
		Arr.some(texts, (text) => Str.includes(path)(text) || Str.includes(Str.replace(home, "~")(path))(text));

	return new Set(
		Arr.map(
			Arr.filter(files, ({ path }) => names(path)),
			({ path }) => path,
		),
	);
};

const sessionFiles = Effect.fn("sessionFiles")(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem;
	const listed = yield* fs.readDirectory(dir, { recursive: true });

	const recent = yield* Effect.forEach(Arr.filter(listed, Str.endsWith(".jsonl")), (name) =>
		Effect.map(fs.stat(`${dir}/${name}`), (info) =>
			Option.exists(info.mtime, (mtime) => mtime.getTime() >= since) ? [`${dir}/${name}`] : [],
		),
	);

	return Arr.flatten(recent);
});

interface Replay {
	readonly index: Index;
	readonly files: ReadonlyArray<GuideFile>;
	readonly home: string;
}

const readingOf = (inText: boolean, inPath: boolean) => {
	if (inText && inPath) {
		return "both";
	}

	return inText ? "text only" : "path only";
};

/** Each guide either reading found in one session, and which readings found it. */
const compare =
	({ index, files, home }: Replay) =>
	(file: string) => {
		const { entries } = SessionManager.open(file).buildSessionProjection();
		const loaded = inContext({ index, entries });
		const text = new Set(Arr.map(loaded, ({ path }) => path));
		const path = byPath(entries, files, home);

		return Arr.map([...new Set([...text, ...path])], (guide) => ({
			where: `${Str.slice(-50)(file)} ${Str.slice(root.length)(guide)}`,
			reading: readingOf(text.has(guide), path.has(guide)),
			partial: Arr.some(loaded, (found) => found.path === guide && found.state === "partial"),
		}));
	};

const program = Effect.gen(function* () {
	const home = yield* Config.String("HOME");
	const skills = yield* Effect.forEach([`${root}/agent/skills`, `${root}/features/web`], skillFilesIn);
	const principles = yield* guideFilesIn("principle", `${root}/agent/principles`);
	const playbooks = yield* guideFilesIn("playbook", `${root}/agent/playbooks`);
	const files = [...Arr.flatten(skills), ...principles, ...playbooks];
	const index = yield* loadGuides(files);
	const sessions = yield* sessionFiles(`${root}/agent/sessions`);
	const found = Arr.flatMap(sessions, compare({ index, files, home }));

	const where = (reading: string) =>
		Arr.map(
			Arr.filter(found, (guide) => guide.reading === reading),
			(guide) => guide.where,
		);

	yield* Console.log({
		sessions: sessions.length,
		both: Arr.length(where("both")),
		partial: Arr.length(Arr.filter(found, (guide) => guide.partial)),
		textOnly: where("text only"),
		pathOnly: where("path only"),
	});
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
