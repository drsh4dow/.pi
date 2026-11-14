import { afterAll, test } from "bun:test";

import * as Effect from "effect/Effect";

import { Design } from "../../clients/pi-cli/index.ts";
import { type BriefRow, handed, refused, runBriefRow } from "./brief.fixture.ts";
import { designChoice } from "./brief.ts";

const folder = `${Bun.env["TMPDIR"] ?? "/tmp"}/owned-work-design-test-${String(process.pid)}`;

await Promise.all([
	Bun.write(`${folder}/sketch.md`, "# Retry cap\n\n## Synthesis decision\n\nBase: one.\n"),
	Bun.write(
		`${folder}/draft.md`,
		"# Retry cap\n\nNo decision yet. A later ## Synthesis decision heading goes here.\n",
	),
]);

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${folder}`.quiet())));

const designRows: ReadonlyArray<BriefRow> = [
	{
		name: "an owner call that names no design is a tool error that offers a sketch path or yours, and starts nothing",
		call: { name: "m", message: "m", role: "owner", model: "quick" },
		expect: refused(`name a \`design\` for an owner: ${designChoice}`),
	},
	{
		name: "an owner handed a sketch that holds its synthesis decision builds to it, resolved against the caller's folder",
		call: { name: "m", message: "m", role: "owner", model: "quick", design: "sketch.md" },
		caller: { cwd: folder },
		expect: handed({ role: "owner", design: Design.cases.Sketch.make({ path: `${folder}/sketch.md` }) }),
	},
	{
		name: "a design sketch that does not exist is a tool error",
		call: { name: "m", message: "m", role: "owner", model: "quick", design: `${folder}/missing.md` },
		expect: refused(`cannot read design sketch ${folder}/missing.md: NotFound`),
	},
	{
		name: "a design sketch without a synthesis decision is a tool error",
		call: { name: "m", message: "m", role: "owner", model: "quick", design: `${folder}/draft.md` },
		expect: refused(`design sketch ${folder}/draft.md holds no \`## Synthesis decision\`: name ${designChoice}`),
	},
	{
		name: "a leaf call that names a design is a tool error",
		call: { name: "m", message: "m", role: "leaf", model: "quick", design: "yours" },
		expect: refused("a leaf takes no `design`: leave it out, or start an owner"),
	},
];

for (const row of designRows) {
	test(row.name, () => runBriefRow(row));
}
