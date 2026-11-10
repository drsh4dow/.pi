import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Record from "effect/Record";
import * as Str from "effect/String";

/**
 * A lexical stand-in for how pi routes a prompt to a skill, ported from the Tier-2 eval in addyosmani/agent-skills:
 * stemmed TF-IDF over each skill's name and description. It cannot judge meaning, but it catches a description that
 * lacks the words users say, one that outranks the skill a prompt belongs to, and two descriptions that read alike.
 */
export interface Skill {
	readonly name: string;
	readonly description: string;
}

/** Prompts a skill must win, within `topK` places (3 when absent), and prompts it must lose, to `owner` when named. */
export interface Triggers {
	readonly positive: ReadonlyArray<{ readonly prompt: string; readonly topK?: number }>;
	readonly negative: ReadonlyArray<{ readonly prompt: string; readonly owner?: string }>;
}

type Vector = ReadonlyMap<string, number>;

export interface Corpus {
	readonly docs: ReadonlyMap<string, Vector>;
	readonly idf: (term: string) => number;
}

interface Ranked {
	readonly name: string;
	readonly score: number;
}

const stopWords = new Set(
	Str.split(" ")(
		"a an and any are as at be before by for from in into is it its my need needs of on or our so that the them this to use want we when with you your help me i",
	),
);

const suffixes = ["ally", "ing", "ations", "ation", "ed", "es", "al"];

/** Forms users type that share no stem with the word a description uses: clipped forms, and verbs built on a noun. */
const aliases = new Map([
	["doc", "document"],
	["docs", "document"],
	["config", "configuration"],
	["configs", "configuration"],
	["auth", "authenticate"],
	["authentication", "authenticate"],
	["repo", "repository"],
	["repos", "repository"],
	["dep", "dependency"],
	["deps", "dependency"],
	["ideate", "idea"],
	["ideation", "idea"],
]);

const dropLast = Str.slice(0, -1);

const stripSuffix = (term: string) => {
	const suffix = Arr.findFirst(suffixes, (ending) => term.length > ending.length + 3 && Str.endsWith(ending)(term));

	return Option.match(suffix, { onNone: () => term, onSome: (ending) => Str.slice(0, -ending.length)(term) });
};

const undouble = (term: string) => {
	const last = Str.slice(-1)(term);
	const doubled = Str.slice(-2, -1)(term) === last && !Str.includes(last)("aeiou");

	return term.length > 4 && doubled ? dropLast(term) : term;
};

/** Light suffix stripping, so "conflicts" and "conflict" or "branching" and "branch" share a stem. Not a real stemmer. */
const stemSteps: ReadonlyArray<(term: string) => string> = [
	(term) => (term.length > 10 && /ifications?$/u.test(term) ? Str.replace(/ications?$/u, "i")(term) : term),
	stripSuffix,
	(term) => (term.length > 3 && Str.endsWith("s")(term) && !Str.endsWith("ss")(term) ? dropLast(term) : term),
	(term) => (term.length > 4 && Str.endsWith("e")(term) ? dropLast(term) : term),
	undouble,
	(term) => (term.length > 3 && Str.endsWith("y")(term) ? `${dropLast(term)}i` : term),
];

const stem = (word: string) => Arr.reduce(stemSteps, word, (term, step) => step(term));

const tokenize = (text: string) => {
	const words = Str.split(/[\s-]+/u)(Str.replaceAll(/[^a-z0-9\s-]/gu, " ")(Str.toLowerCase(text)));
	const kept = Arr.filter(words, (word) => word.length > 2 && !stopWords.has(word));

	return Arr.map(kept, (word) => stem(aliases.get(word) ?? word));
};

const termFrequency = (tokens: ReadonlyArray<string>) => {
	const frequency = new Map<string, number>();

	for (const token of tokens) {
		frequency.set(token, (frequency.get(token) ?? 0) + 1);
	}

	return frequency;
};

/** A skill's document is its name, counted twice, then its description. */
export const corpusOf = (skills: ReadonlyArray<Skill>): Corpus => {
	const entries = Arr.map(skills, ({ name, description }) => {
		const nameTokens = tokenize(Str.replaceAll("-", " ")(name));
		const doc = termFrequency([...nameTokens, ...nameTokens, ...tokenize(description)]);

		return [name, doc] as const;
	});

	const docs = new Map(entries);
	const documentFrequency = termFrequency(Arr.flatMap(entries, ([, doc]) => [...doc.keys()]));

	return { docs, idf: (term) => Math.log(1 + docs.size / (1 + (documentFrequency.get(term) ?? 0))) };
};

const weigh = (frequency: Vector, idf: Corpus["idf"]): Vector =>
	new Map(Arr.map([...frequency], ([term, count]) => [term, count * idf(term)] as const));

const norm = (vector: Vector) => {
	const weights = [...vector.values()];

	return Math.sqrt(Arr.reduce(weights, 0, (sum, weight) => sum + weight * weight));
};

const cosine = (left: Vector, right: Vector) => {
	const dot = Arr.reduce([...left], 0, (sum, [term, weight]) => sum + weight * (right.get(term) ?? 0));
	const length = norm(left) * norm(right);

	return length === 0 ? 0 : dot / length;
};

const byScore = Order.mapInput(Order.Number, ({ score }: Ranked) => score);

/** Every skill in the corpus, best match for `prompt` first. */
export const rank = ({ prompt, corpus }: { prompt: string; corpus: Corpus }): ReadonlyArray<Ranked> => {
	const query = weigh(termFrequency(tokenize(prompt)), corpus.idf);
	const scored = Arr.map([...corpus.docs], ([name, doc]) => ({ name, score: cosine(query, weigh(doc, corpus.idf)) }));

	return Arr.sort(scored, Order.flip(byScore));
};

/** The 1-based place of `name` in `ranking`, counting only skills that share a word with the prompt. */
const placeOf = (ranking: ReadonlyArray<Ranked>, name: string) => {
	const index = Arr.findFirstIndex(ranking, (entry) => entry.name === name && entry.score > 0);

	return Option.map(index, (at) => at + 1);
};

const quote = (prompt: string) => `"${prompt}"`;

const positiveFailures = (corpus: Corpus, skill: string, { positive }: Triggers) =>
	Arr.flatMap(positive, ({ prompt, topK = 3 }) => {
		const ranking = rank({ prompt, corpus });
		const top = Arr.map(Arr.take(ranking, 3), ({ name }) => name);

		if (Option.exists(placeOf(ranking, skill), (at) => at <= topK)) {
			return [];
		}

		return [`${skill} is not in the top ${String(topK)} for ${quote(prompt)}; top: ${Arr.join(top, ", ")}`];
	});

const negativeFailures = (corpus: Corpus, skill: string, { negative }: Triggers) =>
	Arr.flatMap(negative, ({ prompt, owner }) => {
		const ranking = rank({ prompt, corpus });
		const first = Option.filter(Arr.head(ranking), ({ score }) => score > 0);
		const self = placeOf(ranking, skill);

		const takesIt = Option.exists(first, ({ name }) => name === skill);
		const failures = takesIt ? [`${skill} ranks first for ${quote(prompt)}, which is not its prompt`] : [];

		if (owner === undefined) {
			return failures;
		}

		const ownerWins = Option.exists(placeOf(ranking, owner), (at) => !Option.exists(self, (place) => place < at));

		return ownerWins ? failures : [...failures, `${owner} does not outrank ${skill} for ${quote(prompt)}`];
	});

/** Each trigger the corpus breaks, as one line naming the skill, the prompt, and what outranked it. */
export const routingFailures = ({
	corpus,
	triggers,
}: {
	corpus: Corpus;
	triggers: Record.ReadonlyRecord<string, Triggers>;
}) =>
	Arr.flatMap(Record.toEntries(triggers), ([skill, cases]) => [
		...positiveFailures(corpus, skill, cases),
		...negativeFailures(corpus, skill, cases),
	]);

const collisionLimit = 0.75;

/** Each pair of skills whose name and description vectors are at least `collisionLimit` alike. */
export const collisions = (corpus: Corpus) => {
	const vectors = Arr.map([...corpus.docs], ([name, doc]) => ({ name, vector: weigh(doc, corpus.idf) }));

	return Arr.flatMap(vectors, (left, index) =>
		Arr.flatMap(Arr.drop(vectors, index + 1), (right) => {
			const similarity = cosine(left.vector, right.vector);

			if (similarity < collisionLimit) {
				return [];
			}

			return [`${left.name} and ${right.name} are ${similarity.toFixed(2)} alike`];
		}),
	);
};
