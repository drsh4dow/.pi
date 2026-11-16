import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { JudgeFailed, Phi, ScanResult, type JudgeInput } from "./index.ts";
import { assistant, clearedCursor, scanWith, system, user } from "./judge.fixture.ts";

const run = (body: Effect.Effect<void>) => Effect.runPromise(body);

const harness = system("You are a coding agent. Use the read, bash, edit and write tools.");
const projectContext = system("# AGENTS.md\nRun bun run check before every commit.");
const question = user("Why does the build fail?");
const reply = assistant("The lockfile is stale.");

const taintingOn = (marker: string) => (input: JudgeInput) =>
	Effect.succeed({ pPhi: Str.includes(marker)(input.fresh) ? 0.9 : 0, category: Option.none() });

test("conversation calls never carry system text, on a first scan or a later one", () =>
	run(
		Effect.gen(function* () {
			const first = yield* scanWith({ transcript: [harness, question] });
			const cursor = yield* clearedCursor([harness, question]);
			const later = yield* scanWith({ transcript: [harness, question, reply], cursor });

			const conversation = Arr.filter(
				[...first.asked, ...later.asked],
				(input) => !Str.startsWith("[system]")(input.fresh),
			);

			expect(conversation).toEqual([
				{ seen: "", fresh: "[user] Why does the build fail?" },
				{ seen: "[user] Why does the build fail?", fresh: "[assistant] The lockfile is stale." },
			]);
		}),
	));

test("a changed system prompt gets its own call, with nothing as seen", () =>
	run(
		Effect.gen(function* () {
			const cursor = yield* clearedCursor([harness, question]);
			const { asked } = yield* scanWith({ transcript: [harness, projectContext, question], cursor });

			expect(asked).toEqual([
				{
					seen: "",
					fresh: `[system] You are a coding agent. Use the read, bash, edit and write tools.\n[system] # AGENTS.md\nRun bun run check before every commit.`,
				},
			]);
		}),
	));

test("an unchanged system prompt is not judged again on later scans", () =>
	run(
		Effect.gen(function* () {
			const cursor = yield* clearedCursor([harness, question]);
			const { asked } = yield* scanWith({ transcript: [harness, question, reply], cursor });

			expect(asked).toEqual([
				{ seen: "[user] Why does the build fail?", fresh: "[assistant] The lockfile is stale." },
			]);
		}),
	));

test("a tainting system call taints the request, though the conversation clears", () =>
	run(
		Effect.gen(function* () {
			const { result } = yield* scanWith({
				transcript: [system("TAINTED project context"), question],
				answer: taintingOn("TAINTED"),
			});

			expect(ScanResult.$is("Tainted")(result) && result.taint).toEqual(Phi.make({ detector: "judge" }));
		}),
	));

test("a failed system call is Unsure even when the conversation call clears", () =>
	run(
		Effect.gen(function* () {
			const { result } = yield* scanWith({
				transcript: [harness, question],
				answer: (input) =>
					Str.startsWith("[system]")(input.fresh)
						? Effect.fail(JudgeFailed.make({ why: "timeout" }))
						: Effect.succeed({ pPhi: 0, category: Option.none() }),
			});

			expect(ScanResult.$is("Unsure")(result) && result.why).toBe("judge-timeout");
		}),
	));

test("the size limit applies to each call on its own", () =>
	run(
		Effect.gen(function* () {
			const longPrompt = system(Str.repeat(60)("x"));
			const fits = yield* scanWith({ transcript: [longPrompt, question], maxChars: 80 });
			const tooLong = yield* scanWith({ transcript: [system(Str.repeat(90)("x")), question], maxChars: 80 });

			expect(ScanResult.$is("Clean")(fits.result)).toBe(true);
			expect(fits.asked).toHaveLength(2);
			expect(ScanResult.$is("Unsure")(tooLong.result) && tooLong.result.why).toBe("too-large");
		}),
	));
