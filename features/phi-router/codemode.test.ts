import { expect, test } from "bun:test";

import * as Effect from "effect/Effect";

import { guardCodemode } from "./index.ts";
import { onAccount, phiAuto } from "./router.fixture.ts";

const codemode = (code: string) => ({
	type: "tool_call" as const,
	toolCallId: "call-1",
	toolName: "codemode",
	input: { code },
});

const guarded = [
	{ name: "a script that calls models", code: "await models.classify(m, c)", blocked: true },
	{ name: String.raw`an escaped \u006dodels`, code: String.raw`const m = this["\u006dodels"]`, blocked: true },
	{ name: String.raw`a braced \u{67}lobalThis`, code: String.raw`\u{67}lobalThis.x`, blocked: true },
	{ name: "a dynamic import", code: 'const m = await import ("x")', blocked: true },
	{ name: "a script that only calls tools", code: 'await tools.read({ path: "a.ts" })', blocked: false },
];

for (const { name, code, blocked } of guarded) {
	test(`the codemode guard in a phi/auto session: ${name} is ${blocked ? "blocked" : "allowed"}`, () =>
		Effect.runPromise(
			Effect.map(
				Effect.promise(() => guardCodemode({ event: codemode(code), ctx: { model: phiAuto } })),
				(result) => {
					expect(result?.block ?? false).toBe(blocked);
				},
			),
		));
}

const scriptIn = (provider: string) => {
	const ctx = { model: onAccount(provider) };

	return Effect.promise(() => guardCodemode({ event: codemode("models.x"), ctx }));
};

const bothSessions = Effect.all([scriptIn("ent"), scriptIn("ultra-a")]);

test("the codemode guard covers a BAA-account session and leaves a personal one alone", () =>
	Effect.runPromise(
		Effect.map(bothSessions, ([ent, personalSession]) => {
			expect(ent?.block).toBe(true);
			expect(personalSession).toBeUndefined();
		}),
	));
