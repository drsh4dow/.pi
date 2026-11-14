import { expect, test } from "bun:test";

import * as Effect from "effect/Effect";
import * as Str from "effect/String";

import { carriedNote, narrativeCap } from "./index.ts";
import {
	answering,
	compact,
	type Ctx,
	delegateEnv,
	eventFor,
	modelWith,
	ops,
	readA,
	reply,
	run,
	sessionWithPrior,
	sessionWithTask,
	task,
} from "./session.fixture.ts";

const carriedTail = `\nPrior narrative.\n\n<task>\n${task}\n</task>\n\n<read-files>\nsrc/a.ts\nsrc/new.ts\n</read-files>\n\n<modified-files>\nsrc/b.ts\n</modified-files>`;

const failedRows: ReadonlyArray<{ readonly name: string; readonly ctx: () => Ctx }> = [
	{
		name: "a narrative call that throws",
		ctx: () => modelWith([() => Promise.reject(new Error("socket closed"))]).ctx,
	},
	{
		name: "a narrative call that stops with an error",
		ctx: () => answering(reply({ text: "Half a narrative.", stopReason: "error" })).ctx,
	},
	{
		name: "a narrative call that answers with a tool call",
		ctx: () =>
			answering({
				...reply({ text: "Reading first." }),
				content: [
					{ type: "text", text: "Reading first." },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } },
				],
				stopReason: "toolUse",
			}).ctx,
	},
	{ name: "a session with no model", ctx: () => ({ model: undefined, modelRegistry: answering().ctx.modelRegistry }) },
	{
		name: "a narrative step that throws outside the model call",
		ctx: () => ({
			get model(): Ctx["model"] {
				throw new Error("the registry is gone");
			},
			modelRegistry: answering().ctx.modelRegistry,
		}),
	},
];

for (const row of failedRows) {
	test(`${row.name} carries the prior narrative, the anchor and the file lists`, () =>
		run(
			Effect.gen(function* () {
				const event = eventFor({ session: sessionWithPrior(), fileOps: ops({ read: ["src/new.ts"] }) });
				const { summary, details } = yield* compact(delegateEnv, event, row.ctx());

				expect({
					opensWithNote: Str.startsWith(carriedNote)(summary),
					endsWithPriorAnchorAndFiles: Str.endsWith(carriedTail)(summary),
					narrative: details.narrative,
				}).toEqual({ opensWithNote: true, endsWithPriorAnchorAndFiles: true, narrative: "Prior narrative." });
			}),
		));
}

test("without a narrative of ours, the summary pi wrote is the prior narrative, cut to the cap", () =>
	run(
		Effect.gen(function* () {
			const session = sessionWithTask();
			const kept = session.appendMessage({ role: "user", content: "Go on.", timestamp: 0 });

			session.appendCompaction(Str.repeat(13_000)("p"), kept, 90_000, { readFiles: [], modifiedFiles: [] });

			const { details } = yield* compact(
				delegateEnv,
				eventFor({ session, fileOps: readA }),
				answering(reply({ text: "", stopReason: "error" })).ctx,
			);

			expect(details.narrative).toBe(Str.repeat(narrativeCap)("p"));
		}),
	));

const over = Str.repeat(13_000)("x");

test("a reply over the cap gets one retry, and the entry counts the usage of both", () =>
	run(
		Effect.gen(function* () {
			const short = Str.repeat(2000)("y");

			const { prompts, ctx } = answering(
				reply({ text: over, stopReason: "stop", cost: 0.25 }),
				reply({ text: short, stopReason: "stop", cost: 0.5 }),
			);

			const entry = yield* compact(delegateEnv, eventFor({ session: sessionWithTask(), fileOps: readA }), ctx);

			expect({
				narrative: entry.details.narrative,
				usage: entry.usage,
				retryNamesRun: Str.includes("13000")(prompts[1] ?? ""),
			}).toEqual({
				narrative: short,
				usage: {
					input: 2000,
					output: 200,
					cacheRead: 20,
					cacheWrite: 2,
					totalTokens: 2222,
					cost: { input: 0.375, output: 0.375, cacheRead: 0, cacheWrite: 0, total: 0.75 },
				},
				retryNamesRun: true,
			});
		}),
	));

test("a reply cut off at the length limit gets one retry", () =>
	run(
		Effect.gen(function* () {
			const { ctx } = answering(reply({ text: "Half a narr", stopReason: "length" }), reply({ text: "Whole." }));
			const { details } = yield* compact(delegateEnv, eventFor({ session: sessionWithTask(), fileOps: readA }), ctx);

			expect(details.narrative).toBe("Whole.");
		}),
	));

test("two replies over the cap carry the prior narrative, after exactly one retry", () =>
	run(
		Effect.gen(function* () {
			const { prompts, ctx } = answering(
				reply({ text: over }),
				reply({ text: over }),
				reply({ text: "Never asked." }),
			);

			const entry = yield* compact(delegateEnv, eventFor({ session: sessionWithPrior(), fileOps: readA }), ctx);

			expect({
				calls: prompts.length,
				opensWithNote: Str.startsWith(carriedNote)(entry.summary),
				narrative: entry.details.narrative,
				cost: entry.usage?.cost.total,
			}).toEqual({ calls: 2, opensWithNote: true, narrative: "Prior narrative.", cost: 0.5 });
		}),
	));

test("a split turn's prefix reaches the narrative call after the messages to summarize", () =>
	run(
		Effect.gen(function* () {
			const { prompts, ctx } = answering(reply({ text: "Narrative." }));
			const event = eventFor({ session: sessionWithTask(), fileOps: readA });
			const prefix = { role: "user" as const, content: "Then split the lexer.", timestamp: 0 };

			yield* compact(
				delegateEnv,
				{ ...event, preparation: { ...event.preparation, isSplitTurn: true, turnPrefixMessages: [prefix] } },
				ctx,
			);

			expect(
				Str.includes("[User]: Read src/a.ts and edit it.\n\n[User]: Then split the lexer.")(prompts[0] ?? ""),
			).toBe(true);
		}),
	));
