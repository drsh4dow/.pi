import { expect } from "bun:test";

import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Struct from "effect/Struct";
import type { Static } from "typebox";

import type { Design } from "../../clients/pi-cli/index.ts";
import type { DelegateParams } from "./brief.ts";
import type { Brief, ChildRole } from "./child.ts";
import { Ledger } from "./ledger.ts";
import { Tools } from "./tools.ts";
import { type ContinueRequest, type Handle, StartRequest, WorkRef } from "./work.ts";

const luna = getBuiltinModel("openai", "gpt-6-luna");

const opus = getBuiltinModel("anthropic", "claude-opus-5-5");

export const proxied = { ...luna, provider: "proxy/openai" };

export const fixtures = `${Bun.env["TMPDIR"] ?? "/tmp"}/owned-work-tools-test-${String(process.pid)}`;

export const body = "Read it cold.";

const instructionFiles = {
	plain: body,
	profiled: `---\nmodel: deep\nthinking: low\nreadonly: true\nrole: leaf\n---\n${body}`,
	owned: `---\nrole: owner\n---\n${body}`,
	ruler: `---\nrole: root\n---\n${body}`,
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
	aliases: {
		deep: { provider: "anthropic", id: "claude-opus-5-5", use: "work that needs taste" },
		quick: { provider: "openai", id: "gpt-6-luna", use: "mechanical scouting" },
		gone: { provider: "anthropic", id: "nope", use: "nothing" },
	},
	panel: ["deep", "proxy/openai/gpt-6-luna"],
};

interface Started {
	readonly brief: Brief;
	readonly cwd: string;
}

export const started: Array<Started> = [];

export const continued: Array<ContinueRequest> = [];

const handle: Handle = {
	ref: WorkRef("delegate-1"),
	kind: "delegate",
	terminal: Option.none(),
	group: Option.none(),
	ready: Option.none(),
};

const ledger = Layer.mock(Ledger)({
	start: (request) =>
		Effect.sync(() => {
			if (StartRequest.$is("Delegate")(request)) {
				started.push({ brief: request.brief, cwd: request.childSession.cwd });
			}

			return handle;
		}),
	continue: (request) =>
		Effect.sync(() => {
			continued.push(request);

			return handle;
		}),
});

const home = ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: fixtures }));

export const runtime = ManagedRuntime.make(Layer.mergeAll(NodeServices.layer, ledger, home));

export const delegateStarting = (roles: ReadonlyArray<ChildRole>) =>
	Tools.delegate(runtime, roles, { cwd: "/", dir: "/d" }, table, Option.none());

export const delegate = delegateStarting(["owner", "leaf"]);

/** A real caller carries its own thinking level, which a delegate must never take. */
export const callerOf = (): Parameters<typeof delegate.execute>[4] => {
	const caller = {
		cwd: `${fixtures}/work`,
		model: luna,
		thinkingLevel: "low",
		modelRegistry: { getAll: () => [luna, opus, proxied] },
		sessionManager: { getBranch: () => [] },
	};

	return caller;
};

interface Shown {
	readonly name: string;
	readonly role: ChildRole;
	readonly model: string;
	readonly thinking: string | undefined;
	readonly readOnly: boolean;
	readonly instructions: { readonly file: string; readonly text: string } | undefined;
	readonly design: Design | undefined;
	readonly cwd: string;
}

/** What a call with a name, a message, the leaf role and the `quick` alias alone starts. */
const plainStart: Shown = {
	name: "m",
	role: "leaf",
	model: "openai/gpt-6-luna",
	thinking: "high",
	readOnly: false,
	instructions: undefined,
	design: undefined,
	cwd: "/",
};

export const handed = (start: Partial<Shown> = {}) => ({
	isError: false,
	details: { ref: "delegate-1", kind: "delegate", next: "end your turn; delegate-1 wakes you" },
	started: [{ ...plainStart, ...start }],
});

export const refused = (message: string) => ({
	isError: true,
	details: { error: "BadDelegate", message },
	started: [],
});

export const goal = "Cap the retries.";

export interface BriefRow {
	readonly name: string;
	readonly call: Static<DelegateParams>;
	readonly caller?: Partial<ReturnType<typeof callerOf>>;
	readonly roles?: ReadonlyArray<ChildRole>;
	readonly expect: ReturnType<typeof handed> | ReturnType<typeof refused>;
}

export const runBriefRow = (row: BriefRow) =>
	runtime.runPromise(
		Effect.gen(function* () {
			const caller = { ...callerOf(), ...row.caller };
			const tool = delegateStarting(row.roles ?? ["owner", "leaf"]);

			const { isError, details } = yield* Effect.promise(() =>
				tool.execute("call", { goal, ...row.call }, undefined, undefined, caller),
			);

			const shown = Arr.map(started.splice(0), ({ brief, cwd }) => ({
				name: brief.name,
				role: brief.role,
				model: brief.model,
				thinking: Option.getOrUndefined(brief.thinking),
				readOnly: brief.readOnly,
				instructions: Option.getOrUndefined(brief.instructions),
				design: brief.role === "owner" ? brief.design : undefined,
				cwd,
			}));

			expect({ isError, details, started: shown }).toEqual(row.expect);
		}),
	);
