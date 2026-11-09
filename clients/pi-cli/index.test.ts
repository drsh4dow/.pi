import { afterAll, expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Str from "effect/String";

import { instructionsFlag, PiCli, piCliLayer } from "./index.ts";

const cli = Layer.provideMerge(piCliLayer(["/entrypoint.ts"]), NodeServices.layer);

const staging = `${Bun.env["TMPDIR"] ?? "/tmp"}/pi-cli-test-${String(process.pid)}`;

const stagedFiles = (argv: ReadonlyArray<string>) => {
	const instructions = Arr.filter(Arr.zip(argv, Arr.drop(argv, 1)), ([flag]) => flag === `--${instructionsFlag}`);
	const messages = Arr.map(Arr.filter(argv, Str.startsWith("@")), (word) => ["@", Str.slice(1)(word)] as const);

	return Effect.flatMap(FileSystem.FileSystem, (fs) =>
		Effect.forEach([...instructions, ...messages], ([flag, file]) =>
			Effect.zipWith(
				fs.readFileString(file),
				fs.stat(file),
				(text, { mode }) => `${flag} ${text} ${(mode % 0o1000).toString(8)}`,
			),
		),
	);
};

const rows = [
	{
		name: "a launch whose files can't be staged fails with the filesystem's error, not hc's",
		dir: "/dev/null/delegates",
		expect: ["PlatformError"],
	},
	{
		name: "a launch stages the delegate's instructions for the child's prompt extension, and both files for the user alone",
		dir: staging,
		expect: ["--instructions Review. 600", "@ m 600"],
	},
];

for (const row of rows) {
	test(row.name, () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const pi = yield* PiCli;
				const session = { id: "child", cwd: "/", dir: row.dir };
				const loadout = { model: "a/b", instructions: "Review." };

				const got = yield* pi
					.launch({ session, name: "n", message: "m", loadout })
					.pipe(
						Effect.matchEffect({ onFailure: (error) => Effect.succeed([error._tag]), onSuccess: stagedFiles }),
					);

				expect(got).toEqual(row.expect);
			}).pipe(Effect.provide(cli)),
		),
	);
}

test("a launch makes a delegates folder that already exists owner-only", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const pi = yield* PiCli;
			const dir = `${staging}/open`;
			const loadout = { model: "a/b", instructions: "Review." };

			yield* fs.makeDirectory(dir, { recursive: true });
			yield* fs.chmod(dir, 0o777);
			yield* pi.launch({ session: { id: "open", cwd: "/", dir }, name: "n", message: "m", loadout });

			const { mode } = yield* fs.stat(dir);

			expect((mode % 0o1000).toString(8)).toBe("700");
		}).pipe(Effect.provide(cli)),
	));

test("closing the client leaves alone the paths of a child it already unstaged", () => {
	const session = { id: "unstaged", cwd: "/", dir: staging };
	const message = `${staging}/unstaged.message`;

	return Effect.runPromise(
		Effect.gen(function* () {
			const scope = yield* Scope.make();
			const context = yield* Layer.buildWithScope(cli, scope);
			const pi = Context.get(context, PiCli);
			const fs = Context.get(context, FileSystem.FileSystem);

			yield* pi.launch({
				session,
				name: "n",
				message: "m",
				loadout: { model: "a/b", instructions: "R." },
			});
			yield* pi.unstage(session);
			yield* fs.writeFileString(message, "someone else's");
			yield* Scope.close(scope, Exit.void);

			const kept = yield* fs.exists(message);

			expect(kept).toBe(true);
		}),
	);
});

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${staging}`.quiet())));
