/**
 * A root starts one leaf with the `delegate` tool, and the leaf's result wakes the root: owned-work appends the wake to
 * the root's session once the leaf settles, and the leaf's own session lands in the run's delegates folder. The leaf
 * runs the same pi as the root, on this worktree's extensions.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { type Run, scenario } from "../../tools/driver/index.ts";
import { entryKind } from "./recorded.ts";

const Started = Schema.Struct({
	type: Schema.Literal("custom"),
	customType: Schema.Literal(entryKind),
	data: Schema.Struct({ type: Schema.Literal("delegate-started"), child_session_id: Schema.String }),
});

const Outcome = Schema.Struct({ status: Schema.String, text: Schema.optionalKey(Schema.String) });

const Wake = Schema.Struct({
	type: Schema.Literal("custom_message"),
	customType: Schema.Literal(entryKind),
	details: Schema.Struct({ ref: Schema.String, kind: Schema.String, outcome: Outcome }),
});

const decodeStarted = Schema.decodeUnknownOption(Started);

const decodeWake = Schema.decodeUnknownOption(Wake);

const startedIn = (entries: ReadonlyArray<SessionEntry>) => Arr.findFirst(entries, (entry) => decodeStarted(entry));

const wakeIn = (entries: ReadonlyArray<SessionEntry>) => Arr.findFirst(entries, (entry) => decodeWake(entry));

/** What the leaf named by the root's `delegate-started` entry loaded, once its session has started. */
const leafLoaded = (run: Run) =>
	run.waitFor("what the leaf loaded", "10 seconds", ({ root, delegates }) =>
		startedIn(root.entries).pipe(
			Option.flatMap(({ data }) => Arr.findFirst(delegates, (session) => session.id === data.child_session_id)),
			Option.flatMap((session) => session.loaded),
		),
	);

scenario({
	model: "ultra-a/claude-fable-5-2",
	play: (run) =>
		Effect.gen(function* () {
			yield* run.root.prompt(
				"Use the delegate tool to start one leaf. Its whole task: reply with the single word ok. Then end your turn without waiting for it.",
			);

			const wake = yield* run.waitFor("the leaf's wake", "5 minutes", ({ root }) => wakeIn(root.entries));
			const { status, text } = wake.details.outcome;

			yield* run.say(wake.details);
			yield* run.say(`settled ${status}`);
			yield* run.check(
				status === "done" && text === "ok",
				`the leaf settled done with ok (it settled ${status} with ${text ?? "no text"})`,
			);

			const leaf = yield* leafLoaded(run);
			const ours = Arr.filter(leaf.extensions, Str.startsWith(`${run.agentDir}/extensions/`));

			yield* run.say(`leaf runs pi ${leaf.version} with ${Arr.join(leaf.extensions, " ")}`);
			yield* run.check(
				leaf.version === "1.5.2" && Arr.isReadonlyArrayNonEmpty(ours) && ours.length === leaf.extensions.length,
				`the leaf runs pi 1.5.2 with extensions from ${run.agentDir}/extensions only (it runs ${leaf.version} with ${Arr.join(leaf.extensions, ", ")})`,
			);
		}),
});
