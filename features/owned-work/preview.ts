import { uuidv7 } from "@earendil-works/pi-ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";

import { PiCli, piCliLayer } from "../../clients/pi-cli/index.ts";
import { stateFilesFor } from "./brief.ts";
import { type Brief, childExtensions, type ChildRole, inheritedEnv, launch, levels } from "./child.ts";
import { type Alias, aliases, ModelName, modelTable } from "./models.ts";
import { parseProfile } from "./profile.ts";

/** One delegate as its parent would start it, minus the systemd scope and hc terminal around it. */
export interface StagedLaunch {
	readonly name: string;
	readonly role: ChildRole;
	readonly level: number;
	readonly argv: ReadonlyArray<string>;
	readonly env: Readonly<Record<string, string>>;
}

const instructionsFolder = `${import.meta.dirname}/../../agent/instructions`;

const keyOf = ({ provider, id }: Alias) => `${provider}/${id}`;

/** An alias runs on its own provider, since no caller stands behind a staged delegate. */
const stagedModel = (name: ModelName) =>
	ModelName.$match(name, {
		Spelled: ({ key }) => key,
		Alias: ({ alias }) => Option.match(Rec.get(modelTable.aliases, alias), { onNone: () => alias, onSome: keyOf }),
	});

const goal = "Capture the system prompt each delegate gets.";

/** A staged delegate's brief before its message and state folder, and its level. */
interface Staged extends Pick<Brief, "name" | "model" | "thinking" | "readOnly" | "instructions"> {
	readonly role: ChildRole;
	readonly level: number;
}

const bare = (name: string, role: ChildRole, level: number): Staged => ({
	name,
	role,
	level,
	model: keyOf(aliases.judgment),
	thinking: Option.none(),
	readOnly: false,
	instructions: Option.none(),
});

/** An owner that can delegate, an owner at the last level that cannot, and a leaf. */
const bareDelegates = [bare("owner", "owner", 2), bare("owner-last-level", "owner", levels), bare("leaf", "leaf", 2)];

/** A level-2 delegate on a harness instructions file, in the role and on the model its profile names. */
const onInstructionsFile = Effect.fn("onInstructionsFile")(function* (file: string) {
	const fs = yield* FileSystem.FileSystem;
	const profile = yield* Effect.flatMap(fs.readFileString(`${instructionsFolder}/${file}`), parseProfile);
	const role = yield* Effect.fromOption(profile.role, () => `instructions file ${file} names no role`);
	const model = yield* Effect.fromOption(profile.model, () => `instructions file ${file} names no model`);

	const staged: Staged = {
		name: Str.replace(/\.md$/u, "")(file),
		role,
		level: 2,
		model: stagedModel(model),
		thinking: profile.thinking,
		readOnly: profile.readOnly,
		instructions: Option.some({ file, text: profile.text }),
	};

	return staged;
});

/**
 * Stages, on `message`, one level-2 delegate per harness instructions file, in the role its profile names, and the bare
 * delegates above, with the same `launch` the ledger uses, so a tool can run each and see exactly what it receives. Each
 * reads its project facts and owner rules from `state` as a call would. The staged files live in `dir` until the
 * caller's scope closes.
 */
export const stagedLaunches = Effect.fn("stagedLaunches")(function* (
	cwd: string,
	dir: string,
	message: string,
	state: string,
) {
	const fs = yield* FileSystem.FileSystem;
	const files = yield* fs.readDirectory(instructionsFolder);

	const services = yield* Layer.build(piCliLayer(childExtensions));
	const cli = Context.get(services, PiCli);

	const withInstructions = yield* Effect.forEach(files, onInstructionsFile);

	return yield* Effect.forEach([...withInstructions, ...bareDelegates], ({ level, role, ...staged }) =>
		Effect.gen(function* () {
			const stateFiles = yield* stateFilesFor(Option.some(state), role);
			const brief: Brief = { ...staged, message, goal, state: Option.some(state), ...stateFiles };

			const spec = yield* launch(cli)({
				brief,
				level,
				childSession: { cwd, dir: `${dir}/${brief.name}`, id: uuidv7() },
				passEnv: inheritedEnv(process.env),
			});

			// In a real launch the systemd client's `wrap` sets the slice. A child without one fails to start.
			const launched: StagedLaunch = {
				name: brief.name,
				role,
				level,
				argv: spec.argv,
				env: { ...spec.env, PI_OWNED_WORK_SLICE: `pi-ow-prompts-${brief.name}` },
			};

			return launched;
		}),
	);
});
