import {
	type BeforeAgentStartEvent,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { instructionsFlag } from "../../clients/pi-cli/index.ts";
import { type Role, selfFromEnv } from "../owned-work/index.ts";
import { compose } from "./compose.ts";
import { entryIndex, type Kind, loadEntries } from "./kinds.ts";
import { skillsFor } from "./skills.ts";

const indexOf = Effect.fn("indexOf")(function* (kind: Kind, agentDir: string, role: Role) {
	const dir = `${agentDir}/${kind}`;
	const { entries, problems } = yield* loadEntries(kind, dir);

	return { index: entryIndex({ kind, role, dir, entries }), problems };
});

/** Reads the prompt files on every run, so an edit lands on the next turn. Unchanged files give the same text, so pi sends no patch. */
export const layersOf = Effect.fn("layersOf")(function* (
	agentDir: string,
	role: Role,
	instructionsFile: Option.Option<string>,
	loaded: ReadonlyArray<Skill>,
) {
	const fs = yield* FileSystem.FileSystem;
	const roleText = yield* fs.readFileString(`${agentDir}/roles/${role}.md`);

	const instructions = yield* Option.match(instructionsFile, {
		onNone: () => Effect.succeedNone,
		onSome: (file) => Effect.asSome(fs.readFileString(file)),
	});

	const principles = yield* indexOf("principles", agentDir, role);
	const playbooks = yield* indexOf("playbooks", agentDir, role);
	const skills = yield* skillsFor({ role, skills: loaded });

	return {
		layers: {
			role: roleText,
			instructions,
			principles: principles.index,
			playbooks: playbooks.index,
			skills: skills.skills,
		},
		problems: [...principles.problems, ...playbooks.problems, ...skills.problems],
	};
});

export const prompt = (pi: ExtensionAPI) => {
	pi.registerFlag(instructionsFlag, { description: "File with this delegate's instructions.", type: "string" });

	const run = Effect.fn("prompt")(function* (event: BeforeAgentStartEvent, ctx: ExtensionContext) {
		const file = Schema.decodeUnknownOption(Schema.String)(pi.getFlag(instructionsFlag));
		const { role } = yield* selfFromEnv(process.env);
		const { layers, problems } = yield* layersOf(getAgentDir(), role, file, event.systemPromptOptions.skills);

		compose(layers)(event);

		for (const { file: broken, why } of problems) {
			const warning = `left out of the prompt, ${broken}: ${why}`;

			yield* ctx.hasUI
				? Effect.sync(() => {
						ctx.ui.notify(warning, "warning");
					})
				: Effect.logWarning(warning);
		}
	});

	return (event: BeforeAgentStartEvent, ctx: ExtensionContext) =>
		Effect.runPromise(run(event, ctx).pipe(Effect.provide(NodeServices.layer)));
};
