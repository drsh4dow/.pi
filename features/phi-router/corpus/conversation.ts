import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import type { Entry, Message } from "./manifest.ts";
import type { Random } from "./random.ts";

export interface Scene {
	readonly asks: Arr.NonEmptyReadonlyArray<string>;
	readonly commands: Arr.NonEmptyReadonlyArray<string>;
	readonly paths: Arr.NonEmptyReadonlyArray<string>;
}

export interface Sample {
	readonly scene: Scene;
	readonly payload: string;
	/** Partial identifiers the payload plants on purpose. */
	readonly fragments?: ReadonlyArray<string>;
}

export interface Image {
	readonly mimeType: string;
	readonly data: string;
}

interface Delivery {
	readonly entry: typeof Entry.Type;
	readonly scene: Scene;
	readonly parts: readonly [string] | readonly [string, string];
	readonly image: Option.Option<Image>;
	/** Values an `ent-reply` quotes back, by the payload lines that hold them. */
	readonly quotes: ReadonlyArray<string>;
	readonly rng: Random;
}

type Role = Message["role"];

type Messages = Arr.NonEmptyReadonlyArray<Message>;

const text = (role: Role, body: string): Message => ({ role, text: body });

const imageAfter = (delivery: Delivery, role: Role): ReadonlyArray<Message> =>
	Option.match(delivery.image, { onNone: () => [], onSome: (image) => [{ role, image }] });

const systemPrompt = (rng: Random): ReadonlyArray<Message> =>
	rng.chance(0.4)
		? [
				text(
					"system",
					"You are a coding agent working in the user's repository. Use the read, bash, edit and write tools.",
				),
			]
		: [];

const steers: Arr.NonEmptyReadonlyArray<string> = [
	"Wait, before you rerun it, look at this:",
	"Also, support just sent me this:",
	"Hold on, here's what I'm actually looking at:",
	"One more thing. This is what we got last night:",
];

const busyWork: Arr.NonEmptyReadonlyArray<readonly [string, string]> = [
	[
		"Let me run the failing test first.",
		"FAIL test/mapper.test.ts > maps an inbound record\n  expected 1 row, received 0\n\nTests: 1 failed, 41 passed",
	],
	["Building to check the types.", "$ npm run build\n> tsc -p .\n\nFound 0 errors. Watching for file changes."],
	[
		"Searching for where records get rejected.",
		"src/mapper.ts:142:      throw new RecordRejected(row)\nsrc/worker.ts:57:  const rows = batch.map(mapRow)",
	],
];

const fenced = (payload: string) => `\`\`\`\n${payload}\n\`\`\``;

const viaUser = (delivery: Delivery): Messages => {
	const ask = delivery.rng.pick(delivery.scene.asks);
	const [first, second] = delivery.parts;

	if (second === undefined) {
		return [text("user", `${ask}\n\n${fenced(first)}`), ...imageAfter(delivery, "user")];
	}

	return [text("user", `${ask}\n\n${first}`), ...imageAfter(delivery, "user"), text("user", second)];
};

const viaTool =
	(opener: (delivery: Delivery) => Messages, resume: string) =>
	(delivery: Delivery): Messages => {
		const [first, second] = delivery.parts;
		const rest = second === undefined ? [] : [text("assistant", resume), text("tool", second)];

		return [...opener(delivery), text("tool", first), ...imageAfter(delivery, "tool"), ...rest];
	};

const toolResult = viaTool((delivery): Messages => {
	const command = delivery.rng.pick(delivery.scene.commands);

	return [
		text("user", delivery.rng.pick(delivery.scene.asks)),
		text("assistant", `I'll run \`${command}\` to see it.`),
	];
}, "The output was cut off. Fetching the rest.");

const fileRead = viaTool((delivery): Messages => {
	const path = delivery.rng.pick(delivery.scene.paths);

	return [
		text("user", `${delivery.rng.pick(delivery.scene.asks)} It's in ${path}.`),
		text("assistant", `Reading ${path}.`),
	];
}, "The read stopped at the line limit. Reading the rest with an offset.");

const steering = (delivery: Delivery): Messages => {
	const { rng } = delivery;
	const [doing, output] = rng.pick(busyWork);
	const [first, second] = delivery.parts;
	const rest = second === undefined ? [] : [text("assistant", "Got it, looking at that now."), text("user", second)];

	return [
		text("user", rng.pick(delivery.scene.asks)),
		text("assistant", doing),
		text("tool", output),
		text("user", `${rng.pick(steers)}\n\n${first}`),
		...imageAfter(delivery, "user"),
		...rest,
	];
};

const finished: Arr.NonEmptyReadonlyArray<string> = [
	"Reproduced the failure locally.",
	"Wrote a failing test that loads the captured input.",
	"Ruled out the deploy config; staging has the same settings.",
	"Bisected to the commit that changed the mapper.",
];

const underway: Arr.NonEmptyReadonlyArray<string> = [
	"Tracing the failing input through the parser.",
	"Comparing the captured input with the schema the importer expects.",
	"Narrowing down which field trips the validation.",
];

const compactionPrefix = "The conversation history before this point was compacted into the following summary:";

const compactionSummary = (delivery: Delivery): Messages => {
	const { rng } = delivery;
	const [first, second] = delivery.parts;

	const summary = Arr.join(
		[
			compactionPrefix,
			"",
			"<summary>",
			"## Goal",
			rng.pick(delivery.scene.asks),
			"",
			"## Progress",
			"### Done",
			`- ${rng.pick(finished)}`,
			"### In Progress",
			`- ${rng.pick(underway)}`,
			"",
			"## Critical Context",
			"- The input in question:",
			first,
			"</summary>",
		],
		"\n",
	);

	const rest =
		second === undefined
			? []
			: [
					text("assistant", `Re-running \`${rng.pick(delivery.scene.commands)}\` for the rest.`),
					text("tool", second),
				];

	return [text("user", summary), ...imageAfter(delivery, "user"), ...rest];
};

const followUps: Arr.NonEmptyReadonlyArray<string> = [
	"Thanks. Fix the mapper so it handles that.",
	"Makes sense. Write a failing test for that case first.",
	"Ok, go ahead with the fix and rerun the import.",
];

const quoted = ({ parts, quotes }: Delivery) => {
	const lines = Str.split("\n")(Arr.join(parts, ""));
	const holding = Arr.filter(lines, (line) => Arr.some(quotes, (quote) => Str.includes(quote)(line)));

	return Arr.join(holding.length > 0 ? holding : Arr.take(lines, 6), "\n");
};

/** The payload arrives in a file read, and the reply `ent` writes about it quotes the lines that matter. */
const entReply = (delivery: Delivery): Messages => [
	...fileRead(delivery),
	text(
		"assistant",
		`The record that fails is this one:\n\n${fenced(quoted(delivery))}\n\nIts fields don't match what the mapper expects.`,
	),
	text("user", delivery.rng.pick(followUps)),
];

const frames = {
	user: viaUser,
	"tool-result": toolResult,
	"file-read": fileRead,
	steering,
	"compaction-summary": compactionSummary,
	"ent-reply": entReply,
} satisfies Record<typeof Entry.Type, (delivery: Delivery) => Messages>;

export const converse = (delivery: Delivery): Messages =>
	Arr.appendAll(systemPrompt(delivery.rng), frames[delivery.entry](delivery));
