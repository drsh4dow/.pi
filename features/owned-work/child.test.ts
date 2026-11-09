import { afterAll, expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { RunSpec } from "../../clients/hc/index.ts";
import { PiCli } from "../../clients/pi-cli/index.ts";
import { childExtensions, inheritedEnv, launch } from "./child.ts";
import { type Delegate, DelegateName } from "./delegates.ts";
import { Act, type Row, runRow } from "./ledger.fixture.ts";
import { commandSpec } from "./ledger.ts";
import { WorkRef } from "./work.ts";
import { exit, killed, node, sessionRoot } from "./world.fixture.ts";

const { Hook, Start, Answer, Stop, TurnEnds, Wakes, Leftovers } = Act;

const runs = Hook({ event: "run starts" });

const idles = Hook({ event: "goes idle" });

const delegate = Start({ kind: "delegate" });

const rows: ReadonlyArray<Row> = [
	{
		name: "a child whose answer is followed by an empty closing message is done with that answer",
		role: "root",
		acts: [
			runs,
			delegate,
			Answer({ terminal: "t1", text: "a", closing: "", end: exit(0) }),
			TurnEnds({ expect: "continue: delegate-1 done: a" }),
		],
	},
	{
		name: "a child whose last provider call errored after its answer settles failed",
		role: "root",
		acts: [
			runs,
			delegate,
			Answer({ terminal: "t1", text: "a", closing: "", stopReason: "error", end: exit(0) }),
			TurnEnds({ expect: "continue: delegate-1 failed: exited" }),
		],
	},
	{
		name: "a child aborted mid-answer settles failed, even if it exits cleanly",
		role: "root",
		acts: [
			runs,
			delegate,
			Answer({ terminal: "t1", text: "half", stopReason: "aborted", end: exit(0) }),
			TurnEnds({ expect: "continue: delegate-1 failed: exited" }),
		],
	},
	{
		name: "a child killed by SIGKILL settles failed: oom, even with an assistant text in its session",
		role: "root",
		acts: [
			runs,
			delegate,
			TurnEnds({ expect: "idle: delegate-1" }),
			idles,
			Answer({ terminal: "t1", text: "half an answer", end: killed(9) }),
			Wakes({ expect: ["delegate-1 failed: oom"] }),
		],
	},
	{
		name: "a delegate's staged files and slice are gone once it settles, however it ends",
		role: "root",
		acts: [
			runs,
			delegate,
			delegate,
			delegate,
			Leftovers({ expect: ["t1.message", "t1.prompt", "t2.message", "t2.prompt", "t3.message", "t3.prompt"] }),
			Act.Slices({ expect: ["delegate-1", "delegate-2", "delegate-3"] }),
			Answer({ terminal: "t1", text: "a", end: exit(0) }),
			Answer({ terminal: "t2", text: "half", end: killed(9) }),
			Stop({ refs: ["delegate-3"], expect: "delegate-3 failed: stopped by delegate-3" }),
			Leftovers({ expect: [] }),
			TurnEnds({ expect: "continue: delegate-1 done: a; delegate-2 failed: oom" }),
		],
	},
	{
		name: "a root that shuts down before its work settles leaves no staged files",
		role: "root",
		acts: [
			runs,
			delegate,
			delegate,
			Answer({ terminal: "t1", text: "a", end: exit(0) }),
			Hook({ event: "parent dies" }),
			Leftovers({ expect: [] }),
		],
	},
	{
		name: "a task message and a system prompt longer than one argv word still start their delegate",
		role: "root",
		acts: [
			runs,
			Start({ kind: "delegate", messageKiB: 200, promptKiB: 200 }),
			Answer({ terminal: "t1", text: "a", end: exit(0) }),
			TurnEnds({ expect: "continue: delegate-1 done: a" }),
		],
	},
];

for (const row of rows) {
	test(row.name, () => Effect.runPromise(runRow(row)));
}

const parentEnv = inheritedEnv({
	PATH: "/bin",
	HC_TERMINAL_ID: "t9",
	PI_OWNED_WORK_ROLE: "owner",
	PI_OWNED_WORK_DELEGATES: "reviewer",
	PI_OWNED_WORK_SLICE: "pi-ow-test-delegate1",
});

const common = { description: "Does it.", model: "a/b", systemPrompt: "Do it." };

const delegateLaunch = (config: Delegate) =>
	Effect.gen(function* () {
		const name = yield* Schema.decodeEffect(DelegateName)("child");
		const entry = { name, config, source: "harness" as const, file: "/child.ts", hash: "test" };
		const childSession = { id: "launched", cwd: sessionRoot, dir: `${sessionRoot}/delegates` };
		const request = { entry, message: "Do it.", ref: "delegate-1", agentKey: "test", childSession };
		const pi = yield* PiCli;

		return yield* launch(pi)({ ...request, passEnv: parentEnv });
	});

const plumbing = ({ argv, env }: Pick<RunSpec, "argv" | "env">) => {
	const excluded = Arr.filter(Arr.zip(argv, Arr.drop(argv, 1)), ([flag]) => flag === "--exclude-tools");

	return { argv: Arr.take(argv, 4), excluded: Arr.map(excluded, ([, tools]) => tools), env };
};

const launchRows = [
	{
		name: "a leaf delegate starts at OOM score 1000, as a leaf, without the core tools it does not declare",
		spec: delegateLaunch({ ...common, role: "leaf", tools: ["read", "bash"] }),
		expect: {
			argv: ["choom", "-n", "1000", "--"],
			excluded: ["powershell,edit,write,grep,find,ls"],
			env: { PATH: "/bin", PI_OWNED_WORK_ROLE: "leaf" },
		},
	},
	{
		name: "an owner delegate starts at OOM score 500, as an owner that may start only its listed delegates",
		spec: delegateLaunch({ ...common, role: "owner", tools: ["read"], delegates: ["e2e", "reviewer"] }),
		expect: {
			argv: ["choom", "-n", "500", "--"],
			excluded: ["bash,powershell,edit,write,grep,find,ls"],
			env: { PATH: "/bin", PI_OWNED_WORK_ROLE: "owner", PI_OWNED_WORK_DELEGATES: "e2e,reviewer" },
		},
	},
	{
		name: "a serve or watch starts at OOM score 1000 as a leaf, so a pi it runs has no delegate tool",
		spec: Effect.succeed(
			commandSpec({ role: "owner", agentKey: "test", cwd: "/", passEnv: parentEnv })(WorkRef("watch-1"), "pi"),
		),
		expect: { argv: ["choom", "-n", "1000", "--"], excluded: [], env: { PATH: "/bin", PI_OWNED_WORK_ROLE: "leaf" } },
	},
];

for (const row of launchRows) {
	test(row.name, () =>
		Effect.runPromise(
			Effect.map(row.spec, (spec) => {
				expect(plumbing(spec)).toEqual(row.expect);
			}).pipe(Effect.provide(node)),
		),
	);
}

test("every child extension is an entrypoint pi can load", () => {
	for (const entry of childExtensions) {
		expect(Bun.file(entry).size).toBeGreaterThan(0);
	}
});

const cleanup = Effect.promise(() => Bun.$`rm -rf ${sessionRoot}`.quiet());

afterAll(() => Effect.runPromise(cleanup));
