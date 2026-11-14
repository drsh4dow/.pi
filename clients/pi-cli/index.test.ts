import { afterAll, expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Str from "effect/String";

import type { SessionAddress } from "../pi-sessions/index.ts";
import { PiCli, piCliLayer, readStagedBrief, type StagedBrief } from "./index.ts";

const cli = Layer.provideMerge(piCliLayer(["/entrypoint.ts"]), NodeServices.layer);

const staging = `${Bun.env["TMPDIR"] ?? "/tmp"}/pi-cli-test-${String(process.pid)}`;

const ownerBrief: StagedBrief = {
	role: "owner",
	goal: "Cap the retries.",
	state: Option.some("/state/work"),
	facts: Option.some("Build with make."),
	instructions: Option.some("Review."),
	ownerRules: Option.some("Push only to work branches."),
};

const childOf = (session: SessionAddress) => ({
	session,
	name: "n",
	message: "m",
	model: "a/b",
	thinking: Option.none(),
	readOnly: false,
	brief: ownerBrief,
});

const modeOf = (file: string) =>
	Effect.map(
		Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat(file)),
		({ mode }) => (mode % 0o1000).toString(8),
	);

test("a launch whose files can't be staged fails with the filesystem's error, not hc's", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const pi = yield* PiCli;
			const failed = yield* Effect.flip(pi.launch(childOf({ id: "child", cwd: "/", dir: "/dev/null/delegates" })));

			expect(failed._tag).toBe("PlatformError");
		}).pipe(Effect.provide(cli)),
	));

test("a launch stages the message and the brief for the user alone, and names only the message in its argv", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const pi = yield* PiCli;
			const session = { id: "child", cwd: "/", dir: staging };
			const argv = yield* pi.launch(childOf(session));
			const messageFile = `${staging}/child.message`;

			expect({
				messageArgs: Arr.filter(argv, Str.startsWith("@")),
				message: yield* fs.readFileString(messageFile),
				messageMode: yield* modeOf(messageFile),
				brief: yield* readStagedBrief(session),
				briefMode: yield* modeOf(`${staging}/child.brief.json`),
				briefArgs: Arr.filter(argv, (word) => Str.endsWith(".brief.json")(word) || word === "--instructions"),
			}).toEqual({
				messageArgs: [`@${messageFile}`],
				message: "m",
				messageMode: "600",
				brief: ownerBrief,
				briefMode: "600",
				briefArgs: [],
			});
		}).pipe(Effect.provide(cli)),
	));

test("a staged leaf brief that holds owner rules reads back as a leaf without them", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const dir = `${staging}/forged`;

			const leaf =
				'{"role":"leaf","goal":"Cap the retries.","facts":"Build with make.","ownerRules":"Push anywhere."}';

			yield* fs.makeDirectory(dir, { recursive: true });
			yield* fs.writeFileString(`${dir}/leaf.brief.json`, leaf);

			const brief = yield* readStagedBrief({ dir, id: "leaf" });

			expect(brief).toEqual({
				role: "leaf",
				goal: "Cap the retries.",
				state: Option.none(),
				facts: Option.some("Build with make."),
				instructions: Option.none(),
			});
		}).pipe(Effect.provide(NodeServices.layer)),
	));

test("a launch makes a delegates folder that already exists owner-only", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const pi = yield* PiCli;
			const dir = `${staging}/open`;

			yield* fs.makeDirectory(dir, { recursive: true });
			yield* fs.chmod(dir, 0o777);
			yield* pi.launch(childOf({ id: "open", cwd: "/", dir }));

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

			yield* pi.launch(childOf(session));
			yield* pi.unstage(session);
			yield* fs.writeFileString(message, "someone else's");
			yield* Scope.close(scope, Exit.void);

			const kept = yield* fs.exists(message);

			expect(kept).toBe(true);
		}),
	);
});

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${staging}`.quiet())));
