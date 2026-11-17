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
	on("ent", fable),
	on("phi", "auto"),
	on("phi", opus.id),
	on("phi", fable),
	on("phi", "gpt-6.1-sol"),
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

const investigatorOnOpus = {
	model: "ent/claude-opus-5-5",
	substituted:
		"The alias `investigator` names openai/gpt-6.1-sol, which no BAA account carries, so this delegate runs on ent/claude-opus-5-5.",
};

/** The rows of a routing parent: the alias or key picks the id, and the delegate runs it as `phi/<id>`. */
const routingRows = (from: string, parent: Model<Api>): ReadonlyArray<Row> => [
	{ from, parent, name: "judgment", runs: "phi/claude-opus-5-5" },
	{ from, parent, name: "worker", runs: "phi/claude-opus-5-5" },
	{ from, parent, name: "fable", runs: "phi/claude-fable-5-2" },
	{ from, parent, name: "ultra-b/claude-fable-5-2", runs: "phi/claude-fable-5-2" },
	{ from, parent, name: "investigator", runs: "phi/gpt-6.1-sol" },
	{ from, parent, name: "openai/gpt-6.1-sol", runs: "phi/gpt-6.1-sol" },
	{ from, parent, name: "divergent", runs: "phi/glm-5.3-flash" },
	{ from, parent, name: "phi/auto", runs: "phi/auto" },
	{ from, parent, name: "ent/claude-opus-5-5", runs: "ent/claude-opus-5-5" },
	{ from, parent, name: "elsewhere/claude-opus-5-5", runs: "refused" },
];

/** The rows of a parent held on ent: the id's sealed lane, or the substitute when ent lacks the id. */
const heldRows = (from: string, held: Pick<Row, "mode" | "branch">): ReadonlyArray<Row> => [
	{ from, parent: phiAuto, ...held, name: "judgment", runs: "ent/claude-opus-5-5" },
	{ from, parent: phiAuto, ...held, name: "fable", runs: "ent/claude-fable-5-2" },
	{ from, parent: phiAuto, ...held, name: "investigator", runs: investigatorOnOpus },
	{ from, parent: phiAuto, ...held, name: "ultra-b/claude-opus-5-5", runs: "ent/claude-opus-5-5" },
	{ from, parent: phiAuto, ...held, name: "openai/gpt-6.1-sol", runs: "refused" },
	{ from, parent: phiAuto, ...held, name: "phi/auto", runs: "ent/claude-opus-5-5" },
];

const rows: ReadonlyArray<Row> = [
	...routingRows("a routing phi/auto parent", phiAuto),
	...routingRows("a routing phi/claude-fable-5-2 parent", on("phi", fable)),
	...heldRows("a pinned phi/auto parent", { branch: [pinned] }),
	...heldRows("a shadow phi/auto parent", { mode: "shadow" }),
	{ from: "an ent parent", parent: onEnt, name: "judgment", runs: "ent/claude-opus-5-5" },
	{ from: "an ent parent", parent: onEnt, name: "fable", runs: "ent/claude-fable-5-2" },
	{ from: "an ent parent", parent: onEnt, name: "investigator", runs: investigatorOnOpus },
	{ from: "an ent parent", parent: onEnt, name: "ent/claude-opus-5-5", runs: "ent/claude-opus-5-5" },
	{ from: "an ent parent", parent: onEnt, name: "openai/gpt-6.1-sol", runs: "refused" },
	{ from: "an ent parent", parent: onEnt, name: "ultra-a/claude-opus-5-5", runs: "refused" },
	{ from: "an ent parent", parent: onEnt, name: "phi/auto", runs: "refused" },
	{ from: "an ultra-a parent", parent: on("ultra-a", opus.id), name: "investigator", runs: "openai/gpt-6.1-sol" },
	{ from: "an ultra-a parent", parent: on("ultra-a", opus.id), name: "fable", runs: "ultra-a/claude-fable-5-2" },
	{
		from: "a parent switched from phi/auto to ultra-a",
		parent: on("ultra-a", opus.id),
		branch: [selectedPhiAuto],
		name: "investigator",
		runs: "openai/gpt-6.1-sol",
	},
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
		title: "naming quick from a shadow phi/auto parent starts on ent/claude-opus-5-5 and says so",
		parent: phiAuto,
		call: fresh("quick"),
		expect: substitutedOn(
			"ent/claude-opus-5-5",
			"The alias `quick` names openai/gpt-6-luna, which no BAA account carries, so this delegate runs on ent/claude-opus-5-5.",
		),
	},
	{
		title: "naming deep from a shadow phi/auto parent starts on ent/claude-opus-5-5 with no substitution",
		parent: phiAuto,
		call: fresh("deep"),
		expect: relaunched("ent/claude-opus-5-5"),
	},
	{
		title: "continuing a phi/gpt-6.1-sol delegate from a shadow phi/auto parent starts on ent/claude-opus-5-5 and says so",
		parent: phiAuto,
		call: { continues: "delegate-4" },
		expect: substitutedOn(
			"ent/claude-opus-5-5",
			"The model `phi/gpt-6.1-sol` asks for gpt-6.1-sol, which no BAA account carries, so this delegate runs on ent/claude-opus-5-5.",
		),
	},
	{
		title: "continuing an ultra-a/claude-opus-5-5 delegate from a shadow phi/auto parent starts on ent/claude-opus-5-5",
		parent: phiAuto,
		call: { continues: "delegate-2" },
		expect: relaunched("ent/claude-opus-5-5"),
	},
	{
		title: "continuing an openai/gpt-6.1-sol delegate from a shadow phi/auto parent is refused",
		parent: phiAuto,
		call: { continues: "delegate-3" },
		expect: refused(
			"a delegate of a session held on the BAA account runs there, and no BAA account carries gpt-6.1-sol, which openai/gpt-6.1-sol names",
		),
	},
	{
		title: "continuing an ultra-a/claude-opus-5-5 delegate from an ent parent is refused",
		parent: onEnt,
		call: { continues: "delegate-2" },
		expect: refused(
			"a delegate of a session on a BAA account runs on a BAA account, and ultra-a/claude-opus-5-5 is not one",
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
