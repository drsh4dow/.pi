import { expect, test } from "bun:test";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { OpencodeGo, opencodeGoLayer } from "./index.ts";

/** Answers each request with the next reply in line, and the last reply from then on. */
const answering = (replies: ReadonlyArray<() => Response>) => {
	let asked = 0;

	const transport = HttpClient.make((request) => {
		const reply = replies[Math.min(asked, replies.length - 1)];

		asked += 1;

		return reply === undefined
			? Effect.die("no reply")
			: Effect.succeed(HttpClientResponse.fromWeb(request, reply()));
	});

	return opencodeGoLayer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, transport)));
};

const page = `{"usage":{
	"rolling":{"status":"ok","percent":0,"resetsAt":"2026-11-10T21:43:42.981Z"},
	"weekly":{"status":"ok","percent":12,"resetsAt":"2026-11-16T00:00:00.000Z"},
	"monthly":{"status":"ok","percent":4,"resetsAt":"2026-12-01T22:19:41.000Z"}
}}`;

const served = () => new Response(page);

const unavailable = () =>
	new Response(`{"type":"error","error":{"type":"api_error","message":"Go usage is unavailable"}}`, { status: 503 });

const unauthorized = () => new Response("{}", { status: 401 });

const weeklyOnly = () => new Response(`{"usage":{"weekly":{"percent":30,"resetsAt":"2026-11-16T00:00:00.000Z"}}}`);

const at = (iso: string) => Option.some(DateTime.makeUnsafe(iso));

const servedOnly = answering([served]);

const weeklyOnlyPlan = answering([weeklyOnly]);

const flaky = answering([unavailable, served]);

const refusing = answering([unauthorized]);

const usage = Effect.flatMap(OpencodeGo, (go) => go.usage(Redacted.make("oc-test")));

test("each window the subscription has, with its reset", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const got = yield* usage;

			expect(got).toEqual([
				{ name: "5-hour", percent: 0, resetsAt: at("2026-11-10T21:43:42.981Z") },
				{ name: "weekly", percent: 12, resetsAt: at("2026-11-16T00:00:00.000Z") },
				{ name: "monthly", percent: 4, resetsAt: at("2026-12-01T22:19:41.000Z") },
			]);
		}).pipe(Effect.provide(servedOnly)),
	));

test("a plan without a monthly window leaves it out", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const got = yield* usage;

			expect(got).toEqual([{ name: "weekly", percent: 30, resetsAt: at("2026-11-16T00:00:00.000Z") }]);
		}).pipe(Effect.provide(weeklyOnlyPlan)),
	));

test("a moment of 503 is retried", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const got = yield* usage;

			expect(got).toHaveLength(3);
		}).pipe(Effect.provide(flaky)),
	));

test("a refusal that lasts fails", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const got = yield* Effect.flip(usage);

			expect(got._tag).toBe("OpencodeGoError");
		}).pipe(Effect.provide(refusing)),
	));
