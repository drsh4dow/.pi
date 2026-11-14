import { uuidv7 } from "@earendil-works/pi-ai";
import type {
	AgentBeforeSettleEvent,
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { type Hc, hcLayer, TerminalAddress } from "../../clients/hc/index.ts";
import { type HerdrApp, herdrAppLayer } from "../../clients/herdr-app/index.ts";
import { type PiCli, piCliLayer, unwrapMessage } from "../../clients/pi-cli/index.ts";
import { type PiSessions, piSessionsLayer } from "../../clients/pi-sessions/index.ts";
import { type Slices, slicesLayer } from "../../clients/systemd/index.ts";
import { inheritedEnv, Self, selfFromEnv, withAgentBin } from "./child.ts";
import { forkInTab, restoreDraft } from "./fork.ts";
import {
	type Inheritance,
	inheritanceOf,
	newAgentKey,
	leave,
	ledgerStamp,
	type Lineage,
	rootSlices,
	stateOf,
	stopStale,
	take,
} from "./handover.ts";
import { Host, Ledger, ledgerLayer } from "./ledger.ts";
import { Out } from "./out.ts";
import { warnPolling } from "./polling.ts";
import { entryKind, firstRefAfter } from "./recorded.ts";
import { Tools } from "./tools.ts";
import type { Settled } from "./work.ts";

type RuntimeServices = Ledger | Hc | Slices | PiCli | PiSessions | HerdrApp | NodeServices.NodeServices;

type Runtime = ManagedRuntime.ManagedRuntime<RuntimeServices, never>;

interface Relay {
	waiter: Option.Option<Deferred.Deferred<ReadonlyArray<Settled>>>;
}

interface Session {
	readonly runtime: Runtime;
	readonly lineage: Lineage;
	readonly relay: Relay;
	/** The hc terminal pi runs in, when it runs in one. */
	readonly terminal: Option.Option<TerminalAddress>;
	readonly passEnv: Readonly<Record<string, string>>;
}

const messageOf = (settled: Settled) => {
	const json = Out.result(settled);

	return Effect.map(Out.text(json), (content) => ({ customType: entryKind, content, display: true, details: json }));
};

const hostLayer = (pi: ExtensionAPI, relay: Relay) => {
	const send = (settled: Settled) =>
		Effect.map(messageOf(settled), (message) => {
			pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
		});

	const handOver = (waiter: Deferred.Deferred<ReadonlyArray<Settled>>, results: ReadonlyArray<Settled>) => {
		relay.waiter = Option.none();

		return Effect.asVoid(Deferred.succeed(waiter, results));
	};

	return Layer.succeed(Host, {
		wake: (results) =>
			Option.match(relay.waiter, {
				onSome: (waiter) => handOver(waiter, results),
				onNone: () => Effect.asVoid(Effect.forEach(results, send)),
			}),
		append: (entry) =>
			Effect.sync(() => {
				pi.appendEntry(entryKind, Out.entry(entry));
			}),
	});
};

type Env = Readonly<Record<string, string | undefined>>;

const runtimeOf = (pi: ExtensionAPI, { ctx, env, childExtensions, inheritance, stamp, sliceOf }: Start, self: Self) => {
	const { agentKey } = inheritance;
	const parent = Option.map(Option.fromUndefinedOr(env["HC_TERMINAL_ID"]), TerminalAddress);
	const relay: Relay = { waiter: Option.none() };
	const firstRef = firstRefAfter(ctx.sessionManager.getEntries());
	const passEnv = inheritedEnv(env);
	const ledger = ledgerLayer({ self, cwd: ctx.cwd, passEnv, firstRef, carried: stateOf(inheritance) });

	const slices = Self.$is("Root")(self)
		? slicesLayer({ slice: sliceOf(agentKey), rootPid: Option.some(process.pid) })
		: slicesLayer({ slice: self.slice, rootPid: Option.none() });

	const services = Layer.provideMerge(
		Layer.mergeAll(
			hcLayer({ agentKey, parent }),
			hostLayer(pi, relay),
			slices,
			piSessionsLayer,
			piCliLayer(childExtensions),
			herdrAppLayer,
		),
		NodeServices.layer,
	);

	const runtime = ManagedRuntime.make(Layer.provideMerge(ledger, services));

	return { runtime, lineage: { agentKey, stamp }, relay, terminal: parent, passEnv };
};

/**
 * Under --no-session pi's session folder is "", so a root's delegates keep their sessions in a temp folder whose name
 * nobody can guess ahead of time. It is made, owner-only, when the first delegate starts.
 */
export const delegatesDirOf = ({ sessionDir, tmpDir }: { readonly sessionDir: string; readonly tmpDir: string }) =>
	sessionDir === "" ? `${tmpDir}/pi-delegates-${uuidv7()}` : `${sessionDir}/delegates`;

const placeOf = (self: Self, ctx: ExtensionContext, env: Env) => {
	const sessionDir = ctx.sessionManager.getSessionDir();
	const tmpDir = Option.getOrElse(Option.filter(Option.fromUndefinedOr(env["TMPDIR"]), Str.isNonEmpty), () => "/tmp");

	return { cwd: ctx.cwd, dir: Self.$is("Root")(self) ? delegatesDirOf({ sessionDir, tmpDir }) : sessionDir };
};

interface Start {
	readonly ctx: ExtensionContext;
	readonly env: Env;
	readonly childExtensions: ReadonlyArray<string>;
	readonly inheritance: Inheritance;
	readonly stamp: number;
	readonly sliceOf: (agentKey: string) => string;
}

const sessionOf = (pi: ExtensionAPI, start: Start) =>
	Effect.map(selfFromEnv(start.env), (self): Session => {
		const { ctx, env } = start;
		const session = runtimeOf(pi, start, self);

		Tools.register(pi, session.runtime, self, placeOf(self, ctx, env));

		return session;
	});

/** Both modes run pi's `print-mode.js`, which exits once the prompt resolves. */
export const exitsWhenPromptResolves = (mode: ExtensionContext["mode"]): boolean => mode === "print" || mode === "json";

const continued = (event: AgentBeforeSettleEvent, results: ReadonlyArray<Settled>) =>
	Effect.map(Effect.forEach(results, messageOf), (messages) => ({
		entries: [...event.entries, ...Arr.map(messages, (message) => ({ type: "custom_message" as const, ...message }))],
		continue: true,
	}));

const awaitResults = (ledger: (typeof Ledger)["Service"], relay: Relay) =>
	Effect.gen(function* () {
		const waiter = yield* Deferred.make<ReadonlyArray<Settled>>();

		relay.waiter = Option.some(waiter);
		yield* ledger.wentIdle;

		return yield* Deferred.await(waiter);
	});

const settle =
	(session: Session, event: AgentBeforeSettleEvent, ctx: ExtensionContext) => (ledger: (typeof Ledger)["Service"]) =>
		Effect.flatMap(ledger.turnEnded, (verdict) =>
			Match.valueTags(verdict, {
				Continue: ({ results }) => continued(event, results),
				Idle: ({ outstanding }) =>
					exitsWhenPromptResolves(ctx.mode) && Arr.isReadonlyArrayNonEmpty(outstanding)
						? Effect.flatMap(awaitResults(ledger, session.relay), (results) => continued(event, results))
						: Effect.void,
				Finish: () =>
					Effect.sync(() => {
						ctx.shutdown();
					}),
			}),
		);

/** True when nothing runs, or the person agrees to stop what does, since leaving this session stops its work. */
const mayStopRunning = (ledger: (typeof Ledger)["Service"], ctx: ExtensionContext) =>
	Effect.flatMap(ledger.running, (refs) =>
		Arr.isReadonlyArrayNonEmpty(refs) && ctx.hasUI
			? Effect.promise(() =>
					ctx.ui.confirm(
						"Stop running work?",
						`${Arr.join(refs, ", ")} still run. Leaving this session stops them.`,
					),
				)
			: Effect.succeed(true),
	);

const cancelUnless = (ledger: (typeof Ledger)["Service"], ctx: ExtensionContext) =>
	Effect.map(mayStopRunning(ledger, ctx), (agreed) => (agreed ? {} : { cancel: true }));

const forkOrAsk =
	(session: Session, event: SessionBeforeForkEvent, ctx: ExtensionContext) => (ledger: (typeof Ledger)["Service"]) =>
		Effect.flatMap(forkInTab({ event, ctx, terminal: session.terminal, env: session.passEnv }), (opened) =>
			opened ? Effect.succeed({ cancel: true }) : cancelUnless(ledger, ctx),
		);

export const runHook =
	<Services>(runtime: ManagedRuntime.ManagedRuntime<Services, never>) =>
	<Reply>(hook: Effect.Effect<Reply, never, Services>): Promise<Reply | undefined> =>
		Effect.promise(() => runtime.runPromiseExit(hook)).pipe(
			Effect.flatMap((exit) =>
				Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? Effect.undefined : exit,
			),
			Effect.runPromise,
		);

interface Current {
	session: Option.Option<Session>;
}

const begin =
	(pi: ExtensionAPI, env: Env, childExtensions: ReadonlyArray<string>, current: Current) =>
	(event: SessionStartEvent, ctx: ExtensionContext) =>
		Effect.gen(function* () {
			const stamp = yield* ledgerStamp;
			const sliceOf = yield* rootSlices;
			const inheritance = inheritanceOf({ stamp, agentKey: newAgentKey() })(event.reason, take());
			const session = yield* sessionOf(pi, { ctx, env, childExtensions, inheritance, stamp, sliceOf });

			current.session = Option.some(session);
			restoreDraft({ event, ctx, env });
			yield* Effect.promise(() => runHook(session.runtime)(stopStale({ ui: ctx.ui, sliceOf })(inheritance)));
		}).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

/** Forgets the session before it stops, so no hook reaches a ledger that froze for a reload. */
const end = (current: Current) => (event: SessionShutdownEvent) => {
	const ending = current.session;

	current.session = Option.none();

	return Option.match(ending, {
		onNone: () => Promise.resolve(),
		onSome: (session) =>
			Effect.runPromise(
				Effect.andThen(
					Effect.promise(() => runHook(session.runtime)(leave(session.lineage)(event))),
					Effect.promise(() => session.runtime.dispose()),
				),
			),
	});
};

/** `childExtensions` are the entrypoints each delegate loads: this feature's own, plus any the harness wants in every child. */
export const ownedWork = (childExtensions: ReadonlyArray<string>) => (agentDir: string) => (pi: ExtensionAPI) => {
	const env = withAgentBin(agentDir)({ ...process.env });
	const current: Current = { session: Option.none() };

	const withLedger = <Reply>(
		use: (session: Session) => (ledger: (typeof Ledger)["Service"]) => Effect.Effect<Reply, never, RuntimeServices>,
	) =>
		Option.match(current.session, {
			onNone: () => Promise.resolve(),
			onSome: (session) => runHook(session.runtime)(Effect.flatMap(Ledger, use(session))),
		});

	return {
		sessionStart: begin(pi, env, childExtensions, current),
		input: ({ text }: InputEvent, ctx: ExtensionContext) => {
			const session = { dir: ctx.sessionManager.getSessionDir(), id: ctx.sessionManager.getSessionId() };

			return Option.match(unwrapMessage(session)(text), {
				onNone: () => ({ action: "continue" as const }),
				onSome: (message) => ({ action: "transform" as const, text: message }),
			});
		},
		agentStart: () => withLedger(() => (ledger) => ledger.runStarted),
		beforeSettle: (event: AgentBeforeSettleEvent, ctx: ExtensionContext) =>
			withLedger((session) => settle(session, event, ctx)),
		settled: () => withLedger(() => (ledger) => ledger.wentIdle),
		toolResult: (event: ToolResultEvent) => withLedger(() => warnPolling(event)),
		beforeSwitch: (_event: SessionBeforeSwitchEvent, ctx: ExtensionContext) =>
			withLedger(() => (ledger) => cancelUnless(ledger, ctx)),
		beforeFork: (event: SessionBeforeForkEvent, ctx: ExtensionContext) =>
			withLedger((session) => forkOrAsk(session, event, ctx)),
		shutdown: end(current),
	};
};
