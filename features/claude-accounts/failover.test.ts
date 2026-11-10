import { expect, test } from "bun:test";

import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import * as Arr from "effect/Array";

import { accounts } from "./accounts.ts";
import { endedOnRateLimit, failoverTargets } from "./failover.ts";

const opus = getBuiltinModel("anthropic", "claude-opus-5-5");

/** A registry where every account offers Opus and nothing else. */
const find = (provider: string, id: string) =>
	Arr.some(accounts, (account) => account.id === provider) && id === opus.id ? { ...opus, provider } : undefined;

const withoutUltraB = (provider: string, id: string) => (provider === "ultra-b" ? undefined : find(provider, id));

const failovers = [
	{
		name: "a session on ultra-a tries ultra-b, then ent",
		request: { current: { ...opus, provider: "ultra-a" }, find },
		targets: ["ultra-b/claude-opus-5-5", "ent/claude-opus-5-5"],
	},
	{
		name: "a session on ultra-b tries ent, then wraps to ultra-a",
		request: { current: { ...opus, provider: "ultra-b" }, find },
		targets: ["ent/claude-opus-5-5", "ultra-a/claude-opus-5-5"],
	},
	{
		name: "an account without the session's model is skipped",
		request: { current: { ...opus, provider: "ultra-a" }, find: withoutUltraB },
		targets: ["ent/claude-opus-5-5"],
	},
	{
		name: "a session on no Claude account has nowhere to go",
		request: { current: { ...opus, provider: "openai", id: "gpt-6.1-sol" }, find },
		targets: [],
	},
	{
		name: "a session on no model has nowhere to go",
		request: { current: undefined, find },
		targets: [],
	},
];

for (const { name, request, targets } of failovers) {
	test(`a rate limit fails over to the same model on the next account: ${name}`, () => {
		expect(Arr.map(failoverTargets(request), ({ provider, id }) => `${provider}/${id}`)).toEqual(targets);
	});
}

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const answered = {
	role: "assistant" as const,
	content: [],
	api: "anthropic-messages" as const,
	provider: "ultra-a",
	model: "claude-opus-5-5",
	usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
	stopReason: "stop" as const,
	timestamp: 0,
};

const failed = (errorMessage: string) => ({ ...answered, stopReason: "error" as const, errorMessage });

const asked = { role: "user" as const, content: "Find the bug.", timestamp: 0 };

const rateLimited = failed(
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}',
);

const overloaded = failed('529 {"type":"error","error":{"type":"overloaded_error"}}');

const runEnds = [
	{ name: "a run whose last reply is a 429 ended on a rate limit", messages: [asked, rateLimited], limited: true },
	{ name: "a run that recovered after a 429 did not", messages: [asked, rateLimited, answered], limited: false },
	{ name: "an overloaded API is not an account's rate limit", messages: [asked, overloaded], limited: false },
	{ name: "a run that ends on a user message did not", messages: [asked], limited: false },
];

for (const { name, messages, limited } of runEnds) {
	test(name, () => {
		expect(endedOnRateLimit(messages)).toBe(limited);
	});
}
