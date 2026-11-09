import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";

/** The part of an Anthropic request payload the report reads: its system blocks. */
export const Payload = Schema.Struct({
	system: Schema.Array(Schema.Struct({ text: Schema.String })),
});

export type Payload = typeof Payload.Type;

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
	const blocks = Arr.map(capture.payload.system, (block) => block.text);

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
