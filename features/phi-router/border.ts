/**
 * The border: what a personal Claude account may receive in a protected process. An allow-list over the verdicts the
 * router wrote, which never judges. claude-accounts wraps the personal accounts' api with it where it registers them,
 * so no later `registerProvider` can drop it. In a protected process, every part a personal account receives has a
 * cleared verdict for its key or is a constant stub, even when `route()` dispatches wrongly or never ran.
 */
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type ProviderStreams,
	type SystemMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Function from "effect/Function";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";

import type { AccountId } from "../claude-accounts/index.ts";
import { phiId, phiProvider } from "./gate.ts";
import { partsOf, type Slot, writtenOnPersonal } from "./pieces.ts";
import type { ContentKey } from "./policy/engine.ts";

export type Seal = "cleared" | "sealed";

/** All the border knows about verdicts. `undefined` means never judged. */
export type Lookup = (key: ContentKey) => Seal | undefined;

/** Constant per class, so a stub never changes and the account's cache prefix stays stable. */
export const stubs = {
	sealed: "[withheld: holds patient identifiers, handled on the HIPAA account]",
	unknown: "[withheld: not checked for patient identifiers]",
} as const;

export interface BorderReport {
	readonly stubbedSealed: number;
	readonly stubbedUnknown: number;
	readonly refused: boolean;
}

/** A tool declaration cannot be stubbed without breaking the calls that name it, so the request is refused. */
export type Refusal = "tools-not-cleared";

type Standing = Seal | "unknown";

interface Checked {
	readonly slot: Slot;
	readonly standing: Standing;
}

const stubOf = (standing: Standing) => (standing === "sealed" ? stubs.sealed : stubs.unknown);

/** Thinking is the model's reading of earlier content, so only a reply a personal account wrote keeps it. */
const clearedReply = (message: AssistantMessage): AssistantMessage => {
	if (writtenOnPersonal(message)) {
		return message;
	}

	return { ...message, content: Arr.filter(message.content, ({ type }) => type !== "thinking") };
};

/** `toolsAdded` and `toolsRemoved` are never touched: without them the model would lose its tools. */
const stubbedSlot = (message: SystemMessage, { slot, standing }: Checked): SystemMessage => {
	if (standing === "cleared") {
		return message;
	}

	const stub = stubOf(standing);

	return Match.valueTags(slot, {
		SystemContent: () => ({ ...message, content: stub }),
		SystemSection: ({ name }) => ({ ...message, sections: { ...message.sections, [name]: stub } }),
		// `guard` refuses uncleared tools before it stubs anything, and a system message has no `Message` slot.
		SystemTools: () => message,
		Message: () => message,
	});
};

/** Only the role and the ids that pair a tool call with its result survive. */
const stubbedMessage = (message: Exclude<Message, SystemMessage>, stub: string): Message => {
	switch (message.role) {
		case "user": {
			return { role: "user", content: stub, timestamp: message.timestamp };
		}

		case "toolResult": {
			const { toolCallId, toolName, isError, timestamp } = message;

			return {
				role: "toolResult",
				toolCallId,
				toolName,
				isError,
				content: [{ type: "text", text: stub }],
				timestamp,
			};
		}

		case "assistant": {
			const calls = Arr.flatMap(message.content, (block) =>
				block.type === "toolCall"
					? [{ type: "toolCall" as const, id: block.id, name: block.name, arguments: {} }]
					: [],
			);

			return { ...message, content: [{ type: "text", text: stub }, ...calls] };
		}

		default: {
			const unhandled: never = message;

			return unhandled;
		}
	}
};

const guardedMessage = (message: Message, checked: ReadonlyArray<Checked>): Message => {
	if (message.role === "system") {
		return Arr.reduce(checked, message, stubbedSlot);
	}

	if (Arr.every(checked, ({ standing }) => standing === "cleared")) {
		return message.role === "assistant" ? clearedReply(message) : message;
	}

	return stubbedMessage(
		message,
		Arr.some(checked, ({ standing }) => standing === "sealed") ? stubs.sealed : stubs.unknown,
	);
};

/**
 * The messages a personal account may receive, keyed with `partsOf` as `route()` keys them. A cleared part passes, a
 * sealed or never-judged one becomes a constant stub, and tools that never cleared refuse the request.
 */
export const guard = ({
	messages,
	lookup,
}: {
	readonly messages: ReadonlyArray<Message>;
	readonly lookup: Lookup;
}): Result.Result<{ readonly messages: Array<Message>; readonly report: BorderReport }, Refusal> => {
	const checked = Arr.map(messages, (message) => ({
		message,
		parts: Arr.map(partsOf(message), ({ key, slot }): Checked => ({ slot, standing: lookup(key) ?? "unknown" })),
	}));

	const all = Arr.flatMap(checked, ({ parts }) => parts);

	if (Arr.some(all, ({ slot, standing }) => Predicate.isTagged(slot, "SystemTools") && standing !== "cleared")) {
		return Result.fail("tools-not-cleared");
	}

	const report = {
		stubbedSealed: Arr.filter(all, ({ standing }) => standing === "sealed").length,
		stubbedUnknown: Arr.filter(all, ({ standing }) => standing === "unknown").length,
		refused: false,
	};

	return Result.succeed({
		messages: Arr.map(checked, ({ message, parts }) => guardedMessage(message, parts)),
		report,
	});
};

/** Handed from the router to claude-accounts over `pi.events`. Function values survive the bus. */
export interface BorderLink {
	readonly lookup: Lookup;
	readonly report: (report: BorderReport & { readonly account: AccountId }) => void;
}

/** How the border treats requests in this process. Protected with no link yet, every part is unknown. */
export type Scope =
	| { readonly kind: "open" }
	| { readonly kind: "protected"; readonly link: Option.Option<BorderLink> };

const noCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Ends the request before it reaches the network, with the error pi records for it. */
const refusedStream = (model: Model<Api>, refusal: Refusal) => {
	const stream = createAssistantMessageEventStream();

	stream.push({
		type: "error",
		reason: "error",
		error: {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { ...noCost, totalTokens: 0, cost: { ...noCost, total: 0 } },
			stopReason: "error",
			errorMessage: `phi border refused: ${refusal}`,
			timestamp: DateTime.toEpochMillis(DateTime.nowUnsafe()),
		},
	});

	return stream;
};

const reportOf = Result.match({
	onSuccess: ({ report }: { readonly report: BorderReport }) => report,
	onFailure: (): BorderReport => ({ stubbedSealed: 0, stubbedUnknown: 0, refused: true }),
});

type Send<Options> = (model: Model<Api>, context: TranscriptContext, options?: Options) => AssistantMessageEventStream;

const guardedSend =
	<Options>(send: Send<Options>, account: AccountId, scope: () => Scope): Send<Options> =>
	(model, context, options) => {
		const now = scope();

		if (now.kind === "open") {
			return send(model, context, options);
		}

		const lookup: Lookup = Option.isSome(now.link) ? now.link.value.lookup : Function.constUndefined;
		const guarded = guard({ messages: context.messages, lookup });

		if (Option.isSome(now.link)) {
			now.link.value.report({ ...reportOf(guarded), account });
		}

		return Result.match(guarded, {
			onFailure: (refusal) => refusedStream(model, refusal),
			onSuccess: ({ messages }) => send(model, { ...context, messages }, options),
		});
	};

/** `api` with `guard` in front of `stream` and `streamSimple`. An open scope passes every request untouched. */
export const guardedApi = ({
	api,
	account,
	scope,
}: {
	readonly api: ProviderStreams;
	readonly account: AccountId;
	readonly scope: () => Scope;
}): ProviderStreams => ({
	...api,
	stream: guardedSend((model, context, options) => api.stream(model, context, options), account, scope),
	streamSimple: guardedSend((model, context, options) => api.streamSimple(model, context, options), account, scope),
});

/** The router emits `link` on load and whenever it hears `hello`; claude-accounts emits `hello` on load. */
export const borderEvents = { hello: "phi:border-hello", link: "phi:border-link" } as const;

const isBorderLink = (data: unknown): data is BorderLink =>
	Predicate.hasProperty(data, "lookup") &&
	Predicate.isFunction(data.lookup) &&
	Predicate.hasProperty(data, "report") &&
	Predicate.isFunction(data.report);

const selectsPhi = (model: Model<Api> | undefined, ctx: ExtensionContext) =>
	(model?.provider === phiProvider && model.id === phiId) ||
	Arr.some(
		ctx.sessionManager.getBranch(),
		(entry) => entry.type === "model_change" && entry.provider === phiProvider && entry.modelId === phiId,
	);

/**
 * The process's scope and link. A session that selects `phi/auto`, or whose branch ever did, stays protected until the
 * next session starts, so a later switch to a raw personal model is still guarded.
 */
export const phiBorder = (pi: Pick<ExtensionAPI, "on" | "events">) => {
	let protectedSession = false;
	let link = Option.none<BorderLink>();

	pi.on("session_start", (_event, ctx) => {
		protectedSession = selectsPhi(ctx.model, ctx);
	});

	pi.on("model_select", (event, ctx) => {
		protectedSession ||= selectsPhi(event.model, ctx);
	});

	pi.events.on(borderEvents.link, (data) => {
		if (isBorderLink(data)) {
			link = Option.some(data);
		}
	});

	pi.events.emit(borderEvents.hello, { from: "claude-accounts" });

	const scope = (): Scope => (protectedSession ? { kind: "protected", link } : { kind: "open" });

	return { wrap: (account: AccountId) => (api: ProviderStreams) => guardedApi({ api, account, scope }) };
};
