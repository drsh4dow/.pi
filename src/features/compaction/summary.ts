import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { FileOperations, SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import type { Guides } from "./guides.ts";

/** The file lists live here because pi drops a hook entry's file lists. */
export const Details = Schema.Struct({
	narrative: Schema.String,
	readFiles: Schema.Array(Schema.String),
	modifiedFiles: Schema.Array(Schema.String),
});

export type Details = typeof Details.Type;

type Files = Omit<Details, "narrative">;

export type Anchor = Data.TaggedEnum<{
	State: { readonly path: string; readonly text: string };
	Task: { readonly text: string };
}>;

export const Anchor = Data.taggedEnum<Anchor>();

export type Narrative = Data.TaggedEnum<{
	Written: { readonly text: string };
	Carried: { readonly prior: Option.Option<string>; readonly reason: string };
}>;

export const Narrative = Data.taggedEnum<Narrative>();

export interface Parts {
	readonly narrative: Narrative;
	readonly anchor: Option.Option<Anchor>;
	readonly guides: Guides;
	readonly files: Files;
}

export const narrativeCap = 12_000;

export const carriedNote = "The harness could not write a new narrative at this compaction";

const narrativeBlock = Narrative.$match({
	Written: ({ text }) => text,
	Carried: ({ prior, reason }) =>
		Option.match(prior, {
			onNone: () => `${carriedNote}, because ${reason}.`,
			onSome: (text) =>
				`${carriedNote}, because ${reason}. This is the narrative from the compaction before.\n${text}`,
		}),
});

const anchorBlock = (anchor: Option.Option<Anchor>) =>
	Option.match(anchor, {
		onNone: () => "",
		onSome: Anchor.$match({
			State: ({ path, text }) => `<state-file path="${path}">\n${text}\n</state-file>`,
			Task: ({ text }) => `<task>\n${text}\n</task>`,
		}),
	});

const listBlock = (tag: string, paths: ReadonlyArray<string>) =>
	Arr.isReadonlyArrayNonEmpty(paths) ? `<${tag}>\n${Arr.join(paths, "\n")}\n</${tag}>` : "";

export const restoredNote =
	"These guides were in your context before this compaction. Each is its file as it reads now. Follow them as before.";

export const rereadNote =
	"These guides were in your context before this compaction and did not fit in this summary. Read each again before you rely on it.";

const restoredBlock = ({ restored }: Guides) =>
	Arr.isReadonlyArrayNonEmpty(restored)
		? Arr.join(
				[
					"<restored-guides>",
					restoredNote,
					...Arr.map(restored, ({ path, text }) => `<guide path="${path}">\n${Str.trimEnd(text)}\n</guide>`),
					"</restored-guides>",
				],
				"\n",
			)
		: "";

const rereadBlock = ({ listed }: Guides) =>
	Arr.isReadonlyArrayNonEmpty(listed) ? listBlock("guides-to-reread", [rereadNote, ...listed]) : "";

export const summaryOf = ({ narrative, anchor, guides, files }: Parts) =>
	Arr.join(
		Arr.filter(
			[
				narrativeBlock(narrative),
				anchorBlock(anchor),
				restoredBlock(guides),
				rereadBlock(guides),
				listBlock("read-files", files.readFiles),
				listBlock("modified-files", files.modifiedFiles),
			],
			Str.isNonEmpty,
		),
		"\n\n",
	);

export const detailsOf = ({ narrative, files }: Parts): Details => ({
	narrative: Narrative.$match(narrative, {
		Written: ({ text }) => text,
		Carried: ({ prior }) => Option.getOrElse(prior, () => ""),
	}),
	...files,
});

const HarnessCompaction = Schema.Struct({ type: Schema.Literal("compaction"), details: Details });

const decodeHarnessCompaction = Schema.decodeUnknownOption(HarnessCompaction);

export interface Prior {
	readonly narrative: Option.Option<string>;
	readonly files: Files;
}

/** Without a compaction this handler wrote, `fileOps` already holds the file lists of the one pi wrote. */
export const priorOf = ({
	branch,
	previousSummary,
}: {
	readonly branch: ReadonlyArray<SessionEntry>;
	readonly previousSummary: string | undefined;
}): Prior => {
	const ours = Arr.getSomes(Arr.map(branch, (entry) => decodeHarnessCompaction(entry)));

	return Option.match(Arr.last(ours), {
		onNone: () => ({
			narrative: Option.map(Option.fromNullishOr(previousSummary), Str.slice(0, narrativeCap)),
			files: { readFiles: [], modifiedFiles: [] },
		}),
		onSome: ({ details: { narrative, ...files } }) => ({
			narrative: Option.liftPredicate(narrative, Str.isNonEmpty),
			files,
		}),
	});
};

export const filesOf = ({ prior, fileOps }: { readonly prior: Files; readonly fileOps: FileOperations }): Files => {
	const modified = new Set([...prior.modifiedFiles, ...fileOps.edited, ...fileOps.written]);
	const read = new Set([...prior.readFiles, ...fileOps.read]);

	return {
		readFiles: Arr.sort(
			Arr.filter([...read], (path) => !modified.has(path)),
			Order.String,
		),
		modifiedFiles: Arr.sort(modified, Order.String),
	};
};

export const taskOf = (branch: ReadonlyArray<SessionEntry>): Option.Option<Anchor> => {
	const content = Arr.findFirst(branch, (entry) =>
		entry.type === "message" && entry.message.role === "user" ? Option.some(entry.message.content) : Option.none(),
	);

	return Option.map(content, (found) =>
		Anchor.Task({
			text: Predicate.isString(found)
				? found
				: Arr.join(
						Arr.flatMap(found, (block) => (block.type === "text" ? [block.text] : [])),
						"\n",
					),
		}),
	);
};

export const systemPrompt =
	"You write the narrative part of a coding agent's compaction summary. Do not continue the conversation and do not answer questions in it. Output only the narrative.";

const historyLine = (anchor: Option.Option<Anchor>) =>
	Option.match(anchor, {
		onNone: () => "Drop finished history, since the session file keeps it.",
		onSome: Anchor.$match({
			State: () =>
				"Drop finished history, since the session file and the decision trail, decisions.tsv beside STATE.md, keep it. Do not restate STATE.md, which the summary carries whole after the narrative.",
			Task: () =>
				"Drop finished history, since the session file keeps it. Do not restate the task message, which the summary carries whole after the narrative.",
		}),
	});

export const promptOf = ({
	prior,
	conversation,
	anchor,
	customInstructions,
	overrun,
}: {
	readonly prior: Option.Option<string>;
	readonly conversation: string;
	readonly anchor: Option.Option<Anchor>;
	readonly customInstructions: Option.Option<string>;
	readonly overrun: Option.Option<number>;
}) =>
	Arr.join(
		[
			...Option.toArray(Option.map(prior, (text) => `<previous-narrative>\n${text}\n</previous-narrative>`)),
			`<conversation>\n${conversation}\n</conversation>`,
			Arr.join(
				[
					"Write the narrative of the work so far, for the agent that continues it after this compaction. It replaces the previous narrative, if there is one, and the conversation above.",
					"Keep the goal, the constraints still in force, the open work, the next steps, and the context they need, such as exact file paths, names and error messages.",
					"Say where the work stands now. Do not list the steps already done or what their tool calls returned, unless the open work still needs that result.",
					historyLine(anchor),
					Option.match(overrun, {
						onNone: () => "Write at most 1,500 words.",
						onSome: (chars) =>
							`Your last reply ran ${String(chars)} characters and must stay under ${String(narrativeCap)}. Write at most 750 words.`,
					}),
				],
				"\n",
			),
			...Option.toArray(Option.map(customInstructions, (focus) => `Additional focus: ${focus}`)),
		],
		"\n\n",
	);

export type Reply = Data.TaggedEnum<{
	Fits: { readonly text: string };
	Over: { readonly chars: number };
	Failed: { readonly reason: string };
}>;

export const Reply = Data.taggedEnum<Reply>();

export const replyOf = (message: AssistantMessage): Reply => {
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		return Reply.Failed({
			reason: `the model call ended with ${message.stopReason}: ${message.errorMessage ?? "no message"}`,
		});
	}

	if (Arr.some(message.content, (block) => block.type === "toolCall")) {
		return Reply.Failed({ reason: "the reply called a tool" });
	}

	const text = Str.trim(
		Arr.join(
			Arr.flatMap(message.content, (block) => (block.type === "text" ? [block.text] : [])),
			"\n",
		),
	);

	if (message.stopReason === "length" || text.length > narrativeCap) {
		return Reply.Over({ chars: text.length });
	}

	return Str.isEmpty(text) ? Reply.Failed({ reason: "the reply held no text" }) : Reply.Fits({ text });
};

export const narrativeFrom = ({ reply, prior }: { readonly reply: Reply; readonly prior: Option.Option<string> }) =>
	Reply.$match(reply, {
		Fits: ({ text }) => Narrative.Written({ text }),
		Over: ({ chars }) =>
			Narrative.Carried({
				prior,
				reason: `the reply ran over the cap twice, the second time ${String(chars)} characters`,
			}),
		Failed: ({ reason }) => Narrative.Carried({ prior, reason }),
	});

const noUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const totalUsage = (usages: ReadonlyArray<Usage>): Usage =>
	Arr.reduce(usages, noUsage, (sum, usage) => ({
		input: sum.input + usage.input,
		output: sum.output + usage.output,
		cacheRead: sum.cacheRead + usage.cacheRead,
		cacheWrite: sum.cacheWrite + usage.cacheWrite,
		totalTokens: sum.totalTokens + usage.totalTokens,
		cost: {
			input: sum.cost.input + usage.cost.input,
			output: sum.cost.output + usage.cost.output,
			cacheRead: sum.cost.cacheRead + usage.cost.cacheRead,
			cacheWrite: sum.cost.cacheWrite + usage.cost.cacheWrite,
			total: sum.cost.total + usage.cost.total,
		},
	}));
