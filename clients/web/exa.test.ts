import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { PublicUrl, Web } from "./index.ts";
import { exaContents } from "./sites.ts";
import { webFor } from "./web.fixture.ts";

const endless = webFor({
	withExaKey: true,
	routes: {
		"GET https://docs.example/broken": () => new Response("", { status: 500 }),
		"POST https://api.exa.ai/contents": () => new Response(new ReadableStream()),
	},
});

const endlessOnTestClock = Layer.provideMerge(endless, TestClock.layer());

test("an Exa answer whose body never ends gives up after 30 s", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const target = yield* Schema.decodeEffect(PublicUrl)("https://docs.example/broken");
			const web = yield* Web;
			const reading = yield* web.read(target).pipe(Effect.flip, Effect.forkChild);

			yield* TestClock.adjust("10 minutes");

			const got = yield* Fiber.join(reading);

			expect(got.message).toContain("https://api.exa.ai/contents: no answer in 30 s");
		}).pipe(Effect.provide(endlessOnTestClock)),
	));

const exaClaimRows = [
	["https://bun.sh/docs?q=bun", true],
	["https://bun.sh/docs", true],
	["https://shop.example/?design=red&keyword=bun&monkey=1", true],
	["https://bucket.example/a?X-Amz-Signature=x", false],
	["https://bucket.example/a?x-goog-signature=x", false],
	["https://bucket.example/a?Expires=1", false],
	["https://cdn.example/a?sig=x", false],
	["https://cdn.example/a?Signature=x", false],
	["https://app.example/?token=x", false],
	["https://app.example/?KEY=x", false],
	["https://app.example/?api_key=x", false],
	["https://app.example/?access_key=x", false],
	["https://app.example/?secret=x", false],
	["https://app.example/?client_secret=x", false],
	["https://app.example/?password=x", false],
	["https://app.example/?auth=x", false],
	["https://app.example/callback?code=x", false],
	["https://app.example/?session=x", false],
	["https://app.example/?jwt=x", false],
	["https://app.example/?otp=x", false],
	["https://app.example/?access_token=x", false],
	["https://app.example/?id_token=x", false],
	["https://app.example/?refresh_token=x", false],
	["https://app.example/?apikey=x", false],
	["https://app.example/?api-key=x", false],
	["https://app.example/?private_token=x", false],
	["https://app.example/?pub_secret=x", false],
	["https://app.example/?clientSecret=x", false],
	["https://app.example/?X-Amz-Credential=x", false],
	["https://app.example/callback#access_token=x&state=y", false],
	["https://app.example/callback#state=y&clientSecret=x", false],
	["https://docs.example/#/guide/setup?id=keyword", true],
	["https://docs.example/guide#key-concepts", true],
	["https://docs.example/auth#using-an-api-key", true],
	["https://docs.example/#session-management", true],
	["https://docs.example/#/settings/api-key", true],
	...Arr.map(
		[
			"pwd",
			"passwd",
			"authorization",
			"authkey",
			"rlkey",
			"resourcekey",
			"accesskey",
			"authtoken",
			"apitoken",
			"sessionid",
			"ACCESSTOKEN",
			"JWTToken",
			"auth[token]",
			"key2",
			"hmac",
			"ticket",
			"user_pwd",
			"adminPwd",
			"x-hmac",
			"hmac_sha256",
			"serviceTicket",
			"passcode",
			"passphrase",
			"PHPSESSID",
			"sid",
			"sessid",
		],
		(name) => [`https://share.example/f?${name}=x`, false] as const,
	),
] as const;

for (const [url, claimed] of exaClaimRows) {
	test(`Exa ${claimed ? "may" : "may not"} read ${url}`, () => {
		expect(exaContents.claims(new URL(url))).toBe(claimed);
	});
}
