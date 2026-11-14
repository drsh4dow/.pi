import { expect, test } from "bun:test";

import * as Option from "effect/Option";

import { layoutOf, modelsOf, runEnv, settingsOf } from "./world.ts";

const layout = layoutOf({ tmp: "/t", name: "smoke", stamp: "20260514-101010", pid: 42, tag: "0abc12" });

const own = {
	PATH: "/repo/node_modules/.bin:/h/.pi/agent/bin:/h/.pi-worktrees/x/agent/bin:/usr/bin",
	HC_SESSION: "default",
	PI_OWNED_WORK_SLICE: "parent",
	XDG_STATE_HOME: "/h/.local/state",
	XDG_CONFIG_HOME: "/h/.config",
	XDG_RUNTIME_DIR: "/run/user/1000",
	LANG: "C.UTF-8",
	UNSET: undefined,
};

const env = runEnv({ own, humanHome: "/h", layout, borrowed: { GIT_CONFIG_GLOBAL: "/h/.gitconfig" } });

const envRows = [
	{
		name: "PATH starts with the wrapper, without package bins or the live harness",
		key: "PATH",
		value: `${layout.bin}:/h/.pi-worktrees/x/agent/bin:/usr/bin`,
	},
	{ name: "HOME is the scratch home", key: "HOME", value: "/t/pi-driver/smoke-20260514-101010-42/home" },
	{
		name: "the agent folder is the scratch home's",
		key: "PI_CODING_AGENT_DIR",
		value: "/t/pi-driver/smoke-20260514-101010-42/home/.pi/agent",
	},
	{ name: "the core session replaces the caller's", key: "HC_SESSION", value: "pi-driver-42-0abc12" },
	{
		name: "the hc CLI reaches the run's core",
		key: "HC_SOCKET",
		value: "/t/pi-driver/pi-driver-42-0abc12/herdr-core/pi-driver-42-0abc12.sock",
	},
	{ name: "owned-work reaches the run's core", key: "HC_TERMINAL_SOCKET", value: layout.socket },
	{ name: "the probe writes into the run", key: "PI_DRIVER_PROBE", value: layout.probe },
	{ name: "the caller's slice is dropped", key: "PI_OWNED_WORK_SLICE", value: undefined },
	{ name: "the state folder follows the scratch home", key: "XDG_STATE_HOME", value: undefined },
	{ name: "the config folder follows the scratch home", key: "XDG_CONFIG_HOME", value: undefined },
	{ name: "the runtime folder stays, for systemd", key: "XDG_RUNTIME_DIR", value: "/run/user/1000" },
	{ name: "other keys stay", key: "LANG", value: "C.UTF-8" },
	{ name: "borrowed config is added", key: "GIT_CONFIG_GLOBAL", value: "/h/.gitconfig" },
	{ name: "an unset key stays unset", key: "UNSET", value: undefined },
] as const;

for (const { name, key, value } of envRows) {
	test(`runEnv: ${name}`, () => {
		if (value === undefined) {
			expect(env).not.toHaveProperty(key);
		} else {
			expect(env).toHaveProperty(key, value);
		}
	});
}

const settingsRows = [
	{
		name: "resource keys are dropped so the live harness never loads",
		human: {
			packages: ["npm:x"],
			extensions: ["/h/.pi/agent/x.ts"],
			skills: [],
			prompts: [],
			themes: [],
			theme: "dark",
		},
		overrides: {},
		expected: { theme: "dark" },
	},
	{
		name: "an override replaces the whole top-level key",
		human: { compaction: { enabled: false, reserveTokens: 1 }, theme: "dark" },
		overrides: { compaction: { enabled: true } },
		expected: { compaction: { enabled: true }, theme: "dark" },
	},
	{
		name: "an override may set a resource key the human had",
		human: { extensions: ["/h/x.ts"] },
		overrides: { extensions: ["/w/y.ts"] },
		expected: { extensions: ["/w/y.ts"] },
	},
] as const;

for (const { name, human, overrides, expected } of settingsRows) {
	test(`settingsOf: ${name}`, () => {
		expect(settingsOf({ human, overrides })).toEqual(expected);
	});
}

const override = { modelOverrides: { "claude-fable-5-2": { contextWindow: 40_000 } } };

const modelsRows = [
	{
		name: "with no human file, the setup starts one",
		human: Option.none(),
		providers: { "ultra-a": override },
		expected: { providers: { "ultra-a": override } },
	},
	{
		name: "a setup provider replaces the human's of that name and keeps the rest",
		human: Option.some({ providers: { "ultra-a": { apiKey: "k" }, local: { baseUrl: "http://l" } }, other: 1 }),
		providers: { "ultra-a": override },
		expected: { providers: { "ultra-a": override, local: { baseUrl: "http://l" } }, other: 1 },
	},
	{
		name: "with no setup providers, the human's file is copied",
		human: Option.some({ providers: { local: { baseUrl: "http://l" } } }),
		providers: {},
		expected: { providers: { local: { baseUrl: "http://l" } } },
	},
] as const;

for (const { name, human, providers, expected } of modelsRows) {
	test(`modelsOf: ${name}`, () => {
		expect(modelsOf({ human, providers })).toEqual(expected);
	});
}
