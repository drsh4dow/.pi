import { afterAll, expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Rec from "effect/Record";
import * as Str from "effect/String";

import { patchIdOf, recordVerdict, verdictsFolder } from "#src/features/pr/index.ts";

const scratch = `${Bun.env["TMPDIR"] ?? "/tmp"}/gh-wrapper-test-${String(process.pid)}`;

const worldIn = (root: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		for (const [where, name] of [
			["real", "REAL"],
			["star*", "GLOB"],
			["current", "CURRENT"],
		]) {
			yield* fs.makeDirectory(`${root}/${where}`, { recursive: true });
			yield* fs.writeFileString(`${root}/${where}/gh`, `#!/bin/sh\nprintf ${name}; printf '[%s]' "$@"\n`, {
				mode: 0o755,
			});
		}

		yield* fs.makeDirectory(`${root}/directory/gh`, { recursive: true });
		yield* fs.makeDirectory(`${root}/tools`);
		yield* fs.symlink(Bun.which("readlink") ?? "/usr/bin/readlink", `${root}/tools/readlink`);
		yield* fs.symlink(import.meta.dirname, `${root}/bin`);
	});

const freshRoot = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;

	yield* fs.makeDirectory(scratch, { recursive: true });

	return yield* fs.makeTempDirectory({ directory: scratch });
});

const ghWith = (path: string) =>
	Effect.gen(function* () {
		const root = yield* freshRoot;

		yield* worldIn(root);

		const run = Bun.spawn([`${root}/bin/gh`, "a", "b c", "owner:branch", ""], {
			cwd: `${root}/current`,
			env: { PATH: `${root}/bin:${Str.replaceAll("<root>", root)(path)}:${root}/tools` },
		});

		const out = yield* Effect.promise(() => new Response(run.stdout).text());

		return { code: yield* Effect.promise(() => run.exited), out: Str.trim(out) };
	});

const rows = [
	{
		name: "hands its arguments to the next gh on PATH",
		path: "<root>/real",
		expect: { code: 0, out: "REAL[a][b c][owner:branch][]" },
	},
	{
		name: "skips a folder named gh",
		path: "<root>/directory:<root>/real",
		expect: { code: 0, out: "REAL[a][b c][owner:branch][]" },
	},
	{
		name: "reads an empty entry as the current folder",
		path: ":<root>/real",
		expect: { code: 0, out: "CURRENT[a][b c][owner:branch][]" },
	},
	{ name: "never expands a pattern in PATH", path: "<root>/st*", expect: { code: 127, out: "" } },
];

test.each(rows)("the gh wrapper $name", (row) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const got = yield* ghWith(row.path);

			expect(got).toEqual(row.expect);
		}).pipe(Effect.provide(NodeServices.layer)),
	),
);

const head = "9c1e2a0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const view = `{"url":"https://github.com/o/r/pull/7","headRefOid":"${head}","reviewDecision":"","reviews":[],"statusCheckRollup":[],"state":"OPEN"}`;

const diff = "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n";

const fakeGh = `#!/bin/sh
case "$1 $2" in
"pr view") printf '%s' '${view}' ;;
"pr diff") printf '${diff}' ;;
*) printf REAL; printf '[%s]' "$@" ;;
esac
`;

const passIn = (home: string) =>
	Effect.gen(function* () {
		const patchId = yield* patchIdOf(diff);
		const verifier = { name: "verify 7", session: "s1", model: "m" };
		const record = { repo: "o/r", number: 7, head, patchId, result: "pass" as const, verifier, answer: "/a.md" };

		yield* recordVerdict(verdictsFolder(home))(record);
	});

const gatedWorld = (root: string, verdict: boolean) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const tools = { readlink: Bun.which("readlink") ?? "/usr/bin/readlink", git: Bun.which("git") ?? "/usr/bin/git" };

		yield* fs.makeDirectory(`${root}/real`, { recursive: true });
		yield* fs.makeDirectory(`${root}/tools`);
		yield* fs.writeFileString(`${root}/real/gh`, fakeGh, { mode: 0o755 });
		yield* fs.symlink(import.meta.dirname, `${root}/bin`);
		yield* fs.symlink(process.execPath, `${root}/tools/bun`);
		yield* Effect.forEach(Rec.toEntries(tools), ([name, path]) => fs.symlink(path, `${root}/tools/${name}`));

		if (verdict) {
			yield* passIn(`${root}/home`);
		}
	});

const gatedRun = (verdict: boolean, args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const root = yield* freshRoot;

		yield* gatedWorld(root, verdict);

		const run = Bun.spawn([`${root}/bin/gh`, ...args], {
			env: { PATH: `${root}/bin:${root}/real:${root}/tools`, HOME: `${root}/home` },
			stderr: "pipe",
		});

		const out = yield* Effect.promise(() => new Response(run.stdout).text());
		const err = yield* Effect.promise(() => new Response(run.stderr).text());

		return { code: yield* Effect.promise(() => run.exited), out, firstLine: Str.split(Str.trim(err), "\n")[0] ?? "" };
	});

const gatedRows = [
	{
		name: "refuses a merge with no verdict before the real gh merges",
		verdict: false,
		args: ["pr", "merge", "7", "--squash"],
		expect: { code: 1, out: "", firstLine: "merge gate: merge refused." },
	},
	{
		name: "hands a merge with a pass at its head to the real gh, pinned to that head",
		verdict: true,
		args: ["pr", "merge", "7", "--squash"],
		expect: { code: 0, out: `REAL[pr][merge][7][--squash][--match-head-commit][${head}]`, firstLine: "" },
	},
	{
		name: "hands a call that only names a merge to the real gh unchanged",
		verdict: false,
		args: ["issue", "view", "merge-1"],
		expect: { code: 0, out: "REAL[issue][view][merge-1]", firstLine: "" },
	},
];

test.each(gatedRows)("the gh wrapper $name", (row) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const got = yield* gatedRun(row.verdict, row.args);

			expect(got).toEqual(row.expect);
		}).pipe(Effect.provide(NodeServices.layer)),
	),
);

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${scratch}`.quiet())));
