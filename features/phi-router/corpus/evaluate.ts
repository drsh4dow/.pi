import * as Arr from "effect/Array";
import * as Chunk from "effect/Chunk";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Ref from "effect/Ref";

import { foundIn, tokensOf } from "../canary-tokens.ts";
import { type Cursor, Judge, SafeHarbor, scan, ScanResult, type Transcript, Unscanned } from "../policy/index.ts";
import { Carrier, type Case, Entry, Negative, type PhiStrata, Transform, transcriptOf } from "./manifest.ts";
import { requestsOf } from "./requests.ts";

/** `exposed`: a Clean scan sent a canary. `clean`: no scan caught the case. */
type Outcome = "exposed" | "clean" | "tainted" | "unsure";

const isMiss = (outcome: Outcome) => outcome === "exposed" || outcome === "clean";

interface Scored {
	readonly case: Case;
	readonly outcome: Outcome;
}

interface Stratum {
	readonly axis: keyof PhiStrata;
	readonly value: string;
	readonly cases: number;
	readonly misses: number;
	readonly uncertain: number;
	readonly missRateUpper95: number;
}

interface OverRouting {
	readonly negative: typeof Negative.Type;
	readonly cases: number;
	readonly overRouted: number;
}

export interface Report {
	/** Every value of every axis, in the schema's order, including values no case covers. */
	readonly strata: ReadonlyArray<Stratum>;
	readonly misses: ReadonlyArray<{ readonly id: string; readonly strata: PhiStrata }>;
	readonly overRouting: ReadonlyArray<OverRouting>;
	readonly totals: {
		readonly phi: number;
		readonly misses: number;
		readonly uncertain: number;
		readonly clean: number;
		readonly overRouted: number;
	};
	readonly judge: {
		readonly calls: number;
		readonly p50Ms: Option.Option<number>;
		readonly p95Ms: Option.Option<number>;
	};
}

const alpha = 0.05;

interface Tally {
	readonly misses: number;
	readonly cases: number;
}

const binomialCdf = ({ misses, cases }: Tally, rate: number) => {
	const logRate = Math.log(rate);
	const logRest = Math.log1p(-rate);
	const terms: Array<number> = [];
	let logChoose = 0;

	for (let count = 0; count <= misses; count += 1) {
		logChoose += count === 0 ? 0 : Math.log((cases - count + 1) / count);
		terms.push(logChoose + count * logRate + (cases - count) * logRest);
	}

	const top = Math.max(...terms);

	return Math.exp(top) * Arr.reduce(terms, 0, (sum, term) => sum + Math.exp(term - top));
};

/** The exact one-sided Clopper-Pearson upper bound at 95%: the rate where P(X <= misses; cases, rate) = 0.05. */
export const missRateUpperBound = (tally: Tally) => {
	if (tally.misses >= tally.cases) {
		return 1;
	}

	let low = 0;
	let high = 1;

	for (let step = 0; step < 100; step += 1) {
		const mid = (low + high) / 2;

		if (binomialCdf(tally, mid) > alpha) {
			low = mid;
		} else {
			high = mid;
		}
	}

	return high;
};

interface Game {
	readonly requests: ReadonlyArray<Transcript>;
	readonly tokens: ReadonlyArray<string>;
}

interface Played {
	readonly cursor: Cursor;
	readonly unsure: boolean;
}

const exposes = (request: Transcript, tokens: ReadonlyArray<string>) => {
	const bodies = Arr.flatMap(request, ({ parts }) =>
		Arr.map(parts, (part) => (part.kind === "text" ? part.text : part.data)),
	);

	return Arr.isReadonlyArrayNonEmpty(foundIn({ bodies, tokens }));
};

const playFrom = (game: Game, next: number, played: Played): Effect.Effect<Outcome, never, Judge> => {
	const request = Arr.get(game.requests, next);

	if (Option.isNone(request)) {
		return Effect.succeed(played.unsure ? "unsure" : "clean");
	}

	return Effect.flatMap(
		scan(request.value, played.cursor),
		ScanResult.$match({
			Tainted: () => Effect.succeed<Outcome>("tainted"),
			Unsure: () => playFrom(game, next + 1, { ...played, unsure: true }),
			Clean: ({ cursor }) =>
				exposes(request.value, game.tokens)
					? Effect.succeed<Outcome>("exposed")
					: playFrom(game, next + 1, { cursor, unsure: played.unsure }),
		}),
	);
};

const play = Effect.fn("play")(function* (found: Case) {
	const { tokens } = yield* tokensOf(found);
	const system = transcriptOf(Arr.filter(found.messages, (message) => message.role === "system"));
	const conversations = yield* Effect.orDie(requestsOf(found));
	const requests = Arr.map(conversations, (conversation) => [...system, ...conversation]);

	return yield* playFrom({ requests, tokens }, 0, { cursor: Unscanned.make({}), unsure: false });
});

const timed = (judge: Judge["Service"], latencies: Ref.Ref<Chunk.Chunk<number>>) =>
	Judge.of({
		maxChars: judge.maxChars,
		ask: (input) =>
			judge.ask(input).pipe(
				Effect.exit,
				Effect.timed,
				Effect.tap(([took]) => Ref.update(latencies, Chunk.append(Duration.toMillis(took)))),
				Effect.flatMap(([, exit]) => exit),
			),
	});

const percentile = (sorted: ReadonlyArray<number>, quantile: number) =>
	Arr.get(sorted, Math.ceil(quantile * sorted.length) - 1);

const axes = [
	["identifier", SafeHarbor.literals],
	["carrier", Carrier.literals],
	["transform", Transform.literals],
	["entry", Entry.literals],
] as const;

const strataOf = (phi: ReadonlyArray<{ readonly strata: PhiStrata; readonly outcome: Outcome }>) =>
	Arr.flatMap(axes, ([axis, values]) =>
		Arr.map(values, (value) => {
			const inStratum = Arr.filter(phi, ({ strata }) => strata[axis] === value);
			const misses = Arr.filter(inStratum, ({ outcome }) => isMiss(outcome)).length;

			return {
				axis,
				value,
				cases: inStratum.length,
				misses,
				uncertain: Arr.filter(inStratum, ({ outcome }) => outcome === "unsure").length,
				missRateUpper95: missRateUpperBound({ misses, cases: inStratum.length }),
			};
		}),
	);

const reportOf = (scored: ReadonlyArray<Scored>, latencies: ReadonlyArray<number>): Report => {
	const phi = Arr.flatMap(scored, ({ case: { id, expect, strata }, outcome }) =>
		expect === "phi" ? [{ id, strata, outcome }] : [],
	);

	const clean = Arr.flatMap(scored, ({ case: { expect, strata }, outcome }) =>
		expect === "clean" ? [{ negative: strata.negative, outcome }] : [],
	);

	const missed = Arr.filter(phi, ({ outcome }) => isMiss(outcome));
	const sorted = Arr.sort(latencies, Order.Number);

	const overRouting = Arr.map(Negative.literals, (negative) => {
		const inClass = Arr.filter(clean, (found) => found.negative === negative);

		return {
			negative,
			cases: inClass.length,
			overRouted: Arr.filter(inClass, ({ outcome }) => outcome !== "clean").length,
		};
	});

	return {
		strata: strataOf(phi),
		misses: Arr.map(missed, ({ id, strata }) => ({ id, strata })),
		overRouting,
		totals: {
			phi: phi.length,
			misses: missed.length,
			uncertain: Arr.filter(phi, ({ outcome }) => outcome === "unsure").length,
			clean: clean.length,
			overRouted: Arr.filter(clean, ({ outcome }) => outcome !== "clean").length,
		},
		judge: { calls: sorted.length, p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95) },
	};
};

const scoreCase = (found: Case) => Effect.map(play(found), (outcome): Scored => ({ case: found, outcome }));

export const evaluate = Effect.fn("evaluate")(function* (cases: ReadonlyArray<Case>) {
	const judge = yield* Judge;
	const latencies = yield* Ref.make(Chunk.empty<number>());

	const scored = yield* Effect.forEach(cases, scoreCase, { concurrency: 8 }).pipe(
		Effect.provideService(Judge, timed(judge, latencies)),
	);

	const took = yield* Ref.get(latencies);

	return reportOf(scored, Chunk.toReadonlyArray(took));
});
