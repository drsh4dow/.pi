/**
 * The run's isolated world: its folder layout, the environment every process in it gets, the scratch HOME whose
 * `.pi/agent` links to this worktree's `agent/`, and the `bin/pi` wrapper that loads the probe into every pi.
 */
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Str from "effect/String";

import { harnessEntries, withoutPackageBins } from "../harness.ts";
import { type Argv, execIn, type Exited, ran, startCore } from "./core.ts";
import { type ScenarioFailed, SetupFailed } from "./failed.ts";
import { modelsOf, type Setup, settingsOf } from "./setup.ts";

type Env = Readonly<Record<string, string>>;

/** Where everything of one run lives. The one place that knows the layout; every other module asks it. */
export interface Layout {
	/** `<name>-<yyyymmdd-hhmmss>-<driver pid>`, the run's own name. Every folder the run names outside its own holds it. */
	readonly id: string;
	/** `<tmp>/pi-driver/<id>`, kept as evidence after the run. */
	readonly folder: string;
	/** `HOME` for every process in the run, so `~/.pi/agent`, `~/.local/state` and `~/.config` are the run's. */
	readonly home: string;
	/** `PI_CODING_AGENT_DIR`, `<home>/.pi/agent`: links to the worktree's shipped entries and the human's `auth.json`. */
	readonly agent: string;
	/** First on the run's PATH. Holds the `pi` wrapper that adds the probe and refuses to start outside `folder`. */
	readonly bin: string;
	/** Each working folder outside `folder` that the wrapper refused, one per line. */
	readonly refused: string;
	/** `PI_DRIVER_PROBE`: one JSON lines file per pi process. */
	readonly probe: string;
	/** The root's cwd, `<folder>/<id>`, so a session or state folder named for it holds `id`. Empty at the start. */
	readonly project: string;
	/** `--session-dir` of the root. owned-work puts delegates' sessions in `delegates/` under it. */
	readonly sessions: string;
	/** `HC_SESSION` of the run's core, unique even when a pid is reused. */
	readonly coreSession: string;
	/** The core's `XDG_RUNTIME_DIR`, outside `folder` because a socket path holds at most 108 bytes. */
	readonly runtime: string;
	readonly socket: string;
	readonly report: string;
	readonly rpcIn: string;
	readonly rpcOut: string;
	readonly rootStderr: string;
	readonly coreLog: string;
}

export const layoutOf = (run: {
	readonly tmp: string;
	readonly name: string;
	readonly stamp: string;
	readonly pid: number;
	readonly tag: string;
}): Layout => {
	const id = `${run.name}-${run.stamp}-${String(run.pid)}`;
	const folder = `${run.tmp}/pi-driver/${id}`;
	const coreSession = `pi-driver-${String(run.pid)}-${run.tag}`;
	const runtime = `${run.tmp}/pi-driver/${coreSession}`;

	return {
		id,
		folder,
		home: `${folder}/home`,
		agent: `${folder}/home/.pi/agent`,
		bin: `${folder}/bin`,
		refused: `${folder}/refused.txt`,
		probe: `${folder}/probe`,
		project: `${folder}/${id}`,
		sessions: `${folder}/sessions`,
		coreSession,
		runtime,
		socket: `${runtime}/herdr-core/${coreSession}.sock`,
		report: `${folder}/report.txt`,
		rpcIn: `${folder}/root.in.jsonl`,
		rpcOut: `${folder}/root.out.jsonl`,
		rootStderr: `${folder}/root.stderr`,
		coreLog: `${folder}/core.log`,
	};
};

const followsHome = new Set(["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]);

/**
 * Pure. The environment of every process in the run, from the driver's own.
 *
 * - Drops every `HC_*` and `PI_*` key: the driver may itself run inside a delegate, and owned-work reads any
 *   `PI_OWNED_WORK_LEVEL` as "I am a delegate".
 * - Drops the `XDG_*_HOME` overrides, so they follow the scratch HOME. Keeps `XDG_RUNTIME_DIR`: `systemd-run --user`
 *   reaches the user manager through it.
 * - PATH loses `node_modules/.bin` folders and every folder under `<human home>/.pi/` (the live harness's `agent/bin`),
 *   and starts with the run's `bin/`.
 * - `HC_SOCKET` (the `hc` CLI) and `HC_TERMINAL_SOCKET` (owned-work's client) name the run's core.
 * - `borrowed` adds the human's git and gh config locations that exist.
 */
export const runEnv = ({
	own,
	humanHome,
	layout,
	borrowed,
}: {
	readonly own: Readonly<Record<string, string | undefined>>;
	readonly humanHome: string;
	readonly layout: Layout;
	readonly borrowed: Env;
}) => {
	const kept = Rec.filterMap(own, (value, key) =>
		value === undefined || /^(?:HC|PI)_/u.test(key) || followsHome.has(key) ? Result.failVoid : Result.succeed(value),
	);

	const isLiveHarness = (folder: string) =>
		folder === `${humanHome}/.pi` || Str.startsWith(`${humanHome}/.pi/`)(folder);

	const path = Arr.filter(Str.split(withoutPackageBins(kept).PATH, ":"), (folder) => !isLiveHarness(folder));

	return {
		...kept,
		...borrowed,
		PATH: Arr.join([layout.bin, ...path], ":"),
		HOME: layout.home,
		PI_CODING_AGENT_DIR: layout.agent,
		PI_DRIVER_PROBE: layout.probe,
		HC_SESSION: layout.coreSession,
		HC_SOCKET: layout.socket,
		HC_TERMINAL_SOCKET: layout.socket,
	};
};

/** What the run is, once built. Closing its scope stops the core, whose guardian unlinks the human's `auth.json`. */
export interface World {
	readonly layout: Layout;
	/** The worktree's `agent/`, the real folder the agent folder's links point into. */
	readonly agentDir: string;
	readonly env: Env;
	/** The `pi` the human's PATH resolves, through links, and its version. The `bin/pi` wrapper runs it. */
	readonly pi: { readonly version: string; readonly path: string };
	readonly exec: (argv: Argv) => Effect.Effect<Exited, ScenarioFailed>;
}

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject));

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject, { space: "\t" }));

const worktree = Str.replace(/\/tools\/driver$/u, "")(import.meta.dirname);

/** Links the worktree's shipped entries and the human's credentials. The core's guardian removes the credentials link. */
const linkAgent = Effect.fn("linkAgent")(function* (layout: Layout, humanAgent: string) {
	const fs = yield* FileSystem.FileSystem;
	const gitignore = yield* fs.readFileString(`${worktree}/.gitignore`);
	const shipped = yield* Effect.filter(harnessEntries(gitignore), (entry) => fs.exists(`${worktree}/agent/${entry}`));

	yield* Effect.forEach(shipped, (entry) => fs.symlink(`${worktree}/agent/${entry}`, `${layout.agent}/${entry}`));
	yield* fs.symlink(`${humanAgent}/auth.json`, `${layout.agent}/auth.json`);

	if (yield* fs.exists(`${humanAgent}/models-store.json`)) {
		yield* fs.copyFile(`${humanAgent}/models-store.json`, `${layout.agent}/models-store.json`);
	}
});

/** Writes the run's `settings.json`, and its `models.json` when the human or the setup has one. */
const writeConfig = Effect.fn("writeConfig")(function* (layout: Layout, setup: Setup, humanAgent: string) {
	const fs = yield* FileSystem.FileSystem;

	const readHuman = (file: string) =>
		Effect.flatMap(fs.exists(`${humanAgent}/${file}`), (exists) =>
			exists
				? Effect.asSome(Effect.flatMap(fs.readFileString(`${humanAgent}/${file}`), decodeJson))
				: Effect.succeedNone,
		);

	const humanSettings = yield* readHuman("settings.json");
	const humanModels = yield* readHuman("models.json");

	const settings = yield* encodeJson(
		settingsOf({ human: Option.getOrElse(humanSettings, () => ({})), overrides: setup.settings ?? {} }),
	);

	yield* fs.writeFileString(`${layout.agent}/settings.json`, settings);

	if (Option.isNone(humanModels) && setup.models === undefined) {
		return;
	}

	const models = yield* encodeJson(modelsOf({ human: humanModels, providers: setup.models ?? {} }));

	yield* fs.writeFileString(`${layout.agent}/models.json`, models);
});

/**
 * The `pi` on the run's PATH, through links, before the wrapper exists, and its version. pi names a session folder for
 * its working folder, so the wrapper starts pi only inside the run's folder, whose path holds the run's id.
 */
const resolvePi = Effect.fn("resolvePi")(function* (layout: Layout, env: Env) {
	const fs = yield* FileSystem.FileSystem;
	const found = yield* ran({ argv: ["sh", "-c", "command -v pi"], env, cwd: layout.folder });

	if (found.code !== 0) {
		return yield* SetupFailed.make({ message: "no pi on PATH" });
	}

	const path = yield* fs.realPath(Str.trim(found.output));
	const version = yield* ran({ argv: [path, "--version"], env, cwd: layout.folder });
	const folder = yield* fs.realPath(layout.folder);

	const wrapper = `#!/bin/sh
case "$(pwd -P)/" in '${folder}'/*) exec '${path}' -e '${worktree}/tools/driver/probe.ts' "$@" ;; esac
pwd -P >>'${layout.refused}'
echo "pi starts only inside the run folder ${folder}, not in $(pwd -P)" >&2
exit 2
`;

	yield* fs.writeFileString(`${layout.bin}/pi`, wrapper, { mode: 0o755 });

	return { version: Str.trim(version.output), path };
});

type Needs = Scope.Scope | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner;

/** The run's environment from the driver's own, with the human's git and gh config when they exist. */
const envOf = Effect.fn("envOf")(function* (layout: Layout) {
	const fs = yield* FileSystem.FileSystem;
	const humanHome = yield* Config.String("HOME");
	const borrowable = { GIT_CONFIG_GLOBAL: `${humanHome}/.gitconfig`, GH_CONFIG_DIR: `${humanHome}/.config/gh` };
	const borrowed = yield* Effect.filter(Rec.toEntries(borrowable), ([, file]) => fs.exists(file));

	return { humanHome, env: runEnv({ own: process.env, humanHome, layout, borrowed: Rec.fromEntries(borrowed) }) };
});

/**
 * Builds the world in order, each step's undo registered in the scope as it lands, so a failure at any step undoes
 * exactly the steps before it. The core starts before the credentials link exists, so the guardian that removes the
 * link outlives the driver from the moment there is one. Every failure is `SetupFailed`.
 */
export const openWorld = (input: {
	readonly layout: Layout;
	readonly setup: Setup;
}): Effect.Effect<World, SetupFailed, Needs> =>
	Effect.gen(function* () {
		const { layout } = input;
		const fs = yield* FileSystem.FileSystem;
		const { humanHome, env } = yield* envOf(layout);

		yield* Effect.forEach([layout.agent, layout.bin, layout.probe, layout.project, layout.sessions], (folder) =>
			fs.makeDirectory(folder, { recursive: true }),
		);

		const pi = yield* resolvePi(layout, env);

		yield* startCore({ layout, env });
		yield* linkAgent(layout, `${humanHome}/.pi/agent`);
		yield* writeConfig(layout, input.setup, `${humanHome}/.pi/agent`);

		const exec = yield* execIn({ env, cwd: layout.project });

		return { layout, agentDir: `${worktree}/agent`, env, pi, exec };
	}).pipe(
		Effect.catchTags({
			PlatformError: (error) => Effect.fail(SetupFailed.make({ message: error.message })),
			SchemaError: (error) =>
				Effect.fail(SetupFailed.make({ message: `a JSON file did not parse: ${error.message}` })),
			ConfigError: (error) => Effect.fail(SetupFailed.make({ message: error.message })),
		}),
	);
