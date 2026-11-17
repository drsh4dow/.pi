import type { ClassifierResult } from "@earendil-works/pi-ai";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Str from "effect/String";

import type { Classify } from "#src/features/phi-router/decisions.ts";
import { judgeOn, liveClassify } from "./live.ts";

const sizes = [10_000, 100_000, 400_000, 1_600_000];

const callsPerSize = 3;

const fillerOf = Effect.fn("fillerOf")(function* (root: string) {
	const fs = yield* FileSystem.FileSystem;
	const listed = yield* fs.readDirectory(`${root}/features`, { recursive: true });
	const sources = Arr.filter(listed, (file) => Str.endsWith(".ts")(file) && !Str.startsWith("phi-router/")(file));
	const texts = yield* Effect.forEach(sources, (file) => fs.readFileString(`${root}/features/${file}`));

	return Arr.join(texts, "\n");
});

const sized = (filler: string, size: number) => Str.slice(0, size)(Str.repeat(Math.ceil(size / filler.length))(filler));

const failureOf = (why: string, last: Option.Option<ClassifierResult>) =>
	Option.match(last, {
		onNone: () => `failed (${why}), no classifier result`,
		onSome: ({ stopReason, errorMessage }) =>
			Str.slice(0, 200)(`failed (${why}), ${stopReason}: ${errorMessage ?? "no message"}`),
	});

const probe = Effect.fn("probe")(function* (classify: Classify, piece: string) {
	const last = yield* Ref.make(Option.none<ClassifierResult>());
	const services = yield* Effect.context();

	const watched: Classify = (context, options) =>
		Effect.runPromiseWith(services)(
			Effect.tap(
				Effect.promise(() => classify(context, options)),
				(result) => Ref.set(last, Option.some(result)),
			),
		);

	const judge = yield* judgeOn(watched);
	const [took, answer] = yield* judge.identifier({ piece, context: [], images: [] }).pipe(Effect.result, Effect.timed);
	const result = yield* Ref.get(last);

	const outcome = Result.match(answer, {
		onSuccess: ({ score }) => `ok, score ${score.toFixed(4)}`,
		onFailure: ({ why }) => failureOf(why, result),
	});

	return { ms: Math.round(Duration.toMillis(took)), outcome };
}, Effect.scoped);

const measure = Effect.fn("measure")(function* (classify: Classify, piece: string) {
	const calls = yield* Effect.forEach(Arr.range(1, callsPerSize), () => probe(classify, piece));

	yield* Effect.forEach(calls, ({ ms, outcome }, index) =>
		Console.log(`${piece.length} chars, call ${index + 1}: ${ms} ms, ${outcome}`),
	);

	const times = Arr.sort(
		Arr.map(calls, ({ ms }) => ms),
		Order.Number,
	);

	const median = Arr.get(times, Math.floor(callsPerSize / 2));

	yield* Console.log(`${piece.length} chars, median ${Option.getOrElse(median, () => 0)} ms`);
});

const program = Effect.gen(function* () {
	const path = yield* Path.Path;
	const filler = yield* fillerOf(path.resolve(import.meta.dirname, "../../../.."));
	const classify = yield* liveClassify;

	yield* Effect.forEach(sizes, (size) => measure(classify, sized(filler, size)));
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
