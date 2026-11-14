import { afterAll, expect, test } from "bun:test";

import { SessionManager, type ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Str from "effect/String";

import { entryKind, finishCall, lastFolder, type Watched, watchCall } from "./index.ts";

const home = `${Bun.env["TMPDIR"] ?? "/tmp"}/state-folder-test-${String(process.pid)}`;
const folder = (work: string) => `${home}/.local/state/pi-agent/pi/${work}`;
const logScript = `${import.meta.dir}/../../agent/skills/show-me-your-work/scripts/log.sh`;

/** A tool call: its arguments as the JSON text the extension scans, and what running it did to the disk. */
interface Call {
	readonly input: string;
	readonly run: Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>;
}

const write = (path: string, text: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		yield* fs.writeFileString(path, text);
	});

const read = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		yield* fs.readFileString(path);
	});

const bash = (command: string) =>
	Effect.asVoid(Effect.promise(() => Bun.$`bash -c ${command}`.env({ ...Bun.env, HOME: home }).quiet()));

/** Runs a call as the extension watches it, with a result whose own text is "ran" and whose own structuredContent is set. */
const finish = Effect.fn("finish")(function* (watched: Watched, toolCallId: string, call: Call) {
	yield* watchCall(watched, { home, toolCallId, input: call.input });
	yield* call.run;

	const result = { toolCallId, content: [{ type: "text" as const, text: "ran" }], structuredContent: { ran: true } };

	return yield* finishCall(watched, { result });
});

/** The state folder a session resolves to after these calls, as the extension watches them one by one. */
const resolve = Effect.fn("resolve")(function* (calls: ReadonlyArray<Call>) {
	const watched: Watched = new Map();
	let last = Option.none<string>();

	for (const [index, call] of calls.entries()) {
		const { wrote } = yield* finish(watched, String(index), call);

		if (Option.isSome(wrote)) {
			last = wrote;
		}
	}

	return last;
});

const runTest = <Value, Failure>(effect: Effect.Effect<Value, Failure, FileSystem.FileSystem>) =>
	Effect.runPromise(Effect.provide(effect, NodeServices.layer));

await runTest(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		for (const work of ["alpha", "beta", "gamma", "delta", "epsilon"]) {
			yield* fs.makeDirectory(folder(work), { recursive: true });
			yield* fs.writeFileString(`${folder(work)}/STATE.md`, `# ${work}\n`);
		}

		yield* fs.writeFileString(`${folder("delta")}/STATE.md`, `# delta\n${Str.repeat(20_000)("x")}\n`);
	}),
);

const writeState = (work: string): Call => ({
	input: `{"path":"${folder(work)}/STATE.md","content":"# updated"}`,
	run: write(`${folder(work)}/STATE.md`, "# updated\n"),
});

const writeFile = (path: string, text: string): Call => ({ input: `{"path":"${path}"}`, run: write(path, text) });

const runBash = (command: string): Call => ({ input: `{"command":"${command}"}`, run: bash(command) });

const readState = (work: string): Call => ({
	input: `{"command":"cat ${folder(work)}/STATE.md"}`,
	run: read(`${folder(work)}/STATE.md`),
});

test("a write names the folder, and a later read of another work's folder does not move it", () =>
	runTest(
		Effect.gen(function* () {
			const resolved = yield* resolve([writeState("alpha"), readState("beta")]);

			expect(resolved).toEqual(Option.some(folder("alpha")));
		}),
	));

test("a session that only reads state folders has none", () =>
	runTest(
		Effect.gen(function* () {
			const resolved = yield* resolve([readState("alpha")]);

			expect(resolved).toEqual(Option.none());
		}),
	));

test("a bash call that appends a decision through log.sh, with the folder written as ~, moves to that folder", () =>
	runTest(
		Effect.gen(function* () {
			const command = `${logScript} ~/.local/state/pi-agent/pi/beta/decisions.tsv frame "picked a label" simplest none open`;
			const append: Call = { input: `{"command":"${command}"}`, run: bash(command) };

			const resolved = yield* resolve([writeState("alpha"), append]);

			expect(resolved).toEqual(Option.some(folder("beta")));
		}),
	));

test("a codemode script that writes a file in a folder it names moves to that folder", () =>
	runTest(
		Effect.gen(function* () {
			const path = `${folder("gamma")}/TODO.md`;
			const code = `const state = await tools.read({ path: '${folder("alpha")}/STATE.md' });\\nawait tools.write({ path: '${path}', content: '# Todo' });`;
			const script: Call = { input: `{"code":"${code}"}`, run: write(path, "# Todo\n") };

			const resolved = yield* resolve([writeState("beta"), script]);

			expect(resolved).toEqual(Option.some(folder("gamma")));
		}),
	));

test("a resumed session takes the last folder its branch recorded, and a /tree move back takes the one before", () => {
	const session = SessionManager.inMemory();
	const first = session.appendCustomEntry(entryKind, { folder: folder("alpha") });

	session.appendCustomEntry(entryKind, { folder: folder("beta") });

	const resumed = lastFolder(session.getBranch());

	session.branch(first);

	expect({ resumed, afterTree: lastFolder(session.getBranch()), empty: lastFolder([]) }).toEqual({
		resumed: Option.some(folder("beta")),
		afterTree: Option.some(folder("alpha")),
		empty: Option.none(),
	});
});

const textsOf = (checked: Option.Option<ToolResultEventResult>) => {
	const result = Option.getOrThrow(checked);

	expect(result.isError).toBe(true);
	expect(result).not.toHaveProperty("structuredContent");

	return Arr.map(result.content ?? [], (part) => (part.type === "text" ? part.text : ""));
};

const writeActionItems = Effect.fn("writeActionItems")(function* (work: string, text: string) {
	const path = `${folder(work)}/USER_ACTION_ITEMS.md`;
	const { checked } = yield* finish(new Map(), "0", writeFile(path, text));

	return checked;
});

test("a write of USER_ACTION_ITEMS.md with an item that bullets its labels comes back as an error naming each line", () =>
	runTest(
		Effect.gen(function* () {
			const checked = yield* writeActionItems(
				"alpha",
				`# Needs\n\n## Merge PR 3\n- **The call.** Merge it.\n**My pick.** Merge.\n**What it changes.** Ships.\n**Evidence.** Green.\n**Risk.** Low.\n`,
			);

			const texts = textsOf(checked);

			expect(texts).toHaveLength(2);
			expect(texts[0]).toBe("ran");
			expect(texts[1]).toContain("line 4: ");
		}),
	));

test("a write of a valid USER_ACTION_ITEMS.md leaves the result as it was", () =>
	runTest(
		Effect.gen(function* () {
			const checked = yield* writeActionItems(
				"beta",
				`# Needs\n\n## Merge PR 3\n**The call.** Merge it.\n**My pick.** Merge.\n**What it changes.** Ships.\n**Evidence.** Green.\n**Risk.** Low.\n`,
			);

			expect(checked).toEqual(Option.none());
		}),
	));

test("a call that names another file in a folder whose USER_ACTION_ITEMS.md is broken leaves the result as it was", () =>
	runTest(
		Effect.gen(function* () {
			yield* write(`${folder("gamma")}/USER_ACTION_ITEMS.md`, "# Needs\n\n- **The call.** Merge it.\n");

			const command = `cp ${folder("beta")}/STATE.md ${folder("gamma")}/STATE.md`;
			const { checked } = yield* finish(new Map(), "0", runBash(command));

			expect(checked).toEqual(Option.none());
		}),
	));

test("a read of a 20 KB STATE.md leaves the result as it was and does not move the folder", () =>
	runTest(
		Effect.gen(function* () {
			const finished = yield* finish(new Map(), "0", readState("delta"));

			expect(finished).toEqual({ wrote: Option.none(), checked: Option.none() });
		}),
	));

test("a write of TODO.md in a folder whose STATE.md is over the cap leaves the result as it was", () =>
	runTest(
		Effect.gen(function* () {
			const path = `${folder("delta")}/TODO.md`;
			const finished = yield* finish(new Map(), "0", writeFile(path, "# Todo\n"));

			expect(finished).toEqual({ wrote: Option.some(folder("delta")), checked: Option.none() });
		}),
	));

test("a bash heredoc that grows STATE.md past the cap comes back as an error naming the cap and the decision trail", () =>
	runTest(
		Effect.gen(function* () {
			const command = `cat > ${folder("epsilon")}/STATE.md <<EOF\n# epsilon\n${Str.repeat(17_000)("x")}\nEOF`;
			const { checked } = yield* finish(new Map(), "0", runBash(command));

			const texts = textsOf(checked);

			expect(texts[1]).toContain("16,384");
			expect(texts[1]).toContain("decisions.tsv");
		}),
	));

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${home}`.quiet())));
