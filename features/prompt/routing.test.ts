import { expect, test } from "bun:test";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { collisions, corpusOf, rank, routingFailures } from "./routing.ts";

const SkillFrontmatter = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	"disable-model-invocation": Schema.optionalKey(Schema.Boolean),
});

const Positive = Schema.Struct({ prompt: Schema.String, topK: Schema.optionalKey(Schema.Int) });

const Negative = Schema.Struct({ prompt: Schema.String, owner: Schema.optionalKey(Schema.String) });

const Cases = Schema.Struct({ positive: Schema.Array(Positive), negative: Schema.Array(Negative) });

const Triggers = Schema.fromJsonString(Schema.Record(Schema.String, Cases));

/** The trigger prompts from addyosmani/agent-skills' `evals/cases/`, keyed by the skill each must route to. */
const triggerFile = `${import.meta.dirname}/triggers.json`;

const skillsDir = `${import.meta.dirname}/../../agent/skills`;

/** The skills whose description pi shows the model, which are the ones that compete for a prompt. */
const modelSkills = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const dirs = yield* fs.readDirectory(skillsDir);

	const found = yield* Effect.forEach(dirs, (dir) =>
		fs.readFileString(`${skillsDir}/${dir}/SKILL.md`).pipe(
			Effect.flatMap((text) => Schema.decodeUnknownEffect(SkillFrontmatter)(parseFrontmatter(text).frontmatter)),
			Effect.map((fields) =>
				fields["disable-model-invocation"] === true
					? []
					: [{ name: fields.name, description: Str.trim(fields.description) }],
			),
			Effect.catchTag("PlatformError", () => Effect.succeed([])),
		),
	);

	return Arr.flatten(found);
});

test("a prompt ranks the skill whose name and description share its words first", () => {
	const corpus = corpusOf([
		{ name: "release-notes", description: "Write release notes. Use when shipping a version." },
		{ name: "flaky-tests", description: "Find flaky tests. Use when a test fails only sometimes." },
	]);

	const order = Arr.map(rank({ prompt: "this test fails only sometimes", corpus }), ({ name }) => name);

	expect(order).toEqual(["flaky-tests", "release-notes"]);
});

test("every trigger prompt routes to its own skill over every other skill the model sees", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const skills = yield* modelSkills;
			const triggers = yield* Effect.flatMap(fs.readFileString(triggerFile), Schema.decodeEffect(Triggers));
			const names = Arr.map(skills, ({ name }) => name);

			const owners = Arr.flatMap(Record.values(triggers), ({ negative }) =>
				Arr.flatMap(negative, ({ owner }) => (owner === undefined ? [] : [owner])),
			);

			const named = Arr.dedupe([...Record.keys(triggers), ...owners]);

			expect(Arr.difference(named, names)).toEqual([]);
			expect(routingFailures({ corpus: corpusOf(skills), triggers })).toEqual([]);
		}).pipe(Effect.provide(NodeServices.layer)),
	));

test("no two descriptions the model sees read alike", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const skills = yield* modelSkills;

			expect(collisions(corpusOf(skills))).toEqual([]);
		}).pipe(Effect.provide(NodeServices.layer)),
	));
