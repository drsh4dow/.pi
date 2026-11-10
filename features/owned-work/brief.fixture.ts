import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Struct from "effect/Struct";

import type { Brief } from "./child.ts";
import { Ledger } from "./ledger.ts";
import { Tools } from "./tools.ts";
import { StartRequest, WorkRef } from "./work.ts";

const haiku = getBuiltinModel("anthropic", "claude-haiku-5-5");

const opus = getBuiltinModel("anthropic", "claude-opus-5-5");

export const unlisted = { ...haiku, id: "claude-haiku-9-9" };

export const proxied = { ...haiku, provider: "proxy/anthropic" };

export const fixtures = `${Bun.env["TMPDIR"] ?? "/tmp"}/owned-work-tools-test-${String(process.pid)}`;

export const body = "Read it cold.";

const instructionFiles = {
	plain: body,
	profiled: `---\nmodel: deep\nthinking: low\nreadonly: true\n---\n${body}`,
	slow: `---\nthinking: low\n---\n${body}`,
	misspelt: `---\nread-only: true\n---\n${body}`,
	loud: `---\nthinking: loud\n---\n${body}`,
	unclosed: `---\nreadonly: true\n\n${body}`,
	late: `\n---\nreadonly: true\n---\n${body}`,
};

await Bun.$`mkdir -p ${fixtures}/work && ln -sfn work ${fixtures}/link`.quiet();

await Promise.all(
	Arr.map(Struct.keys(instructionFiles), (name) => Bun.write(`${fixtures}/${name}.md`, instructionFiles[name])),
);

export const table = {
	aliases: { deep: "claude-opus-5-5", quick: "claude-haiku-5-5", gone: "nope" },
	fallbackProvider: "anthropic",
	panel: ["anthropic/claude-opus-5-5", "proxy/anthropic/claude-haiku-5-5"],
};

interface Started {
	readonly brief: Brief;
	readonly cwd: string;
}

export const started: Array<Started> = [];

const ledger = Layer.mock(Ledger)({
	start: (request) =>
		Effect.sync(() => {
			if (StartRequest.$is("Delegate")(request)) {
				started.push({ brief: request.brief, cwd: request.childSession.cwd });
			}

			return {
				ref: WorkRef("delegate-1"),
				kind: "delegate" as const,
				terminal: Option.none(),
				ready: Option.none(),
			};
		}),
});

const home = ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: fixtures }));

export const runtime = ManagedRuntime.make(Layer.mergeAll(NodeServices.layer, ledger, home));

export const delegate = Tools.delegate(runtime, 2, { cwd: "/", dir: "/d" }, table);

export const callerOf = (): Parameters<typeof delegate.execute>[4] => ({
	cwd: `${fixtures}/work`,
	model: haiku,
	thinkingLevel: "high",
	modelRegistry: { getAll: () => [haiku, opus, proxied] },
});

interface Shown {
	readonly name: string;
	readonly model: string;
	readonly thinking: string | undefined;
	readonly readOnly: boolean;
	readonly instructions: { readonly file: string; readonly text: string } | undefined;
	readonly cwd: string;
}

/** What a call with a name and a message alone starts. */
const plainStart: Shown = {
	name: "m",
	model: "anthropic/claude-haiku-5-5",
	thinking: "high",
	readOnly: false,
	instructions: undefined,
	cwd: "/",
};

export const handed = (start: Partial<Shown> = {}) => ({
	isError: false,
	details: { ref: "delegate-1", kind: "delegate" },
	started: [{ ...plainStart, ...start }],
});

export const refused = (message: string) => ({
	isError: true,
	details: { error: "BadDelegate", message },
	started: [],
});
