import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/encoding";
import * as Str from "effect/String";

import { ScanResult, Unscannable } from "./index.ts";
import { scanWith, user } from "./judge.fixture.ts";

const gzip = (text: string) =>
	Effect.promise(() => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).bytes());

const gzipBase64 = (text: string) => Effect.map(gzip(text), Encoding.Base64.encode);

const binary = (length: number) => Uint8Array.from(Arr.makeBy(length, (index) => (index * 37 + 11) % 256));

const tainted = (what: "binary" | "undecodable") =>
	ScanResult.Tainted({
		taint: Unscannable.make({ what }),
		stats: { newChars: 0, judgeCalls: 0, judgeMs: 0 },
	});

const scanned = (text: string) =>
	Effect.map(scanWith({ transcript: [user(text)] }), ({ result, asked }) => ({
		result,
		fresh: Arr.map(asked, (input) => input.fresh),
	}));

const run = (body: Effect.Effect<void>) => Effect.runPromise(body);

const note = "Patient Marisol Quintero";

test("base64 text reaches the judge decoded, after the original", () =>
	run(
		Effect.gen(function* () {
			const letter = `${note}\r\n\tseen for chest pain`;
			const encoded = Encoding.Base64.encode(letter);
			const { fresh } = yield* scanned(`token ${encoded}`);

			expect(fresh).toEqual([`[user] token ${encoded}\n${letter}`]);
		}),
	));

test("base64 text whose encoding happens to read as words still reaches the judge decoded", () =>
	run(
		Effect.gen(function* () {
			const { fresh } = yield* scanned("emlwIG1hcmlzb2wgcGhvbmU=");

			expect(fresh).toEqual(["[user] emlwIG1hcmlzb2wgcGhvbmU=\nzip marisol phone"]);
		}),
	));

test("base64url text reaches the judge decoded", () =>
	run(
		Effect.gen(function* () {
			const encoded = Encoding.Base64Url.encode("Marisol Quintero?? born 1962>>");
			const { fresh } = yield* scanned(encoded);

			expect(fresh).toEqual([`[user] ${encoded}\nMarisol Quintero?? born 1962>>`]);
		}),
	));

test("gzip inside base64 reaches the judge inflated", () =>
	run(
		Effect.gen(function* () {
			const encoded = yield* gzipBase64(note);
			const { fresh } = yield* scanned(encoded);

			expect(fresh).toEqual([`[user] ${encoded}\n${note}`]);
		}),
	));

test("gzip written as hex reaches the judge inflated", () =>
	run(
		Effect.gen(function* () {
			const encoded = yield* Effect.map(gzip(note), Encoding.Hex.encode);
			const { fresh } = yield* scanned(`payload=${encoded}`);

			expect(fresh).toEqual([`[user] payload=${encoded}\n${note}`]);
		}),
	));

test("percent-encoded text reaches the judge decoded", () =>
	run(
		Effect.gen(function* () {
			const { fresh } = yield* scanned("GET /search?q=Marisol+Quintero%2C%20chest%20pain 200");

			expect(fresh).toEqual([
				"[user] GET /search?q=Marisol+Quintero%2C%20chest%20pain 200\n/search?q=Marisol Quintero, chest pain",
			]);
		}),
	));

const once = Encoding.Base64.encode(note);
const twice = Encoding.Base64.encode(once);
const thrice = Encoding.Base64.encode(twice);

test("a payload nested three levels deep is decoded at every level", () =>
	run(
		Effect.gen(function* () {
			const { fresh } = yield* scanned(thrice);

			expect(fresh).toEqual([`[user] ${thrice}\n${twice}\n${once}\n${note}`]);
		}),
	));

test("a payload still encoded below three levels is undecodable", () =>
	run(
		Effect.gen(function* () {
			const { result } = yield* scanned(Encoding.Base64.encode(thrice));

			expect(result).toEqual(tainted("undecodable"));
		}),
	));

test("decoded binary over 64 bytes taints as binary without a judge call", () =>
	run(
		Effect.gen(function* () {
			const { result, fresh } = yield* scanned(`blob ${Encoding.Base64.encode(binary(65))}`);

			expect(result).toEqual(tainted("binary"));
			expect(fresh).toEqual([]);
		}),
	));

test("decoded bytes of 64 or less, such as a key or a digest, never taint: the judge decides", () =>
	run(
		Effect.gen(function* () {
			const key = `JWT_SECRET=${Encoding.Base64.encode(binary(32))}`;
			const digest = `"digest": "${Encoding.Base64.encode(binary(64))}"`;
			const { result, fresh } = yield* scanned(`${key}\n${digest}`);

			expect(ScanResult.$is("Clean")(result)).toBe(true);
			expect(fresh).toHaveLength(1);
		}),
	));

test("a corrupt gzip taints as undecodable", () =>
	run(
		Effect.gen(function* () {
			const valid = yield* gzip(`${note}, seen for chest pain on 2024-01-05`);
			const corrupt = Uint8Array.from(valid, (byte, index) => (index > 12 ? 255 - byte : byte));
			const { result } = yield* scanned(Encoding.Base64.encode(corrupt));

			expect(result).toEqual(tainted("undecodable"));
		}),
	));

test("a gzip that inflates past the size bound taints as undecodable", () =>
	run(
		Effect.gen(function* () {
			const bomb = yield* gzipBase64(Str.repeat(5 * 1024 * 1024)("a"));
			const { result } = yield* scanned(bomb);

			expect(result).toEqual(tainted("undecodable"));
		}),
	));

test("decoded output is bounded across all the payloads of a transcript", () =>
	run(
		Effect.gen(function* () {
			const big = yield* gzipBase64(Str.repeat(3 * 1024 * 1024)("a"));
			const { result } = yield* scanWith({ transcript: [user(big), user(big)] });

			expect(result).toEqual(tainted("undecodable"));
		}),
	));

test("decoded output is bounded even when no payload is gzip", () =>
	run(
		Effect.gen(function* () {
			const { result } = yield* scanned(Encoding.Base64.encode(Str.repeat(200_000)(`${note}. `)));

			expect(result).toEqual(tainted("undecodable"));
		}),
	));

const lookAlikes = Arr.join(
	[
		"commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b",
		"sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		"sha512 45843648ecf9da8e513286f136e3f271e7d6dee4d29b947a50dde8c61f3e197694c13bcdc279ce459839757cd8de19c11b23b33565384a97afcf360483578cd4",
		"id 550e8400-e29b-41d4-a716-446655440000",
		"bumped typescript 7.0.2 -> 7.0.3 in packages/phi-router",
		"see AbstractSingletonProxyFactoryBean for details",
		"open src/main/kotlin/com/acme/client2024v2/eligibility/models/CoverageEligibilityResponseMapper.kt",
		"fun test_returns_the_cached_value_when_the_key_was_written_in_2024Q1_and_has_not_expired_yet()",
		"cache miss for setup-bun-Linux-x64-node20-3f2a9c1e7b6d4f8a0c5e2b9d7a1f3c6e8b0d2f4a6c8e0b2d4f6a8c",
	],
	"\n",
);

test("hex digests, UUIDs, versions, paths and identifiers are left as they are", () =>
	run(
		Effect.gen(function* () {
			const { fresh } = yield* scanned(lookAlikes);

			expect(fresh).toEqual([`[user] ${lookAlikes}`]);
		}),
	));
