import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { narrativeCap } from "#src/features/compaction/index.ts";
import { Reply } from "#src/features/phi-router/anthropic.fixture.ts";
import { tokensOf } from "./canary-tokens.ts";
import type { Case, Message, PhiStrata } from "./manifest.ts";
import { planOf, Step } from "./wire.ts";

const mrn = "MRN 4417-2290";

const record = `{"patient":"Synthetic Person","mrn":"${mrn}","diagnosis":"E11.9"}`;

const pixel = { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ" };

const phiCase = (entry: PhiStrata["entry"], messages: readonly [Message, ...Array<Message>]): Case => ({
	id: "t-1",
	expect: "phi",
	strata: { identifier: "mrn", carrier: "fhir-json", transform: "plain", entry },
	canaries: [mrn],
	fragments: [],
	messages,
});

test("a steering message is sent while the slow tool call of its turn runs, with its image", () => {
	const plan = planOf(
		phiCase("steering", [
			{ role: "system", text: "You are a coding agent." },
			{ role: "user", text: "Run the test." },
			{ role: "assistant", text: "Running it." },
			{ role: "tool", text: "FAIL mapper" },
			{ role: "user", text: `Also this: ${record}` },
			{ role: "user", image: pixel },
			{ role: "assistant", text: "Looking." },
			{ role: "user", text: "Thanks." },
		]),
	);

	expect(plan).toEqual({
		agents: Option.some("You are a coding agent."),
		files: [{ path: "files/2.txt", bytes: new TextEncoder().encode("FAIL mapper") }],
		replies: [
			Reply.ToolUse({
				before: Option.some("Running it."),
				name: "bash",
				input: { command: "sleep 3; cat files/2.txt" },
			}),
			Reply.Text({ text: "Looking." }),
		],
		steps: [
			Step.Turn({
				prompt: "Run the test.",
				steer: Option.some({ text: `Also this: ${record}`, images: [{ type: "image", ...pixel }] }),
			}),
			Step.Turn({ prompt: "Thanks.", steer: Option.none() }),
		],
	});
});

const opening = Step.Turn({ prompt: "Go on with the task.", steer: Option.none() });

const pinned = [
	Step.Turn({ prompt: "/phi pin", steer: Option.none() }),
	opening,
	Step.Turn({ prompt: "/phi unpin", steer: Option.none() }),
];

test("a case that opens with a tool result starts with a neutral prompt that the mock answers with the tool call", () => {
	const plan = planOf(phiCase("tool-result", [{ role: "tool", text: record }]));

	expect(plan.steps).toEqual([opening]);
	expect(plan.replies).toEqual([
		Reply.ToolUse({ before: Option.none(), name: "bash", input: { command: "cat files/0.txt" } }),
	]);
});

test("a case that opens with a reply gets it from ent in a pinned stretch, then plays on unpinned", () => {
	const plan = planOf(
		phiCase("ent-reply", [
			{ role: "assistant", text: record },
			{ role: "tool", text: "FAIL mapper" },
			{ role: "user", text: "Fix it." },
		]),
	);

	expect(plan.steps).toEqual([...pinned, opening, Step.Turn({ prompt: "Fix it.", steer: Option.none() })]);
	expect(plan.replies).toEqual([
		Reply.Text({ text: record }),
		Reply.ToolUse({ before: Option.none(), name: "read", input: { path: "files/0.txt" } }),
	]);
});

test("a compaction summary comes back from the mock after two filler turns, and a new turn carries it", () => {
	const summary = `## Goal\nFix the parser.\n${record}`;
	const wrapped = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n\n</summary>`;

	const { steps } = planOf(phiCase("compaction-summary", [{ role: "user", text: wrapped }]));

	expect(Arr.map(steps, ({ _tag }) => _tag)).toEqual(["Turn", "Turn", "Compact", "Turn"]);
	expect(steps[2]).toEqual(Step.Compact({ summary }));
});

test("a summary written without pi's line breaks is still a compaction", () => {
	const opened = "The conversation history before this point was compacted into the following summary:<summary>";

	const subject = phiCase("compaction-summary", [
		{ role: "user", text: `${opened}Import of the chart: MRN 4417-</summary>` },
		{ role: "user", text: "2290\nreschedule the visit" },
	]);

	expect(planOf(subject).steps[2]).toEqual(Step.Compact({ summary: "Import of the chart: MRN 4417-" }));
});

test("a summary loses the space it ends with, as compaction trims it", () => {
	const opened = "The conversation history before this point was compacted into the following summary:\n<summary>\n";

	const subject = phiCase("compaction-summary", [
		{ role: "user", text: `${opened}Import of the chart: MRN \n</summary>` },
		{ role: "user", text: "4417-2290\nreschedule the visit" },
	]);

	expect(planOf(subject).steps[2]).toEqual(Step.Compact({ summary: "Import of the chart: MRN" }));
});

test("a summary longer than compaction keeps is played as a pasted turn, so its canary still reaches a request", () => {
	const text = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${Str.repeat(narrativeCap)("x")}\n${record}\n</summary>`;
	const subject = phiCase("compaction-summary", [{ role: "user", text }]);

	expect(Arr.map(planOf(subject).steps, ({ _tag }) => _tag)).toEqual(["Turn"]);

	return Effect.runPromise(
		Effect.gen(function* () {
			const { complete } = yield* tokensOf(subject);

			expect(complete).toEqual([mrn]);
		}),
	);
});

test("a tool text over pi's 50 KB output limit is read a page at a time, every line once and none cut", () => {
	const line = Str.repeat(50)("x");
	const text = Arr.join(Arr.replicate(line, 2000), "\n");

	const plan = planOf(
		phiCase("file-read", [
			{ role: "user", text: "Read the log." },
			{ role: "assistant", text: "Reading it." },
			{ role: "tool", text },
		]),
	);

	const ranges = Arr.flatMap(plan.replies, (reply) =>
		Reply.$is("ToolUse")(reply) && reply.input["path"] === "files/2.txt"
			? [{ offset: Number(reply.input["offset"]), limit: Number(reply.input["limit"]) }]
			: [],
	);

	const covered = Arr.flatMap(ranges, ({ offset, limit }) => Arr.range(offset, offset + limit - 1));

	expect(ranges.length).toBe(plan.replies.length);
	expect(ranges.length).toBeGreaterThan(1);
	expect(covered).toEqual(Arr.range(1, 2000));
	expect(Arr.every(ranges, ({ limit }) => limit * (line.length + 1) <= 50 * 1024)).toBe(true);
});
