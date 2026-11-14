import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Str from "effect/String";

const oxlint = `${import.meta.dirname}/../../../node_modules/.bin/oxlint`;

const flagged = [
	"agent/bin/bad.ts:1:1: ../../features/demo/internal.ts reaches inside features/demo/. Import features/demo/index.ts, its public interface.",
	"agent/bin/bad.ts:2:1: an entrypoint (agent/extensions/<name>/ or agent/bin/) may not import a client (clients/<system>/): ../../clients/demo/index.ts.",
	"agent/extensions/bad/index.ts:1:1: ../../../features/demo/internal.ts reaches inside features/demo/. Import features/demo/index.ts, its public interface.",
	"agent/extensions/bad/index.ts:2:1: an entrypoint (agent/extensions/<name>/ or agent/bin/) may not import a client (clients/<system>/): ../../../clients/demo/index.ts.",
	"clients/bad/index.ts:1:1: a client (clients/<system>/) may not import a feature (features/<name>/): ../../features/demo/index.ts.",
	"clients/demo/index.ts:2:1: ./wire.js must end in .ts, as AGENTS.md requires of relative imports.",
	"clients/hash#1/index.ts:1:1: ../demo/wire.ts reaches inside clients/demo/. Import clients/demo/index.ts, its public interface.",
	"clients/query?1/index.ts:1:1: ../demo/wire.ts reaches inside clients/demo/. Import clients/demo/index.ts, its public interface.",
	"features/bad/index.ts:1:1: ../../clients/demo/wire.ts reaches inside clients/demo/. Import clients/demo/index.ts, its public interface.",
	"features/bad/index.ts:2:1: a feature (features/<name>/) may not import an entrypoint (agent/extensions/<name>/ or agent/bin/): ../../agent/extensions/demo/index.ts.",
	"features/bad/index.ts:3:1: a feature (features/<name>/) may not import an entrypoint (agent/extensions/<name>/ or agent/bin/): ../../agent/bin/good.ts.",
	"features/demo/bad.scenario.ts:1:1: ../../tools/demo/world.ts reaches inside tools/demo/. Import tools/demo/index.ts, its public interface.",
	"features/demo/uses.ts:1:1: a feature (features/<name>/) may not import a tool (tools/<name>/): ../../tools/demo/index.ts.",
	"features/demo/uses.ts:2:1: ./good.scenario.ts is a scenario. Nothing imports a scenario; run it with bun <file>.",
	"features/demo/uses.ts:4:27: ./good.scenario.ts is a scenario. Nothing imports a scenario; run it with bun <file>.",
];

const rule = " [Error/harness(import-boundaries)]";

test("import-boundaries flags each fixture import that breaks the layout, and no other", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const cwd = `${import.meta.dirname}/../fixtures/harness-layout`;
			const lint = Bun.spawn([oxlint, "-c", "oxlintrc.json", "--format", "unix", "."], { cwd });

			const output = yield* Effect.promise(() => new Response(lint.stdout).text());
			const found = Arr.filter(Str.split(output, "\n"), Str.endsWith(rule));
			const messages = Arr.map(found, Str.replace(rule, ""));
			const exitCode = yield* Effect.promise(() => lint.exited);

			expect(Arr.sort(messages, Order.String)).toEqual(flagged);
			expect(exitCode).toBe(1);
		}),
	));
