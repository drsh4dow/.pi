import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SettingsManager,
	type ModelRoute,
	type ModelRouteRequest,
	type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { type AccountId, accounts, isRateLimited } from "../claude-accounts/index.ts";
import { type Classify, decisionsJudge, decisionsModel } from "./decisions.ts";
import { delegateTarget, isProtected, type ModelKey, type Target, unsafeReach, type Wanted } from "./gate.ts";
import { appendLane } from "./lanes.ts";
import { Fixtures } from "./policy/digest.ts";
import type { Judge } from "./policy/index.ts";
import { decide, type RouteRequest, RouterState } from "./route.ts";
import { keepProtected, keepProtectedOnStart } from "./selection.ts";
import { phiId, phiProvider, storedOnBranch, transcriptOf } from "./session.ts";
import { defaultModel, readSettings } from "./settings.ts";

export type { Wanted } from "./gate.ts";

export type Request = ModelRouteRequest<typeof RouterState.Encoded>;

export type Route = ModelRoute<typeof RouterState.Encoded>;

type RouterContext = Pick<ExtensionContext, "cwd"> & {
	/** Where pi compacts a request it sends to a model with `window`. */
	readonly compaction: (window: number) => RouteRequest["compaction"];
	readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getLeafId" | "getBranch">;
	readonly modelRegistry: Pick<ExtensionContext["modelRegistry"], "find" | "hasConfiguredAuth">;
};

type Env = Readonly<Record<string, string | undefined>>;

const decisionsOf = (ctx: ExtensionContext, signal: AbortSignal | undefined) => {
	const classifier = Option.fromUndefinedOr(ctx.modelRegistry.findOfType("classifier", "openai", decisionsModel));

	const classify: Classify = (context, options) =>
		Option.match(classifier, {
			onNone: () => Promise.reject(new Error(`no classifier openai/${decisionsModel}`)),
			onSome: (model) =>
				ctx.modelRegistry.classify(model, context, signal === undefined ? options : { ...options, signal }),
		});

	return decisionsJudge(classify);
};

const encodeState = Schema.encodeEffect(RouterState);

/** Where pi's `_exceedsCompactionThreshold` (agent-session.js) compacts a request routed to a model with `window`. */
const compactionOf = (ctx: ExtensionContext, window: number) => {
	const settings = SettingsManager.create(ctx.cwd, getAgentDir()).getCompactionSettings(ctx.model);

	return {
		at: settings.enabled ? Option.some(window - settings.reserveTokens) : Option.none(),
		known: ctx.getContextUsage()?.tokens ?? 0,
	};
};

const personalAccounts = Arr.filterMap(accounts, ({ id, baa }) => (baa ? Result.failVoid : Result.succeed(id)));

/** Pi checks its compaction threshold against the model a request is dispatched to, so take the smallest window. */
const smallestWindow = (virtual: Model<Api>, modelOn: (account: AccountId) => Option.Option<Model<Api>>) => {
	const dispatched = Arr.getSomes(Arr.map(personalAccounts, modelOn));

	return Arr.reduce(dispatched, virtual.contextWindow, (smallest, model) => Math.min(smallest, model.contextWindow));
};

const route = Effect.fn("route")(function* (request: Request, ctx: RouterContext) {
	const settings = yield* readSettings(ctx.cwd);
	const transcript = yield* transcriptOf(request.messages);
	const modelOn = (account: AccountId) => Option.fromUndefinedOr(ctx.modelRegistry.find(account, settings.model));

	const decision = yield* decide({
		session: ctx.sessionManager.getSessionId(),
		leaf: ctx.sessionManager.getLeafId(),
		reason: request.reason,
		failed: Option.map(Option.fromUndefinedOr(request.failed), ({ model, message }) => ({
			account: model.provider,
			rateLimited: isRateLimited(message),
		})),
		stored: storedOnBranch(ctx.sessionManager.getBranch()),
		transcript,
		mode: settings.mode,
		compaction: ctx.compaction(smallestWindow(request.model, modelOn)),
		usable: (account) => Option.exists(modelOn(account), (model) => ctx.modelRegistry.hasConfiguredAuth(model)),
	}).pipe(Effect.provideService(Fixtures, settings.fixtures));

	yield* appendLane(decision.lane);

	const model = yield* Effect.fromOption(modelOn(decision.dispatch));
	const routed: Route = { model, thinkingLevel: request.thinkingLevel };

	if (Option.isNone(decision.state)) {
		return routed;
	}

	return { ...routed, state: yield* encodeState(decision.state.value) };
});

const failClosed = (request: Request, ctx: RouterContext) =>
	Effect.catchCause((cause) => {
		const ent = Effect.fromNullishOr(ctx.modelRegistry.find("ent", defaultModel));

		const routed = Effect.map(ent, (model): Route => ({
			model,
			thinkingLevel: request.thinkingLevel,
		}));

		return Effect.andThen(Effect.logWarning("phi-router failed, so this request goes to ent", cause), routed);
	});

const CodemodeInput = Schema.Struct({ code: Schema.String });

const decodeCodemodeInput = Schema.decodeUnknownOption(CodemodeInput);

const reachOf = (input: ToolCallEvent["input"]) =>
	Option.match(decodeCodemodeInput(input), {
		onNone: () => Option.some("an input without code"),
		onSome: ({ code }) => unsafeReach(code),
	});

/** Blocks a codemode script that can reach classifier or image models, whose calls bypass the router, in a protected session. */
export const guardCodemode = ({
	event,
	ctx,
}: {
	readonly event: ToolCallEvent;
	readonly ctx: Pick<ExtensionContext, "model">;
}) => {
	const reach = event.toolName === "codemode" && isProtected(ctx.model) ? reachOf(event.input) : Option.none();

	const blocked = Option.map(reach, (name) => ({
		block: true,
		reason: `This session may hold PHI, and a codemode script that names \`${name}\` can send it to a model outside the PHI router. Call the tools directly instead.`,
	}));

	return Promise.resolve(Option.getOrUndefined(blocked));
};

interface DelegateCaller {
	readonly parent: Pick<Model<Api>, "provider" | "id"> | undefined;
	readonly cwd: string;
	readonly wanted: Wanted;
	readonly has: (key: ModelKey) => boolean;
}

export const delegateTargetOf = Effect.fn("delegateTargetOf")(function* (caller: DelegateCaller) {
	if (!isProtected(caller.parent)) {
		return { kind: "open" } satisfies Target;
	}

	const settings = yield* readSettings(caller.cwd);
	const routes = settings.mode === "shadow" || settings.mode === "enforce";

	return delegateTarget({ ...caller, mayHoldPhi: !routes, dispatchModel: settings.model });
});

/** `phi/auto`'s `route()`, on the given judge. It never throws: pi turns a throw into an error response, not a fallback. */
export const routeWith =
	({ env, judge }: { readonly env: Env; readonly judge: Layer.Layer<Judge> }) =>
	(request: Request, ctx: RouterContext) => {
		const services = Layer.mergeAll(
			NodeServices.layer,
			ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)),
			judge,
		);

		return Effect.runPromise(route(request, ctx).pipe(failClosed(request, ctx), Effect.provide(services)));
	};

/** Registers `phi/auto`, which sends each request with no PHI to a personal account and the rest to `ent`, and the codemode guard. */
export const phiRouter = (env: Env) => (pi: ExtensionAPI) => {
	const dispatch = getBuiltinModel("anthropic", defaultModel);

	pi.registerVirtualModel<typeof RouterState.Encoded>({
		provider: phiProvider,
		id: phiId,
		name: "PHI router",
		thinkingLevels: getSupportedThinkingLevels(dispatch),
		contextWindow: dispatch.contextWindow,
		maxTokens: dispatch.maxTokens,
		route: (request, ctx) =>
			routeWith({ env, judge: decisionsOf(ctx, request.signal) })(request, {
				cwd: ctx.cwd,
				sessionManager: ctx.sessionManager,
				modelRegistry: ctx.modelRegistry,
				compaction: (window) => compactionOf(ctx, window),
			}),
	});

	pi.on("tool_call", (event, ctx) => guardCodemode({ event, ctx }));
	pi.on("model_select", (event, ctx) => keepProtected({ event, ctx, setModel: (model) => pi.setModel(model) }));
	pi.on("session_start", (_event, ctx) => keepProtectedOnStart({ ctx, setModel: (model) => pi.setModel(model) }));
};
