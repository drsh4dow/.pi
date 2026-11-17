import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { type Run, scenario } from "#tools/driver/index.ts";
import { type Asked, compactionPrompt, mockedModels, Reply, serveMock } from "./anthropic.fixture.ts";
import { stubs } from "./policy/policy.ts";
import { providersOf } from "./session.fixture.ts";

const summaryCanary = "Ottoline Varga-Pemberton, DOB 1947-06-02, MRN 55120-8873, metastatic breast cancer";

const paste = Arr.join(Arr.replicate("Row of the parser fixture is fine.", 2300), "\n");

const reply = ({ body }: Asked) =>
	Reply.Text({
		text: Str.includes(compactionPrompt)(body) ? `The developer pasted a chart: ${summaryCanary}.` : "done",
	});

const mocks = { "ultra-a": serveMock(reply), "ultra-b": serveMock(reply), ent: serveMock(reply) };

const verdict = (run: Run, providers: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const personal = [...mocks["ultra-a"].bodies(), ...mocks["ultra-b"].bodies()];
		const ent = mocks.ent.bodies();
		const summaries = Arr.filter(ent, Str.includes(compactionPrompt)).length;
		const entTurns = Arr.filter(ent, (body) => !Str.includes(compactionPrompt)(body));

		yield* run.say({ personal: personal.length, ent: ent.length, summaries, providers });
		yield* run.check(
			personal.length > 0,
			`the opening reached a personal mock (${String(personal.length)} requests)`,
		);
		yield* run.check(summaries > 0, `pi compacted the session on ent (${String(summaries)} summary requests)`);
		yield* run.check(!Arr.some(personal, Str.includes(summaryCanary)), "no personal mock received the summary's PHI");
		yield* run.check(
			Arr.some(personal, Str.includes(stubs.sealed)),
			"the send after the compaction went to a personal mock with the summary withheld",
		);
		yield* run.check(
			Arr.some(entTurns, Str.includes(summaryCanary)),
			"the next request carried the sealed summary to ent",
		);
	});

scenario({
	env: process.env,
	model: "phi/auto",
	settings: { compaction: { enabled: true, reserveTokens: 984_000, keepRecentTokens: 2000 } },
	models: mockedModels(mocks),
	play: (run) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;

			yield* fs.writeFileString(`${run.home}/.pi/agent/phi-router.json`, '{"mode":"enforce"}\n');
			yield* run.root.prompt("Look at the parser.");
			yield* run.root.prompt(`Here is the fixture:\n${paste}`);
			yield* run.root.prompt("Go on.");

			const providers = yield* run.waitFor("the root's answers", "10 seconds", ({ root }) =>
				Option.some(providersOf(root.entries)),
			);

			yield* verdict(run, providers);
		}),
});
