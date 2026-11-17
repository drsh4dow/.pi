/**
 * A test-only pi extension that `border.scenario.ts` loads with `pi -e`. It is not under `agent/extensions/`, so no pi
 * loads it unless a command line names it. It runs the real router, whose `route()` judges and records verdicts as in
 * production, but sends every request to `ultra-a` whatever the router decided. Its `context` hook writes a marker into
 * one user message after `route()` ran, so that message reaches the border under a key the book never saw. It appends
 * what each request held before the border to the session, as a `border-fixture` entry.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionVirtualModel } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { phiRouter } from "./index.ts";

/** Synthetic values only. `ssn` passes the `ssn` rule, so it seals with no judge call. */
export const planted = {
	ssn: "078-05-1120",
	sealed: "BORDER-SEALED-7Q4K",
	slot: "BORDER-SLOT",
	neverJudged: "BORDER-NEVER-JUDGED-3M8T",
	cleared: "BORDER-CLEARED-5X2P",
} as const;

export const forcedAccount = "ultra-a";

export const fixtureEntryType = "border-fixture";

export const ContextSeen = Schema.Struct({
	messages: Schema.Finite,
	ssn: Schema.Finite,
	neverJudged: Schema.Finite,
	cleared: Schema.Finite,
});

const userText = (message: AgentMessage) => {
	if (message.role !== "user") {
		return "";
	}

	if (Predicate.isString(message.content)) {
		return message.content;
	}

	return Arr.join(
		Arr.flatMap(message.content, (block) => (block.type === "text" ? [block.text] : [])),
		"\n",
	);
};

const holding = (messages: ReadonlyArray<AgentMessage>, marker: string) =>
	Arr.filter(messages, (message) => Str.includes(marker)(userText(message))).length;

const withMarker = Str.replaceAll(planted.slot, planted.neverJudged);

const edited = (message: AgentMessage): AgentMessage => {
	if (message.role !== "user") {
		return message;
	}

	if (Predicate.isString(message.content)) {
		return { ...message, content: withMarker(message.content) };
	}

	return {
		...message,
		content: Arr.map(message.content, (block) =>
			block.type === "text" ? { ...block, text: withMarker(block.text) } : block,
		),
	};
};

const forced = <State>(model: ExtensionVirtualModel<State>): ExtensionVirtualModel<State> => ({
	...model,
	route: (request, ctx) => {
		const routed = Effect.promise(() => Promise.resolve(model.route(request, ctx)));

		return Effect.runPromise(
			Effect.flatMap(routed, (decided) =>
				Effect.map(Effect.fromNullishOr(ctx.modelRegistry.find(forcedAccount, decided.model.id)), (account) => ({
					...decided,
					model: account,
				})),
			),
		);
	},
});

export default function borderFixtureExtension(pi: ExtensionAPI) {
	return Effect.runPromise(
		Effect.map(Config.String("HOME"), (home) => {
			phiRouter({ env: { HOME: home }, ids: [] })({
				...pi,
				registerVirtualModel: (model) => {
					pi.registerVirtualModel(forced(model));
				},
			});

			pi.on("context", (event) => {
				const messages = Arr.map(event.messages, edited);

				pi.appendEntry(fixtureEntryType, {
					messages: messages.length,
					ssn: holding(messages, planted.ssn),
					neverJudged: holding(messages, planted.neverJudged),
					cleared: holding(messages, planted.cleared),
				} satisfies typeof ContextSeen.Type);

				return { messages };
			});
		}),
	);
}
