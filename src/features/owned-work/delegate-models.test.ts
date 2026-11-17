import { beforeAll, expect, test } from "bun:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { callerOf, continued, delegate, fixtures, runtime, started } from "./brief.fixture.ts";
import { modelNameOf, modelOf, modelTable } from "./models.ts";

const opus = getBuiltinModel("anthropic", "claude-opus-5-5");

const on = (provider: string, id: string): Model<Api> => ({ ...opus, provider, id });

const fable = "claude-fable-5-2";

const registry = [
	on("ultra-a", opus.id),
	on("ultra-b", opus.id),
	on("ent", opus.id),
	on("ultra-a", fable),
	on("ultra-b", fable),
	on("phi", "auto"),
	on("phi", opus.id),
	on("phi", fable),
	on("phi", "glm-5.3-flash"),
	on("openai", "gpt-6.1-sol"),
	on("openai", "gpt-6-luna"),
	on("opencode-go", "glm-5.3-flash"),
	on("elsewhere", opus.id),
];

const scratch = `${Bun.env["TMPDIR"] ?? "/tmp"}/delegate-models-${String(process.pid)}`;

/** HOMEs whose phi-router.json routes (`enforce`) or holds every request on ent (`shadow`). */
const homes = { enforce: `${scratch}/enforce`, shadow: `${scratch}/shadow` };

beforeAll(() =>
	Promise.all([
		Bun.write(`${homes.enforce}/.pi/agent/phi-router.json`, '{ "mode": "enforce" }'),
		Bun.write(`${homes.shadow}/.pi/agent/phi-router.json`, '{ "mode": "shadow" }'),
		Bun.write(`${fixtures}/.pi/agent/phi-router.json`, '{ "mode": "shadow" }'),
	]),
);

const pinned: SessionEntry = {
	type: "custom",
	customType: "phi-pin",
	id: "p0000001",
	parentId: "",
	timestamp: "2026-05-14T10:00:00.000Z",
	data: { pinned: true },
};

const selectedPhiAuto: SessionEntry = {
	type: "model_change",
	id: "m0000001",
	parentId: "",
	timestamp: "2026-05-14T10:00:00.000Z",
	provider: "phi",
	modelId: "auto",
};

/** What a delegate runs: a model, a model with the sentence its tool result carries, or a refusal. */
type Runs = string | { readonly model: string; readonly substituted: string };

interface Row {
	readonly from: string;
	readonly parent: Model<Api>;
	readonly name: string;
	readonly runs: Runs;
	readonly mode?: keyof typeof homes;
	readonly branch?: ReadonlyArray<SessionEntry>;
}

const delegateModel = ({ parent, name, mode = "enforce", branch = [] }: Row) => {
	const caller = {
		model: parent,
		cwd: "/",
		modelRegistry: { getAll: () => registry },
		sessionManager: { getBranch: () => [...branch] },
	};

	const home = Layer.merge(
		NodeServices.layer,
		ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: homes[mode] })),
	);

	return Effect.runPromise(
		modelOf(caller, modelTable, modelNameOf(name)).pipe(
			Effect.match({
				onFailure: (): Runs => "refused",
				onSuccess: ({ model, substitution }): Runs =>
					Option.match(substitution, { onNone: () => model, onSome: (substituted) => ({ model, substituted }) }),
			}),
			Effect.provide(home),
		),
	);
};

const phiAuto = on("phi", "auto");

const onEnt = on("ent", opus.id);

const onOpenai = on("openai", "gpt-6.1-sol");

/** What an alias whose id no BAA provider carries runs from a held or BAA parent. */
const onOpus = (alias: string, named: string) => ({
	model: "ent/claude-opus-5-5",
	substituted: `The alias \`${alias}\` names ${named}, which no BAA provider carries, so this delegate runs on ent/claude-opus-5-5.`,
});

/** The rows of a routing parent: an id a personal provider carries runs as `phi/<id>`, any other on its sealed lane. */
const routingRows = (from: string, parent: Model<Api>): ReadonlyArray<Row> => [
	{ from, parent, name: "judgment", runs: "phi/claude-opus-5-5" },
	{ from, parent, name: "worker", runs: "phi/claude-opus-5-5" },
	{ from, parent, name: "fable", runs: "phi/claude-fable-5-2" },
	{ from, parent, name: "ultra-b/claude-fable-5-2", runs: "phi/claude-fable-5-2" },
	{ from, parent, name: "investigator", runs: "openai/gpt-6.1-sol" },
	{ from, parent, name: "openai/gpt-6.1-sol", runs: "openai/gpt-6.1-sol" },
	{ from, parent, name: "divergent", runs: "phi/glm-5.3-flash" },
	{ from, parent, name: "phi/auto", runs: "phi/auto" },
	{ from, parent, name: "ent/claude-opus-5-5", runs: "ent/claude-opus-5-5" },
	{ from, parent, name: "elsewhere/claude-opus-5-5", runs: "refused" },
];

/** The rows of a parent held on ent: the id's sealed lane, or the substitute when no BAA provider carries the id. */
const heldRows = (from: string, held: Pick<Row, "mode" | "branch">): ReadonlyArray<Row> => [
	{ from, parent: phiAuto, ...held, name: "judgment", runs: "ent/claude-opus-5-5" },
	{ from, parent: phiAuto, ...held, name: "fable", runs: onOpus("fable", "ultra-a/claude-fable-5-2") },
	{ from, parent: phiAuto, ...held, name: "investigator", runs: "openai/gpt-6.1-sol" },
	{ from, parent: phiAuto, ...held, name: "divergent", runs: onOpus("divergent", "opencode-go/glm-5.3-flash") },
	{ from, parent: phiAuto, ...held, name: "ultra-b/claude-opus-5-5", runs: "ent/claude-opus-5-5" },
	{ from, parent: phiAuto, ...held, name: "openai/gpt-6.1-sol", runs: "openai/gpt-6.1-sol" },
	{ from, parent: phiAuto, ...held, name: "opencode-go/glm-5.3-flash", runs: "refused" },
	{ from, parent: phiAuto, ...held, name: "phi/auto", runs: "ent/claude-opus-5-5" },
];

/** The rows of a parent on a BAA provider: an alias runs on its id's sealed lane, a spelled model only on a BAA one. */
const baaRows = (from: string, parent: Model<Api>): ReadonlyArray<Row> => [
	{ from, parent, name: "judgment", runs: "ent/claude-opus-5-5" },
	{ from, parent, name: "fable", runs: onOpus("fable", "ultra-a/claude-fable-5-2") },
	{ from, parent, name: "investigator", runs: "openai/gpt-6.1-sol" },
	{ from, parent, name: "divergent", runs: onOpus("divergent", "opencode-go/glm-5.3-flash") },
	{ from, parent, name: "ent/claude-opus-5-5", runs: "ent/claude-opus-5-5" },
	{ from, parent, name: "openai/gpt-6.1-sol", runs: "openai/gpt-6.1-sol" },
	{ from, parent, name: "ultra-a/claude-opus-5-5", runs: "refused" },
	{ from, parent, name: "opencode-go/glm-5.3-flash", runs: "refused" },
	{ from, parent, name: "phi/auto", runs: "refused" },
];

/** The rows of an open parent: the alias's model, on the parent's provider when that provider has the id. */
const openRows = (from: string, branch: ReadonlyArray<SessionEntry>): ReadonlyArray<Row> => [
	{ from, parent: on("ultra-a", opus.id), branch, name: "investigator", runs: "openai/gpt-6.1-sol" },
	{ from, parent: on("ultra-a", opus.id), branch, name: "fable", runs: "ultra-a/claude-fable-5-2" },
	{ from, parent: on("ultra-a", opus.id), branch, name: "divergent", runs: "opencode-go/glm-5.3-flash" },
];

const rows: ReadonlyArray<Row> = [
	...routingRows("a routing phi/auto parent", phiAuto),
	...routingRows("a routing phi/claude-fable-5-2 parent", on("phi", fable)),
	...heldRows("a pinned phi/auto parent", { branch: [pinned] }),
	...heldRows("a shadow phi/auto parent", { mode: "shadow" }),
	...baaRows("an ent parent", onEnt),
	...baaRows("an openai parent", onOpenai),
	...openRows("an ultra-a parent", []),
	...openRows("a parent switched from phi/auto to ultra-a", [selectedPhiAuto]),
];

test.each(rows)("a delegate of $from that names $name runs on $runs", (row) =>
	Effect.runPromise(
		Effect.map(
			Effect.promise(() => delegateModel(row)),
			(model) => {
				expect(model).toEqual(row.runs);
			},
		),
	),
);

type DelegateCall = Parameters<typeof delegate.execute>[1];

/** What the delegate tool returns and starts for one call. `HOME` is the fixtures folder, whose settings say `shadow`. */
const calledFrom = (parent: Model<Api>, call: DelegateCall) => {
	const caller = { ...callerOf(), model: parent, modelRegistry: { getAll: () => registry } };

	return Effect.map(
		Effect.promise(() => delegate.execute("call", call, undefined, undefined, caller)),
		({ isError, details }) => {
			continued.splice(0);

			return { isError, details, started: Arr.map(started.splice(0), ({ brief }) => brief.model) };
		},
	);
};

const handedTo = "end your turn; delegate-1 wakes you";

const relaunched = (model: string) => ({
	isError: false,
	details: { ref: "delegate-1", kind: "delegate", next: handedTo },
	started: [model],
});

const substitutedOn = (model: string, substituted: string) => ({
	isError: false,
	details: { ref: "delegate-1", kind: "delegate", next: handedTo, substituted },
	started: [model],
});

const refused = (why: string) => ({ isError: true, details: { error: "BadDelegate", message: why }, started: [] });

const fresh = (model: string): DelegateCall => ({
	goal: "Cap the retries.",
	name: "scout",
	message: "Read it.",
	role: "leaf",
	model,
});

interface CallRow {
	readonly title: string;
	readonly parent: Model<Api>;
	readonly call: DelegateCall;
	readonly expect: ReturnType<typeof relaunched | typeof substitutedOn | typeof refused>;
}

const calls: ReadonlyArray<CallRow> = [
	{
		title: "naming quick from a shadow phi/auto parent starts on openai/gpt-6-luna with no substitution",
		parent: phiAuto,
		call: fresh("quick"),
		expect: relaunched("openai/gpt-6-luna"),
	},
	{
		title: "naming phi/glm-5.3-flash from a shadow phi/auto parent starts on ent/claude-opus-5-5 and says so",
		parent: phiAuto,
		call: fresh("phi/glm-5.3-flash"),
		expect: substitutedOn(
			"ent/claude-opus-5-5",
			"The model `phi/glm-5.3-flash` asks for glm-5.3-flash, which no BAA provider carries, so this delegate runs on ent/claude-opus-5-5.",
		),
	},
	{
		title: "naming deep from a shadow phi/auto parent starts on ent/claude-opus-5-5 with no substitution",
		parent: phiAuto,
		call: fresh("deep"),
		expect: relaunched("ent/claude-opus-5-5"),
	},
	{
		title: "continuing a phi/glm-5.3-flash delegate from a shadow phi/auto parent starts on ent/claude-opus-5-5 and says so",
		parent: phiAuto,
		call: { continues: "delegate-4" },
		expect: substitutedOn(
			"ent/claude-opus-5-5",
			"The model `phi/glm-5.3-flash` asks for glm-5.3-flash, which no BAA provider carries, so this delegate runs on ent/claude-opus-5-5.",
		),
	},
	{
		title: "continuing an ultra-a/claude-opus-5-5 delegate from a shadow phi/auto parent starts on ent/claude-opus-5-5",
		parent: phiAuto,
		call: { continues: "delegate-2" },
		expect: relaunched("ent/claude-opus-5-5"),
	},
	{
		title: "continuing an openai/gpt-6.1-sol delegate from a shadow phi/auto parent starts on it",
		parent: phiAuto,
		call: { continues: "delegate-3" },
		expect: relaunched("openai/gpt-6.1-sol"),
	},
	{
		title: "continuing an ultra-a/claude-opus-5-5 delegate from an ent parent is refused",
		parent: onEnt,
		call: { continues: "delegate-2" },
		expect: refused(
			"a delegate of a session on a BAA provider runs on a BAA provider, and ultra-a/claude-opus-5-5 is not one",
		),
	},
	{
		title: "continuing an ultra-a/claude-opus-5-5 delegate from an ultra-b parent starts on it",
		parent: on("ultra-b", opus.id),
		call: { continues: "delegate-2" },
		expect: relaunched("ultra-a/claude-opus-5-5"),
	},
];

test.each(calls)("a delegate call $title", ({ parent, call, expect: expected }) =>
	runtime.runPromise(
		Effect.map(calledFrom(parent, call), (got) => {
			expect(got).toEqual(expected);
		}),
	),
);
