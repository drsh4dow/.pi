/**
 * A leaf idles past the 5-minute cache lifetime inside one run, in a `sleep` its bash tool waits on, and its next reply
 * rewrites its whole prompt. The cache feature records that miss with an idle cause. The leaf runs on Claude Haiku:
 * pi's cache warmer refreshes a cache only when that saves at least $0.05, which a Haiku prompt under 100,000 tokens
 * never does, so nothing refreshes the cache while the leaf sleeps.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { scenario } from "../../tools/driver/index.ts";
import { Cause, entryKind, Miss } from "./index.ts";

const Recorded = Schema.Struct({ type: Schema.Literal("custom"), customType: Schema.Literal(entryKind), data: Miss });

const decodeRecorded = Schema.decodeUnknownOption(Recorded);

const missIn = (entries: ReadonlyArray<SessionEntry>) => Arr.findFirst(entries, (entry) => decodeRecorded(entry));

const cacheLifetimeMs = 5 * 60 * 1000;

scenario({
	model: "ultra-a/claude-fable-5-2",
	play: (run) =>
		Effect.gen(function* () {
			// Random base64 costs about one token a byte, so the leaf's prompt passes 50,000 tokens and stays under 100,000.
			const filler = yield* run.exec(["sh", "-c", "head -c 34000 /dev/urandom | base64 -w 76 > filler.txt"]);

			yield* run.check(filler.code === 0, `the filler file was written (exit ${String(filler.code)})`);

			yield* run.root.prompt(
				Arr.join(
					[
						"Use the delegate tool to start one leaf on the model ultra-a/claude-haiku-5-5. Its whole task, word for word:",
						"Read the file filler.txt with the read tool, in one call. Then run the bash command `sleep 330`, in the foreground. Then reply with the single word done.",
						"Then end your turn without waiting for it.",
					],
					"\n\n",
				),
			);

			const { data } = yield* run.waitFor("the leaf's cache-miss entry", "10 minutes", ({ delegates }) =>
				Arr.findFirst(delegates, (session) => missIn(session.entries)),
			);

			yield* run.say(data);

			const idle = Arr.findFirst(data.causes, Cause.guards.Idle);

			yield* run.check(
				Option.exists(idle, ({ ms }) => ms > cacheLifetimeMs) && data.missedTokens >= 50_000,
				`the leaf recorded an idle miss past 5 minutes of at least 50,000 tokens (it recorded ${String(data.missedTokens)} tokens, causes ${Arr.join(
					Arr.map(data.causes, ({ _tag }) => _tag),
					" ",
				)})`,
			);
		}),
});
