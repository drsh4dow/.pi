import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { accounts } from "./accounts.ts";

interface FailoverRequest {
	readonly current: Model<Api> | undefined;
	readonly find: (provider: string, id: string) => Model<Api> | undefined;
}

/** The session's model on each other account, in account order from the one after its own, so a rate limit tries each account once. */
export const failoverTargets = ({ current, find }: FailoverRequest) => {
	if (current === undefined) {
		return [];
	}

	const own = Arr.findFirstIndex(accounts, ({ id }) => id === current.provider);

	if (Option.isNone(own)) {
		return [];
	}

	const after = [...Arr.drop(accounts, own.value + 1), ...Arr.take(accounts, own.value)];

	return Arr.flatMap(after, ({ id }) => Option.toArray(Option.fromUndefinedOr(find(id, current.id))));
};

/** Anthropic's SDK starts a failed request's error message with its HTTP status, and pi records no status of its own. */
const rateLimitStatus = /^429\b/u;

/** Whether the run's last reply is a 429, the failure another account can answer. */
export const endedOnRateLimit = (messages: AgentEndEvent["messages"]) =>
	Option.exists(
		Arr.last(messages),
		(message) =>
			message.role === "assistant" &&
			message.stopReason === "error" &&
			rateLimitStatus.test(message.errorMessage ?? ""),
	);

/** Moves a rate-limited session to the first other account that takes it, so pi's own retry of the failed request goes there. */
export const failOver = Effect.fn("failOver")(function* (pi: ExtensionAPI, ctx: ExtensionContext) {
	const from = ctx.model;
	const level = pi.getThinkingLevel();
	const find = (provider: string, id: string) => ctx.modelRegistry.find(provider, id);

	const moved = yield* Effect.findFirst(failoverTargets({ current: from, find }), (model) =>
		Effect.promise(() => pi.setModel(model)),
	);

	if (Option.isNone(moved)) {
		return;
	}

	pi.setThinkingLevel(level);
	ctx.ui.notify(
		`${from?.provider ?? "This account"} is rate-limited. Now on ${moved.value.provider}/${moved.value.id}.`,
		"warning",
	);
});
