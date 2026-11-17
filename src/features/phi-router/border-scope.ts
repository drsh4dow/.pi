/**
 * Which processes the border protects. claude-accounts wraps the personal accounts' api with `wrap` where it registers
 * them, so no later `registerProvider` can drop it.
 */
import type { Api, Model, ProviderStreams } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import type { AccountId } from "#src/features/claude-accounts/index.ts";
import { type BorderLink, guardedApi, type Scope } from "./border.ts";
import { isPhi, phiProvider } from "./gate.ts";

/** The router emits `link` on load and whenever it hears `hello`; claude-accounts emits `hello` on load. */
export const borderEvents = { hello: "phi:border-hello", link: "phi:border-link" } as const;

const isBorderLink = (data: unknown): data is BorderLink =>
	Predicate.hasProperty(data, "lookup") &&
	Predicate.isFunction(data.lookup) &&
	Predicate.hasProperty(data, "report") &&
	Predicate.isFunction(data.report);

const selectsPhi = (model: Model<Api> | undefined, ctx: ExtensionContext) =>
	isPhi(model) ||
	Arr.some(ctx.sessionManager.getBranch(), (entry) => entry.type === "model_change" && entry.provider === phiProvider);

/**
 * The process's scope and link. A session that selects a `phi` model, or whose branch ever did, stays protected until
 * the next session starts, so a later switch to a raw personal model is still guarded.
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
