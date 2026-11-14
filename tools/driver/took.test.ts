import { expect, test } from "bun:test";

import * as Option from "effect/Option";

import type { Loaded } from "./probe.ts";
import { type Asked, unmetOf } from "./took.ts";

const socket = "/t/pi-driver/pi-driver-42-0abc12/herdr-core/pi-driver-42-0abc12.sock";
const compaction = { enabled: true, reserveTokens: 10_000, keepRecentTokens: 5000 };

const asked: Asked = {
	model: "p/m",
	contextWindow: 40_000,
	setup: { settings: { compaction }, models: { prov: { modelOverrides: { mod: { contextWindow: 40_000 } } } } },
	socket,
};

const taken: Loaded = {
	version: "1.5.2",
	model: "p/m",
	contextWindow: 40_000,
	extensions: [],
	settings: { compaction, theme: "dark" },
	modelsError: Option.none(),
	socket: Option.some(socket),
};

const rows: ReadonlyArray<{
	readonly name: string;
	readonly asked?: Partial<Asked>;
	readonly loaded?: Partial<Loaded>;
	readonly expected: ReadonlyArray<string>;
}> = [
	{ name: "a root that took everything misses nothing", expected: [] },
	{
		name: "a dropped models.json misses the context window and names pi's error",
		loaded: { contextWindow: 1_000_000, modelsError: Option.some("bad providers") },
		expected: ["its context window is 1000000, not 40000", "it dropped models.json: bad providers"],
	},
	{ name: "another model is a miss", loaded: { model: "p/other" }, expected: ["it runs p/other, not p/m"] },
	{
		name: "a settings key with another value is a miss",
		loaded: { settings: { compaction: { ...compaction, reserveTokens: 16_384 } } },
		expected: ["its settings key compaction is not the one set"],
	},
	{
		name: "a settings key the record cannot confirm is refused, even when the record shows it",
		asked: { setup: { settings: { compaction, contextWindow: 40_000 } } },
		loaded: { settings: { compaction, contextWindow: 40_000 } },
		expected: [
			"the driver cannot confirm the setting contextWindow, only compaction.enabled, compaction.reserveTokens, compaction.keepRecentTokens",
		],
	},
	{
		name: "a compaction field pi does not read is refused",
		asked: { setup: { settings: { compaction: { ...compaction, reserveTokns: 1 } } } },
		loaded: { settings: { compaction: { ...compaction, reserveTokns: 1 } } },
		expected: [
			"the driver cannot confirm the setting compaction.reserveTokns, only compaction.enabled, compaction.reserveTokens, compaction.keepRecentTokens",
		],
	},
	{
		name: "a context window given only through models is refused",
		asked: {
			contextWindow: undefined,
			models: { prov: { modelOverrides: { mod: { contextWindow: 40_000 } } } },
		},
		expected: ["models sets a context window, which the driver confirms only as contextWindow"],
	},
	{
		name: "a root with no core socket misses the run's core",
		loaded: { socket: Option.none() },
		expected: [`it starts delegates in no core, not the run's ${socket}`],
	},
	{
		name: "a models.json error is the human's own when the setup sets no models",
		asked: { contextWindow: undefined, setup: {} },
		loaded: { modelsError: Option.some("bad providers") },
		expected: [],
	},
];

for (const row of rows) {
	test(`unmetOf: ${row.name}`, () => {
		expect(unmetOf({ asked: { ...asked, ...row.asked }, loaded: { ...taken, ...row.loaded } })).toEqual([
			...row.expected,
		]);
	});
}
