import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import type { Case, Transcript } from "./manifest.ts";
import { requestsOf } from "./requests.ts";

const texts = (request: Transcript) =>
	Arr.map(request, ({ role, parts }) => [role, ...Arr.map(parts, (part) => (part.kind === "text" ? part.text : ""))]);

const wrapped = (summary: string) =>
	`The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`;

test("a tool result shares its request with the assistant turn that called it, rendered as pi sends them", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const subject: Case = {
				id: "fetch",
				expect: "phi",
				strata: {
					identifier: "driver-license",
					carrier: "clinical-note",
					transform: "split",
					entry: "tool-result",
				},
				canaries: ["canary-fetch"],
				fragments: [],
				messages: [
					{ role: "user", text: "Why is this note rejected?" },
					{ role: "assistant", text: "Fetching it." },
					{ role: "tool", text: "Line one" },
					{ role: "assistant", text: "Cut off. Fetching the rest." },
					{ role: "tool", text: "Line two" },
				],
			};

			const requests = yield* requestsOf(subject);

			expect(Arr.map(requests, texts)).toEqual([
				[["user", "Why is this note rejected?"]],
				[
					["user", "Why is this note rejected?"],
					["assistant", "Fetching it.", 'bash toolu_mock_1 {"command":"cat files/2.txt"}'],
					["tool", "toolu_mock_1", "Line one"],
				],
				[
					["user", "Why is this note rejected?"],
					["assistant", "Fetching it.", 'bash toolu_mock_1 {"command":"cat files/2.txt"}'],
					["tool", "toolu_mock_1", "Line one"],
					["assistant", "Cut off. Fetching the rest.", 'bash toolu_mock_2 {"command":"cat files/4.txt"}'],
					["tool", "toolu_mock_2", "Line two"],
				],
			]);
		}),
	));

test("a second compaction's summary replaces the first and lists the files read before it", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const subject: Case = {
				id: "twice",
				expect: "clean",
				strata: { negative: "schema-only" },
				canaries: [],
				fragments: [],
				messages: [
					{ role: "user", text: "Why does the importer skip rows?" },
					{ role: "assistant", text: "Reading it." },
					{ role: "tool", text: "src/import.ts:12: if (!row.id) continue" },
					{ role: "user", text: wrapped("First summary.") },
					{ role: "user", text: wrapped("Second summary.") },
					{ role: "user", text: "Keep going." },
				],
			};

			const requests = yield* requestsOf(subject);
			const last = texts(Option.getOrElse(Arr.last(requests), Arr.empty));

			expect(last[0]).toEqual(["user", wrapped("Second summary.\n\n<read-files>\nfiles/2.txt\n</read-files>")]);
			expect(Arr.some(last, (turn) => Arr.some(turn, Str.includes("First summary")))).toBe(false);
			expect(Arr.last(last)).toEqual(Option.some(["user", "Keep going."]));
		}),
	));
