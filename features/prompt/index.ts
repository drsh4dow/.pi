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
import type * as Option from "effect/Option";

import { readStagedBrief, type StagedBrief } from "../../clients/pi-cli/index.ts";
import { type Role, Self, selfFromEnv } from "../owned-work/index.ts";
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
	brief: Option.Option<StagedBrief>,
	loaded: ReadonlyArray<Skill>,
) {
	const fs = yield* FileSystem.FileSystem;
	const roleText = yield* fs.readFileString(`${agentDir}/roles/${role}.md`);
	const principles = yield* indexOf("principles", agentDir, role);
	const playbooks = yield* indexOf("playbooks", agentDir, role);
	const skills = yield* skillsFor({ role, skills: loaded });

	return {
		layers: {
			role: roleText,
			brief,
			principles: principles.index,
			playbooks: playbooks.index,
			skills: skills.skills,
		},
		problems: [...principles.problems, ...playbooks.problems, ...skills.problems],
	};
});

const briefOf = (self: Self, ctx: ExtensionContext) =>
	Self.$is("Root")(self)
		? Effect.succeedNone
		: Effect.asSome(
				readStagedBrief({ dir: ctx.sessionManager.getSessionDir(), id: ctx.sessionManager.getSessionId() }),
			);

const run = Effect.fn("prompt")(function* (event: BeforeAgentStartEvent, ctx: ExtensionContext) {
	const self = yield* selfFromEnv(process.env);
	const brief = yield* briefOf(self, ctx);
	const { layers, problems } = yield* layersOf(getAgentDir(), self.role, brief, event.systemPromptOptions.skills);

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

export const prompt = (pi: Pick<ExtensionAPI, "on">) => {
	pi.on("before_agent_start", (event, ctx) =>
		Effect.runPromise(run(event, ctx).pipe(Effect.provide(NodeServices.layer))),
	);
};
