import { expect, test } from "bun:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { parseSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
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

const latched = Arr.filter(
	parseSessionEntries(
		'{"type":"custom","customType":"pi.virtual-model-state","id":"e0000001","parentId":null,"timestamp":"2026-05-14T10:00:00.000Z","data":{"provider":"phi","modelId":"auto","state":{"cursor":{"_tag":"Tainted","taint":{"_tag":"Phi","detector":"judge"}},"home":"ultra-a","limited":[]}}}',
	),
	(entry): entry is SessionEntry => entry.type !== "session",
);

const home = Layer.merge(
	NodeServices.layer,
	ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: `${Bun.env["TMPDIR"] ?? "/tmp"}/no-phi-settings` })),
);

const delegateModel = ({
	parent,
	branch = [],
	name,
}: {
	readonly parent: Model<Api>;
	readonly branch?: ReadonlyArray<SessionEntry>;
	readonly name: string;
}) => {
	const caller = {
		model: parent,
		cwd: "/",
		modelRegistry: { getAll: () => registry },
		sessionManager: { getBranch: () => [...branch] },
	};

	return Effect.runPromise(
		modelOf(caller, modelTable, modelNameOf(name)).pipe(
			Effect.match({ onFailure: () => "refused", onSuccess: (model) => model }),
			Effect.provide(home),
		),
	);
};

const phiAuto = on("phi", "auto");

const rows = [
	{ from: "a clean phi/auto parent", parent: phiAuto, branch: [], name: "judgment", runs: "phi/auto" },
	{ from: "a clean phi/auto parent", parent: phiAuto, branch: [], name: "investigator", runs: "phi/auto" },
	{ from: "a clean phi/auto parent", parent: phiAuto, branch: [], name: "ultra-b/claude-opus-5-5", runs: "phi/auto" },
	{ from: "a clean phi/auto parent", parent: phiAuto, branch: [], name: "phi/auto", runs: "phi/auto" },
	{
		from: "a clean phi/auto parent",
		parent: phiAuto,
		branch: [],
		name: "ent/claude-opus-5-5",
		runs: "ent/claude-opus-5-5",
	},
	{ from: "a clean phi/auto parent", parent: phiAuto, branch: [], name: "openai/gpt-6.1-sol", runs: "refused" },
	{
		from: "a latched phi/auto parent",
		parent: phiAuto,
		branch: latched,
		name: "judgment",
		runs: "ent/claude-opus-5-5",
	},
	{
		from: "a latched phi/auto parent",
		parent: phiAuto,
		branch: latched,
		name: "divergent",
		runs: "ent/claude-opus-5-5",
	},
	{
		from: "a latched phi/auto parent",
		parent: phiAuto,
		branch: latched,
		name: "phi/auto",
		runs: "ent/claude-opus-5-5",
	},
	{
		from: "a latched phi/auto parent",
		parent: phiAuto,
		branch: latched,
		name: "ultra-a/claude-opus-5-5",
		runs: "ent/claude-opus-5-5",
	},
	{ from: "an ent parent", parent: on("ent", opus.id), branch: [], name: "judgment", runs: "ent/claude-opus-5-5" },
	{ from: "an ent parent", parent: on("ent", opus.id), branch: [], name: "investigator", runs: "ent/claude-opus-5-5" },
	{
		from: "an ent parent",
		parent: on("ent", opus.id),
		branch: [],
		name: "ent/claude-opus-5-5",
		runs: "ent/claude-opus-5-5",
	},
	{ from: "an ent parent", parent: on("ent", opus.id), branch: [], name: "ultra-a/claude-opus-5-5", runs: "refused" },
	{ from: "an ent parent", parent: on("ent", opus.id), branch: [], name: "phi/auto", runs: "refused" },
	{
		from: "an ultra-a parent",
		parent: on("ultra-a", opus.id),
		branch: [],
		name: "investigator",
		runs: "openai/gpt-6.1-sol",
	},
];

for (const { from, parent, branch, name, runs } of rows) {
	test(`a delegate of ${from} that names ${name} runs on ${runs}`, () =>
		Effect.runPromise(
			Effect.map(
				Effect.promise(() => delegateModel({ parent, branch, name })),
				(model) => {
					expect(model).toBe(runs);
				},
			),
		));
}

const continuedFrom = (parent: Model<Api>, branch: ReadonlyArray<SessionEntry>, ref: string) => {
	const caller = {
		...callerOf(),
		model: parent,
		modelRegistry: { getAll: () => registry },
		sessionManager: { getBranch: () => [...branch] },
	};

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
	{ from: "a clean phi/auto parent", parent: phiAuto, branch: [], ref: "delegate-2", expect: relaunched("phi/auto") },
	{
		from: "a latched phi/auto parent",
		parent: phiAuto,
		branch: latched,
		ref: "delegate-2",
		expect: relaunched("ent/claude-opus-5-5"),
	},
	{
		from: "a clean phi/auto parent",
		parent: phiAuto,
		branch: [],
		ref: "delegate-3",
		expect: refused(
			"a delegate of a phi/auto session runs on phi/auto or a BAA account, and openai/gpt-6.1-sol is neither",
		),
	},
	{
		from: "an ent parent",
		parent: on("ent", opus.id),
		branch: [],
		ref: "delegate-2",
		expect: refused(
			"a delegate of a session on the BAA account ent runs on a BAA account, and ultra-a/claude-opus-5-5 is not one",
		),
	},
	{
		from: "an ultra-b parent",
		parent: on("ultra-b", opus.id),
		branch: [],
		ref: "delegate-2",
		expect: relaunched("ultra-a/claude-opus-5-5"),
	},
];

for (const { from, parent, branch, ref, expect: expected } of continuations) {
	const outcome = expected.isError ? "is refused, and nothing starts" : `relaunches on ${String(expected.started[0])}`;

	test(`continuing ${ref} from ${from} ${outcome}`, () =>
		runtime.runPromise(
			Effect.map(continuedFrom(parent, branch, ref), (got) => {
				expect(got).toEqual(expected);
			}),
		));
}
