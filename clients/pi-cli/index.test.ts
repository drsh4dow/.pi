import { afterAll, expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { instructionsFlag, PiCli, piCliLayer } from "./index.ts";

const cli = Layer.provideMerge(piCliLayer(["/entrypoint.ts"]), NodeServices.layer);

const staging = `${Bun.env["TMPDIR"] ?? "/tmp"}/pi-cli-test-${String(process.pid)}`;

const instructionFlags = (argv: ReadonlyArray<string>) => {
	const pairs = Arr.filter(Arr.zip(argv, Arr.drop(argv, 1)), ([flag]) => flag === `--${instructionsFlag}`);

	return Effect.flatMap(FileSystem.FileSystem, (fs) =>
		Effect.forEach(pairs, ([flag, file]) => Effect.map(fs.readFileString(file), (text) => `${flag} ${text}`)),
	);
};

const rows = [
	{
		name: "a launch whose files can't be staged fails with the filesystem's error, not hc's",
		dir: "/dev/null/delegates",
		expect: ["PlatformError"],
	},
	{
		name: "a launch stages the delegate's instructions for the child's prompt extension, not as pi's appended prompt",
		dir: staging,
		expect: ["--instructions Review."],
	},
];

for (const row of rows) {
	test(row.name, () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const pi = yield* PiCli;
				const session = { id: "child", cwd: "/", dir: row.dir };
				const loadout = { model: "a/b", instructions: "Review.", tools: [] };

				const got = yield* pi.launch({ session, name: "n", message: "m", loadout }).pipe(
					Effect.matchEffect({
						onFailure: (error) => Effect.succeed([error._tag]),
						onSuccess: instructionFlags,
					}),
				);

				expect(got).toEqual(row.expect);
			}).pipe(Effect.provide(cli)),
		),
	);
}

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
				loadout: { model: "a/b", instructions: "R.", tools: [] },
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
