/**
 * The run uses the pi on PATH, not this checkout's dev copy, loads its extensions from this worktree's agent folder, and
 * applies the setup's model override. It proves the README's context window example too.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Str from "effect/String";

import { scenario } from "./index.ts";

const contextWindow = 40_000;

scenario({
	model: "ultra-a/claude-fable-5-2",
	models: { "ultra-a": { modelOverrides: { "claude-fable-5-2": { contextWindow } } } },
	play: (run) =>
		Effect.gen(function* () {
			yield* run.root.prompt("Reply with the single word ok.");

			const loaded = yield* run.waitFor("what the root loaded", "30 seconds", ({ root }) => root.loaded);
			const foreign = Arr.filter(loaded.extensions, (file) => !Str.startsWith(`${run.agentDir}/extensions/`)(file));

			yield* run.say(`root runs pi ${loaded.version} on ${run.agentDir}`);
			yield* run.check(loaded.version === "1.5.2", `the root runs pi 1.5.2 (it runs ${loaded.version})`);
			yield* run.check(Arr.isReadonlyArrayNonEmpty(loaded.extensions), "the root loaded extensions");
			yield* run.check(
				foreign.length === 0,
				`every extension the root loaded comes from ${run.agentDir}/extensions (others: ${Arr.join(foreign, ", ")})`,
			);
			yield* run.check(
				loaded.contextWindow === contextWindow,
				`the root's context window is the override, ${String(contextWindow)} (it is ${String(loaded.contextWindow)})`,
			);
		}),
});
