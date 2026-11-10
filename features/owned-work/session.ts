import { uuidv7 } from "@earendil-works/pi-ai";
import type {
	AgentBeforeSettleEvent,
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionStartEvent,
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
import { piCliLayer, unwrapMessage } from "../../clients/pi-cli/index.ts";
import { type PiSessions, piSessionsLayer } from "../../clients/pi-sessions/index.ts";
import { slicesLayer } from "../../clients/systemd/index.ts";
import { inheritedEnv, Self, selfFromEnv } from "./child.ts";
import { draftVariable, forkInTab } from "./fork.ts";
import { Host, Ledger, ledgerLayer } from "./ledger.ts";
import { Out } from "./out.ts";
import { entryKind, firstRefAfter } from "./recorded.ts";
import { Tools } from "./tools.ts";
import type { Settled } from "./work.ts";

type RuntimeServices = Ledger | Hc | PiSessions | HerdrApp | NodeServices.NodeServices;

type Runtime = ManagedRuntime.ManagedRuntime<RuntimeServices, never>;

interface Relay {
	waiter: Option.Option<Deferred.Deferred<ReadonlyArray<Settled>>>;
}

interface Session {
	readonly runtime: Runtime;
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

const runtimeOf = (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	env: Env,
	self: Self,
	childExtensions: ReadonlyArray<string>,
) => {
	const agentKey = Str.takeRight(uuidv7(), 8);
	const parent = Option.map(Option.fromUndefinedOr(env["HC_TERMINAL_ID"]), TerminalAddress);
	const relay: Relay = { waiter: Option.none() };
	const firstRef = firstRefAfter(ctx.sessionManager.getEntries());
	const passEnv = inheritedEnv(env);
	const ledger = ledgerLayer({ self, cwd: ctx.cwd, passEnv, firstRef });

	const slices = Self.$is("Root")(self)
		? slicesLayer({ slice: `pi-ow-${agentKey}`, rootPid: Option.some(process.pid) })
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

	return { runtime: ManagedRuntime.make(Layer.provideMerge(ledger, services)), relay, terminal: parent, passEnv };
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

const sessionOf = (pi: ExtensionAPI, ctx: ExtensionContext, env: Env, childExtensions: ReadonlyArray<string>) =>
	Effect.map(selfFromEnv(env), (self): Session => {
		const session = runtimeOf(pi, ctx, env, self, childExtensions);

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

/** A fork's pi puts back in the editor the prompt `/fork` took it from, once, when it starts. */
const restoreDraft = (event: SessionStartEvent, ctx: ExtensionContext, env: Env): void => {
	const draft = Option.fromUndefinedOr(env[draftVariable]);

	if (event.reason === "startup" && ctx.hasUI && Option.isSome(draft)) {
		ctx.ui.setEditorText(draft.value);
	}
};

export const runHook =
	<Services>(runtime: ManagedRuntime.ManagedRuntime<Services, never>) =>
	<Reply>(hook: Effect.Effect<Reply, never, Services>): Promise<Reply | undefined> =>
		Effect.promise(() => runtime.runPromiseExit(hook)).pipe(
			Effect.flatMap((exit) =>
				Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? Effect.undefined : exit,
			),
			Effect.runPromise,
		);

/** `childExtensions` are the entrypoints each delegate loads: this feature's own, plus any the harness wants in every child. */
export const ownedWork = (childExtensions: ReadonlyArray<string>) => (pi: ExtensionAPI) => {
	const env = { ...process.env } satisfies Env;
	const current = { session: Option.none<Session>() };

	const withLedger = <Reply>(
		use: (session: Session) => (ledger: (typeof Ledger)["Service"]) => Effect.Effect<Reply, never, RuntimeServices>,
	) =>
		Option.match(current.session, {
			onNone: () => Promise.resolve(),
			onSome: (session) => runHook(session.runtime)(Effect.flatMap(Ledger, use(session))),
		});

	const dispose = () => {
		const runtime = Option.map(current.session, (session) => session.runtime);

		current.session = Option.none();

		return Option.match(runtime, { onNone: () => Promise.resolve(), onSome: (found) => found.dispose() });
	};

	return {
		sessionStart: (event: SessionStartEvent, ctx: ExtensionContext) =>
			Effect.runPromise(
				Effect.gen(function* () {
					const session = yield* sessionOf(pi, ctx, env, childExtensions);

					current.session = Option.some(session);
					restoreDraft(event, ctx, env);
				}),
			),
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
		beforeSwitch: (_event: SessionBeforeSwitchEvent, ctx: ExtensionContext) =>
			withLedger(() => (ledger) => cancelUnless(ledger, ctx)),
		beforeFork: (event: SessionBeforeForkEvent, ctx: ExtensionContext) =>
			withLedger((session) => forkOrAsk(session, event, ctx)),
		shutdown: dispose,
	};
};
