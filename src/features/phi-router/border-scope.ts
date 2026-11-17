/**
 * Which processes the border protects, and where its guard sits. claude-accounts wraps the personal accounts' api with
 * `wrap` where it registers them, so no later `registerProvider` can drop it. The bordered builtins are pi's own
 * providers, so the border wraps the ones the registry holds at `session_start`, which keeps pi's remote catalog, and
 * again before each agent run, with auth passed through. `openai` is a BAA provider, so the border leaves it alone.
 */
import type { Api, Model, Provider, ProviderStreams } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { type BorderLink, guardedApi, type Scope } from "./border.ts";
import { borderedBuiltins, isPhi, type Personal } from "./gate.ts";

type Selection = Pick<Model<Api>, "provider" | "id">;

/** The router emits `link` on load and whenever it hears `hello`; claude-accounts emits `hello` on load. */
export const borderEvents = { hello: "phi:border-hello", link: "phi:border-link" } as const;

const isBorderLink = (data: unknown): data is BorderLink =>
	Predicate.hasProperty(data, "lookup") &&
	Predicate.isFunction(data.lookup) &&
	Predicate.hasProperty(data, "report") &&
	Predicate.isFunction(data.report);

type BorderContext = Pick<ExtensionContext, "model"> & {
	readonly modelRegistry: Pick<ExtensionContext["modelRegistry"], "getProvider">;
};

/** `Symbol.for`, so a wrapper made before an extension reload still names its original. */
const originalKey: unique symbol = Symbol.for("phi-router/border-original");

interface Wrapper extends Provider {
	readonly [originalKey]: Provider;
}

const isWrapper = (provider: Provider): provider is Wrapper => originalKey in provider;

/**
 * Registers one guard over the original of each builtin the registry holds, unless it holds a guard of `mine` already.
 * A guard of an earlier load is unwrapped first, so the registry never holds a guard over a guard.
 */
const guardBuiltins = ({
	registry,
	mine,
	scope,
	register,
}: {
	readonly registry: BorderContext["modelRegistry"];
	readonly mine: WeakSet<Provider>;
	readonly scope: () => Scope;
	readonly register: (provider: Provider) => void;
}) => {
	for (const account of borderedBuiltins) {
		const found = registry.getProvider(account);

		if (found !== undefined && !mine.has(found)) {
			const original = isWrapper(found) ? found[originalKey] : found;

			const wrapper: Wrapper = {
				...original,
				...guardedApi({ api: original, account, scope }),
				[originalKey]: original,
			};

			mine.add(wrapper);
			register(wrapper);
		}
	}
};

/**
 * The process's scope and link, and the bordered builtins. The process is protected while its selection is a `phi`
 * model. A switch to any other model is the human's choice to break the seal, so it ends the protection (ADR 0017).
 */
export const borderOf = ({
	events,
	register,
}: {
	readonly events: Pick<ExtensionAPI["events"], "on" | "emit">;
	readonly register: (provider: Provider) => void;
}) => {
	let protectedSession = false;
	let link = Option.none<BorderLink>();
	const mine = new WeakSet<Provider>();

	const scope = (): Scope => (protectedSession ? { kind: "protected", link } : { kind: "open" });

	events.on(borderEvents.link, (data) => {
		if (isBorderLink(data)) {
			link = Option.some(data);
		}
	});

	events.emit(borderEvents.hello, { from: "claude-accounts" });

	return {
		wrap: (account: Personal) => (api: ProviderStreams) => guardedApi({ api, account, scope }),
		sessionStarted: (ctx: BorderContext) => {
			protectedSession = isPhi(ctx.model);
			guardBuiltins({ registry: ctx.modelRegistry, mine, scope, register });
		},
		modelSelected: (model: Selection) => {
			protectedSession = isPhi(model);
		},
		agentStarting: (ctx: BorderContext) => {
			guardBuiltins({ registry: ctx.modelRegistry, mine, scope, register });
		},
	};
};

export const phiBorder = (pi: Pick<ExtensionAPI, "on" | "events" | "registerProvider">) => {
	const border = borderOf({
		events: pi.events,
		register: (provider) => {
			pi.registerProvider(provider);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		border.sessionStarted(ctx);
	});

	pi.on("model_select", (event) => {
		border.modelSelected(event.model);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		border.agentStarting(ctx);
	});

	return { wrap: border.wrap };
};
