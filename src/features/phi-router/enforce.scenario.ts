import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { type Run, scenario } from "#tools/driver/index.ts";
import { stubs } from "./policy/policy.ts";
import { providersOf } from "./session.fixture.ts";

const patient = "Wilhelmina Okafor-Brandt";

const syntheticRecord = `Discharge summary. Patient: ${patient}, DOB 1953-02-27, MRN 77041-3392. Admitted for community-acquired pneumonia; history of COPD and type 2 diabetes. Discharged on levofloxacin 750 mg daily.\n`;

const isPersonal = (provider: string) => provider === "ultra-a" || provider === "ultra-b";

const afterRecord = (entries: ReadonlyArray<SessionEntry>) =>
	Option.flatMap(
		Arr.findFirstIndex(entries, (entry) => entry.type === "message" && entry.message.role === "toolResult"),
		(index) => Arr.head(providersOf(Arr.drop(entries, index + 1))),
	);

interface Seen {
	readonly providers: ReadonlyArray<string>;
	readonly sealing: Option.Option<string>;
	readonly last: Option.Option<string>;
}

const played = (run: Run) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const pwd = yield* run.exec(["pwd"]);

		yield* fs.writeFileString(`${run.home}/.pi/agent/phi-router.json`, '{"mode":"enforce"}\n');
		yield* fs.writeFileString(`${Str.trim(pwd.output)}/discharge.txt`, syntheticRecord);
		yield* run.root.prompt("Reply with the single word ready and call no tool.");
		yield* run.root.prompt(
			"Run `cat discharge.txt` with the bash tool, then reply with the single word read and call no other tool.",
		);
		yield* run.root.prompt("Reply with the single word done and call no tool.");

		return yield* run.waitFor("the root's four answers", "10 seconds", ({ root }) =>
			Option.map(
				Option.liftPredicate(root, ({ entries }) => providersOf(entries).length >= 4),
				(session): Seen => ({
					providers: providersOf(session.entries),
					sealing: afterRecord(session.entries),
					last: Arr.last(session.requests),
				}),
			),
		);
	});

const checked = (run: Run, { providers, sealing, last }: Seen) =>
	Effect.gen(function* () {
		yield* run.say({ providers });
		yield* run.check(
			Option.exists(Arr.head(providers), isPersonal),
			`the clean opening ran on a personal account (${Arr.join(providers, ", ")})`,
		);
		yield* run.check(
			Option.contains(sealing, "ent"),
			`the request that carried the record ran on ent (${Option.getOrElse(sealing, () => "none")})`,
		);
		yield* run.check(
			Option.exists(Arr.last(providers), isPersonal),
			`the request after the record returned to a personal account (${Arr.join(providers, ", ")})`,
		);
		yield* run.check(
			Option.exists(last, (payload) => Str.includes(stubs.sealed)(payload) && !Str.includes(patient)(payload)),
			"the last payload, sent to the personal account, carries the record withheld and not the patient's name",
		);
	});

scenario({
	env: process.env,
	model: "phi/auto",
	play: (run) => Effect.flatMap(played(run), (seen) => checked(run, seen)),
});
