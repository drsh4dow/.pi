import type { Message } from "@earendil-works/pi-ai";
import type {
	CompactionEntry,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isRateLimited } from "#src/features/claude-accounts/index.ts";
import { askedId, type Carries, isBaa, isPhi, type Placement, sealedLane } from "./gate.ts";
import { appendLane, judgedOf } from "./lanes.ts";
import { Fixtures } from "./policy/digest.ts";
import { Judge, Verdict } from "./policy/engine.ts";
import { Synthetic } from "./policy/synthetic.ts";
import {
	compactionHead,
	decide,
	type Decision,
	holdOf,
	homeOf,
	limitedAt,
	pinnedOn,
	placementFor,
	RouterState,
	stampedAfter,
	undeliveredSummary,
} from "./route.ts";
import { readSettings, type Settings } from "./settings.ts";
import type { VerdictBook, VerdictsEntry } from "./store.ts";

export type Request = ModelRouteRequest<typeof RouterState.Encoded>;

export type Route = ModelRoute<typeof RouterState.Encoded>;

type RouterContext = Pick<ExtensionContext, "cwd"> & {
	readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getBranch">;
	readonly modelRegistry: Pick<ExtensionContext["modelRegistry"], "find" | "hasConfiguredAuth">;
	readonly ui: Pick<ExtensionContext["ui"], "notify" | "setStatus">;
};

export interface RouterSession {
	readonly book: Option.Option<VerdictBook>;
	readonly appendVerdicts: (entry: VerdictsEntry) => void;
}

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

	const undelivered = undeliveredSummary(branch);

	const decision = yield* decide({ messages, reason, book, hold, undelivered }).pipe(
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

const usableIn =
	(ctx: RouterContext): Carries =>
	(provider, id) => {
		const found = ctx.modelRegistry.find(provider, id);

		return found !== undefined && ctx.modelRegistry.hasConfiguredAuth(found);
	};

/** The router state after this request's failure, and the state to store when it changed. */
const stateAfter = ({
	request,
	ctx,
	failed,
	now,
}: {
	readonly request: Request;
	readonly ctx: RouterContext;
	readonly failed: ReturnType<typeof failureOf>;
	readonly now: number;
}) => {
	const stored = decodeState(request.state);
	const prior = Option.getOrElse(stored, () => ({ home: homeOf(ctx.sessionManager.getSessionId()), limited: [] }));
	const stamped = stampedAfter({ limited: prior.limited, failed, now });
	const limited = Option.getOrElse(stamped, () => prior.limited);
	const changed = Option.isNone(stored) || Option.isSome(stamped);

	return { home: prior.home, limited, state: changed ? Option.some({ ...prior, limited }) : Option.none() };
};

const placementOf = ({
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
	const { home, limited, state } = stateAfter({ request, ctx, failed, now });
	const id = askedId({ selected: request.model.id, fallback: settings.model });
	const usable = usableIn(ctx);

	const wouldBe = placementFor({
		id,
		lane: decision.lane,
		home,
		fallback: settings.model,
		limited: limitedAt({ limited, now }),
		usable,
		failedOnBaa: Option.exists(failed, ({ account }) => isBaa(account)),
	});

	return {
		wouldBe,
		dispatched: shadow ? sealedLane({ id, fallback: settings.model, carries: usable }) : wouldBe,
		state,
	};
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
	readonly dispatched: Placement;
	readonly shadow: boolean;
}) => {
	const sealed = Arr.filter(decision.found, ([, verdict]) => Verdict.$is("Sealed")(verdict)).length;

	ctx.ui.setStatus(statusKey, `phi → ${dispatched.provider}/${dispatched.id}`);

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
	const { wouldBe, dispatched, state } = placementOf({ request, ctx, settings, decision, now });

	yield* appendLane({
		type: "route",
		time: now,
		session: ctx.sessionManager.getSessionId(),
		reason,
		mode: settings.mode,
		wouldBe: wouldBe.provider,
		dispatched: dispatched.provider,
		model: dispatched.id,
		...judgedOf(decision),
	});

	const model = yield* Effect.fromNullishOr(ctx.modelRegistry.find(dispatched.provider, dispatched.id));

	shown({ ctx, decision, dispatched, shadow: settings.mode === "shadow" });

	const routed: Route = { model, thinkingLevel: request.thinkingLevel };

	return Option.isSome(state) ? { ...routed, state: yield* encodeState(state.value) } : routed;
});

/** The sealed lane of the selected id. `readSettings` never fails: settings it cannot read give the default model. */
const sealedRoute = Effect.fn("sealedRoute")(function* (request: Request, ctx: RouterContext) {
	const settings = yield* readSettings(ctx.cwd);

	const lane = sealedLane({
		id: askedId({ selected: request.model.id, fallback: settings.model }),
		fallback: settings.model,
		carries: usableIn(ctx),
	});

	const model = yield* Effect.fromNullishOr(ctx.modelRegistry.find(lane.provider, lane.id));

	ctx.ui.setStatus(statusKey, `phi → ${lane.provider}/${lane.id}`);

	return { model, thinkingLevel: request.thinkingLevel } satisfies Route;
});

const failClosed = (request: Request, ctx: RouterContext) =>
	Effect.catchCause((cause) =>
		Effect.andThen(
			Effect.logWarning("phi-router failed, so this request goes to its sealed lane", cause),
			sealedRoute(request, ctx),
		),
	);

/**
 * Every `phi` model's `route()`, on the given judge. It never throws, since pi turns a throw into an error response:
 * any failure dispatches the selected id's sealed lane. The request's verdicts are in the book and the session before
 * it returns, so the border sees them when pi streams.
 */
export const routeWith =
	({ judge, session }: { readonly judge: Judge["Service"]; readonly session: RouterSession }) =>
	(request: Request, ctx: RouterContext) =>
		route({ request, ctx, session }).pipe(failClosed(request, ctx), Effect.provideService(Judge, judge));

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
	readonly ctx: Pick<ExtensionContext, "model" | "cwd"> & {
		readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">;
		readonly ui: Pick<ExtensionContext["ui"], "notify">;
	};
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
