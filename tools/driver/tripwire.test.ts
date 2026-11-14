import { expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Order from "effect/Order";
import * as Str from "effect/String";

import { strayed } from "./tripwire.ts";

const run = "leak-20260514-101010-42";
const core = "pi-driver-42-0abc12";

/** Files a leaked run and another session leave under a home, by path from the home. */
const written = [
	`.pi/agent/sessions/--tmp-pi-driver-${run}-${run}--/s.jsonl`,
	".pi/agent/sessions/--home-u-work--/other.jsonl",
	`.local/state/herdr-core/${core}/core.json`,
	`.local/state/pi-agent/${run}/work/STATE.md`,
	".local/state/pi-agent/work/run/STATE.md",
	".local/state/herdr-core/default/terminals.json",
];

const leaked = [
	`.local/state/herdr-core/${core}`,
	`.local/state/pi-agent/${run}`,
	`.pi/agent/sessions/--tmp-pi-driver-${run}-${run}--`,
];

/** Writes `written` under `root`, whose `.local/state` is a link to a folder outside it when `linked`. */
const homeIn = (root: string, linked: boolean) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const state = linked ? `${root}/elsewhere` : `${root}/home/.local/state`;

		yield* fs.makeDirectory(`${root}/home/.local`, { recursive: true });
		yield* fs.makeDirectory(state, { recursive: true });
		yield* linked ? fs.symlink(state, `${root}/home/.local/state`) : Effect.void;
		yield* Effect.forEach(written, (file) =>
			Effect.andThen(
				fs.makeDirectory(`${root}/home/${Str.replace(/\/[^/]+$/u, "")(file)}`, { recursive: true }),
				fs.writeFileString(`${root}/home/${file}`, "x"),
			),
		);

		return `${root}/home`;
	});

for (const linked of [false, true]) {
	test(`strayed: names exactly what the run's names name${linked ? ", under a linked state folder" : ""}`, () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const root = yield* fs.makeTempDirectoryScoped({ directory: "/tmp" });
				const home = yield* homeIn(root, linked);
				const found = yield* strayed({ home, names: [run, core] });
				const relative = Arr.map(found, Str.slice(home.length + 1));

				expect(Arr.sort(relative, Order.String)).toEqual(leaked);
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		));
}
