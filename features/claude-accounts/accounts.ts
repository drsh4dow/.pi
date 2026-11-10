import type { Model } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import { createProvider, hasApi, type Provider } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

type ApiKeyAuth = NonNullable<Provider["auth"]["apiKey"]>;

type OAuthAuth = NonNullable<Provider["auth"]["oauth"]>;

/** How an account logs in: Anthropic's OAuth flow, or a token from `claude setup-token`, which has no refresh token. */
export type Login = "oauth" | "setup-token";

export const accounts = [
	{ id: "ultra-a", name: "Claude Ultra A", login: "oauth" },
	{ id: "ultra-b", name: "Claude Ultra B", login: "setup-token" },
	{ id: "ent", name: "Claude Enterprise", login: "oauth" },
] as const satisfies ReadonlyArray<{ readonly id: string; readonly name: string; readonly login: Login }>;

export type Account = (typeof accounts)[number];

export const accountOf = (id: string) => Arr.findFirst(accounts, (account) => account.id === id);

export class NotASetupToken extends Schema.TaggedError<NotASetupToken, { readonly brand: unique symbol }>()(
	"NotASetupToken",
	{
		message: Schema.String,
	},
) {}

/** Pi sends a key with this prefix as a subscription token, with the same headers as an OAuth login. */
const subscriptionTokenPrefix = "sk-ant-oat";

const setupTokenOf = (pasted: string) => {
	const key = Str.trim(pasted);

	if (!Str.startsWith(subscriptionTokenPrefix)(key)) {
		return Effect.fail(
			NotASetupToken.make({
				message: `A setup-token starts with ${subscriptionTokenPrefix}. Any other key bills the API, not the subscription.`,
			}),
		);
	}

	return Effect.succeed({ type: "api_key" as const, key });
};

/** Reads only the account's own stored token, never an `ANTHROPIC_*` variable, so no other account can stand in for it. */
const setupTokenAuth: ApiKeyAuth = {
	name: "Claude setup-token",
	login: (interaction) =>
		Effect.runPromise(
			Effect.flatMap(
				Effect.promise(() =>
					interaction.prompt({ type: "secret", message: "Paste the token `claude setup-token` printed" }),
				),
				setupTokenOf,
			),
		),
	resolve: ({ credential }) => {
		const stored = Option.map(Option.fromUndefinedOr(credential?.key), (apiKey) => ({
			auth: { apiKey },
			source: "stored setup-token",
		}));

		return Promise.resolve(Option.getOrUndefined(stored));
	},
};

export interface Anthropic {
	/** Pi's Anthropic catalog. */
	readonly models: ReadonlyArray<Model<"anthropic-messages">>;
	/** Pi's Anthropic OAuth flow, which every OAuth account reuses. */
	readonly oauth: OAuthAuth;
}

/** Pi's own Anthropic provider, whose catalog and OAuth flow every account reuses. */
export const anthropicOf = (): Anthropic => {
	const anthropic = Arr.findFirst(builtinProviders(), ({ id }) => id === "anthropic");

	if (Option.isNone(anthropic)) {
		throw new Error("claude-accounts: pi has no built-in anthropic provider to copy");
	}

	const { oauth } = anthropic.value.auth;

	if (oauth === undefined) {
		throw new Error("claude-accounts: pi's anthropic provider no longer offers an OAuth login");
	}

	const models = Arr.filter(anthropic.value.getModels(), (model) => hasApi(model, "anthropic-messages"));

	return { models, oauth };
};

const authOf = (login: Login, { oauth }: Anthropic) => {
	switch (login) {
		case "oauth": {
			return { oauth };
		}

		case "setup-token": {
			return { apiKey: setupTokenAuth };
		}

		default: {
			const unhandled: never = login;

			return unhandled;
		}
	}
};

/**
 * Anthropic's catalog and API under the account's id. Pi stores and reads the account's credential under that id, and
 * each model names it as its provider, so a session shows which account answered.
 */
export const accountProvider = ({ anthropic, account }: { anthropic: Anthropic; account: Account }): Provider =>
	createProvider({
		id: account.id,
		name: account.name,
		auth: authOf(account.login, anthropic),
		models: Arr.map(anthropic.models, (model) => ({
			...model,
			provider: account.id,
			// Pi turns message threads on by itself only for the provider named `anthropic`. Every account talks to the same endpoint.
			compat: { ...model.compat, supportsMessageThreads: true },
		})),
		api: anthropicMessagesApi(),
	});
