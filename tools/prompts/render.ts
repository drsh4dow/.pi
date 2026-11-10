import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";

/** An Anthropic request carries the system prompt as blocks. */
const AnthropicPayload = Schema.Struct({
	system: Schema.Array(Schema.Struct({ text: Schema.String })),
});

const Instruction = Schema.Struct({
	role: Schema.Literals(["developer", "system"]),
	content: Schema.String,
});

/** An OpenAI Responses request carries the system prompt as developer or system messages among its other input items. */
const InputItem = Schema.Union([Instruction, Schema.Struct({})]);

const ResponsesPayload = Schema.Struct({ input: Schema.Array(InputItem) });

/** The part of a request payload the report reads: its system prompt. */
export const Payload = Schema.Union([AnthropicPayload, ResponsesPayload]);

export type Payload = typeof Payload.Type;

const isInstruction = Schema.is(Instruction);

const systemBlocks = (payload: Payload) =>
	"system" in payload
		? Arr.map(payload.system, (block) => block.text)
		: Arr.map(Arr.filter(payload.input, isInstruction), (item) => item.content);

export interface Capture {
	readonly title: string;
	/** One line on which pi this is. */
	readonly about: string;
	readonly payload: Payload;
}

export interface Report {
	readonly piVersion: string;
	readonly project: string;
	readonly captures: ReadonlyArray<Capture>;
}

const fence = (body: string) => `\`\`\`\`text\n${body}\n\`\`\`\``;

const section = (capture: Capture) => {
	const blocks = systemBlocks(capture.payload);

	return [`## ${capture.title}`, "", capture.about, "", fence(Arr.join(blocks, "\n\n")), ""];
};

export const render = (report: Report) => {
	const lines = [
		"# System prompts",
		"",
		`The full system prompt each agent receives, copied from the request pi ${report.piVersion} builds. Captured in \`${report.project}\`.`,
		"",
		...Arr.flatMap(report.captures, section),
	];

	return Arr.join(lines, "\n");
};
