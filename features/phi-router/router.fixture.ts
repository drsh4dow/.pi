import { afterAll } from "bun:test";

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { type SessionEntry, VIRTUAL_MODEL_STATE_ENTRY } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { type Request, type Route, routeWith } from "./index.ts";
import { LaneLine } from "./lanes.ts";
import { Judge, JudgeFailed } from "./policy/index.ts";
import { RouterState } from "./route.ts";

const scratch = `${Bun.env["TMPDIR"] ?? "/tmp"}/phi-router-test-${String(process.pid)}`;

export const run = <Value, Failure>(effect: Effect.Effect<Value, Failure, FileSystem.FileSystem>) =>
	Effect.runPromise(Effect.provide(effect, NodeServices.layer));

afterAll(() =>
	run(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;

			yield* fs.remove(scratch, { recursive: true, force: true });
		}),
	),
);

export const opus = getBuiltinModel("anthropic", "claude-opus-5-5");

export const phiAuto = { ...opus, provider: "phi", id: "auto" };

export const onAccount = (provider: string) => ({ ...opus, provider });

export const syntheticChart =
	"Patient Jane Roe, DOB 1961-03-14, MRN 4471-0932-88, admitted with diabetic ketoacidosis.";

/** Pi's default `compaction.reserveTokens`. */
const reserveTokens = 16_384;

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const system: Message = { role: "system", content: "You are a coding agent.", timestamp: 0 };

export const asked = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });

export const done = (provider: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text: "Done." }],
	api: "anthropic-messages",
	provider,
	model: opus.id,
	usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
	stopReason: "stop",
	timestamp: 0,
});

export const ranCat = (provider: string): AssistantMessage => ({
	...done(provider),
	content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "cat admissions.txt" } }],
	stopReason: "toolUse",
});

export const catOutput = (text: string): Message => ({
	role: "toolResult",
	toolCallId: "call-1",
	toolName: "bash",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 0,
});

export const screenshot: Message = {
	role: "user",
	content: [
		{ type: "text", text: "Why does this page render blank?" },
		{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
	],
	timestamp: 0,
};

const failedReply = (provider: string, errorMessage: string): AssistantMessage => ({
	...done(provider),
	stopReason: "error",
	errorMessage,
});

export const rateLimitedOn = (provider: string) =>
	failedReply(provider, '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}');

export const overloadedOn = (provider: string) =>
	failedReply(provider, '529 {"type":"error","error":{"type":"overloaded_error"}}');

type Verdict = "judge" | "error" | "timeout";

const scriptedJudge = (verdict: Verdict, calls: Array<string>) =>
	Layer.succeed(Judge, {
		maxChars: 400_000,
		ask: ({ seen, fresh }) => {
			calls.push(fresh);

			if (verdict !== "judge") {
				return Effect.fail(JudgeFailed.make({ why: verdict }));
			}

			const phi = Str.includes(syntheticChart)(`${seen}\n${fresh}`);

			return Effect.succeed({
				pPhi: phi ? 0.97 : 0.01,
				category: phi ? Option.some("name" as const) : Option.none(),
			});
		},
	});

interface World {
	readonly home: string;
	readonly cwd: string;
	readonly session: string;
	readonly judgeCalls: Array<string>;
	verdict: Verdict;
	known: number;
	accountWindow: number;
}

export const worldOf = ({
	name,
	settings = Option.some('{ "mode": "enforce" }'),
}: {
	readonly name: string;
	readonly settings?: Option.Option<string>;
}) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const home = `${scratch}/${name}`;

		yield* fs.makeDirectory(`${home}/.pi/agent`, { recursive: true });
		yield* fs.makeDirectory(`${home}/repo`, { recursive: true });

		for (const text of Option.toArray(settings)) {
			yield* fs.writeFileString(`${home}/.pi/agent/phi-router.json`, Str.replace("REPO", `${home}/repo`)(text));
		}

		const world: World = {
			home,
			cwd: `${home}/repo`,
			session: name,
			judgeCalls: [],
			verdict: "judge",
			known: 0,
			accountWindow: opus.contextWindow,
		};

		return world;
	});

export const stateEntry = (data: Schema.JsonObject): SessionEntry => ({
	type: "custom",
	customType: VIRTUAL_MODEL_STATE_ENTRY,
	id: "s0000001",
	parentId: "",
	timestamp: "2026-05-14T10:00:00.000Z",
	data,
});

export const phiState = (state: Schema.Json) => ({ provider: "phi", modelId: "auto", state });

const EncodedState = Schema.toEncoded(RouterState);

const PiStateEntry = Schema.Struct({
	type: Schema.Literal("custom"),
	customType: Schema.Literal(VIRTUAL_MODEL_STATE_ENTRY),
	data: Schema.Struct({
		provider: Schema.Literal("phi"),
		modelId: Schema.Literal("auto"),
		state: Schema.optionalKey(EncodedState),
	}),
});

const decodePiStateEntry = Schema.decodeUnknownOption(PiStateEntry);

/**
 * What pi's `getVirtualModelState` (virtual-models.js) hands the route as `request.state`: the latest phi/auto entry's
 * `state`, none when that entry has none. A state this fixture cannot type is left out; the router never reads it.
 */
const piStateOf = (branch: ReadonlyArray<SessionEntry>) => {
	const latest = Arr.last(Arr.getSomes(Arr.map(branch, (entry) => decodePiStateEntry(entry))));

	return Option.flatMap(latest, ({ data }) => Option.fromUndefinedOr(data.state));
};

export const branchOf = ({
	world,
	entries = [],
}: {
	readonly world: World;
	readonly entries?: ReadonlyArray<SessionEntry>;
}) => {
	const branch = [...entries];

	const send = (reason: Request["reason"], messages: ReadonlyArray<Message>, failed?: AssistantMessage) =>
		Effect.promise(() => {
			const route = routeWith({ env: { HOME: world.home }, judge: scriptedJudge(world.verdict, world.judgeCalls) });
			const request: Request = { model: phiAuto, thinkingLevel: "high", reason, messages };

			for (const state of Option.toArray(piStateOf(branch))) {
				request.state = state;
			}

			if (failed !== undefined) {
				request.failed = { model: onAccount(failed.provider), message: failed };
			}

			const ctx = {
				cwd: world.cwd,
				compaction: (window: number) => ({ at: Option.some(window - reserveTokens), known: world.known }),
				sessionManager: {
					getSessionId: () => world.session,
					getLeafId: () => "e0000001",
					getBranch: () => [...branch],
				},
				modelRegistry: {
					find: (provider: string) => ({ ...onAccount(provider), contextWindow: world.accountWindow }),
					hasConfiguredAuth: () => true,
				},
			};

			return route(request, ctx);
		}).pipe(
			Effect.map((routed: Route) => {
				if (routed.state !== undefined) {
					branch.push(stateEntry(phiState(routed.state)));
				}

				return routed.model.provider;
			}),
		);

	return { send, entries: () => [...branch] };
};

export const lanesOf = (world: World) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const text = yield* fs.readFileString(`${world.home}/.local/state/pi-phi-router/lanes/${world.session}.jsonl`);
		const lines = Arr.filter(Str.split(text, "\n"), Str.isNonEmpty);
		const lanes = yield* Effect.forEach(lines, (line) => Schema.decodeEffect(LaneLine)(line));

		return { text, lanes };
	});

export const personal = ["ultra-a", "ultra-b"];
