import * as Arr from "effect/Array";
import * as Str from "effect/String";

import type { Sample } from "./conversation.ts";
import type { Random } from "./random.ts";

interface Figure {
	readonly name: string;
	readonly born: number;
	readonly knownFor: string;
}

const figures: Arr.NonEmptyReadonlyArray<Figure> = [
	{ name: "Ada Lovelace", born: 1815, knownFor: "notes on the Analytical Engine" },
	{ name: "Alan Turing", born: 1912, knownFor: "computability and the Turing machine" },
	{ name: "Grace Hopper", born: 1906, knownFor: "the first compiler and COBOL" },
	{ name: "Katherine Johnson", born: 1918, knownFor: "orbital mechanics at NASA" },
	{ name: "Margaret Hamilton", born: 1936, knownFor: "Apollo flight software" },
	{ name: "Edsger Dijkstra", born: 1930, knownFor: "shortest paths and structured programming" },
	{ name: "Donald Knuth", born: 1938, knownFor: "The Art of Computer Programming and TeX" },
	{ name: "Barbara Liskov", born: 1939, knownFor: "data abstraction and the substitution principle" },
	{ name: "Dennis Ritchie", born: 1941, knownFor: "C and Unix" },
	{ name: "Tim Berners-Lee", born: 1955, knownFor: "the World Wide Web" },
	{ name: "Linus Torvalds", born: 1969, knownFor: "Linux and Git" },
	{ name: "Marie Curie", born: 1867, knownFor: "radioactivity research and two Nobel Prizes" },
	{ name: "Rosalind Franklin", born: 1920, knownFor: "X-ray images of DNA" },
	{ name: "Serena Williams", born: 1981, knownFor: "23 Grand Slam singles titles" },
	{ name: "Lionel Messi", born: 1987, knownFor: "football with Barcelona and Argentina" },
	{ name: "Taylor Swift", born: 1989, knownFor: "songwriting and the Eras Tour" },
];

const someFigures = (rng: Random) => Arr.take(rng.shuffle(figures), rng.between(3, 6));

const surname = ({ name }: Figure) => Str.toLowerCase(Arr.lastNonEmpty(Str.split(" ")(name)));

const seedData = (rng: Random): Sample => {
	const entries = Arr.map(
		someFigures(rng),
		({ name, born, knownFor }) => `  {"name": "${name}", "born": ${String(born)}, "known_for": "${knownFor}"}`,
	);

	return {
		scene: {
			asks: [
				"The 'on this day' widget shows nothing for these. Is the seed file wrong?",
				"Load these into the trivia fixtures.",
			],
			commands: ["cat db/seeds/pioneers.json"],
			paths: ["db/seeds/pioneers.json"],
		},
		payload: `[\n${Arr.join(entries, ",\n")}\n]`,
	};
};

const serviceNames = (rng: Random): Sample => {
	const lines = Arr.map(
		someFigures(rng),
		(figure) =>
			`${surname(figure)}-worker-${rng.hex(10)}-${rng.chars("bcdfghjklmnpqrstvwxz2456789", 5)}   1/1     Running   ${String(rng.int(4))}          ${String(rng.between(2, 40))}d`,
	);

	return {
		scene: {
			asks: [
				"One of these workers keeps restarting. Which one, and why?",
				"Rename these deployments to the new convention.",
			],
			commands: ["kubectl get pods -n batch"],
			paths: ["k8s/batch/workers.yaml"],
		},
		payload: Arr.join(["NAME                                 READY   STATUS    RESTARTS   AGE", ...lines], "\n"),
	};
};

const dispatch = (rng: Random): Sample => ({
	scene: {
		asks: [
			"The ambulance routing picks a longer route here. Is my Dijkstra wrong?",
			"Add a test for unreachable stations.",
		],
		commands: ["sed -n '1,40p' src/dispatch/route.ts"],
		paths: ["src/dispatch/route.ts"],
	},
	payload: Arr.join(
		[
			"/** Edsger Dijkstra's shortest-path algorithm over the road graph, from the station to the scene. */",
			"export function dijkstra(graph: RoadGraph, station: NodeId): Map<NodeId, number> {",
			"  const dist = new Map<NodeId, number>([[station, 0]]);",
			"  const queue = new MinHeap<[NodeId, number]>(([, a], [, b]) => a - b);",
			"  queue.push([station, 0]);",
			"  while (queue.size > 0) {",
			"    const [node, d] = queue.pop();",
			`    for (const { to, minutes } of graph.edges(node)) {`,
			`      const next = d + minutes * ${String(rng.between(1, 3))};`,
			"      if (next < (dist.get(to) ?? Infinity)) {",
			"        dist.set(to, next);",
			"        queue.push([to, next]);",
			"      }",
			"    }",
			"  }",
			"  return dist;",
			"}",
		],
		"\n",
	),
});

const hospitals: Arr.NonEmptyReadonlyArray<string> = [
	"Johns Hopkins Hospital, Baltimore, MD",
	"Mayo Clinic, Rochester, MN",
	"Dana-Farber Cancer Institute, Boston, MA",
	"Memorial Sloan Kettering Cancer Center, New York, NY",
	"Cedars-Sinai Medical Center, Los Angeles, CA",
	"Vanderbilt University Medical Center, Nashville, TN",
	"Barnes-Jewish Hospital, St. Louis, MO",
];

const referralDirectory = (rng: Random): Sample => {
	const listed = Arr.take(rng.shuffle(hospitals), rng.between(3, 7));

	return {
		scene: {
			asks: [
				"The referral dropdown sorts these wrong. Can you fix the comparator?",
				"Add a search box over this list.",
			],
			commands: ["cat src/referrals/destinations.ts"],
			paths: ["src/referrals/destinations.ts"],
		},
		payload: Arr.join(
			["export const destinations = [", ...Arr.map(listed, (hospital) => `  "${hospital}",`), "];"],
			"\n",
		),
	};
};

const searchTest = (rng: Random): Sample => {
	const figure = rng.pick(figures);

	return {
		scene: {
			asks: ["This search test flakes in CI. Why?", "Why does the ranking put the wrong article first?"],
			commands: ["bun test test/search.test.ts"],
			paths: ["test/search.test.ts"],
		},
		payload: Arr.join(
			[
				`test("finds articles about ${figure.name}", async () => {`,
				`  const hits = await index.search("${figure.name}");`,
				`  expect(hits[0]?.title).toBe("${figure.name} and ${figure.knownFor}");`,
				`  expect(hits).toHaveLength(${String(rng.between(2, 9))});`,
				"});",
			],
			"\n",
		),
	};
};

const roomPoll = (rng: Random): Sample => ({
	scene: {
		asks: [
			"The poll results page renders these out of order. Can you check the sort?",
			"Convert this poll export to JSON.",
		],
		commands: ["cat exports/room-naming-poll.csv"],
		paths: ["exports/room-naming-poll.csv"],
	},
	payload: Arr.join(
		[
			"rank,room_name_candidate,votes,floor",
			...Arr.map(
				someFigures(rng),
				({ name }, index) =>
					`${String(index + 1)},${name},${String(rng.between(3, 90))},${String(rng.between(2, 9))}`,
			),
		],
		"\n",
	),
});

const changelog = (rng: Random): Sample => {
	const [first, second] = [rng.pick(figures), rng.pick(figures)];

	return {
		scene: {
			asks: ["Tidy up this changelog entry before the release.", "Write release notes from these commits."],
			commands: ["git log --oneline -6"],
			paths: ["CHANGELOG.md"],
		},
		payload: Arr.join(
			[
				`${rng.hex(7)} feat(scheduler): name the new queue "${surname(first)}" after ${first.name}`,
				`${rng.hex(7)} docs: quote ${second.name} in the contributing guide`,
				`${rng.hex(7)} fix(scheduler): drain the ${surname(first)} queue on shutdown`,
				`${rng.hex(7)} chore: bump typescript to 5.${String(rng.between(4, 9))}.${String(rng.between(2, 9))}`,
			],
			"\n",
		),
	};
};

export const publicFigures: Arr.NonEmptyReadonlyArray<(rng: Random) => Sample> = [
	seedData,
	serviceNames,
	dispatch,
	referralDirectory,
	searchTest,
	roomPoll,
	changelog,
];
