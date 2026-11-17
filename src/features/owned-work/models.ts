import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";

import { delegateTargetOf, type Target, type Wanted } from "#src/features/phi-router/index.ts";
import { BadDelegate } from "./work.ts";

export type ModelKey = `${string}/${string}`;

const isModelKey = (name: string): name is ModelKey => Str.includes("/")(name);

export type ModelName = Data.TaggedEnum<{
	Alias: { readonly alias: string };
	Spelled: { readonly key: ModelKey };
}>;

export const ModelName = Data.taggedEnum<ModelName>();

export const modelNameOf = (name: string): ModelName =>
	isModelKey(name) ? ModelName.Spelled({ key: name }) : ModelName.Alias({ alias: name });

/** A model and the work it is for. It runs on the caller's provider when that provider has the model id, so a delegate stays on its parent's account, and on `provider` otherwise. */
export interface Alias {
	readonly provider: string;
	readonly id: string;
	readonly use: string;
}

export interface ModelTable {
	readonly aliases: Readonly<Record<string, Alias>>;
	/** Model names, aliases or `provider/id`, one per seat. */
	readonly panel: ReadonlyArray<string>;
}

/** An alias never looks like a `provider/id`, so a spelled model always means that model. */
type Aliases = Readonly<Record<string, Alias> & Record<ModelKey, never>>;

export const aliases = {
	judgment: {
		provider: "ultra-a",
		id: "claude-opus-5-5",
		use: "implementation, design, synthesis, prose, and anything that needs taste",
	},
	worker: {
		provider: "ultra-a",
		id: "claude-opus-5-5",
		use: "swarm workers, verification lanes, mechanical edits, research, web search, investigation, scouting, and fan-out aggregation",
	},
	investigator: {
		provider: "openai",
		id: "gpt-6.1-sol",
		use: "a second opinion from another vendor: code review, audits, and the arena judge for a Claude parent",
	},
	fable: {
		provider: "ultra-a",
		id: "claude-fable-5-2",
		use: "a panel seat. Outside a panel only when the user names it for the task or two `judgment` runs of the same brief failed their check, and say which. Difficulty alone never qualifies",
	},
	divergent: {
		provider: "opencode-go",
		id: "glm-5.3-flash",
		use: "the arena skill's extra runner, and nothing else",
	},
} as const satisfies Aliases;

const panel: ReadonlyArray<keyof typeof aliases> = ["fable", "worker", "investigator"];

export const modelTable: ModelTable = { aliases, panel };

/** The model ids the aliases name, which the PHI router registers as `phi/<id>` when a personal provider carries them. */
export const delegateModelIds = Arr.map(Rec.values(aliases), ({ id }) => id);

export type ModelCaller = Pick<ExtensionContext, "model" | "cwd"> & {
	readonly modelRegistry: Pick<ExtensionContext["modelRegistry"], "getAll">;
	readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">;
};

export const modelDescription = (table: ModelTable) => {
	const entries = Rec.toEntries(table.aliases);
	const named = Arr.map(entries, ([alias, { provider, id, use }]) => `\`${alias}\` (${provider}/${id}) for ${use}`);

	const sentences = [
		`\`provider/id\`, or an alias: ${Arr.join(named, "; ")}.`,
		"It overrides the model an instructions file names, and is required when the file names none.",
		`The panel, for work a skill runs once on each: ${Arr.join(table.panel, ", ")}.`,
	];

	return Arr.join(sentences, " ");
};

/** `provider/id` of the alias's model on the caller's provider when that provider has it, so a delegate stays on its parent's account. */
const aliasedModel = (ctx: ModelCaller, { provider: home, id }: Alias) => {
	const registry = ctx.modelRegistry.getAll();

	const own = Option.filter(Option.fromUndefinedOr(ctx.model), ({ provider }) =>
		Arr.some(registry, (model) => model.provider === provider && model.id === id),
	);

	const provider = Option.match(own, { onNone: () => home, onSome: (model) => model.provider });

	return `${provider}/${id}`;
};

export const modelChoices = (table: ModelTable) => {
	const named = Arr.map(Rec.keys(table.aliases), (alias) => `\`${alias}\``);

	return `an alias (${Arr.join(named, ", ")}) or a \`provider/id\`, your own included`;
};

const resolvedOf = (ctx: ModelCaller, table: ModelTable, name: ModelName) =>
	ModelName.$match(name, {
		Spelled: ({ key }) => {
			const [provider, ...id] = Str.split(key, "/");
			const wanted: Wanted = { kind: "key", provider, id: Arr.join(id, "/") };
			const naming = (missing: string) => `The model \`${key}\` asks for ${missing}`;

			return Effect.succeed({ wanted, model: key, source: "", naming });
		},
		Alias: ({ alias }) =>
			Effect.fromOption(Rec.get(table.aliases, alias), () =>
				BadDelegate.make({ why: `${alias} is not an alias: name ${modelChoices(table)}` }),
			).pipe(
				Effect.map((entry) => ({
					wanted: { kind: "alias", id: entry.id } satisfies Wanted,
					model: aliasedModel(ctx, entry),
					source: `, which the alias ${alias} names,`,
					naming: () => `The alias \`${alias}\` names ${entry.provider}/${entry.id}`,
				})),
			),
	});

type Resolved = Effect.Success<ReturnType<typeof resolvedOf>>;

const isRegistered = (ctx: ModelCaller) => (key: string) =>
	Arr.some(ctx.modelRegistry.getAll(), ({ provider, id }) => `${provider}/${id}` === key);

const routerPicks = ", which the PHI router picks,";

/** The model a target runs, the sentence its tool result carries for a substitute, and why it was chosen. */
const chosenOf = (resolved: Resolved, target: Exclude<Target, { readonly kind: "refuse" }>) => {
	switch (target.kind) {
		case "open": {
			return { model: resolved.model, substitution: Option.none<string>(), source: resolved.source };
		}

		case "run": {
			return { model: target.key, substitution: Option.none<string>(), source: routerPicks };
		}

		case "substitute": {
			const sentence = `${resolved.naming(target.missing)}, which no BAA provider carries, so this delegate runs on ${target.key}.`;

			return { model: target.key, substitution: Option.some(sentence), source: routerPicks };
		}

		default: {
			const unhandled: never = target;

			return unhandled;
		}
	}
};

/**
 * A protected session's delegate runs where the PHI router allows, so an alias never takes session content off its
 * boundary. `substitution` says when the whole run lands on another model because no BAA provider carries the one named.
 */
export const modelOf = Effect.fn("modelOf")(function* (ctx: ModelCaller, table: ModelTable, name: ModelName) {
	const resolved = yield* resolvedOf(ctx, table, name);

	const target = yield* delegateTargetOf({
		parent: ctx.model,
		branch: ctx.sessionManager.getBranch(),
		cwd: ctx.cwd,
		wanted: resolved.wanted,
		carries: (provider, id) => isRegistered(ctx)(`${provider}/${id}`),
	});

	if (target.kind === "refuse") {
		return yield* BadDelegate.make({ why: target.why });
	}

	const { model, substitution, source } = chosenOf(resolved, target);

	if (!isRegistered(ctx)(model)) {
		return yield* BadDelegate.make({ why: `model ${model}${source} is not in the model registry` });
	}

	return { model, substitution };
});
