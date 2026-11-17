import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { getBuiltinModel, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
	type BeforeAgentStartEvent,
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionVirtualModel,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { laneLogLayer } from "#src/client/phi-lane-log/index.ts";
import { makePhiSettings, PhiSettings, phiSettingsLayer } from "#src/client/phi-settings/index.ts";
import { verdictCacheLayer } from "#src/client/phi-verdict-cache/index.ts";
import { piHost, type PiHost } from "#src/client/pi-host/index.ts";
import { borderEvents } from "./border-scope.ts";
import type { BorderLink, BorderReport } from "./border.ts";
import { decisionsOf } from "./decisions.ts";
import { compactionJudged, routeWith, type RouterSession } from "./dispatch.ts";
import {
	autoId,
	borderedBuiltins,
	type DelegateRequest,
	delegateTarget,
	guardCodemode,
	isPhi,
	isProtected,
	type Personal,
	phiProvider,
	standingOf,
	type Target,
} from "./gate.ts";
import { appendLane } from "./lanes.ts";
import { partsOf } from "./parts.ts";
import { Judge } from "./policy/engine.ts";
import { stubs } from "./policy/policy.ts";
import { holdOf, pinEntryType, pinnedOn, type RouterState } from "./route.ts";
import { defaultModel, readSettings } from "./settings.ts";
import { bookOf, type VerdictBook, verdictsEntryType } from "./store.ts";

export { phiBorder } from "./border-scope.ts";

export { isPhi, type Target, type Wanted } from "./gate.ts";

export const internalIdsOnly =
	"Refer to patients and members only by internal ids, such as a patient_id or a row id, never by name, SSN, date of birth, address, phone, email, member number or record number.";

/** The same section on both lanes, so neither account's cache breaks on a switch. */
const bridgeSection = {
	name: "phi-bridge",
	text: `${internalIdsOnly} A message shown as ${stubs.sealed} was handled on the HIPAA account.`,
} as const;

/** Adds the `phi-bridge` section to the system prompt of a session on any `phi` model. */
export const bridged = ({
	event,
	ctx,
}: {
	readonly event: { readonly systemPromptOptions: Pick<BeforeAgentStartEvent["systemPromptOptions"], "sections"> };
	readonly ctx: Pick<ExtensionContext, "model">;
}) => {
	if (isPhi(ctx.model)) {
		event.systemPromptOptions.sections[bridgeSection.name] = bridgeSection.text;
	}
};

type DelegateCaller = Pick<DelegateRequest, "wanted" | "carries"> & {
	readonly parent: Pick<Model<Api>, "provider" | "id"> | undefined;
	readonly cwd: string;
	readonly branch: ReadonlyArray<SessionEntry>;
};

/** Where owned-work starts a delegate. A `phi` parent is held when it runs wholly on `ent`, `shadow` included. */
export const delegateTargetOf = Effect.fn("delegateTargetOf")(function* (caller: DelegateCaller) {
	if (!isProtected(caller.parent)) {
		return { kind: "open" } satisfies Target;
	}

	const settings = yield* Effect.provideServiceEffect(readSettings(caller.cwd), PhiSettings, makePhiSettings);
	const hold = holdOf({ mode: settings.mode, pinned: pinnedOn(caller.branch) });
	const held = Option.isSome(hold) || settings.mode === "shadow";

	return delegateTarget({
		standing: standingOf({ parent: caller.parent, held }),
		wanted: caller.wanted,
		fallback: settings.model,
		carries: caller.carries,
	});
});

const statusLine = Effect.fn("statusLine")(function* ({
	ctx,
	book,
}: {
	readonly ctx: ExtensionContext;
	readonly book: Option.Option<VerdictBook>;
}) {
	const settings = yield* readSettings(ctx.cwd);
	const branch = ctx.sessionManager.getBranch();
	const parts = Arr.flatMap(convertToLlm(buildSessionContext([...branch]).messages), partsOf);

	const seals = Arr.map(parts, ({ key }) =>
		Option.isSome(book) ? (book.value.lookup(key) ?? "unjudged") : "unjudged",
	);

	const count = (seal: (typeof seals)[number]) => String(Arr.filter(seals, (found) => found === seal).length);
	const pin = pinnedOn(branch) ? "pinned to ent" : "not pinned";

	return `phi: mode ${settings.mode}, ${pin}. This branch's context has ${count("sealed")} sealed parts, ${count("cleared")} cleared and ${count("unjudged")} not judged yet.`;
});

const pinNotices = {
	pin: "Pinned: this session runs wholly on ent, with nothing judged. `/phi unpin` routes it again.",
	unpin: "Unpinned: requests are routed again, and the next one judges what the pinned stretch added.",
} as const;

type Env = Readonly<Record<string, string | undefined>>;

const servicesOf = (env: Env) =>
	Layer.merge(
		Layer.provide(Layer.mergeAll(phiSettingsLayer, laneLogLayer, verdictCacheLayer), NodeServices.layer),
		ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)),
	);

type Host = PiHost<Layer.Success<ReturnType<typeof servicesOf>>, never>;

/**
 * The verdict book of the session pi runs now, folded at `session_start`, and the border's link to it, emitted on load,
 * on every fold and whenever claude-accounts says hello, so load order does not matter.
 */
const sessionBook = (pi: Pick<ExtensionAPI, "appendEntry" | "events">, host: Host) => {
	let folded = Option.none<{ readonly id: string; readonly book: VerdictBook }>();

	const borderLogged = (report: BorderReport & { readonly account: Personal }) =>
		Effect.forEach(Option.toArray(folded), ({ id }) =>
			Effect.flatMap(Clock.currentTimeMillis, (time) =>
				appendLane({ type: "border", time, session: id, ...report }),
			),
		);

	const link: BorderLink = {
		lookup: (key) => (Option.isSome(folded) ? folded.value.book.lookup(key) : undefined),
		report: (report) => {
			host.fork(borderLogged(report).pipe(Effect.ignore({ log: "Warn" })));
		},
	};

	const fold = Effect.fn("fold")(function* (ctx: ExtensionContext) {
		const book = yield* bookOf({ sessionManager: ctx.sessionManager, pid: process.pid }).pipe(
			Effect.asSome,
			Effect.catchCause((cause) =>
				Effect.as(
					Effect.logWarning("phi-router: no verdict book, so personal accounts receive only stubs", cause),
					Option.none<VerdictBook>(),
				),
			),
		);

		folded = Option.map(book, (found) => ({ id: ctx.sessionManager.getSessionId(), book: found }));
		pi.events.emit(borderEvents.link, link);
	});

	const session = (): RouterSession => ({
		book: Option.map(folded, ({ book }) => book),
		appendVerdicts: (entry) => {
			pi.appendEntry(verdictsEntryType, entry);
		},
	});

	pi.events.on(borderEvents.hello, () => {
		pi.events.emit(borderEvents.link, link);
	});
	pi.events.emit(borderEvents.link, link);

	return { fold, session };
};

const phiCommand = (
	pi: Pick<ExtensionAPI, "appendEntry">,
	host: Host,
	book: () => Option.Option<VerdictBook>,
): Parameters<ExtensionAPI["registerCommand"]>[1] => ({
	description:
		"Show the PHI router's mode, pin and verdicts. `/phi pin` keeps this session on ent; `/phi unpin` routes it again",
	getArgumentCompletions: (prefix) =>
		Arr.map(Arr.filter(["pin", "unpin"], Str.startsWith(prefix)), (word) => ({ value: word, label: word })),
	handler: (args, ctx) => {
		const word = Str.trim(args);

		if (word === "pin" || word === "unpin") {
			pi.appendEntry(pinEntryType, { pinned: word === "pin" });
			ctx.ui.notify(pinNotices[word], "info");

			return Promise.resolve();
		}

		const shown = Effect.map(statusLine({ ctx, book: book() }), (text) => {
			ctx.ui.notify(text, "info");
		});

		return host.run(shown);
	},
});

type PhiModel = ExtensionVirtualModel<typeof RouterState.Encoded>;

/** The static catalogs of the personal providers: the Claude accounts copy `anthropic`'s. */
const personalCatalogs = ["anthropic", ...borderedBuiltins] as const;

const limitsOf = (model: Model<Api>): Pick<PhiModel, "thinkingLevels" | "contextWindow" | "maxTokens"> => ({
	thinkingLevels: getSupportedThinkingLevels(model),
	contextWindow: model.contextWindow,
	maxTokens: model.maxTokens,
});

/**
 * `phi/auto`, which runs `settings.model`, and one `phi/<id>` per distinct id a personal catalog carries, all on one
 * `route`. Content routing picks between a personal provider and a BAA one, so an id no personal provider carries has
 * nothing to route.
 */
const phiModels = (ids: ReadonlyArray<string>, route: PhiModel["route"]): ReadonlyArray<PhiModel> => {
	const catalog = Arr.flatMap(personalCatalogs, getBuiltinModels);

	const routed = Arr.flatMap(Arr.dedupe(ids), (id) =>
		Option.toArray(
			Option.map(
				Arr.findFirst(catalog, (model) => model.id === id),
				(model): PhiModel => ({ provider: phiProvider, id, name: `PHI router (${id})`, ...limitsOf(model), route }),
			),
		),
	);

	return [
		{
			provider: phiProvider,
			id: autoId,
			name: "PHI router",
			...limitsOf(getBuiltinModel("anthropic", defaultModel)),
			route,
		},
		...routed,
	];
};

/**
 * The PHI router. `ids` are the model ids a delegate can ask for; each one a personal provider carries gets its own
 * `phi/<id>`, registered at load so `--model phi/<id>` finds it.
 */
export const phiRouter =
	({ env, ids }: { readonly env: Env; readonly ids: ReadonlyArray<string> }) =>
	(pi: Pick<ExtensionAPI, "appendEntry" | "events" | "on" | "registerCommand" | "registerVirtualModel">) => {
		const host = piHost(servicesOf(env));
		const { fold, session } = sessionBook(pi, host);

		const route: PhiModel["route"] = (request, ctx) =>
			host.run(
				routeWith({
					judge: decisionsOf({ modelRegistry: ctx.modelRegistry, signal: request.signal }),
					session: session(),
				})(request, ctx),
			);

		for (const model of phiModels(ids, route)) {
			pi.registerVirtualModel(model);
		}

		pi.on("session_start", (_event, ctx) => host.run(fold(ctx)));

		pi.on("session_compact", (event, ctx) => {
			const judged = compactionJudged({ compaction: event.compactionEntry, ctx, session: session() }).pipe(
				Effect.catchCause((cause) => Effect.logWarning("phi-router: the compaction summary was not judged", cause)),
			);

			return host.run(Effect.provideService(judged, Judge, decisionsOf(ctx)));
		});

		pi.on("before_agent_start", (event, ctx) => {
			bridged({ event, ctx });
		});

		pi.registerCommand(
			"phi",
			phiCommand(pi, host, () => session().book),
		);
		pi.on("tool_call", (event, ctx) => guardCodemode({ event, ctx }));
	};
