import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type Run, scenario, type Sessions } from "#tools/driver/index.ts";
import { entryKind } from "./recorded.ts";

const ownerName = "wake owner";

const leafName = "wake leaf";

const Wake = Schema.Struct({
	type: Schema.Literal("custom_message"),
	customType: Schema.Literal(entryKind),
	details: Schema.Struct({
		ref: Schema.String,
		kind: Schema.Literal("delegate"),
		name: Schema.String,
		session: Schema.String,
		outcome: Schema.Struct({ status: Schema.String }),
	}),
});

const decodeWake = Schema.decodeUnknownOption(Wake);

const wakeNamed = (entries: ReadonlyArray<SessionEntry>, name: string) =>
	Arr.findFirst(entries, (entry) => Option.filter(decodeWake(entry), ({ details }) => details.name === name));

const wakeOf = (run: Run, name: string, parent: (sessions: Sessions) => Option.Option<ReadonlyArray<SessionEntry>>) =>
	run.waitFor(`the wake that names ${name}`, "5 minutes", (sessions) =>
		Option.flatMap(parent(sessions), (entries) =>
			Option.flatMap(wakeNamed(entries, name), (wake) =>
				Option.map(
					Arr.findFirst(sessions.delegates, ({ id }) => id === wake.details.session),
					(child) => ({ wake: wake.details, child }),
				),
			),
		),
	);

const request = `Use the delegate tool once to start an owner named "${ownerName}" with goal "Prove that wakes name their delegates", and model ultra-a/claude-fable-5-2. Its whole task message: Use the delegate tool once to start a leaf named "${leafName}" whose whole task is to reply with the single word ok. End your turn, and once the leaf wakes you, reply with the single word done. Then end your turn without waiting for the owner.`;

scenario({
	model: "ultra-a/claude-fable-5-2",
	play: (run) =>
		Effect.gen(function* () {
			yield* run.root.prompt(request);

			const owner = yield* wakeOf(run, ownerName, ({ root }) => Option.some(root.entries));

			yield* run.say(owner.wake);
			yield* run.check(
				owner.wake.outcome.status === "done",
				`the root's wake names "${ownerName}" and the owner's session ${owner.child.id}, and it settled done (it settled ${owner.wake.outcome.status})`,
			);

			const leaf = yield* wakeOf(run, leafName, ({ delegates }) =>
				Option.map(
					Arr.findFirst(delegates, ({ id }) => id === owner.child.id),
					({ entries }) => entries,
				),
			);

			yield* run.say(leaf.wake);
			yield* run.check(
				leaf.wake.outcome.status === "done" && leaf.child.id !== owner.child.id,
				`the owner's wake names "${leafName}" and the leaf's own session ${leaf.child.id}, and it settled done (it settled ${leaf.wake.outcome.status})`,
			);
		}),
});
