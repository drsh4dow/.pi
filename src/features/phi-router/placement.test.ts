import { expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type Carries, type Placement, sealedLane } from "./gate.ts";
import { homeOf, placementFor } from "./route.ts";
import {
	asked,
	branchOf,
	catOutput,
	lanesOf,
	overloadedOn,
	phiAuto,
	phiModel,
	ranCat,
	run,
	ssnRecord,
	system,
	worldOf,
} from "./router.fixture.ts";

const opening = [system, asked("Why does the admissions import drop rows?")];

const carrying =
	(keys: ReadonlyArray<string>): Carries =>
	(provider, id) =>
		Arr.contains(keys, `${provider}/${id}`);

const opus = "claude-opus-5-5";

const carried = [
	`ultra-a/${opus}`,
	`ultra-b/${opus}`,
	`ent/${opus}`,
	"ultra-a/claude-fable-5-2",
	"ultra-b/claude-fable-5-2",
	"ent/claude-fable-5-2",
	"openai/gpt-6.1-sol",
	"opencode-go/glm-5.3-flash",
];

test("the sealed lane of an id is the first BAA provider that carries it, else ent's fallback", () => {
	const laneOf = (id: string) => sealedLane({ id, fallback: opus, carries: carrying(carried) });

	expect(Arr.map(["gpt-6.1-sol", "claude-fable-5-2", "glm-5.3-flash"], laneOf)).toEqual([
		{ provider: "openai", id: "gpt-6.1-sol" },
		{ provider: "ent", id: "claude-fable-5-2" },
		{ provider: "ent", id: opus },
	]);
});

test("a Claude id walks home, the other account, then ent, skipping a limited or unusable account", () => {
	const choice = {
		id: opus,
		lane: "personal",
		home: "ultra-a",
		fallback: opus,
		limited: () => false,
		usable: carrying([`ultra-a/${opus}`, `ultra-b/${opus}`, `ent/${opus}`]),
		failedOnBaa: false,
	} as const;

	expect(placementFor(choice)).toEqual({ provider: "ultra-a", id: opus });
	expect(placementFor({ ...choice, limited: (provider) => provider === "ultra-a" })).toEqual({
		provider: "ultra-b",
		id: opus,
	});
	expect(placementFor({ ...choice, usable: carrying([`ultra-b/${opus}`, `ent/${opus}`]) })).toEqual({
		provider: "ultra-b",
		id: opus,
	});
	expect(placementFor({ ...choice, limited: (provider) => provider !== "ent" })).toEqual({
		provider: "ent",
		id: opus,
	});
	expect(placementFor({ ...choice, lane: "ent" })).toEqual({ provider: "ent", id: opus });
});

test("glm-5.3-flash runs on opencode-go when clean and on ent's fallback when sealed, unlogged, or retried after a BAA failure", () => {
	const choice = {
		id: "glm-5.3-flash",
		lane: "personal",
		home: "ultra-b",
		fallback: opus,
		limited: () => false,
		usable: carrying(["opencode-go/glm-5.3-flash", `ent/${opus}`]),
		failedOnBaa: false,
	} as const;

	const substitute: Placement = { provider: "ent", id: opus };

	expect(placementFor(choice)).toEqual({ provider: "opencode-go", id: "glm-5.3-flash" });
	expect(placementFor({ ...choice, lane: "ent" })).toEqual(substitute);
	expect(placementFor({ ...choice, usable: carrying([`ent/${opus}`]) })).toEqual(substitute);
	expect(placementFor({ ...choice, failedOnBaa: true })).toEqual(substitute);
});

const dispatchedFor = ({
	name,
	selected,
	settings = '{ "mode": "enforce" }',
}: {
	readonly name: string;
	readonly selected: string;
	readonly settings?: string;
}) =>
	Effect.gen(function* () {
		const world = yield* worldOf({ name, settings: Option.some(settings), catalog: Option.some(carried) });
		const branch = yield* branchOf({ world, selected: phiModel(selected) });

		yield* branch.send("user", opening);
		yield* branch.send("continuation", [...opening, ranCat(homeOf(world.session)), catOutput(ssnRecord)]);

		return { world, home: homeOf(world.session) };
	});

test("a phi/<id> model sends a clean request to the id on its personal provider and a sealed one to its sealed lane", () =>
	run(
		Effect.gen(function* () {
			const glm = yield* dispatchedFor({ name: "phi-glm", selected: "glm-5.3-flash" });
			const fable = yield* dispatchedFor({ name: "phi-fable", selected: "claude-fable-5-2" });

			expect(glm.world.routed).toEqual(["opencode-go/glm-5.3-flash", `ent/${opus}`]);
			expect(fable.world.routed).toEqual([`${fable.home}/claude-fable-5-2`, "ent/claude-fable-5-2"]);
		}),
	));

test("shadow sends a phi/<id> request to its sealed lane, and the lane log names the model", () =>
	run(
		Effect.gen(function* () {
			const { world, home } = yield* dispatchedFor({
				name: "phi-fable-shadow",
				selected: "claude-fable-5-2",
				settings: '{ "mode": "shadow" }',
			});

			const { lanes } = yield* lanesOf(world);

			expect(world.routed).toEqual(["ent/claude-fable-5-2", "ent/claude-fable-5-2"]);
			expect(lanes[0]).toMatchObject({ wouldBe: home, dispatched: "ent", model: "claude-fable-5-2" });
		}),
	));

test("a router failure sends the selected id's sealed lane, with settings.model as the fallback", () =>
	run(
		Effect.gen(function* () {
			const settings = Option.some('{ "mode": "enforce", "model": "claude-fable-5-2" }');
			const world = yield* worldOf({ name: "phi-fails", settings, catalog: Option.some(carried) });

			world.judge = "dies";

			yield* (yield* branchOf({ world, selected: phiModel("glm-5.3-flash") })).send("user", opening);
			yield* (yield* branchOf({ world, selected: phiModel(opus) })).send("user", opening);

			expect(world.routed).toEqual(["ent/claude-fable-5-2", `ent/${opus}`]);
		}),
	));

test("a retry after a failure on openai stays on the sealed lane, and one after a personal failure goes home", () =>
	run(
		Effect.gen(function* () {
			const world = yield* worldOf({ name: "phi-openai-failed", catalog: Option.some(carried) });
			const branch = yield* branchOf({ world, selected: phiAuto });

			yield* branch.send("retry", opening, overloadedOn("openai"));
			yield* branch.send("retry", opening, overloadedOn("opencode-go"));

			expect(world.routed).toEqual([`ent/${opus}`, `${homeOf(world.session)}/${opus}`]);
		}),
	));
