import { expect, test } from "bun:test";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { delegatesDirOf, exitsWhenPromptResolves, runHook } from "./session.ts";

const rows = [
	{ mode: "print", exits: true },
	{ mode: "json", exits: true },
	{ mode: "rpc", exits: false },
	{ mode: "tui", exits: false },
] as const;

for (const { mode, exits } of rows) {
	test(`pi in ${mode} mode ${exits ? "exits" : "does not exit"} once its prompt resolves`, () => {
		expect(exitsWhenPromptResolves(mode)).toBe(exits);
	});
}

test("a hook still waiting when the session shuts down ends with no reply, and a hook that dies still rejects", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const runtime = ManagedRuntime.make(Layer.empty);
			const run = runHook(runtime);
			const died = yield* Effect.exit(Effect.tryPromise({ try: () => run(Effect.die("boom")), catch: String }));
			const waiting = run(Effect.never);

			yield* Effect.promise(() => runtime.dispose());

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

for (const { name, sessionDir, dir } of places) {
	test(name, () => {
		expect(delegatesDirOf({ sessionDir, tmpDir: "/t" })).toMatch(dir);
	});
}

test("two --no-session runs never share a delegates folder", () => {
	expect(delegatesDirOf({ sessionDir: "", tmpDir: "/t" })).not.toBe(delegatesDirOf({ sessionDir: "", tmpDir: "/t" }));
});
