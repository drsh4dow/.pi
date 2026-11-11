import { afterAll, expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { RunSpec } from "../../clients/hc/index.ts";
import { PiCli } from "../../clients/pi-cli/index.ts";
import { atLevel, childExtensions, inheritedEnv, launch, selfFromEnv } from "./child.ts";
import { Act, type Row, runRow } from "./ledger.fixture.ts";
import { commandSpec } from "./ledger.ts";
import { WorkRef } from "./work.ts";
import { exit, killed, node, sessionRoot } from "./world.fixture.ts";

const { Hook, Start, Answer, Cancel, TurnEnds, Wakes, Leftovers } = Act;

const runs = Hook({ event: "run starts" });

const idles = Hook({ event: "goes idle" });

const delegate = Start({ kind: "delegate" });

const rows: ReadonlyArray<Row> = [
	{
		name: "a root's child starts at level 2, and its answer followed by an empty closing message is done with that answer",
		role: "root",
		acts: [
			runs,
			delegate,
			Act.SpawnLevels({ expect: ["delegate-1 at level 2"] }),
			Answer({ terminal: "t1", text: "a", closing: "", end: exit(0) }),
			TurnEnds({ expect: "continue: delegate-1 done: a" }),
		],
	},
	{
		name: "a child whose last provider call errored after its answer settles failed with the provider's error",
		role: "root",
		acts: [
			runs,
			delegate,
			Answer({ terminal: "t1", text: "a", closing: "", stopReason: "error", end: exit(0) }),
			TurnEnds({ expect: "continue: delegate-1 failed: errored: 429 rate limit" }),
		],
	},
	{
		name: "a child whose last provider call errored and that was then killed by SIGKILL settles failed: oom",
		role: "root",
		acts: [
			runs,
			delegate,
			Answer({ terminal: "t1", text: "a", stopReason: "error", end: killed(9) }),
			TurnEnds({ expect: "continue: delegate-1 failed: oom" }),
		],
	},
	{
		name: "a child whose last provider call errored settles errored even when it exits with an error code",
		role: "root",
		acts: [
			runs,
			delegate,
			Answer({ terminal: "t1", text: "a", stopReason: "error", end: exit(1) }),
			TurnEnds({ expect: "continue: delegate-1 failed: errored: 429 rate limit" }),
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
			Leftovers({
				expect: ["t1.instructions", "t1.message", "t2.instructions", "t2.message", "t3.instructions", "t3.message"],
			}),
			Act.Slices({ expect: ["delegate-1", "delegate-2", "delegate-3"] }),
			Answer({ terminal: "t1", text: "a", end: exit(0) }),
			Answer({ terminal: "t2", text: "half", end: killed(9) }),
			Cancel({ refs: ["delegate-3"], expect: "delegate-3 failed: cancelled by your cancel call" }),
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
		name: "a task message and instructions longer than one argv word still start their delegate",
		role: "root",
		acts: [
			runs,
			Start({ kind: "delegate", messageKiB: 200, instructionsKiB: 200 }),
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
	PI_OWNED_WORK_LEVEL: "2",
	PI_OWNED_WORK_SLICE: "pi-ow-test-delegate1",
});

const brief = { name: "Review the retry cap, again!", message: "Do it.", model: "a/b", instructions: Option.none() };

const delegateLaunch = (level: number, thinking: Option.Option<string>, readOnly = false) =>
	Effect.flatMap(PiCli, (pi) =>
		launch(pi)({
			brief: { ...brief, thinking, readOnly },
			level,
			childSession: { id: "launched", cwd: sessionRoot, dir: `${sessionRoot}/delegates` },
			passEnv: parentEnv,
		}),
	);

const plumbing = ({ name, argv, env }: Pick<RunSpec, "name" | "argv" | "env">) => {
	const shownAs: string = name;
	const flags = Arr.zip(argv, Arr.drop(argv, 1));

	const valuesOf = (flag: string) =>
		Arr.map(
			Arr.filter(flags, ([word]) => word === flag),
			([, value]) => value,
		);

	return {
		name: shownAs,
		argv: Arr.take(argv, 4),
		tools: valuesOf("--tools"),
		excluded: valuesOf("--exclude-tools"),
		thinking: valuesOf("--thinking"),
		env,
	};
};

const launchRows = [
	{
		name: "a level-2 delegate starts at OOM score adjustment 500 with codemode and its thinking level",
		spec: delegateLaunch(2, Option.some("high")),
		expect: {
			name: "review-the-retry-cap-again",
			argv: ["choom", "-n", "500", "--"],
			tools: ["+codemode"],
			excluded: [],
			thinking: ["high"],
			env: { PATH: "/bin", PI_OWNED_WORK_LEVEL: "2" },
		},
	},
	{
		name: "a read-only delegate starts without the edit and write tools, and keeps codemode",
		spec: delegateLaunch(2, Option.none(), true),
		expect: {
			name: "review-the-retry-cap-again",
			argv: ["choom", "-n", "500", "--"],
			tools: ["+codemode"],
			excluded: ["edit,write"],
			thinking: [],
			env: { PATH: "/bin", PI_OWNED_WORK_LEVEL: "2" },
		},
	},
	{
		name: "a delegate at the last level starts at OOM score adjustment 1000, and with no thinking level passes none",
		spec: delegateLaunch(3, Option.none()),
		expect: {
			name: "review-the-retry-cap-again",
			argv: ["choom", "-n", "1000", "--"],
			tools: ["+codemode"],
			excluded: [],
			thinking: [],
			env: { PATH: "/bin", PI_OWNED_WORK_LEVEL: "3" },
		},
	},
	{
		name: "a serve or watch runs at the last level, so a pi it starts has no delegate tool, and is named by its command",
		spec: Effect.succeed(commandSpec({ cwd: "/", passEnv: parentEnv })(WorkRef("watch-1"), "pi --print hi")),
		expect: {
			name: "pi-print-hi",
			argv: ["choom", "-n", "1000", "--"],
			tools: [],
			excluded: [],
			thinking: [],
			env: { PATH: "/bin", PI_OWNED_WORK_LEVEL: "3" },
		},
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

const envRows = [
	{ level: 2, reads: 2 },
	{ level: 3, reads: 3 },
	{ level: 1, reads: undefined },
	{ level: 4, reads: undefined },
];

for (const row of envRows) {
	test(`a child started with level ${String(row.level)}'s env ${row.reads === undefined ? "is refused" : "runs at that level"}`, () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const self = yield* Effect.option(selfFromEnv({ ...atLevel(row.level).env, PI_OWNED_WORK_SLICE: "s" }));

				expect(
					self.pipe(
						Option.map(({ level }) => level),
						Option.getOrUndefined,
					),
				).toBe(row.reads);
			}),
		));
}

test("every child extension is an entrypoint pi can load", () => {
	for (const entry of childExtensions) {
		expect(Bun.file(entry).size).toBeGreaterThan(0);
	}
});

const cleanup = Effect.promise(() => Bun.$`rm -rf ${sessionRoot}`.quiet());

afterAll(() => Effect.runPromise(cleanup));
