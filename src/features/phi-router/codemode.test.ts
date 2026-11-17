import { expect, test } from "bun:test";

import * as Effect from "effect/Effect";

import { guardCodemode } from "./gate.ts";
import { onAccount, phiAuto } from "./router.fixture.ts";

const codemode = (code: string) => ({
	type: "tool_call" as const,
	toolCallId: "call-1",
	toolName: "codemode",
	input: { code },
});

const blocked = [
	{ name: "a script that calls models", code: "await models.classify(m, c)" },
	{ name: String.raw`an escaped \u006dodels`, code: String.raw`const m = this["\u006dodels"]` },
	{ name: String.raw`a braced \u{67}lobalThis`, code: String.raw`\u{67}lobalThis.x` },
	{ name: "a dynamic import", code: 'const m = await import ("x")' },
];

const guardedInPhiAuto = (code: string): ReturnType<typeof guardCodemode> =>
	guardCodemode({ event: codemode(code), ctx: { model: phiAuto } });

test.each(blocked)("the codemode guard in a phi/auto session: $name is blocked", ({ code }) =>
	Effect.runPromise(
		Effect.map(
			Effect.promise(() => guardedInPhiAuto(code)),
			(result) => {
				expect(result?.block).toBe(true);
			},
		),
	),
);

test("the codemode guard in a phi/auto session: a script that only calls tools is allowed", () =>
	Effect.runPromise(
		Effect.map(
			Effect.promise(() => guardedInPhiAuto('await tools.read({ path: "a.ts" })')),
			(result) => {
				expect(result).toBeUndefined();
			},
		),
	));

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
