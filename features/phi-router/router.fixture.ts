import { afterAll } from "bun:test";

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { type SessionEntry, VIRTUAL_MODEL_STATE_ENTRY } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Function from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { type Request, type Route, routeWith } from "./dispatch.ts";
import { LaneJson } from "./lanes.ts";
import { Judge, JudgeFailed } from "./policy/engine.ts";
import { pinEntryType, RouterState } from "./route.ts";
import { bookOf, type VerdictBook, type VerdictsEntry, verdictsEntryType } from "./store.ts";

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

/** Text the scripted judge scores as a patient's identifiers. */
export const syntheticChart =
	"Patient Jane Roe, DOB 1961-03-14, MRN 4471-0932-88, admitted with diabetic ketoacidosis.";

/** Text the `ssn` rule seals before any judge call. */
export const ssnRecord = "member_id 88213, ssn 078-05-1120, plan gold";

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

const failedReply = (provider: string, errorMessage: string): AssistantMessage => ({
	...done(provider),
	stopReason: "error",
	errorMessage,
});

export const rateLimitedOn = (provider: string) =>
	failedReply(provider, '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}');

export const overloadedOn = (provider: string) =>
	failedReply(provider, '529 {"type":"error","error":{"type":"overloaded_error"}}');

type JudgeBehavior = "answers" | "errors" | "dies";

interface World {
	readonly home: string;
	readonly cwd: string;
	readonly session: string;
	/** Every piece the judge was asked about, in order. */
	readonly judged: Array<string>;
	readonly notices: Array<string>;
	judge: JudgeBehavior;
}

const usage = { calls: 1, inputTokens: 10, cost: 0.001, ms: 5 };

/** Scores `syntheticChart` as a patient's name and everything else as clean. */
export const scriptedJudge = (world: Pick<World, "judged" | "judge">) =>
	Judge.of({
		identifier: (input) => {
			world.judged.push(input.piece);

			if (world.judge === "dies") {
				return Effect.die("the judge died");
			}

			if (world.judge === "errors") {
				return Effect.fail(JudgeFailed.make({ why: "judge-error" }));
			}

			return Effect.succeed({ score: Str.includes(syntheticChart)(input.piece) ? 0.97 : 0.01, usage });
		},
		kind: () => Effect.succeed({ kind: "patient-name", usage }),
	});

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

		const world: World = { home, cwd: `${home}/repo`, session: name, judged: [], notices: [], judge: "answers" };

		return world;
	});

/** The fields pi gives every custom entry. */
const custom = { type: "custom", id: "c0000001", parentId: "", timestamp: "2026-05-14T10:00:00.000Z" } as const;

const PiStateEntry = Schema.Struct({
	type: Schema.Literal("custom"),
	customType: Schema.Literal(VIRTUAL_MODEL_STATE_ENTRY),
	data: Schema.Struct({
		provider: Schema.Literal("phi"),
		modelId: Schema.Literal("auto"),
		state: Schema.toEncoded(RouterState),
	}),
});

const decodePiStateEntry = Schema.decodeUnknownOption(PiStateEntry);

/** What pi hands the route as `request.state`: the latest phi/auto entry's `state`. */
const piStateOf = (branch: ReadonlyArray<SessionEntry>) => {
	const states = Arr.getSomes(Arr.map(branch, (entry) => decodePiStateEntry(entry)));

	return Option.map(Arr.last(states), ({ data }) => data.state);
};

/** The book as `session_start` folds it from the session's entries, with the system cache under the world's HOME. */
const foldedBook = (world: World, branch: ReadonlyArray<SessionEntry>) => {
	const home = ConfigProvider.fromEnvRecord({ HOME: world.home });

	return bookOf({ sessionManager: { getEntries: () => [...branch] }, pid: process.pid }).pipe(
		Effect.provideService(ConfigProvider.ConfigProvider, home),
		Effect.orDie,
	);
};

interface Sent {
	readonly world: World;
	readonly branch: Array<SessionEntry>;
	readonly book: VerdictBook;
	readonly reason: Request["reason"];
	readonly messages: ReadonlyArray<Message>;
	readonly failed: AssistantMessage | undefined;
}

/** One request through the real `route()`, with what pi and the router append landing on `branch`. */
const sent = ({ world, branch, book, reason, messages, failed }: Sent) =>
	Effect.promise(() => {
		const session = {
			book: Option.some(book),
			appendVerdicts: (data: VerdictsEntry) => branch.push({ ...custom, customType: verdictsEntryType, data }),
		};

		const request: Request = { model: phiAuto, thinkingLevel: "high", reason, messages };

		for (const state of Option.toArray(piStateOf(branch))) {
			request.state = state;
		}

		if (failed !== undefined) {
			request.failed = { model: onAccount(failed.provider), message: failed };
		}

		const ctx = {
			cwd: world.cwd,
			sessionManager: { getSessionId: () => world.session, getBranch: () => [...branch] },
			modelRegistry: { find: (provider: string) => onAccount(provider), hasConfiguredAuth: () => true },
			ui: { notify: (message: string) => world.notices.push(message), setStatus: Function.constVoid },
		};

		return routeWith({ env: { HOME: world.home }, judge: Layer.succeed(Judge, scriptedJudge(world)), session })(
			request,
			ctx,
		);
	}).pipe(
		Effect.map((routed: Route) => {
			if (routed.state !== undefined) {
				const data = { provider: "phi", modelId: "auto", state: routed.state };

				branch.push({ ...custom, customType: VIRTUAL_MODEL_STATE_ENTRY, data });
			}

			return routed.model.provider;
		}),
	);

/** One session branch, its book folded as at `session_start`. */
export const branchOf = ({
	world,
	entries = [],
}: {
	readonly world: World;
	readonly entries?: ReadonlyArray<SessionEntry>;
}) =>
	Effect.gen(function* () {
		const branch = [...entries];
		let book = yield* foldedBook(world, branch);

		const send = (reason: Request["reason"], messages: ReadonlyArray<Message>, failed?: AssistantMessage) =>
			sent({ world, branch, book, reason, messages, failed });

		/** A new pi process on the same session file: the book folds again from the appended entries. */
		const restart = Effect.map(foldedBook(world, branch), (folded) => {
			book = folded;
		});

		const pin = (pinned: boolean) => branch.push({ ...custom, customType: pinEntryType, data: { pinned } });

		return { send, restart, pin, book: () => book };
	});

export const lanesOf = (world: World) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const text = yield* fs.readFileString(`${world.home}/.local/state/pi-phi-router/lanes/${world.session}.jsonl`);
		const lines = Arr.filter(Str.split(text, "\n"), Str.isNonEmpty);
		const lanes = yield* Effect.forEach(lines, (line) => Schema.decodeEffect(LaneJson)(line));

		return { text, lanes };
	});

export const personal = ["ultra-a", "ultra-b"];
