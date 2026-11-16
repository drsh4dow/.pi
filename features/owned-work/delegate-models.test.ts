import { beforeAll, expect, test } from "bun:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { callerOf, continued, delegate, runtime, started } from "./brief.fixture.ts";
import { modelNameOf, modelOf, modelTable } from "./models.ts";

const opus = getBuiltinModel("anthropic", "claude-opus-5-5");

const on = (provider: string, id: string): Model<Api> => ({ ...opus, provider, id });

const registry = [
	on("ultra-a", opus.id),
	on("ultra-b", opus.id),
	on("ent", opus.id),
	on("phi", "auto"),
	on("openai", "gpt-6.1-sol"),
	on("opencode-go", "glm-5.3-flash"),
];

const scratch = `${Bun.env["TMPDIR"] ?? "/tmp"}/delegate-models-${String(process.pid)}`;

/** HOMEs whose phi-router.json routes (`enforce`) or holds every request on ent (no file: `shadow`). */
const homes = { enforce: `${scratch}/enforce`, shadow: `${scratch}/shadow` };

beforeAll(() => Bun.write(`${homes.enforce}/.pi/agent/phi-router.json`, '{ "mode": "enforce" }'));

const pinned: SessionEntry = {
	type: "custom",
	customType: "phi-pin",
	id: "p0000001",
	parentId: "",
	timestamp: "2026-05-14T10:00:00.000Z",
	data: { pinned: true },
};

interface Row {
	readonly from: string;
	readonly parent: Model<Api>;
	readonly name: string;
	readonly runs: string;
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
			Effect.match({ onFailure: () => "refused", onSuccess: (model) => model }),
			Effect.provide(home),
		),
	);
};

const phiAuto = on("phi", "auto");

const rows: ReadonlyArray<Row> = [
	{ from: "a routing phi/auto parent", parent: phiAuto, name: "judgment", runs: "phi/auto" },
	{ from: "a routing phi/auto parent", parent: phiAuto, name: "investigator", runs: "phi/auto" },
	{ from: "a routing phi/auto parent", parent: phiAuto, name: "ultra-b/claude-opus-5-5", runs: "phi/auto" },
	{ from: "a routing phi/auto parent", parent: phiAuto, name: "phi/auto", runs: "phi/auto" },
	{
		from: "a routing phi/auto parent",
		parent: phiAuto,
		name: "ent/claude-opus-5-5",
		runs: "ent/claude-opus-5-5",
	},
	{ from: "a routing phi/auto parent", parent: phiAuto, name: "openai/gpt-6.1-sol", runs: "refused" },
	{
		from: "a pinned phi/auto parent",
		parent: phiAuto,
		name: "judgment",
		runs: "ent/claude-opus-5-5",
		branch: [pinned],
	},
	{ from: "a shadow phi/auto parent", parent: phiAuto, name: "judgment", runs: "ent/claude-opus-5-5", mode: "shadow" },
	{ from: "a shadow phi/auto parent", parent: phiAuto, name: "openai/gpt-6.1-sol", runs: "refused", mode: "shadow" },
	{ from: "an ent parent", parent: on("ent", opus.id), name: "judgment", runs: "ent/claude-opus-5-5" },
	{ from: "an ent parent", parent: on("ent", opus.id), name: "investigator", runs: "ent/claude-opus-5-5" },
	{
		from: "an ent parent",
		parent: on("ent", opus.id),
		name: "ent/claude-opus-5-5",
		runs: "ent/claude-opus-5-5",
	},
	{ from: "an ent parent", parent: on("ent", opus.id), name: "ultra-a/claude-opus-5-5", runs: "refused" },
	{ from: "an ent parent", parent: on("ent", opus.id), name: "phi/auto", runs: "refused" },
	{
		from: "an ultra-a parent",
		parent: on("ultra-a", opus.id),
		name: "investigator",
		runs: "openai/gpt-6.1-sol",
	},
];

for (const row of rows) {
	test(`a delegate of ${row.from} that names ${row.name} runs on ${row.runs}`, () =>
		Effect.runPromise(
			Effect.map(
				Effect.promise(() => delegateModel(row)),
				(model) => {
					expect(model).toBe(row.runs);
				},
			),
		));
}

const continuedFrom = (parent: Model<Api>, ref: string) => {
	const caller = { ...callerOf(), model: parent, modelRegistry: { getAll: () => registry } };

	const call = { continues: ref, message: "Recheck the synthetic chart of Jane Testpatient, MRN 000-SYNTH-0001." };

	return Effect.map(
		Effect.promise(() => delegate.execute("call", call, undefined, undefined, caller)),
		({ isError, details }) => {
			continued.splice(0);

			return { isError, details, started: Arr.map(started.splice(0), ({ brief }) => brief.model) };
		},
	);
};

const relaunched = (model: string) => ({
	isError: false,
	details: { ref: "delegate-1", kind: "delegate", next: "end your turn; delegate-1 wakes you" },
	started: [model],
});

const refused = (why: string) => ({ isError: true, details: { error: "BadDelegate", message: why }, started: [] });

const continuations = [
	{ from: "a shadow phi/auto parent", parent: phiAuto, ref: "delegate-2", expect: relaunched("ent/claude-opus-5-5") },
	{
		from: "a shadow phi/auto parent",
		parent: phiAuto,
		ref: "delegate-3",
		expect: refused(
			"a delegate of a phi/auto session runs on phi/auto or a BAA account, and openai/gpt-6.1-sol is neither",
		),
	},
	{
		from: "an ent parent",
		parent: on("ent", opus.id),
		ref: "delegate-2",
		expect: refused(
			"a delegate of a session on the BAA account ent runs on a BAA account, and ultra-a/claude-opus-5-5 is not one",
		),
	},
	{
		from: "an ultra-b parent",
		parent: on("ultra-b", opus.id),
		ref: "delegate-2",
		expect: relaunched("ultra-a/claude-opus-5-5"),
	},
];

for (const { from, parent, ref, expect: expected } of continuations) {
	const outcome = expected.isError ? "is refused, and nothing starts" : `relaunches on ${String(expected.started[0])}`;

	test(`continuing ${ref} from ${from} ${outcome}`, () =>
		runtime.runPromise(
			Effect.map(continuedFrom(parent, ref), (got) => {
				expect(got).toEqual(expected);
			}),
		));
}
