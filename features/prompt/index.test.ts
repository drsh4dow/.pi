import { afterAll, expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";

import type { Role } from "../owned-work/index.ts";
import { layersOf } from "./index.ts";

const agentDir = `${Bun.env["TMPDIR"] ?? "/tmp"}/prompt-layers-test-${String(process.pid)}`;

const files = {
	"roles/root.md": "<role>\nroot\n</role>",
	"roles/owner.md": "<role>\nowner\n</role>",
	"roles/leaf.md": "<role>\nleaf\n</role>",
	"principles/fix-root-causes.md": "---\nwhen: Debugging.\n---\nBody.",
	"playbooks/feature.md": "---\nwhen: Building.\n---\nBody.",
	"playbooks/review-lane.md": "---\nwhen: Reviewing one lane.\nfor: [leaf]\n---\nBody.",
};

await Promise.all(Arr.map(Rec.toEntries(files), ([file, text]) => Bun.write(`${agentDir}/${file}`, text)));

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${agentDir}`.quiet())));

const principles = Option.some(
	`<principles dir="${agentDir}/principles">\n- fix-root-causes: Debugging.\n</principles>`,
);

const playbooksFor = (line: string) => Option.some(`<playbooks dir="${agentDir}/playbooks">\n${line}\n</playbooks>`);

const rows: ReadonlyArray<{ role: Role; playbooks: Option.Option<string> }> = [
	{ role: "root", playbooks: playbooksFor("- feature: Building.") },
	{ role: "owner", playbooks: playbooksFor("- feature: Building.") },
	{ role: "leaf", playbooks: playbooksFor("- review-lane: Reviewing one lane.") },
];

for (const row of rows) {
	test(`a ${row.role} reads its own role file, every principle, and only the playbooks that fit it`, () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const { layers, problems } = yield* layersOf(agentDir, row.role, Option.none(), []);

				expect({ role: layers.role, principles: layers.principles, playbooks: layers.playbooks, problems }).toEqual(
					{
						role: `<role>\n${row.role}\n</role>`,
						principles,
						playbooks: row.playbooks,
						problems: [],
					},
				);
			}).pipe(Effect.provide(NodeServices.layer)),
		));
}
