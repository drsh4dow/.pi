import { expect, test } from "bun:test";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

const promptsDir = `${import.meta.dirname}/../../agent/prompts`;

/** The only keys pi reads from a prompt template; an argument hint is required because every template takes one. */
const TemplateFrontmatter = Schema.Struct({ description: Schema.String, "argument-hint": Schema.String });

const decodeFrontmatter = Schema.decodeUnknownEffect(TemplateFrontmatter, { onExcessProperty: "error" });

/** The placeholders pi substitutes, from its prompt-templates docs. Pi appends nothing on its own, so a template without one drops what the user typed. */
const placeholder = /\$\{(?:\d+|@|ARGUMENTS)(?::[^}]*)?\}|\$(?:ARGUMENTS|@|\d+)/u;

test("every prompt template declares its argument and uses what the user types after the command", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const listed = yield* fs.readDirectory(promptsDir);
			const files = Arr.filter(listed, Str.endsWith(".md"));

			const problems = yield* Effect.forEach(files, (file) =>
				Effect.gen(function* () {
					const text = yield* fs.readFileString(`${promptsDir}/${file}`);
					const { frontmatter, body } = parseFrontmatter(text);

					const badFrontmatter = yield* decodeFrontmatter(frontmatter).pipe(
						Effect.match({ onFailure: (error) => [`${file}: ${String(error)}`], onSuccess: () => [] }),
					);

					const dropsArguments = placeholder.test(body) ? [] : [`${file}: no argument placeholder`];

					return [...badFrontmatter, ...dropsArguments];
				}),
			);

			expect(Arr.isReadonlyArrayNonEmpty(files)).toBe(true);
			expect(Arr.flatten(problems)).toEqual([]);
		}).pipe(Effect.provide(NodeServices.layer)),
	));
