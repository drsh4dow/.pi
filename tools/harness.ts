/** What this checkout ships into an agent folder, shared by every tool that runs pi on it. */
import * as Arr from "effect/Array";
import * as Str from "effect/String";

/** The `agent/` entries `.gitignore` lets this repo ship. */
export const harnessEntries = (gitignore: string): ReadonlyArray<string> =>
	Arr.flatMap(Str.split(gitignore, "\n"), (line) => {
		const shipped = /^!\/agent\/(?<entry>[^/]+)\/?$/u.exec(line)?.groups?.["entry"];

		return shipped === undefined ? [] : [shipped];
	});

const isPackageBin = (folder: string) => /\/node_modules\/\.bin\/?$/u.test(folder);

/** `env` without `node_modules/.bin` folders in PATH: `bun run` puts them first, which would run this repo's dev pi. */
export const withoutPackageBins = (env: Readonly<Record<string, string>>) => ({
	...env,
	PATH: Arr.join(
		Arr.filter(Str.split(env["PATH"] ?? "", ":"), (folder) => !isPackageBin(folder)),
		":",
	),
});
