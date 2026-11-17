/**
 * A switch away from `phi/auto` breaks the seal by the human's choice (ADR 0017). A pi on `phi/auto` seals a synthetic
 * SSN, then the same session continues on raw `ultra-a`. The continued request reaches the `ultra-a` mock, sealed
 * content included, and is not refused.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Str from "effect/String";

import { type Run, scenario } from "#tools/driver/index.ts";
import { mockedModels, Reply, serveMock } from "./anthropic.fixture.ts";

const ssn = "123-45-6789";

const prompts = {
	sealed: `Synthetic intake: Maria Delgado-Ruiz, ssn ${ssn}. Reply with the single word done.`,
	after: "Reply with the single word done.",
} as const;

const mocks = {
	"ultra-a": serveMock(() => Reply.Text({ text: "done" })),
	"ultra-b": serveMock(() => Reply.Text({ text: "done" })),
	ent: serveMock(() => Reply.Text({ text: "done" })),
};

const piOn = (run: Run, sessions: string, model: string, extra: ReadonlyArray<string>, prompt: string) =>
	run.exec([
		"pi",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"-e",
		`${run.agentDir}/extensions/claude-accounts/index.ts`,
		"-e",
		`${run.agentDir}/extensions/phi-router/index.ts`,
		"--model",
		model,
		"--session-dir",
		sessions,
		...extra,
		"-p",
		prompt,
	]);

const switchedAway = (run: Run, sessions: string) =>
	Effect.gen(function* () {
		const before = mocks["ultra-a"].bodies().length;
		const away = yield* piOn(run, sessions, "ultra-a/claude-opus-5-5", ["--continue"], prompts.after);
		const reached = Arr.drop(mocks["ultra-a"].bodies(), before);

		yield* run.say({ exit: away.code, output: Str.trim(away.output), ultraARequests: reached.length });
		yield* run.check(
			away.code === 0 && !Str.includes("phi border refused")(away.output),
			"the switch is not refused",
		);
		yield* run.check(Arr.some(reached, Str.includes(ssn)), "ultra-a received the sealed content after the switch");
	});

scenario({
	env: process.env,
	model: "phi/auto",
	models: mockedModels(mocks),
	play: (run) =>
		Effect.gen(function* () {
			const pwd = yield* run.exec(["pwd"]);
			const sessions = `${Str.trim(pwd.output)}/switch-sessions`;

			const onPhi = yield* piOn(run, sessions, "phi/auto", [], prompts.sealed);
			yield* run.check(onPhi.code === 0, `pi on phi/auto exited 0 (${Str.trim(onPhi.output)})`);
			yield* run.check(
				Arr.some(mocks.ent.bodies(), Str.includes(ssn)),
				"the sealed prompt went to ent while the session was on phi/auto",
			);
			yield* switchedAway(run, sessions);
		}),
});
