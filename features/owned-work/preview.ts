import { uuidv7 } from "@earendil-works/pi-ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";

import { PiCli, piCliLayer } from "../../clients/pi-cli/index.ts";
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

/** The model a profile names, with an alias on its own provider since no caller stands behind a staged delegate, or the root's Opus when it names none. */
const stagedModel = (named: Option.Option<ModelName>) =>
	Option.match(named, {
		onNone: () => keyOf(aliases.judgment),
		onSome: (name) =>
			ModelName.$match(name, {
				Spelled: ({ key }) => key,
				Alias: ({ alias }) =>
					Option.match(Rec.get(modelTable.aliases, alias), { onNone: () => alias, onSome: keyOf }),
			}),
	});

/** A staged delegate's brief before the message it runs on, and its level. */
interface Staged extends Omit<Brief, "message"> {
	readonly level: number;
}

const bare = (name: string, role: ChildRole, level: number): Staged => ({
	name,
	role,
	level,
	model: stagedModel(Option.none()),
	thinking: Option.none(),
	readOnly: false,
	instructions: Option.none(),
});

/** An owner that can delegate, an owner at the last level that cannot, and a leaf. */
const bareDelegates = [bare("owner", "owner", 2), bare("owner-last-level", "owner", levels), bare("leaf", "leaf", 2)];

/**
 * Stages, on `message`, one level-2 delegate per harness instructions file, in the role its profile names, and the bare
 * delegates above, with the same `launch` the ledger uses, so a tool can run each and see exactly what it receives. The
 * staged files live in `dir` until the caller's scope closes.
 */
export const stagedLaunches = Effect.fn("stagedLaunches")(function* (cwd: string, dir: string, message: string) {
	const fs = yield* FileSystem.FileSystem;
	const files = yield* fs.readDirectory(instructionsFolder);

	const services = yield* Layer.build(piCliLayer(childExtensions));
	const cli = Context.get(services, PiCli);

	const withInstructions = yield* Effect.forEach(files, (file) =>
		Effect.gen(function* () {
			const profile = yield* Effect.flatMap(fs.readFileString(`${instructionsFolder}/${file}`), parseProfile);
			const role = yield* Effect.fromOption(profile.role, () => `instructions file ${file} names no role`);

			const staged: Staged = {
				name: Str.replace(/\.md$/u, "")(file),
				role,
				level: 2,
				model: stagedModel(profile.model),
				thinking: profile.thinking,
				readOnly: profile.readOnly,
				instructions: Option.some({ file, text: profile.text }),
			};

			return staged;
		}),
	);

	return yield* Effect.forEach([...withInstructions, ...bareDelegates], ({ level, ...brief }) =>
		Effect.map(
			launch(cli)({
				brief: { ...brief, message },
				level,
				childSession: { cwd, dir: `${dir}/${brief.name}`, id: uuidv7() },
				passEnv: inheritedEnv(process.env),
			}),
			// In a real launch the systemd client's `wrap` sets the slice. A child without one fails to start.
			(spec): StagedLaunch => ({
				name: brief.name,
				role: brief.role,
				level,
				argv: spec.argv,
				env: { ...spec.env, PI_OWNED_WORK_SLICE: `pi-ow-prompts-${brief.name}` },
			}),
		),
	);
});
