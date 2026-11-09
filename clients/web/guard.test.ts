import { afterAll, expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";

import { fetched, guardedHttp, isPublicAddress, lookupWith, problemOf, type Resolve, transportWith } from "./guard.ts";

const urlRows = [
	{ url: "https://bun.sh/docs", problem: "-" },
	{ url: "http://[2606:4700::1111]/", problem: "-" },
	{ url: "ftp://example.com/a", problem: "example.com: only http and https URLs" },
	{ url: "file:///etc/passwd", problem: ": only http and https URLs" },
	{ url: "https://user:pass@example.com/", problem: "example.com: a URL with a user name or password" },
	{ url: "http://localhost:3000/", problem: "localhost: a local host name" },
	{ url: "http://api.localhost/", problem: "api.localhost: a local host name" },
	{ url: "http://metadata.google.internal/", problem: "metadata.google.internal: a local host name" },
	{ url: "http://169.254.169.254/latest/meta-data", problem: "169.254.169.254: a private address" },
	{ url: "http://2130706433/", problem: "127.0.0.1: a private address" },
	{ url: "http://0x7f.1/", problem: "127.0.0.1: a private address" },
	{ url: "http://0.0.0.0:8080/", problem: "0.0.0.0: a private address" },
	{ url: "http://[::1]/", problem: "[::1]: a private address" },
	{ url: "http://[::ffff:127.0.0.1]/", problem: "[::ffff:7f00:1]: a private address" },
	{ url: "http://[fd00::1]/", problem: "[fd00::1]: a private address" },
	{ url: "http://[64:ff9b::a9fe:a9fe]/", problem: "[64:ff9b::a9fe:a9fe]: a private address" },
	{ url: "not a url", problem: "not a url: not a URL" },
];

for (const { url, problem } of urlRows) {
	test(`the guard's verdict on ${url} is ${problem}`, () => {
		expect(Option.getOrElse(problemOf(url), () => "-")).toBe(problem);
	});
}

const addressRows = [
	["8.8.8.8", true],
	["1.1.1.1", true],
	["2606:4700::1111", true],
	["10.1.2.3", false],
	["100.64.0.1", false],
	["127.0.0.1", false],
	["169.254.169.254", false],
	["172.16.5.4", false],
	["172.32.0.1", true],
	["192.168.1.1", false],
	["224.0.0.1", false],
	["255.255.255.255", false],
	["::", false],
	["::1", false],
	["fe80::1", false],
	["fc00::1", false],
	["ff02::1", false],
	["fec0::1", false],
	["2001:0:4136:e378:8000:63bf:3fff:fdd2", false],
	["2001:4860:4860::8888", true],
	["::ffff:10.0.0.1", false],
	["::ffff:8.8.8.8", true],
	["192.0.0.170", false],
	["64:ff9b::a9fe:a9fe", false],
	["64:ff9b::169.254.169.254", false],
	["64:ff9b::8.8.10.1", true],
	["64:ff9b:1::808:808", false],
	["2002:a9fe:a9fe::1", false],
	["2002:808:808::1", true],
	["::a9fe:a9fe", false],
	["::ffff:0:a9fe:a9fe", false],
	["::ffff:0:808:808", true],
	["example.com", false],
] as const;

for (const [address, isPublic] of addressRows) {
	test(`${address} ${isPublic ? "is" : "is not"} a public address`, () => {
		expect(isPublicAddress(address)).toBe(isPublic);
	});
}

interface LookupRow {
	readonly name: string;
	readonly answerPerCall: ReadonlyArray<ReadonlyArray<string>>;
	readonly expect: { readonly got: string; readonly calls: number };
}

const lookupRows: ReadonlyArray<LookupRow> = [
	{
		name: "the socket gets the address that was checked, and DNS is asked once, so a second answer cannot rebind it",
		answerPerCall: [["93.184.216.34"], ["127.0.0.1"]],
		expect: { got: "93.184.216.34", calls: 1 },
	},
	{
		name: "an answer with one private address among public ones is refused",
		answerPerCall: [["93.184.216.34", "10.0.0.1"]],
		expect: { got: "pinned.test resolves to 10.0.0.1, a private address", calls: 1 },
	},
];

const resolveFrom = (answerPerCall: ReadonlyArray<ReadonlyArray<string>>) => {
	const calls = { count: 0 };

	const resolve: Resolve = (_hostname, _options, done) => {
		const answer = answerPerCall[Math.min(calls.count, answerPerCall.length - 1)] ?? [];

		calls.count += 1;
		done(
			undefined,
			Arr.map(answer, (address) => ({ address, family: 4 })),
		);
	};

	return { calls, resolve };
};

for (const all of [true, false]) {
	for (const { name, answerPerCall, expect: wanted } of lookupRows) {
		test(`${name} (all: ${String(all)})`, () => {
			const { calls, resolve } = resolveFrom(answerPerCall);

			const got = Effect.callback<string>((resume) => {
				lookupWith(resolve)("pinned.test", { all }, (error, address) => {
					const addresses = Arr.isArray(address) ? Arr.map(address, (one) => one.address) : [address];

					resume(Effect.succeed(error === null ? Arr.join(addresses, ",") : error.message));
				});
			});

			return Effect.runPromise(
				Effect.map(got, (text) => {
					expect({ got: text, calls: calls.count }).toEqual(wanted);
				}),
			);
		});
	}
}

const hits = { count: 0 };

const local = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => {
		hits.count += 1;

		return new Response("served");
	},
});

afterAll(() => local.stop(true));

const guarded = guardedHttp(transportWith(resolveFrom([["127.0.0.1"]]).resolve));

test("a host name whose DNS answer is 127.0.0.1 is refused before any byte reaches the server on it", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const url = `http://pinned.test:${String(local.port)}/`;
			const got = yield* HttpClientRequest.get(url).pipe(fetched, Effect.flip);

			expect([got.kind, got.message, hits.count]).toEqual([
				"blocked",
				"pinned.test resolves to 127.0.0.1, a private address",
				0,
			]);
		}).pipe(Effect.provide(guarded)),
	));
