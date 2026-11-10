import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { accountOf, accountProvider, accounts, anthropicOf } from "./accounts.ts";
import { endedOnRateLimit, failOver } from "./failover.ts";

export { accounts, type Login } from "./accounts.ts";

const accountIds = Arr.map(accounts, ({ id }) => id);

export type Target =
	| { readonly kind: "switch"; readonly model: Model<Api> }
	| { readonly kind: "refuse"; readonly why: string };

interface TargetRequest {
	/** The account name the user typed or picked. */
	readonly name: string;
	readonly current: Model<Api> | undefined;
	readonly find: (provider: string, id: string) => Model<Api> | undefined;
}

/** The same model on the named account, so a switch keeps everything but who pays. */
export const targetOf = ({ name, current, find }: TargetRequest): Target => {
	const account = accountOf(name);

	if (Option.isNone(account)) {
		return { kind: "refuse", why: `No Claude account ${name}. The accounts are ${Arr.join(accountIds, ", ")}.` };
	}

	if (current === undefined) {
		return { kind: "refuse", why: "Pick a model with /model first." };
	}

	const model = find(account.value.id, current.id);

	if (model === undefined) {
		return { kind: "refuse", why: `${account.value.id} has no model ${current.id}.` };
	}

	return { kind: "switch", model };
};

/** The account the user typed after `/account`, or the one they pick from a list when they typed none. */
const nameOf = (args: string, ctx: ExtensionCommandContext) => {
	const typed = Str.trim(args);

	if (typed !== "") {
		return Effect.succeedSome(typed);
	}

	return Effect.map(
		Effect.promise(() => ctx.ui.select("Claude account", accountIds)),
		Option.fromUndefinedOr,
	);
};

const moveTo = Effect.fn("moveTo")(function* (pi: ExtensionAPI, ctx: ExtensionCommandContext, model: Model<Api>) {
	const level = pi.getThinkingLevel();
	const switched = yield* Effect.promise(() => pi.setModel(model));

	if (!switched) {
		ctx.ui.notify(`${model.provider} has no login yet. Run /login ${model.provider}.`, "error");

		return;
	}

	pi.setThinkingLevel(level);
	ctx.ui.notify(`Now on ${model.provider}/${model.id}.`, "info");
});

const switchAccount = (pi: ExtensionAPI) => (args: string, ctx: ExtensionCommandContext) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const name = yield* nameOf(args, ctx);

			if (Option.isNone(name)) {
				return;
			}

			const find = (provider: string, id: string) => ctx.modelRegistry.find(provider, id);
			const target = targetOf({ name: name.value, current: ctx.model, find });

			if (target.kind === "refuse") {
				ctx.ui.notify(target.why, "error");

				return;
			}

			yield* moveTo(pi, ctx, target.model);
		}),
	);

/** Registers one provider per Claude account and the `/account` command that moves the session between them. */
export const claudeAccounts = (pi: ExtensionAPI) => {
	const anthropic = anthropicOf();

	for (const account of accounts) {
		pi.registerProvider(accountProvider({ anthropic, account }));
	}

	pi.on("agent_end", (event, ctx) =>
		endedOnRateLimit(event.messages) ? Effect.runPromise(failOver(pi, ctx)) : Promise.resolve(),
	);

	pi.registerCommand("account", {
		description: "Keep the model, and move this session to another Claude account",
		getArgumentCompletions: (prefix) =>
			Arr.map(Arr.filter(accountIds, Str.startsWith(prefix)), (id) => ({ value: id, label: id })),
		handler: switchAccount(pi),
	});
};
