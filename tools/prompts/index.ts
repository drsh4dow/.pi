/**
 * `bun run prompts [project-dir]` writes `system-prompts.md` at the harness root: the exact first-turn request pi builds
 * for stock pi, for our root agent, and for owners and leaves at each level. No request is sent.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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

import { inheritedEnv, levels, type StagedLaunch, stagedLaunches } from "../../features/owned-work/index.ts";
import { harnessEntries, withoutPackageBins } from "../harness.ts";
import { type Capture, Payload, render } from "./render.ts";

const captureExtension = `${import.meta.dirname}/capture.ts`;

const message = "Capture run: reply with the single word ok.";

type Env = Readonly<Record<string, string>>;

interface Run {
	readonly key: string;
	readonly title: string;
	readonly about: string;
	readonly argv: ReadonlyArray<string>;
	readonly env: Env;
}

/** The environment the user's own pi gets. `bun run` puts `node_modules/.bin` folders first in `PATH`, which would run this repo's dev copy of pi. */
const userEnv = withoutPackageBins(inheritedEnv(process.env));

class CaptureFailed extends Schema.TaggedError<CaptureFailed, { readonly brand: unique symbol }>()("CaptureFailed", {
	message: Schema.String,
}) {}

const decodePayload = Schema.decodeEffect(Schema.fromJsonString(Payload));

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

	return { title: run.title, about: run.about, payload } satisfies Capture;
});

/** The user's own agent folder, which holds what the harness does not ship: credentials, settings, sessions. */
const userAgentDir = getAgentDir();

/** Links to every entry of the user's agent folder the harness does not ship. Links, not copies, so an auth refresh lands in the real file. */
const stockAgentDir = Effect.fn("stockAgentDir")(function* (harnessRoot: string, into: string) {
	const fs = yield* FileSystem.FileSystem;
	const listed = yield* fs.readDirectory(userAgentDir);
	const gitignore = yield* fs.readFileString(`${harnessRoot}/.gitignore`);
	const shipped = harnessEntries(gitignore);

	yield* fs.makeDirectory(into);
	yield* Effect.forEach(Arr.difference(listed, shipped), (entry) =>
		fs.symlink(`${userAgentDir}/${entry}`, `${into}/${entry}`),
	);

	return into;
});

const aboutOf = ({ role, level }: StagedLaunch) => {
	if (role === "leaf") {
		return "A child pi the `delegate` tool started as a leaf, on one bounded task. It has no `delegate` tool and no playbooks.";
	}

	return level < levels
		? "A child pi the `delegate` tool started as an owner, on one slice. It can start delegates of its own."
		: "A child pi started as an owner at the last level, so it has no `delegate` tool.";
};

/**
 * Links each entry of the user's agent folder that `agentDir` lacks into it until the scope closes, so a git worktree's
 * agents run on the user's credentials and settings. In `~/.pi` itself it links nothing.
 */
const borrowUserState = Effect.fn("borrowUserState")(function* (agentDir: string) {
	const fs = yield* FileSystem.FileSystem;
	const own = yield* fs.readDirectory(agentDir);
	const user = yield* fs.readDirectory(userAgentDir);

	yield* Effect.forEach(Arr.difference(user, own), (entry) =>
		Effect.acquireRelease(fs.symlink(`${userAgentDir}/${entry}`, `${agentDir}/${entry}`), () =>
			Effect.orDie(fs.remove(`${agentDir}/${entry}`)),
		),
	);
});

const delegateRun = (launch: StagedLaunch, harnessEnv: Env): Run => ({
	key: `delegate-${launch.name}`,
	title: `Delegate \`${launch.name}\` (${launch.role}, level ${String(launch.level)})`,
	about: aboutOf(launch),
	argv: launch.argv,
	env: { ...withoutPackageBins(launch.env), ...harnessEnv },
});

const piRun = (key: string, title: string, about: string, env: Env): Run => ({
	key,
	title,
	about,
	argv: ["pi", "--no-session", "--", message],
	env,
});

const captureAll = Effect.fn("captureAll")(function* (harnessRoot: string, project: string, workDir: string) {
	const agentDir = `${harnessRoot}/agent`;
	const harnessEnv = { PI_CODING_AGENT_DIR: agentDir };

	yield* borrowUserState(agentDir);

	const stockDir = yield* stockAgentDir(harnessRoot, `${workDir}/stock-agent`);
	const staged = yield* stagedLaunches(project, `${workDir}/delegates`, message);

	const run = (each: Run) => capture(each, project, workDir);

	return yield* Effect.all(
		{
			stock: run(
				piRun("stock", "Stock pi", "pi without this harness: no `SYSTEM.md` and no harness extensions.", {
					...userEnv,
					PI_CODING_AGENT_DIR: stockDir,
				}),
			),
			root: run(piRun("root", "Root agent", "The pi you start and talk to.", { ...userEnv, ...harnessEnv })),
			delegates: Effect.forEach(
				Arr.map(staged, (launch) => delegateRun(launch, harnessEnv)),
				run,
				{ concurrency: "unbounded" },
			),
		},
		{ concurrency: "unbounded" },
	);
});

const reportOf = Effect.fn("reportOf")(function* (harnessRoot: string, project: string) {
	const fs = yield* FileSystem.FileSystem;
	const workDir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-prompts-" });
	const { stock, root, delegates } = yield* captureAll(harnessRoot, project, workDir);
	const version = yield* spawn(["pi", "--version"], project, userEnv);

	return { piVersion: Str.trim(version.output), project, captures: [stock, root, ...delegates] };
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
