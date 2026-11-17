import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionVirtualModel,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { makePhiSettings, PhiSettings } from "#src/client/phi-settings/index.ts";
import type { AccountId } from "#src/features/claude-accounts/index.ts";
import { type BorderLink, type BorderReport, borderEvents } from "./border.ts";
import { compactionJudged, decisionsOf, type Env, routeWith, type RouterSession, servicesOf } from "./dispatch.ts";
import {
	type DelegateRequest,
	delegateTarget,
	guardCodemode,
	isPhi,
	isProtected,
	phiId,
	phiProvider,
	type Target,
} from "./gate.ts";
import { appendLane } from "./lanes.ts";
import { partsOf } from "./parts.ts";
import { stubs } from "./policy/policy.ts";
import { holdOf, pinEntryType, pinnedOn, type RouterState } from "./route.ts";
import { keepProtected, keepProtectedOnStart } from "./selection.ts";
import { defaultModel, readSettings } from "./settings.ts";
import { bookOf, type VerdictBook, verdictsEntryType } from "./store.ts";

export { phiBorder } from "./border.ts";

export { isPhi as isPhiAuto } from "./gate.ts";

export type { Wanted } from "./gate.ts";

export const internalIdsOnly =
	"Refer to patients and members only by internal ids, such as a patient_id or a row id, never by name, SSN, date of birth, address, phone, email, member number or record number.";

/** The same section on both lanes, so neither account's cache breaks on a switch. */
const bridgeSection = {
	name: "phi-bridge",
	text: `${internalIdsOnly} A message shown as ${stubs.sealed} was handled on the HIPAA account.`,
} as const;

type DelegateCaller = Omit<DelegateRequest, "held" | "dispatchModel"> & {
	readonly cwd: string;
	readonly branch: ReadonlyArray<SessionEntry>;
};

/** Where owned-work starts a delegate. A `phi/auto` parent is held when it runs wholly on `ent`, `shadow` included. */
export const delegateTargetOf = Effect.fn("delegateTargetOf")(function* (caller: DelegateCaller) {
	if (!isProtected(caller.parent)) {
		return { kind: "open" } satisfies Target;
	}

	const settings = yield* Effect.provideServiceEffect(readSettings(caller.cwd), PhiSettings, makePhiSettings);
	const hold = holdOf({ mode: settings.mode, pinned: pinnedOn(caller.branch) });
	const held = Option.isSome(hold) || settings.mode === "shadow";

	return delegateTarget({ ...caller, held, dispatchModel: settings.model });
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

type Services = ReturnType<typeof servicesOf>;

/**
 * The verdict book of the session pi runs now, folded at `session_start`, and the border's link to it, emitted on load,
 * on every fold and whenever claude-accounts says hello, so load order does not matter.
 */
const sessionBook = (pi: Pick<ExtensionAPI, "appendEntry" | "events">, services: Services) => {
	let folded = Option.none<{ readonly id: string; readonly book: VerdictBook }>();

	const borderLogged = (report: BorderReport & { readonly account: AccountId }) =>
		Effect.forEach(Option.toArray(folded), ({ id }) =>
			Effect.flatMap(Clock.currentTimeMillis, (time) =>
				appendLane({ type: "border", time, session: id, ...report }),
			),
		);

	const link: BorderLink = {
		lookup: (key) => (Option.isSome(folded) ? folded.value.book.lookup(key) : undefined),
		report: (report) => {
			Effect.runFork(borderLogged(report).pipe(Effect.ignore({ log: "Warn" }), Effect.provide(services)));
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
	services: Services,
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

		return Effect.runPromise(shown.pipe(Effect.provide(services)));
	},
});

const phiAuto = (env: Env, session: () => RouterSession): ExtensionVirtualModel<typeof RouterState.Encoded> => {
	const dispatch = getBuiltinModel("anthropic", defaultModel);

	return {
		provider: phiProvider,
		id: phiId,
		name: "PHI router",
		thinkingLevels: getSupportedThinkingLevels(dispatch),
		contextWindow: dispatch.contextWindow,
		maxTokens: dispatch.maxTokens,
		route: (request, ctx) =>
			routeWith({
				env,
				judge: decisionsOf({ modelRegistry: ctx.modelRegistry, signal: request.signal }),
				session: session(),
			})(request, ctx),
	};
};

export const phiRouter = (env: Env) => (pi: ExtensionAPI) => {
	const services = servicesOf(env);
	const { fold, session } = sessionBook(pi, services);
	const setModel = (model: Parameters<ExtensionAPI["setModel"]>[0]) => pi.setModel(model);

	pi.registerVirtualModel(phiAuto(env, session));

	pi.on("session_start", (_event, ctx) => {
		const started = Effect.andThen(
			fold(ctx),
			Effect.promise(() => keepProtectedOnStart({ ctx, setModel })),
		);

		return Effect.runPromise(started.pipe(Effect.provide(services)));
	});

	pi.on("session_compact", (event, ctx) => {
		const judged = compactionJudged({ compaction: event.compactionEntry, ctx, session: session() }).pipe(
			Effect.catchCause((cause) => Effect.logWarning("phi-router: the compaction summary was not judged", cause)),
		);

		const judge = Layer.merge(services, decisionsOf(ctx));

		return Effect.runPromise(judged.pipe(Effect.provide(judge)));
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (isPhi(ctx.model)) {
			event.systemPromptOptions.sections[bridgeSection.name] = bridgeSection.text;
		}
	});

	pi.registerCommand(
		"phi",
		phiCommand(pi, services, () => session().book),
	);
	pi.on("tool_call", (event, ctx) => guardCodemode({ event, ctx }));
	pi.on("model_select", (event, ctx) => keepProtected({ event, ctx, setModel }));
};
