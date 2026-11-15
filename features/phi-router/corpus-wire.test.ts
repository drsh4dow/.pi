import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/encoding";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { narrativeCap } from "../compaction/index.ts";
import { Reply } from "./anthropic.fixture.ts";
import { foundIn, type Tokens, tokensOf } from "./canary-tokens.ts";
import { planOf, Step } from "./corpus-wire.ts";
import { gzip } from "./corpus/encodings.ts";
import type { Case, Message, PhiStrata } from "./corpus/manifest.ts";

const mrn = "MRN 4417-2290";

const record = `{"patient":"Synthetic Person","mrn":"${mrn}","diagnosis":"E11.9"}`;

const pixel = { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ" };

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const phiCase = (entry: PhiStrata["entry"], messages: readonly [Message, ...Array<Message>]): Case => ({
	id: "t-1",
	expect: "phi",
	strata: { identifier: "mrn", carrier: "fhir-json", transform: "plain", entry },
	canaries: [mrn],
	messages,
});

const tokensAre = (subject: Case, expected: Tokens) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const found = yield* tokensOf(subject);

			expect(found).toEqual({ tokens: [...expected.tokens], untracked: [...expected.untracked] });
		}),
	);

test("a canary carried whole is its own token, and an image is its data", () =>
	tokensAre(
		phiCase("user", [
			{ role: "user", text: `The row is ${record}` },
			{ role: "user", image: pixel },
		]),
		{ tokens: [mrn, pixel.data], untracked: [] },
	));

test("a canary carried in base64 is the encoded run as pi sends it", () => {
	const encoded = Encoding.Base64.encode(record);

	return tokensAre(phiCase("tool-result", [{ role: "tool", text: `payload: ${encoded}\n(1 row)` }]), {
		tokens: [encoded],
		untracked: [],
	});
});

test("a canary carried in gzip hex is the hex run, found by inflating it", () => {
	const hex = Encoding.Hex.encode(gzip(record));

	return tokensAre(phiCase("tool-result", [{ role: "tool", text: ` 29637 | gzip | \\x${hex}\n(1 row)` }]), {
		tokens: [hex],
		untracked: [],
	});
});

test("a canary split across two messages is the end of the first and the start of the second, with context", () => {
	const before = Str.repeat(60)("a");
	const after = Str.repeat(60)("b");

	return tokensAre(
		phiCase("user", [
			{ role: "user", text: `${before}MRN 4417-` },
			{ role: "user", text: `2290${after}` },
		]),
		{ tokens: [`${Str.repeat(40)("a")}MRN 4417-`, `2290${Str.repeat(40)("b")}`], untracked: [] },
	);
});

test("a canary split across two messages may end a line of the first and start a line of the second", () =>
	tokensAre(
		phiCase("file-read", [
			{ role: "tool", text: "read_file export.txt\npatient | mrn | MRN 4417-\n(truncated)" },
			{ role: "tool", text: "read_file export.txt\n2290\ndiabetes follow-up" },
		]),
		{ tokens: ["read_file export.txt\npatient | mrn | MRN 4417-", "2290\ndiabetes follow-up"], untracked: [] },
	));

test("a canary no message carries is untracked, so the run cannot pass it", () =>
	tokensAre(phiCase("user", [{ role: "user", text: "Nothing to see." }]), { tokens: [], untracked: [mrn] }));

test("a token with a line break is found in a JSON body, where it is escaped", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const token = "line one\nline two";
			const body = yield* encodeJson({ messages: [{ content: `x ${token} y` }] });

			expect(foundIn({ bodies: [body], tokens: [token, "line three"] })).toEqual([token]);
		}),
	));

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

test("a compaction summary comes back from the mock after two filler turns, and a new turn carries it", () => {
	const summary = `## Goal\nFix the parser.\n${record}`;
	const wrapped = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n\n</summary>`;

	const { steps } = planOf(phiCase("compaction-summary", [{ role: "user", text: wrapped }]));

	expect(Arr.map(steps, ({ _tag }) => _tag)).toEqual(["Turn", "Turn", "Compact", "Turn"]);
	expect(steps[2]).toEqual(Step.Compact({ summary }));
});

test("a summary written without pi's line breaks is still a compaction, and a canary split out of it is tracked", () => {
	const opened = "The conversation history before this point was compacted into the following summary:<summary>";

	const subject = phiCase("compaction-summary", [
		{ role: "user", text: `${opened}Import of the chart: MRN 4417-</summary>` },
		{ role: "user", text: "2290\nreschedule the visit" },
	]);

	expect(planOf(subject).steps[2]).toEqual(Step.Compact({ summary: "Import of the chart: MRN 4417-" }));

	return tokensAre(subject, {
		tokens: ["Import of the chart: MRN 4417-", "2290\nreschedule the visit"],
		untracked: [],
	});
});

test("a summary loses the space it ends with, as compaction trims it, and a canary split there is still tracked", () => {
	const opened = "The conversation history before this point was compacted into the following summary:\n<summary>\n";

	const subject = phiCase("compaction-summary", [
		{ role: "user", text: `${opened}Import of the chart: MRN \n</summary>` },
		{ role: "user", text: "4417-2290\nreschedule the visit" },
	]);

	expect(planOf(subject).steps[2]).toEqual(Step.Compact({ summary: "Import of the chart: MRN" }));

	return tokensAre(subject, {
		tokens: ["Import of the chart: MRN", "4417-2290\nreschedule the visit"],
		untracked: [],
	});
});

test("a summary longer than compaction keeps is played as a pasted turn, so its canary still reaches a request", () => {
	const text = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${Str.repeat(narrativeCap)("x")}\n${record}\n</summary>`;
	const subject = phiCase("compaction-summary", [{ role: "user", text }]);

	expect(Arr.map(planOf(subject).steps, ({ _tag }) => _tag)).toEqual(["Turn"]);

	return tokensAre(subject, { tokens: [mrn], untracked: [] });
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
