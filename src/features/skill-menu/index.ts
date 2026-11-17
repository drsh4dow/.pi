import {
	type AutocompleteProviderFactory,
	type ExtensionAPI,
	type ExtensionContext,
	parseFrontmatter,
	type SessionStartEvent,
	type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

type AutocompleteProvider = Parameters<AutocompleteProviderFactory>[0];

const Frontmatter = Schema.Struct({ "user-invocable": Schema.optional(Schema.Boolean) });

const frontmatterOf = Option.liftThrowable((skillFile: string) => parseFrontmatter(skillFile).frontmatter);

/** Pi reads no `user-invocable` key, so a skill that sets it to false still loads, and still runs when typed in full. */
export const hidesFromMenu = (skillFile: string) =>
	frontmatterOf(skillFile).pipe(
		Option.flatMap(Schema.decodeOption(Frontmatter)),
		Option.exists((fields) => fields["user-invocable"] === false),
	);

/** The `skill:<name>` commands whose skill sets `user-invocable: false`. A file that cannot be read stays in the menu, as pi shows it. */
export const hiddenCommands = Effect.fn("hiddenCommands")(function* (commands: ReadonlyArray<SlashCommandInfo>) {
	const fs = yield* FileSystem.FileSystem;
	const skills = Arr.filter(commands, (command) => command.source === "skill");

	const hidden = yield* Effect.forEach(
		skills,
		(command) =>
			fs.readFileString(command.sourceInfo.path).pipe(
				Effect.map((text) => (hidesFromMenu(text) ? [command.name] : [])),
				Effect.orElseSucceed(() => []),
			),
		{ concurrency: "unbounded" },
	);

	return new Set(Arr.flatten(hidden));
});

const isSkillCommand = Str.startsWith("skill:");

/**
 * Leaves the hidden skill commands out of the `/` menu's suggestions and passes everything else through. It rereads
 * the skill files on each lookup that suggests a skill, so a frontmatter edit shows on the next keystroke.
 */
export const withoutHiddenSkills =
	(commands: () => ReadonlyArray<SlashCommandInfo>) =>
	(current: AutocompleteProvider): AutocompleteProvider => ({
		getSuggestions: (lines, cursorLine, cursorCol, options) =>
			Effect.runPromise(
				Effect.gen(function* () {
					const suggestions = yield* Effect.promise(() =>
						current.getSuggestions(lines, cursorLine, cursorCol, options),
					);

					if (suggestions === null || !Arr.some(suggestions.items, (item) => isSkillCommand(item.value))) {
						return suggestions;
					}

					const names = yield* hiddenCommands(commands());

					return { ...suggestions, items: Arr.filter(suggestions.items, (item) => !names.has(item.value)) };
				}).pipe(Effect.provide(NodeServices.layer)),
			),
		applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
			current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
		shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
			current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true,
	});

export const skillMenu =
	(pi: Pick<ExtensionAPI, "getCommands">) => (_event: SessionStartEvent, ctx: ExtensionContext) => {
		if (ctx.hasUI) {
			ctx.ui.addAutocompleteProvider(withoutHiddenSkills(() => pi.getCommands()));
		}
	};
