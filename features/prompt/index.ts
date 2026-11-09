import {
	type BeforeAgentStartEvent,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { instructionsFlag } from "../../clients/pi-cli/index.ts";
import { type Role, selfFromEnv } from "../owned-work/index.ts";
import { compose } from "./compose.ts";
import { loadPrinciples, principleIndex } from "./principles.ts";

/** Owners and leaves share one role file: what an owner has beyond a leaf comes with the `delegate` tool. */
const roleFile: Record<Role, string> = { root: "root.md", owner: "delegate.md", leaf: "delegate.md" };

/** Reads the prompt files on every run, so an edit lands on the next turn. Unchanged files give the same text, so pi sends no patch. */
const layersOf = Effect.fn("layersOf")(function* (
	agentDir: string,
	role: Role,
	instructionsFile: Option.Option<string>,
) {
	const fs = yield* FileSystem.FileSystem;
	const roleText = yield* fs.readFileString(`${agentDir}/roles/${roleFile[role]}`);

	const instructions = yield* Option.match(instructionsFile, {
		onNone: () => Effect.succeedNone,
		onSome: (file) => Effect.asSome(fs.readFileString(file)),
	});

	const principlesDir = `${agentDir}/principles`;
	const { principles, problems } = yield* loadPrinciples(principlesDir);

	return {
		layers: {
			role: roleText,
			instructions,
			principles: principleIndex({ role, dir: principlesDir, principles }),
		},
		problems,
	};
});

export const prompt = (pi: ExtensionAPI) => {
	pi.registerFlag(instructionsFlag, { description: "File with this delegate's instructions.", type: "string" });

	const run = Effect.fn("prompt")(function* (event: BeforeAgentStartEvent, ctx: ExtensionContext) {
		const file = Schema.decodeUnknownOption(Schema.String)(pi.getFlag(instructionsFlag));
		const { role } = yield* selfFromEnv(process.env);
		const { layers, problems } = yield* layersOf(getAgentDir(), role, file);

		compose(layers)(event);

		for (const { file: broken, why } of problems) {
			const warning = `principle left out, ${broken}: ${why}`;

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
