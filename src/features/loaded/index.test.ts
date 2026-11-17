import { afterAll, expect, test } from "bun:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { guideFilesIn, inContext, loadGuides } from "./index.ts";

const scratch = `${Bun.env["TMPDIR"] ?? "/tmp"}/loaded-test-${String(process.pid)}`;

const lines = (name: string) =>
	Arr.join(
		Arr.makeBy(10, (line) => `Line ${String(line)} of the ${name} file, long enough to mark it.`),
		"\n",
	);

const playbook = `---\nwhen: Fixing a bug.\n---\n\n# Bug fix\n\n${lines("bug-fix")}\n`;
const notes = lines("notes");

/** A playbooks folder with one playbook and a reference file in its subfolder. There is no principles folder. */
const playbooksFolder = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const dir = `${scratch}/playbooks`;

	yield* fs.makeDirectory(`${dir}/bug-fix`, { recursive: true });
	yield* fs.writeFileString(`${dir}/bug-fix.md`, playbook);
	yield* fs.writeFileString(`${dir}/bug-fix/notes.md`, notes);

	return dir;
});

/** A session whose model has read each text whole. */
const sessionReading = (texts: ReadonlyArray<string>) => {
	const session = SessionManager.inMemory();

	for (const text of texts) {
		session.appendMessage({
			role: "toolResult",
			toolCallId: "call",
			toolName: "read",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 0,
		});
	}

	return session;
};

test("a playbook read whole is in context as a playbook, and a reference file in its subfolder is no guide", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const dir = yield* playbooksFolder;
			const playbooks = yield* guideFilesIn("playbook", dir);
			const principles = yield* guideFilesIn("principle", `${scratch}/principles`);
			const index = yield* loadGuides([...principles, ...playbooks]);
			const { entries } = sessionReading([playbook, notes]).buildSessionProjection();
			const loaded = inContext({ index, entries });

			expect(Arr.map(loaded, ({ kind, name, state }) => ({ kind, name, state }))).toEqual([
				{ kind: "playbook", name: "bug-fix", state: "full" },
			]);
		}).pipe(Effect.provide(NodeServices.layer)),
	));

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${scratch}`.quiet())));
