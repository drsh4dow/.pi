import { uuidv7 } from "@earendil-works/pi-ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { PiCli, piCliLayer } from "../../clients/pi-cli/index.ts";
import { childExtensions, inheritedEnv, launch, levels } from "./child.ts";

/** One delegate as the root would start it, minus the systemd scope and hc terminal around it. */
export interface StagedLaunch {
	readonly name: string;
	readonly level: number;
	readonly argv: ReadonlyArray<string>;
	readonly env: Readonly<Record<string, string>>;
}

const instructionsFolder = `${import.meta.dirname}/../../agent/instructions`;

/**
 * Stages, on `message`, one level-2 delegate per harness instructions file and one bare delegate at the last level, with
 * the same `launch` the ledger uses, so a tool can run each and see exactly what it receives. Each takes its file's name,
 * so no naming call runs. The staged files live in `dir` until the caller's scope closes.
 */
export const stagedLaunches = Effect.fn("stagedLaunches")(function* (cwd: string, dir: string, message: string) {
	const fs = yield* FileSystem.FileSystem;
	const files = yield* fs.readDirectory(instructionsFolder);

	const withInstructions = yield* Effect.forEach(files, (file) =>
		Effect.map(fs.readFileString(`${instructionsFolder}/${file}`), (text) => ({
			name: Str.replace(/\.md$/u, "")(file),
			level: 2,
			instructions: Option.some({ file, text }),
		})),
	);

	const services = yield* Layer.build(piCliLayer(childExtensions));
	const cli = Context.get(services, PiCli);

	const stage = ({ name, level, instructions }: (typeof withInstructions)[number]) =>
		Effect.map(
			launch(cli)({
				brief: { name, message, model: "anthropic/claude-opus-5-5", thinking: Option.none(), instructions },
				level,
				ref: "delegate-1",
				agentKey: "prompts",
				childSession: { cwd, dir: `${dir}/${name}`, id: uuidv7() },
				passEnv: inheritedEnv(process.env),
			}),
			// In a real launch the systemd client's `wrap` sets the slice. A child without one fails to start.
			(spec): StagedLaunch => ({
				name,
				level,
				argv: spec.argv,
				env: { ...spec.env, PI_OWNED_WORK_SLICE: `pi-ow-prompts-${name}` },
			}),
		);

	return yield* Effect.forEach(
		[...withInstructions, { name: "bare", level: levels, instructions: Option.none() }],
		stage,
	);
});
