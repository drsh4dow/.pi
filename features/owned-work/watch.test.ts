import { afterAll, expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";

import { Act, type Row, runRow } from "./ledger.fixture.ts";
import { watchSpec } from "./ledger.ts";
import { WorkRef } from "./work.ts";
import { sessionRoot } from "./world.fixture.ts";

test("a watch exits with its command's code and copies all of its output, stderr too, to its log", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const log = `${sessionRoot}/watch.log`;
			const command = "for i in $(seq 200); do echo line $i; done; echo oops >&2; exit 3";
			const { argv, env } = watchSpec({ cwd: "/", passEnv: { PATH: "/bin" } })(WorkRef("watch-1"), command, log);

			yield* Effect.promise(() => Bun.$`mkdir -p ${sessionRoot}`.quiet());

			const code = yield* Effect.promise(() => Bun.spawn([...argv], { env, stdout: "ignore" }).exited);
			const text = yield* Effect.promise(() => Bun.file(log).text());
			const lines = Arr.map(Arr.range(1, 200), (line) => `line ${String(line)}`);

			expect(code).toBe(3);
			expect(text).toBe(`${Arr.join([...lines, "oops"], "\n")}\n`);
		}),
	));

const spawnFails: Row = {
	name: "a watch whose command never started wakes the agent with no log",
	role: "root",
	acts: [
		Act.Hook({ event: "run starts" }),
		Act.Start({ kind: "watch", heldThen: "fails" }),
		Act.Spawned({ expect: "watch-1" }),
		Act.TurnEnds({ expect: "continue: watch-1 failed: spawn failed" }),
	],
};

test(spawnFails.name, () => Effect.runPromise(runRow(spawnFails)));

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${sessionRoot}`.quiet())));
