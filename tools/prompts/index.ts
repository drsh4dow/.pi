/**
 * `bun run prompts [project-dir]` writes `system-prompts.md` at the harness root: the exact first-turn request pi builds
 * for stock pi, for our root agent, and for each harness delegate, with diffs between them. No request is sent.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";

import { inheritedEnv, type StagedLaunch, stagedLaunches } from "../../features/owned-work/index.ts";
import { type Capture, type Diff, Payload, promptOf, render, Tool } from "./render.ts";

const captureExtension = `${import.meta.dirname}/capture.ts`;

/** What `.gitignore` lets this repo ship in `agent/`. Stock pi gets every other entry of the agent dir. */
const harnessEntries = [
	"extensions",
	"delegates",
	"skills",
	"prompts",
	"themes",
	"AGENTS.md",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
	"keybindings.json",
];

const message = "Capture run: reply with the single word ok.";

type Env = Readonly<Record<string, string>>;

interface Run {
	readonly key: string;
	readonly title: string;
	readonly argv: ReadonlyArray<string>;
	readonly env: Env;
}

const isPackageBin = Str.endsWith("/node_modules/.bin");

const withoutPackageBins = (env: Env) => {
	const folders = Str.split(env["PATH"] ?? "", ":");

	return {
		...env,
		PATH: Arr.join(
			Arr.filter(folders, (folder) => !isPackageBin(folder)),
			":",
		),
	};
};

/** The environment the user's own pi gets. `bun run` puts `node_modules/.bin` folders first in `PATH`, which would run this repo's dev copy of pi. */
const userEnv = withoutPackageBins(inheritedEnv(process.env));

class CaptureFailed extends Schema.TaggedError<CaptureFailed, { readonly brand: unique symbol }>()("CaptureFailed", {
	message: Schema.String,
}) {}

const decodePayload = Schema.decodeEffect(Schema.fromJsonString(Payload));

const encodeTools = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Tool), { space: 2 }));

const spawn = Effect.fn("spawn")(function* (argv: ReadonlyArray<string>, cwd: string, env: Env) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const [program = "", ...args] = argv;
	const handle = yield* spawner.spawn(ChildProcess.make(program, args, { cwd, env, stdin: "ignore" }));

	return yield* Effect.all(
		{ code: handle.exitCode, output: handle.all.pipe(Stream.decodeText, Stream.mkString) },
		{ concurrency: 2 },
	);
}, Effect.scoped);

/** `argv` with the capture extension and print mode added before the `--` that ends pi's options. */
const withCapture = (argv: ReadonlyArray<string>) => {
	const optionsEnd = Option.getOrElse(
		Arr.findLastIndex(argv, (arg) => arg === "--"),
		() => Arr.length(argv),
	);

	return [...Arr.take(argv, optionsEnd), "-e", captureExtension, "-p", ...Arr.drop(argv, optionsEnd)];
};

const capture = Effect.fn("capture")(function* (run: Run, cwd: string, workDir: string) {
	const fs = yield* FileSystem.FileSystem;
	const file = `${workDir}/${run.key}.payload.json`;
	const { code, output } = yield* spawn(withCapture(run.argv), cwd, { ...run.env, PI_PROMPTS_CAPTURE: file });
	const written = yield* fs.exists(file);

	if (!written) {
		return yield* CaptureFailed.make({
			message: `${run.key}: pi exited ${code} before its first request:\n${output}`,
		});
	}

	const payload = yield* Effect.flatMap(fs.readFileString(file), decodePayload);
	const toolsJson = yield* encodeTools(payload.tools);

	return { key: run.key, title: run.title, payload, toolsJson } satisfies Capture;
});

/** Links to every entry of `agentDir` the harness does not ship. Links, not copies, so an auth refresh lands in the real file. */
const stockAgentDir = Effect.fn("stockAgentDir")(function* (agentDir: string, into: string) {
	const fs = yield* FileSystem.FileSystem;
	const listed = yield* fs.readDirectory(agentDir);

	yield* fs.makeDirectory(into);
	yield* Effect.forEach(Arr.difference(listed, harnessEntries), (entry) =>
		fs.symlink(`${agentDir}/${entry}`, `${into}/${entry}`),
	);

	return into;
});

const delegateRun = (launch: StagedLaunch): Run => ({
	key: `delegate-${launch.name}`,
	title: `delegate \`${launch.name}\` (${launch.role})`,
	argv: launch.argv,
	env: withoutPackageBins(launch.env),
});

const piRun = (key: string, title: string, env: Env): Run => ({
	key,
	title,
	argv: ["pi", "--no-session", "--", message],
	env,
});

const diffOf = Effect.fn("diffOf")(function* (workDir: string, from: Capture, to: Capture) {
	const fs = yield* FileSystem.FileSystem;
	const fromFile = `${workDir}/${from.key}.prompt.txt`;
	const toFile = `${workDir}/${to.key}.prompt.txt`;

	yield* fs.writeFileString(fromFile, promptOf(from.payload));
	yield* fs.writeFileString(toFile, promptOf(to.payload));

	const argv = ["diff", "-u", "--label", from.key, "--label", to.key, fromFile, toFile];
	const { output } = yield* spawn(argv, workDir, userEnv);

	return { from: from.key, to: to.key, text: Str.trimEnd(output) } satisfies Diff;
});

/** Stock pi against our root, then our root against each delegate. */
const diffsOf = (workDir: string, stock: Capture, root: Capture, delegates: ReadonlyArray<Capture>) =>
	Effect.all([diffOf(workDir, stock, root), ...Arr.map(delegates, (delegate) => diffOf(workDir, root, delegate))]);

const captureAll = Effect.fn("captureAll")(function* (harnessRoot: string, project: string, workDir: string) {
	const stockDir = yield* stockAgentDir(`${harnessRoot}/agent`, `${workDir}/stock-agent`);
	const staged = yield* stagedLaunches(project, `${workDir}/delegates`, message);

	yield* Effect.forEach(staged.rejected, ({ file, why }) => Effect.logWarning(`skipped delegate ${file}: ${why}`));

	const run = (each: Run) => capture(each, project, workDir);

	return yield* Effect.all(
		{
			stock: run(piRun("stock", "stock pi", { ...userEnv, PI_CODING_AGENT_DIR: stockDir })),
			root: run(piRun("root", "our root agent", userEnv)),
			delegates: Effect.forEach(Arr.map(staged.launches, delegateRun), run, { concurrency: "unbounded" }),
		},
		{ concurrency: "unbounded" },
	);
});

const reportOf = Effect.fn("reportOf")(function* (harnessRoot: string, project: string) {
	const fs = yield* FileSystem.FileSystem;
	const workDir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-prompts-" });
	const { stock, root, delegates } = yield* captureAll(harnessRoot, project, workDir);
	const diffs = yield* diffsOf(workDir, stock, root, delegates);
	const version = yield* spawn(["pi", "--version"], project, userEnv);

	return { piVersion: Str.trim(version.output), project, message, captures: [stock, root, ...delegates], diffs };
});

const program = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const harnessRoot = path.resolve(import.meta.dirname, "../..");
	const project = path.resolve(process.argv[2] ?? harnessRoot);
	const report = yield* reportOf(harnessRoot, project);
	const out = `${harnessRoot}/system-prompts.md`;

	yield* fs.writeFileString(out, render(report));
	yield* Effect.log(`wrote ${out}`);
});

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
