import { type ExtensionAPI, type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Redacted from "effect/Redacted";

import { ClaudeUsage, claudeUsageLayer, type Window } from "../../clients/claude-usage/index.ts";
import { OpencodeGo, opencodeGoLayer } from "../../clients/opencode-go/index.ts";
import { spendSince } from "../../clients/pi-sessions/index.ts";
import { accounts, type Login } from "../claude-accounts/index.ts";
import { type Meter, type Outcome, type Reading, reportOf } from "./report.ts";

type Services = ClaudeUsage | OpencodeGo | FileSystem.FileSystem;

/** One account `/usage` reads, and how. A failure is the reason it could not, as the user reads it. */
interface Source {
	readonly account: string;
	readonly via: string;
	readonly read: (ctx: ExtensionCommandContext) => Effect.Effect<ReadonlyArray<Meter>, string, Services>;
}

const estimateDays = 30;

const timeout = Duration.seconds(20);

const windowMeters = (windows: ReadonlyArray<Window>) =>
	Arr.map(windows, (window): Meter => ({ kind: "window", window }));

const keyOf = (ctx: ExtensionCommandContext, provider: string) =>
	Effect.flatMap(
		Effect.promise(() => ctx.modelRegistry.getApiKeyForProvider(provider)),
		(key) =>
			key === undefined
				? Effect.fail(`${provider} has no login. Run /login ${provider}.`)
				: Effect.succeed(Redacted.make(key)),
	);

const byInputPrice = Order.mapInput(
	Order.Number,
	({ cost }: { readonly cost: { readonly input: number } }) => cost.input,
);

/** The account's cheapest model, so a probe that gets through costs the least. */
const cheapestModel = (ctx: ExtensionCommandContext, provider: string) => {
	const models = Arr.filter(ctx.modelRegistry.getAll(), (model) => model.provider === provider);
	const cheapest = Arr.head(Arr.sort(models, byInputPrice));

	return Option.match(cheapest, {
		onNone: () => Effect.fail(`${provider} has no models to probe with.`),
		onSome: ({ id }) => Effect.succeed(id),
	});
};

const planMeters = (ctx: ExtensionCommandContext, provider: string) =>
	Effect.gen(function* () {
		const token = yield* keyOf(ctx, provider);
		const claude = yield* ClaudeUsage;
		const plan = yield* Effect.mapError(claude.plan(token), ({ message }) => message);
		const extra = Option.map(plan.spend, (spend): Meter => ({ kind: "extra", spend }));

		return [...windowMeters(plan.windows), ...Option.toArray(extra)];
	});

const probeMeters = (ctx: ExtensionCommandContext, provider: string) =>
	Effect.gen(function* () {
		const token = yield* keyOf(ctx, provider);
		const model = yield* cheapestModel(ctx, provider);
		const claude = yield* ClaudeUsage;
		const windows = yield* Effect.mapError(claude.probe({ token, model }), ({ message }) => message);

		return windowMeters(windows);
	});

/** An OAuth login can read the usage page. A setup-token lacks the `user:profile` scope, so only a probe's headers tell. */
const claudeSource = ({ id, login }: { readonly id: string; readonly login: Login }): Source => {
	switch (login) {
		case "oauth": {
			return { account: id, via: "usage page", read: (ctx) => planMeters(ctx, id) };
		}

		case "setup-token": {
			return { account: id, via: "rate-limit headers of a one-token probe", read: (ctx) => probeMeters(ctx, id) };
		}

		default: {
			const unhandled: never = login;

			return unhandled;
		}
	}
};

const opencodeGo: Source = {
	account: "opencode-go",
	via: "OpenCode Go usage API",
	read: (ctx) =>
		Effect.gen(function* () {
			const key = yield* keyOf(ctx, "opencode-go");
			const go = yield* OpencodeGo;
			const windows = yield* Effect.mapError(go.usage(key), ({ message }) => message);

			return windowMeters(windows);
		}),
};

/** OpenAI reports spend only to an admin key, so this prices pi's own replies instead. */
const openai: Source = {
	account: "openai",
	via: "estimate from pi's sessions at list prices",
	read: () =>
		Effect.gen(function* () {
			const now = yield* DateTime.now;
			const since = DateTime.subtract(now, { days: estimateDays });
			const request = { root: `${getAgentDir()}/sessions`, provider: "openai", since };
			const spend = yield* Effect.mapError(spendSince(request), ({ path, why }) => `${path}: ${why}`);

			return [{ kind: "estimate", usd: spend.usd, replies: spend.replies, days: estimateDays }];
		}),
};

const sources: ReadonlyArray<Source> = [...Arr.map(accounts, claudeSource), opencodeGo, openai];

const outcomeOf = (source: Source, ctx: ExtensionCommandContext) =>
	source.read(ctx).pipe(
		Effect.timeoutOrElse({
			duration: timeout,
			orElse: () => Effect.fail(`no answer in ${Duration.format(timeout)}`),
		}),
		Effect.match({
			onFailure: (why): Outcome => ({ kind: "unreadable", why }),
			onSuccess: (meters): Outcome => ({ kind: "read", meters }),
		}),
	);

const readingOf = (source: Source, ctx: ExtensionCommandContext) =>
	Effect.map(outcomeOf(source, ctx), (outcome): Reading => ({ account: source.account, via: source.via, outcome }));

const printUsage = (ctx: ExtensionCommandContext) =>
	Effect.gen(function* () {
		yield* Effect.sync(() => {
			ctx.ui.setWorkingMessage("Reading usage…");
		});

		const readings = yield* Effect.forEach(sources, (source) => readingOf(source, ctx), { concurrency: "unbounded" });
		const now = yield* DateTime.now;

		yield* Effect.sync(() => {
			ctx.ui.setWorkingMessage();
			ctx.ui.notify(reportOf({ readings, now }), "info");
		});
	});

/** Registers `/usage`, which prints what every account has used. */
export const usage = (pi: Pick<ExtensionAPI, "registerCommand">) => {
	const clients = Layer.mergeAll(claudeUsageLayer, opencodeGoLayer).pipe(Layer.provide(FetchHttpClient.layer));
	const runtime = ManagedRuntime.make(Layer.merge(clients, NodeServices.layer));

	pi.registerCommand("usage", {
		description: "Print what every account has used: Claude plans, extra usage, OpenCode Go, OpenAI spend",
		handler: (_args, ctx) => runtime.runPromise(printUsage(ctx)),
	});

	return { shutdown: () => runtime.dispose() };
};
