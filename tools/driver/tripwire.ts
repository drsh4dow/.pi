/**
 * The tripwire for a run's isolation. What the run names outside its own folder carries its run id or its core's
 * session: pi names a session folder for its working folder, an agent names its state folder for its project, and the
 * core names its state folder for its session. So either name under the human's session or state folders is this run's
 * write, whoever else writes there meanwhile.
 */
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Str from "effect/String";

import { ran } from "./core.ts";
import { SetupFailed } from "./failed.ts";
import type { Layout } from "./world.ts";

type Names = readonly [string, ...Array<string>];

/** `find`'s test for a name that holds any of `names`. */
const holdingAny = ([first, ...rest]: Names) => [
	"(",
	"-name",
	`*${first}*`,
	...Arr.flatMap(rest, (name) => ["-o", "-name", `*${name}*`]),
	")",
];

/** Every path under `home`'s session and state folders whose own name holds one of `names`. A linked root is followed. */
export const strayed = Effect.fn("strayed")(function* (input: { readonly home: string; readonly names: Names }) {
	const fs = yield* FileSystem.FileSystem;
	const folders = [`${input.home}/.pi/agent/sessions`, `${input.home}/.local/state`];
	const roots = yield* Effect.filter(folders, (folder) => fs.exists(folder));

	if (Arr.isReadonlyArrayEmpty(roots)) {
		return [];
	}

	const env = { PATH: yield* Config.String("PATH") };
	const found = yield* ran({ argv: ["find", "-H", ...roots, ...holdingAny(input.names), "-print"], env, cwd: "/" });

	if (found.code !== 0) {
		return yield* SetupFailed.make({ message: `the tripwire could not list your folders: ${found.output}` });
	}

	return Arr.filter(Str.split(found.output, "\n"), Str.isNonEmpty);
});

/** Fails with `SetupFailed`, exit 2, naming each path the run wrote under the human's session and state folders. */
export const leftAlone = Effect.fn("leftAlone")(
	function* (layout: Layout) {
		const home = yield* Config.String("HOME");
		const leaked = yield* strayed({ home, names: [layout.id, layout.coreSession] });

		return Arr.isReadonlyArrayNonEmpty(leaked)
			? yield* SetupFailed.make({ message: `the run wrote under your folders: ${Arr.join(leaked, " ")}` })
			: undefined;
	},
	Effect.catchTags({
		PlatformError: (error) => Effect.fail(SetupFailed.make({ message: `the tripwire failed: ${error.message}` })),
		ConfigError: (error) => Effect.fail(SetupFailed.make({ message: `the tripwire failed: ${error.message}` })),
	}),
);
