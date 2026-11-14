/**
 * `contextWindow` forces compaction: three prompts of inert filler pass three quarters of a 40000 token window, and the
 * root's session gains a compaction entry.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";

import { scenario } from "./index.ts";

const filler = Arr.join(
	Arr.makeBy(1500, (index) => `datum${index.toString(36)}`),
	" ",
);

scenario({
	model: "ultra-a/claude-fable-5-2",
	contextWindow: 40_000,
	play: (run) =>
		Effect.gen(function* () {
			yield* Effect.forEach([1, 2, 3], (turn) =>
				run.root.prompt(`Inert filler for a compaction test, turn ${String(turn)}. Reply only ok.\n${filler}`),
			);

			const compaction = yield* run.waitFor("the root's compaction", "30 seconds", ({ root }) =>
				Arr.findFirst(root.entries, (entry) => entry.type === "compaction"),
			);

			yield* run.say(`root compacted ${compaction.id}`);
		}),
});
