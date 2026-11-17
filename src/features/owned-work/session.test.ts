import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { piHost } from "#src/client/pi-host/index.ts";
import { awaitOn, delegatesDirOf, exitsWhenPromptResolves } from "./session.ts";

const rows = [
	{ mode: "print", exits: true },
	{ mode: "json", exits: true },
	{ mode: "rpc", exits: false },
	{ mode: "tui", exits: false },
] as const;

const exitPhrase = (exits: boolean): string => (exits ? "exits" : "does not exit");

test.each(Arr.map(rows, (row) => ({ ...row, does: exitPhrase(row.exits) })))(
	"pi in $mode mode $does once its prompt resolves",
	({ mode, exits }) => {
		expect(exitsWhenPromptResolves(mode)).toBe(exits);
	},
);

test("a hook still waiting when the session shuts down ends with no reply, and a hook that dies still rejects", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const host = piHost(Layer.empty);
			const waiter = piHost(Layer.empty);
			const run = <Reply>(hook: Effect.Effect<Reply>): Promise<Reply | undefined> => waiter.run(awaitOn(host)(hook));
			const died = yield* Effect.exit(Effect.tryPromise({ try: () => run(Effect.die("boom")), catch: String }));
			const waiting = run(Effect.never);

			yield* Effect.promise(() => host.dispose());

			const reply = yield* Effect.promise(() => waiting);

			expect(died._tag).toBe("Failure");
			expect(reply).toBeUndefined();
		}),
	));

const places = [
	{ name: "a saved session keeps delegates beside it", sessionDir: "/s", dir: /^\/s\/delegates$/u },
	{
		name: "a --no-session run keeps delegates in a temp folder named at random",
		sessionDir: "",
		dir: /^\/t\/pi-delegates-[0-9a-f-]{36}$/u,
	},
] as const;

test.each(places)("$name", ({ sessionDir, dir }) => {
	expect(delegatesDirOf({ sessionDir, tmpDir: "/t" })).toMatch(dir);
});

test("two --no-session runs never share a delegates folder", () => {
	expect(delegatesDirOf({ sessionDir: "", tmpDir: "/t" })).not.toBe(delegatesDirOf({ sessionDir: "", tmpDir: "/t" }));
});
