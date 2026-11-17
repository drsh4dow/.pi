import * as Arr from "effect/Array";
import * as Option from "effect/Option";

import { type Seen, seenOn, type Tracked } from "../canary-tokens.ts";
import type { Usage } from "../policy/engine.ts";
import type { Lane } from "../route.ts";
import { Carrier, type Case, Entry, Identifier, Negative, type PhiStrata, Transform } from "./manifest.ts";

export interface Sent {
	readonly lane: Lane;
	readonly usage: Usage;
	/** Pieces this request sealed because the judge failed on them. */
	readonly failures: number;
	readonly view: Option.Option<string>;
}

export interface Played {
	readonly case: Case;
	readonly sent: ReadonlyArray<Sent>;
	readonly tracked: Tracked;
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

interface CaseAt {
	readonly id: string;
	readonly strata: PhiStrata;
	/** The first request that showed it. */
	readonly request: number;
}

export interface Report {
	readonly window: number;
	readonly strata: ReadonlyArray<{
		readonly axis: keyof PhiStrata;
		readonly value: string;
		readonly cases: number;
		readonly leaks: number;
		readonly leakRateUpper95: number;
	}>;
	/** Positive cases that showed a complete canary in one message to personal accounts. */
	readonly leaks: ReadonlyArray<CaseAt>;
	/** Positive cases that showed personal accounts every part of a split canary, only in different messages, and no leak. */
	readonly splits: ReadonlyArray<CaseAt>;
	readonly overRouting: ReadonlyArray<{
		readonly negative: typeof Negative.Type;
		readonly cases: number;
		readonly overRouted: number;
		readonly requests: number;
		readonly onEnt: number;
	}>;
	readonly fragments: { readonly cases: number; readonly shown: number };
	readonly lanes: Readonly<Record<Lane, number>>;
	readonly judge: Usage & { readonly failures: number };
}

type PhiPlayed = Played & { readonly case: Extract<Case, { readonly expect: "phi" }> };

const isPhi = (played: Played): played is PhiPlayed => played.case.expect === "phi";

const seenOf = ({ sent, tracked }: Played, upTo: number) => {
	const personal = Arr.getSomes(Arr.map(Arr.take(sent, upTo), ({ view }) => view));

	return seenOn({ tracked, personal, ent: [] });
};

const firstAt = (played: Played, shown: (seen: Seen) => boolean) =>
	Option.map(
		Arr.findFirstIndex(played.sent, (_sent, index) => shown(seenOf(played, index + 1))),
		(index) => index + 1,
	);

const leakAt = (played: Played) => firstAt(played, ({ leaked: canaries }) => canaries.length > 0);

const leaked = (played: Played) => Option.isSome(leakAt(played));

const splitAt = (played: Played) => (leaked(played) ? Option.none() : firstAt(played, ({ split }) => split.length > 0));

const axes = [
	["identifier", Identifier.literals],
	["carrier", Carrier.literals],
	["transform", Transform.literals],
	["entry", Entry.literals],
] as const;

const strataOf = (scored: ReadonlyArray<PhiPlayed>): Report["strata"] =>
	Arr.flatMap(axes, ([axis, values]) =>
		Arr.map(values, (value) => {
			const inStratum = Arr.filter(scored, ({ case: { strata } }) => strata[axis] === value);
			const leaks = Arr.filter(inStratum, leaked).length;
			const leakRateUpper95 = missRateUpperBound({ misses: leaks, cases: inStratum.length });

			return { axis, value, cases: inStratum.length, leaks, leakRateUpper95 };
		}),
	);

const onEnt = ({ sent }: Played) => Arr.filter(sent, ({ lane }) => lane === "ent").length;

const overRoutingOf = (clean: ReadonlyArray<Played>): Report["overRouting"] =>
	Arr.map(Negative.literals, (negative) => {
		const inClass = Arr.filter(clean, ({ case: { strata } }) => "negative" in strata && strata.negative === negative);

		return {
			negative,
			cases: inClass.length,
			overRouted: Arr.filter(inClass, (played) => onEnt(played) > 0).length,
			requests: Arr.reduce(inClass, 0, (total, played) => total + played.sent.length),
			onEnt: Arr.reduce(inClass, 0, (total, played) => total + onEnt(played)),
		};
	});

const judgeOf = (sent: ReadonlyArray<Sent>): Report["judge"] =>
	Arr.reduce(sent, { calls: 0, inputTokens: 0, cost: 0, ms: 0, failures: 0 }, (total, { usage, failures }) => ({
		calls: total.calls + usage.calls,
		inputTokens: total.inputTokens + usage.inputTokens,
		cost: total.cost + usage.cost,
		ms: total.ms + usage.ms,
		failures: total.failures + failures,
	}));

export const reportOf = ({ played, window }: { readonly played: ReadonlyArray<Played>; readonly window: number }) => {
	const phi = Arr.filter(played, isPhi);
	const sent = Arr.flatMap(played, (each) => each.sent);
	const fragments = Arr.map(played, (each) => seenOf(each, each.sent.length).fragments.length);

	const casesAt = (at: (played: PhiPlayed) => Option.Option<number>) =>
		Arr.flatMap(phi, (each) =>
			Option.toArray(Option.map(at(each), (request) => ({ id: each.case.id, strata: each.case.strata, request }))),
		);

	return {
		window,
		strata: strataOf(phi),
		leaks: casesAt(leakAt),
		splits: casesAt(splitAt),
		overRouting: overRoutingOf(Arr.filter(played, (each) => each.case.expect === "clean")),
		fragments: {
			cases: Arr.filter(fragments, (shown) => shown > 0).length,
			shown: Arr.reduce(fragments, 0, (total, shown) => total + shown),
		},
		lanes: {
			personal: Arr.filter(sent, ({ lane }) => lane === "personal").length,
			ent: Arr.filter(sent, ({ lane }) => lane === "ent").length,
		},
		judge: judgeOf(sent),
	} satisfies Report;
};
