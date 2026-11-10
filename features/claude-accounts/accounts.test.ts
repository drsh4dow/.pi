import { afterEach, expect, test } from "bun:test";

import { createModels } from "@earendil-works/pi-ai/models";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Function from "effect/Function";
import * as Rec from "effect/Record";

import { type Account, accountProvider, accounts, anthropicOf } from "./accounts.ts";
import { targetOf } from "./index.ts";

type Store = NonNullable<NonNullable<Parameters<typeof createModels>[0]>["credentials"]>;

type Credential = NonNullable<Awaited<ReturnType<Store["read"]>>>;

const memoryStore = (initial: Readonly<Record<string, Credential>>): Store => {
	const stored = new Map(Rec.toEntries(initial));

	return {
		read: (id) => Promise.resolve(stored.get(id)),
		list: () => Promise.resolve(Arr.map([...stored], ([providerId, { type }]) => ({ providerId, type }))),
		modify: (id, change) =>
			Effect.runPromise(
				Effect.map(
					Effect.promise(() => change(stored.get(id))),
					(next) => {
						if (next !== undefined) {
							stored.set(id, next);
						}

						return stored.get(id);
					},
				),
			),
		delete: (id) => {
			stored.delete(id);

			return Promise.resolve();
		},
	};
};

/** Every variable pi's own Anthropic provider would fall back to. */
const anthropicEnv = new Map([
	["ANTHROPIC_API_KEY", "sk-ant-api03-from-env"],
	["ANTHROPIC_OAUTH_TOKEN", "sk-ant-oat01-from-env"],
	["ANTHROPIC_AUTH_TOKEN", "bearer-from-env"],
]);

const anthropic = anthropicOf();

const modelsWith = (credentials: Readonly<Record<string, Credential>>) => {
	const models = createModels({
		credentials: memoryStore(credentials),
		authContext: { env: (name) => Promise.resolve(anthropicEnv.get(name)), fileExists: () => Promise.resolve(false) },
	});

	for (const account of accounts) {
		models.setProvider(accountProvider({ anthropic, account }));
	}

	return models;
};

const authOf = (models: ReturnType<typeof modelsWith>, provider: string) =>
	Effect.map(
		Effect.promise(() => models.getAuth(provider)),
		(found) => found?.auth.apiKey,
	);

const unexpiredOAuth = (access: string): Credential => ({
	type: "oauth",
	access,
	refresh: "refresh",
	expires: Number.MAX_SAFE_INTEGER,
});

const ids = (account: Account) => Arr.map(modelsWith({}).getModels(account.id), ({ id }) => id);

for (const account of accounts) {
	test(`${account.id} offers pi's whole Anthropic catalog under its own name`, () => {
		const listed = modelsWith({}).getModels(account.id);

		expect(ids(account)).toEqual(Arr.map(anthropic.models, ({ id }) => id));
		expect(Arr.filter(listed, ({ provider }) => provider !== account.id)).toEqual([]);
	});

	test(`${account.id} has no credential when only ANTHROPIC_* variables are set`, () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const key = yield* authOf(modelsWith({}), account.id);

				expect(key).toBeUndefined();
			}),
		));
}

test("an OAuth account sends its own access token, and no other account sees it", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const models = modelsWith({ ent: unexpiredOAuth("sk-ant-oat01-ent") });

			const ent = yield* authOf(models, "ent");
			const ultraA = yield* authOf(models, "ultra-a");

			expect(ent).toBe("sk-ant-oat01-ent");
			expect(ultraA).toBeUndefined();
		}),
	));

const pasting = (text: string) => ({ prompt: () => Promise.resolve(text), notify: Function.constVoid });

test("ultra-b logs in with a pasted setup-token and sends it as its key", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const models = modelsWith({});

			yield* Effect.promise(() => models.login("ultra-b", "api_key", pasting("  sk-ant-oat01-ultra-b\n")));

			const key = yield* authOf(models, "ultra-b");

			expect(key).toBe("sk-ant-oat01-ultra-b");
		}),
	));

test("ultra-b refuses an API key at login and stores nothing", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const models = modelsWith({});

			const login = yield* Effect.exit(
				Effect.promise(() => models.login("ultra-b", "api_key", pasting("sk-ant-api03-key"))),
			);

			const key = yield* authOf(models, "ultra-b");

			expect(login.pipe(Exit.isFailure)).toBe(true);
			expect(key).toBeUndefined();
		}),
	));

test("the OAuth accounts log in through Anthropic's flow, and ultra-b only by pasting a token", () => {
	const logins = Arr.map(accounts, (account) => {
		const { auth } = accountProvider({ anthropic, account });

		return { id: account.id, oauth: auth.oauth?.name, apiKey: auth.apiKey?.name };
	});

	expect(logins).toEqual([
		{ id: "ultra-a", oauth: anthropic.oauth.name, apiKey: undefined },
		{ id: "ultra-b", oauth: undefined, apiKey: "Claude setup-token" },
		{ id: "ent", oauth: anthropic.oauth.name, apiKey: undefined },
	]);
});

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

/** The requests a call on the provider's Opus sends, answered with an error so nothing leaves the machine. */
const sentRequests = Effect.fn("sentRequests")(function* (
	credentials: Readonly<Record<string, Credential>>,
	provider: string,
) {
	const requests: Array<{ readonly url: string; readonly headers: Headers }> = [];

	globalThis.fetch = Object.assign(
		(...[url, init]: Parameters<typeof fetch>) => {
			requests.push({ url: url instanceof Request ? url.url : url.toString(), headers: new Headers(init?.headers) });

			return Promise.resolve(Response.json({ error: { message: "stop here" } }, { status: 400 }));
		},
		{ preconnect: realFetch.preconnect },
	);

	const models = modelsWith(credentials);
	const model = models.getModel(provider, "claude-opus-5-5");

	if (model === undefined) {
		return yield* Effect.die(`${provider} has no claude-opus-5-5`);
	}

	const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };

	yield* Effect.promise(() => models.completeSimple(model, context));

	return requests;
});

test("a request on an account goes to Anthropic with that account's token as a subscription login", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const [request] = yield* sentRequests(
				{ "ultra-b": { type: "api_key", key: "sk-ant-oat01-ultra-b" } },
				"ultra-b",
			);

			expect(request?.url).toStartWith("https://api.anthropic.com/");
			expect(request?.headers.get("authorization")).toBe("Bearer sk-ant-oat01-ultra-b");
			expect(request?.headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
		}),
	));

const opus = getBuiltinModel("anthropic", "claude-opus-5-5");

const find = (provider: string, id: string) => modelsWith({}).getModel(provider, id);

test("/account keeps the model and moves it to the named account", () => {
	const target = targetOf({ name: "ent", current: { ...opus, provider: "ultra-a" }, find });

	expect(target.kind === "switch" && `${target.model.provider}/${target.model.id}`).toBe("ent/claude-opus-5-5");
});

const refusals = [
	{ name: "an account that does not exist", request: { name: "ultra-c", current: opus } },
	{ name: "no model yet", request: { name: "ent", current: undefined } },
	{
		name: "a model no account offers",
		request: { name: "ent", current: { ...opus, provider: "openai", id: "gpt-6.1-sol" } },
	},
];

for (const { name, request } of refusals) {
	test(`/account refuses ${name}`, () => {
		expect(targetOf({ ...request, find }).kind).toBe("refuse");
	});
}
