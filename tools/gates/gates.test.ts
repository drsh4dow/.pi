import { afterAll, expect, test } from "bun:test";

import * as Effect from "effect/Effect";

const repo = `${import.meta.dirname}/../..`;
const bin = `${repo}/node_modules/.bin`;
const scratch = `${Bun.env["TMPDIR"] ?? "/tmp"}/gates-test-${process.pid}`;

const copyOf = (fixture: string, gate: string): Effect.Effect<string> =>
	Effect.gen(function* () {
		const dir = `${scratch}/${gate}`;

		yield* Effect.promise(() => Bun.$`mkdir -p ${dir} && cp -r ${import.meta.dirname}/fixtures/${fixture}/. ${dir}`);
		yield* Effect.promise(
			() => Bun.$`ln -s ${repo}/node_modules ${dir}/node_modules && cp ${repo}/tsconfig.json ${dir}/`,
		);
		yield* Effect.promise(() =>
			Bun.write(`${dir}/package.json`, `{ "type": "module", "imports": { "#src/*": "./src/*" } }\n`),
		);
		yield* Effect.promise(() => Bun.write(`${dir}/.oxlintrc.json`, `{ "extends": ["${repo}/.oxlintrc.jsonc"] }\n`));

		return dir;
	});

const run = (cwd: string, command: ReadonlyArray<string>): Effect.Effect<{ code: number; output: string }> =>
	Effect.gen(function* () {
		const child = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "pipe" });

		const [stdout, stderr, code] = yield* Effect.promise(() =>
			Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
		);

		return { code, output: stdout + stderr };
	});

const failsWith = (
	fixture: string,
	name: string,
	command: ReadonlyArray<string>,
	messages: ReadonlyArray<string>,
): Promise<void> =>
	Effect.runPromise(
		Effect.gen(function* () {
			const dir = yield* copyOf(fixture, name);
			const { code, output } = yield* run(dir, command);

			expect(code).not.toBe(0);

			for (const message of messages) {
				expect(output).toContain(message);
			}
		}),
	);

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${scratch}`)));

test("the boundary gate rejects a client that imports a type from a feature", () =>
	failsWith(
		"boundaries",
		"boundaries",
		[`${bin}/depcruise`, "src", "--config", `${repo}/.dependency-cruiser.json`, "--output-type", "err-long"],
		["error client-imports: src/client/leaky/index.ts → src/features/sample/index.ts"],
	));

test("the bans reject an Effect runner, a disk import and Bun.env in a feature, and a fixed sleep in test code", () =>
	failsWith(
		"bans",
		"oxlint-bans",
		[`${bin}/oxlint`, "src"],
		[
			"hand it to run or fork from #src/client/pi-host/index.ts",
			"Read and write disk through the src/client/ folder that owns the file",
			"call eventually from #src/primitives/eventually.ts",
			"Read the environment in the entry file and pass it in",
		],
	));

test("the delegate model ban rejects a registry lookup in owned-work outside models.ts", () =>
	failsWith(
		"bans",
		"ast-grep-bans",
		[`${bin}/ast-grep`, "scan", "--config", `${repo}/sgconfig.yml`, "src"],
		["Call modelOf from src/features/owned-work/models.ts"],
	));

test("the ast-grep checks reject a comment, a suppression, a dynamic import and a relative import without .ts", () =>
	failsWith(
		"comments",
		"comments",
		[`${bin}/ast-grep`, "scan", "--config", `${repo}/sgconfig.yml`, "src"],
		[
			"Delete this comment.",
			"Fix the code the rule caught.",
			"Import at the top of the file",
			"End a relative import in .ts",
		],
	));
