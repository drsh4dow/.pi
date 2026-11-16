import type { Message } from "@earendil-works/pi-ai";
import {
	type CompactionEntry,
	convertToLlm,
	type ExtensionContext,
	type ModelRoute,
	type ModelRouteRequest,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type AccountId, isBaaAccount, isRateLimited } from "../claude-accounts/index.ts";
import { type Classify, decisionsModel, decisionsPieceJudge } from "./decisions.ts";
import { isPhi } from "./gate.ts";
import { appendLane, judgedOf } from "./lanes.ts";
import { Fixtures } from "./policy/digest.ts";
import { type Judge, Verdict } from "./policy/engine.ts";
import { Synthetic } from "./policy/synthetic.ts";
import {
	accountFor,
	decide,
	type Decision,
	holdOf,
	homeOf,
	limitedAt,
	pinnedOn,
	RouterState,
	stampedAfter,
} from "./route.ts";
import { defaultModel, readSettings, type Settings } from "./settings.ts";
import type { VerdictBook, VerdictsEntry } from "./store.ts";

export type Request = ModelRouteRequest<typeof RouterState.Encoded>;

export type Route = ModelRoute<typeof RouterState.Encoded>;

export type Env = Readonly<Record<string, string | undefined>>;

type RouterContext = Pick<ExtensionContext, "cwd"> & {
	readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getBranch">;
	readonly modelRegistry: Pick<ExtensionContext["modelRegistry"], "find" | "hasConfiguredAuth">;
	readonly ui: Pick<ExtensionContext["ui"], "notify" | "setStatus">;
};

export interface RouterSession {
	readonly book: Option.Option<VerdictBook>;
	readonly appendVerdicts: (entry: VerdictsEntry) => void;
}

export const servicesOf = (env: Env) =>
	Layer.merge(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)));

export const decisionsOf = ({ modelRegistry, signal }: Pick<ExtensionContext, "modelRegistry" | "signal">) => {
	const classifier = Option.fromUndefinedOr(modelRegistry.findOfType("classifier", "openai", decisionsModel));

	const classify: Classify = (context, options) =>
		Option.match(classifier, {
			onNone: () => Promise.reject(new Error(`no classifier openai/${decisionsModel}`)),
			onSome: (model) =>
				modelRegistry.classify(model, context, signal === undefined ? options : { ...options, signal }),
		});

	return decisionsPieceJudge(classify);
};

const decideIn = Effect.fn("decideIn")(function* ({
	messages,
	reason,
	cwd,
	branch,
	session,
}: {
	readonly messages: ReadonlyArray<Message>;
	readonly reason: Request["reason"];
	readonly cwd: string;
	readonly branch: ReadonlyArray<SessionEntry>;
	readonly session: RouterSession;
}) {
	const book = yield* Effect.fromOption(session.book);
	const settings = yield* readSettings(cwd);
	const hold = holdOf({ mode: settings.mode, pinned: pinnedOn(branch) });

	const decision = yield* decide({ messages, reason, book, hold }).pipe(
		Effect.provideService(Fixtures, settings.fixtures),
		Effect.provideService(Synthetic, settings.synthetic),
	);

	for (const entry of Option.toArray(decision.entry)) {
		session.appendVerdicts(entry);
	}

	return { settings, decision };
});

const decodeState = Schema.decodeUnknownOption(RouterState);

const encodeState = Schema.encodeEffect(RouterState);

const failureOf = (failed: Request["failed"]) =>
	Option.map(Option.fromUndefinedOr(failed), ({ model, message }) => ({
		account: model.provider,
		rateLimited: isRateLimited(message),
	}));

const usableIn = (ctx: RouterContext, model: string) => (account: AccountId) => {
	const found = ctx.modelRegistry.find(account, model);

	return found !== undefined && ctx.modelRegistry.hasConfiguredAuth(found);
};

const accountOf = ({
	request,
	ctx,
	settings,
	decision,
	now,
}: {
	readonly request: Request;
	readonly ctx: RouterContext;
	readonly settings: Settings;
	readonly decision: Decision;
	readonly now: number;
}) => {
	const shadow = settings.mode === "shadow";
	const failed = shadow ? Option.none() : failureOf(request.failed);
	const stored = decodeState(request.state);
	const prior = Option.getOrElse(stored, () => ({ home: homeOf(ctx.sessionManager.getSessionId()), limited: [] }));
	const stamped = stampedAfter({ limited: prior.limited, failed, now });
	const limited = Option.getOrElse(stamped, () => prior.limited);

	const wouldBe = accountFor({
		lane: decision.lane,
		home: prior.home,
		limited: limitedAt({ limited, now }),
		usable: usableIn(ctx, settings.model),
		failedOnBaa: Option.exists(failed, ({ account }) => isBaaAccount(account)),
	});

	const state = Option.isSome(stored) && Option.isNone(stamped) ? Option.none() : Option.some({ ...prior, limited });

	return { wouldBe, dispatched: shadow ? ("ent" as const) : wouldBe, state };
};

const statusKey = "phi";

const sealNotice = (count: number) =>
	count === 1
		? "One message held patient identifiers and was handled only on ent."
		: `${String(count)} messages held patient identifiers and were handled only on ent.`;

const shown = ({
	ctx,
	decision,
	dispatched,
	shadow,
}: {
	readonly ctx: RouterContext;
	readonly decision: Decision;
	readonly dispatched: AccountId;
	readonly shadow: boolean;
}) => {
	const sealed = Arr.filter(decision.found, ([, verdict]) => Verdict.$is("Sealed")(verdict)).length;

	ctx.ui.setStatus(statusKey, `phi → ${dispatched}`);

	if (sealed > 0 && !shadow) {
		ctx.ui.notify(sealNotice(sealed), "info");
	}
};

const route = Effect.fn("route")(function* ({
	request,
	ctx,
	session,
}: {
	readonly request: Request;
	readonly ctx: RouterContext;
	readonly session: RouterSession;
}) {
	const { messages, reason } = request;

	const { settings, decision } = yield* decideIn({
		messages,
		reason,
		cwd: ctx.cwd,
		branch: ctx.sessionManager.getBranch(),
		session,
	});

	const now = yield* Clock.currentTimeMillis;
	const { wouldBe, dispatched, state } = accountOf({ request, ctx, settings, decision, now });

	yield* appendLane({
		type: "route",
		time: now,
		session: ctx.sessionManager.getSessionId(),
		reason,
		mode: settings.mode,
		wouldBe,
		dispatched,
		...judgedOf(decision),
	});

	const model = yield* Effect.fromNullishOr(ctx.modelRegistry.find(dispatched, settings.model));

	shown({ ctx, decision, dispatched, shadow: settings.mode === "shadow" });

	const routed: Route = { model, thinkingLevel: request.thinkingLevel };

	return Option.isSome(state) ? { ...routed, state: yield* encodeState(state.value) } : routed;
});

const failClosed = (request: Request, ctx: RouterContext) =>
	Effect.catchCause((cause) => {
		const ent = Effect.fromNullishOr(ctx.modelRegistry.find("ent", defaultModel));

		const routed = Effect.map(ent, (model): Route => {
			ctx.ui.setStatus(statusKey, "phi → ent");

			return { model, thinkingLevel: request.thinkingLevel };
		});

		return Effect.andThen(Effect.logWarning("phi-router failed, so this request goes to ent", cause), routed);
	});

/**
 * `phi/auto`'s `route()`, on the given judge. It never throws, since pi turns a throw into an error response: any
 * failure dispatches `ent`. The request's verdicts are in the book and the session before it returns, so the border
 * sees them when pi streams.
 */
export const routeWith =
	({
		env,
		judge,
		session,
	}: {
		readonly env: Env;
		readonly judge: Layer.Layer<Judge>;
		readonly session: RouterSession;
	}) =>
	(request: Request, ctx: RouterContext) => {
		const services = Layer.merge(servicesOf(env), judge);

		return Effect.runPromise(
			route({ request, ctx, session }).pipe(failClosed(request, ctx), Effect.provide(services)),
		);
	};

export const compactionHead = (entry: CompactionEntry) => convertToLlm(sessionEntryToContextMessages(entry));

/**
 * Judges a new compaction's head before pi sends again. pi awaits this handler before the send that follows a
 * threshold compaction, which it does not route again, so a clean summary reaches a personal account on that send.
 */
export const compactionJudged = Effect.fn("compactionJudged")(function* ({
	compaction,
	ctx,
	session,
}: {
	readonly compaction: CompactionEntry;
	readonly ctx: ExtensionContext;
	readonly session: RouterSession;
}) {
	if (!isPhi(ctx.model) || Option.isNone(session.book)) {
		return;
	}

	const messages = compactionHead(compaction);
	const branch = ctx.sessionManager.getBranch();

	const { decision } = yield* decideIn({ messages, reason: "continuation", cwd: ctx.cwd, branch, session });

	if (decision.why === "sealed") {
		ctx.ui.notify(
			"The compaction summary holds patient identifiers, so personal accounts see it withheld. `/phi pin` keeps this session on ent.",
			"warning",
		);
	}
});
