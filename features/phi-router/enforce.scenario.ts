import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { scenario } from "../../tools/driver/index.ts";
import { providersOf } from "./session.fixture.ts";

const syntheticRecord =
	"Discharge summary. Patient: Wilhelmina Okafor-Brandt, DOB 1953-02-27, MRN 77041-3392. Admitted for community-acquired pneumonia; history of COPD and type 2 diabetes. Discharged on levofloxacin 750 mg daily.\n";

const isPersonal = (provider: string) => provider === "ultra-a" || provider === "ultra-b";

const personalThenEnt = (providers: ReadonlyArray<string>) => {
	const [personal, rest] = Arr.span(providers, isPersonal);

	return personal.length > 0 && rest.length > 0 && Arr.every(rest, (provider) => provider === "ent");
};

scenario({
	model: "phi/auto",
	play: (run) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const pwd = yield* run.exec(["pwd"]);

			yield* fs.writeFileString(`${run.home}/.pi/agent/phi-router.json`, '{"mode":"enforce"}\n');
			yield* fs.writeFileString(`${Str.trim(pwd.output)}/discharge.txt`, syntheticRecord);
			yield* run.root.prompt("Reply with the single word ready and call no tool.");
			yield* run.root.prompt(
				"Run `cat discharge.txt` with the bash tool, then reply with the single word read and call no other tool.",
			);

			const providers = yield* run.waitFor("the root's answers", "10 seconds", ({ root }) =>
				Option.some(providersOf(root.entries)),
			);

			yield* run.say({ providers });
			yield* run.check(
				personalThenEnt(providers),
				`the clean turn ran on a personal account and every answer after the record on ent (${Arr.join(providers, ", ")})`,
			);
		}),
});
