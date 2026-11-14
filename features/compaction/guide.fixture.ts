import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Random from "effect/Random";
import * as Str from "effect/String";

export const markerOf = (name: string) =>
	Effect.map(Random.nextIntBetween(1_000_000_000, 9_000_000_000), (value) => `${name}-${value.toString(36)}`);

export const guideLines = (name: string) =>
	Arr.makeBy(20, (at) => `Line ${String(at)} of the ${name} test principle, which marks it in context.`);

export const guideText = ({ name, lines }: { readonly name: string; readonly lines: ReadonlyArray<string> }) =>
	`---\nwhen: Never. This principle exists only for a compaction test.\n---\n\n# ${name}\n\n${Arr.join(lines, "\n")}\n`;

export const plantInWorktree = ({
	run,
	name,
	lines,
}: {
	readonly run: { readonly agentDir: string; readonly home: string };
	readonly name: string;
	readonly lines: ReadonlyArray<string>;
}) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) => {
		const file = `${run.agentDir}/principles/${name}.md`;

		return Effect.acquireRelease(fs.writeFileString(file, guideText({ name, lines })), () =>
			Effect.ignore(fs.remove(file)),
		).pipe(Effect.as({ file, seen: `${run.home}/.pi/agent/principles/${name}.md` }));
	});

export const restores = ({
	summary,
	path,
	marker,
}: {
	readonly summary: string;
	readonly path: string;
	readonly marker: string;
}) => Str.includes(`<guide path="${path}">`)(summary) && Str.includes(marker)(summary);

export const denseFiller = ({ seed, words }: { readonly seed: string; readonly words: number }) =>
	Arr.join(
		Arr.makeBy(words, (index) => `${seed}${index.toString(36)}`),
		" ",
	);
