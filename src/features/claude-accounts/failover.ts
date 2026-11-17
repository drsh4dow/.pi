import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { accountOf, fallbackChain } from "./accounts.ts";

interface FailoverRequest {
	readonly current: Model<Api> | undefined;
	readonly find: (provider: string, id: string) => Model<Api> | undefined;
}

/** The session's model on each account of its own account's fallback chain, so a rate limit tries each once and never leaves a BAA account. */
export const failoverTargets = ({ current, find }: FailoverRequest) => {
	if (current === undefined) {
		return [];
	}

	const chain = Option.match(accountOf(current.provider), {
		onNone: () => [],
		onSome: ({ id }) => fallbackChain(id),
	});

	return Arr.flatMap(chain, ({ id }) => Option.toArray(Option.fromUndefinedOr(find(id, current.id))));
};

/** Anthropic's SDK starts a failed request's error message with its HTTP status, and pi records no status of its own. */
const rateLimitStatus = /^429\b/u;

export const isRateLimited = (message: AssistantMessage) =>
	message.stopReason === "error" && rateLimitStatus.test(message.errorMessage ?? "");

export const endedOnRateLimit = (messages: AgentEndEvent["messages"]) =>
	Option.exists(Arr.last(messages), (message) => message.role === "assistant" && isRateLimited(message));

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
