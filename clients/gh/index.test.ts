import { afterAll, expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Str from "effect/String";

import { Gh, ghLayer, patchIdOf } from "./index.ts";

const diff = (hunk: string, lines: string) =>
	`diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n${hunk}\n${lines}\n`;

const patch = " a\n-b\n+c\n d";

const spaced = Str.replace("+c", "+c ")(patch);

const changedContext = Str.replace(" a", " z")(patch);

const diffs = [
	diff("@@ -1,3 +1,3 @@", patch),
	diff("@@ -10,3 +10,3 @@", patch),
	diff("@@ -1,3 +1,3 @@", spaced),
	diff("@@ -1,3 +1,3 @@", changedContext),
];

const scratch = `${Bun.env["TMPDIR"] ?? "/tmp"}/gh-client-test-${String(process.pid)}`;

const origin = `${scratch}/origin`;

const fakeGhWithLocalOrigin = Layer.effect(
	ChildProcessSpawner.ChildProcessSpawner,
	Effect.map(ChildProcessSpawner.ChildProcessSpawner, (real) =>
		ChildProcessSpawner.make((command) => {
			if (!ChildProcess.isStandardCommand(command)) {
				return real.spawn(command);
			}

			const program = command.command === "gh" ? `${scratch}/gh` : command.command;

			const env = {
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`,
				GIT_CONFIG_VALUE_0: "https://github.com/o/r.git",
			};

			return real.spawn(ChildProcess.make(program, command.args, { ...command.options, env, extendEnv: true }));
		}),
	),
);

const runtime = ManagedRuntime.make(
	Layer.provideMerge(ghLayer, Layer.provideMerge(fakeGhWithLocalOrigin, NodeServices.layer)),
);

afterAll(() =>
	runtime.runPromise(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(scratch, { recursive: true }))),
);

test("the patch identity holds across moved lines, and changes with whitespace or a changed line of context", () =>
	runtime.runPromise(
		Effect.gen(function* () {
			const [base, ...others] = yield* Effect.forEach(diffs, patchIdOf);

			expect(Arr.map(others, (id) => id === base)).toEqual([true, false, false]);
		}),
	));

const identity = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];

const git = (...args: ReadonlyArray<string>) =>
	Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
		spawner.string(ChildProcess.make("git", ["-C", origin, ...identity, ...args])),
	);

const commit = (file: string, body: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(`${origin}/${file}`, body)).pipe(
		Effect.andThen(git("add", ".")),
		Effect.andThen(git("commit", "-q", "-m", file)),
		Effect.andThen(git("rev-parse", "HEAD")),
		Effect.map(Str.trim),
	);

const binariesWithOneShortBlobId = ["\0binary 2755\n", "\0binary 32916\n"] as const;

const [sevenBinary, nineBinary] = binariesWithOneShortBlobId;

const branch = (name: string, from: string, binary: string) =>
	git("checkout", "-q", "-b", name, from).pipe(
		Effect.andThen(commit("f", "a\nc\nd\n")),
		Effect.andThen(commit("g", binary)),
	);

const repository = Effect.gen(function* () {
	yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeDirectory(origin, { recursive: true }));
	yield* git("init", "-q", "-b", "main");

	const mergeBase = yield* commit("f", "a\nb\nd\n");
	const seven = yield* branch("seven", mergeBase, sevenBinary);
	const nine = yield* branch("nine", mergeBase, nineBinary);

	yield* git("checkout", "-q", "main");

	const base = yield* commit("other", "moved on\n");

	return { base, mergeBase, seven, nine };
});

const viewJson = (number: string, head: string) =>
	`{"url":"https://github.com/o/r/pull/${number}","headRefOid":"${head}","reviewDecision":"","reviews":[],"statusCheckRollup":[],"state":"OPEN"}`;

type Repository = Effect.Success<typeof repository>;

const fakeGh = ({ base, mergeBase, seven, nine }: Repository) => `#!/bin/sh
case "$*" in
"pr diff 7"|"pr diff 9") echo "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300)." >&2; echo "PullRequest.diff too_large" >&2; exit 1 ;;
"pr diff 8") printf '%s' '${diff("@@ -1,3 +1,3 @@", patch)}' ;;
"pr view "*baseRefOid*) echo ${base} ;;
"pr view 7 "*) echo '${viewJson("7", seven)}' ;;
"pr view 9 "*) echo '${viewJson("9", nine)}' ;;
"api repos/o/r/compare/${base}...${seven} "*|"api repos/o/r/compare/${base}...${nine} "*) echo ${mergeBase} ;;
*) echo "unexpected gh $*" >&2; exit 2 ;;
esac
`;

const threeDot = (base: string, head: string) =>
	Effect.flatMap(git("diff", "--full-index", `${base}...${head}`), patchIdOf);

test("a pull request whose diff GitHub refuses as too large gets the patch id of its full merge-base diff, and others keep gh's diff", () =>
	runtime.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const ends = yield* repository;

			yield* fs.writeFileString(`${scratch}/gh`, fakeGh(ends), { mode: 0o755 });

			const expected = [
				yield* threeDot(ends.base, ends.seven),
				yield* threeDot(ends.base, ends.nine),
				yield* patchIdOf(diff("@@ -1,3 +1,3 @@", patch)),
			];

			const gh = yield* Gh;
			const ids = [yield* gh.patchId("7"), yield* gh.patchId("9"), yield* gh.patchId("8")];

			expect(ids).toEqual(expected);
		}),
	));
