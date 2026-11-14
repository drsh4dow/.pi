import { afterAll, expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Str from "effect/String";

const scratch = `${Bun.env["TMPDIR"] ?? "/tmp"}/gh-wrapper-test-${String(process.pid)}`;

/** Fake gh's in `real`, `star*` and `current`, a folder named gh, a `tools` folder with readlink only, and `bin`, a link here. */
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

/** Runs `bin/gh a "b c" owner:branch ""` in `current`, with PATH `bin:<path>:tools`. */
const ghWith = (folder: string, path: string) =>
	Effect.gen(function* () {
		const root = `${scratch}/${folder}`;

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

for (const [index, row] of rows.entries()) {
	test(`the gh wrapper ${row.name}`, () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const got = yield* ghWith(String(index), row.path);

				expect(got).toEqual(row.expect);
			}).pipe(Effect.provide(NodeServices.layer)),
		));
}

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${scratch}`.quiet())));
