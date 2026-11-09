import { uuidv7 } from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PiCli, piCliLayer } from "../../clients/pi-cli/index.ts";
import { childExtensions, inheritedEnv, launch } from "./child.ts";
import { type Entry, harnessFolder, loadRegistry } from "./delegates.ts";

/** One harness delegate as the root would start it, minus the systemd scope and hc terminal around it. */
export interface StagedLaunch {
	readonly name: string;
	readonly role: "owner" | "leaf";
	readonly argv: ReadonlyArray<string>;
	readonly env: Readonly<Record<string, string>>;
}

/**
 * Stages every harness delegate on `message` with the same `launch` the ledger uses, so a tool can run one and see
 * exactly what it receives. The staged files live in `dir` until the caller's scope closes.
 */
export const stagedLaunches = Effect.fn("stagedLaunches")(function* (cwd: string, dir: string, message: string) {
	const registry = yield* loadRegistry({
		folders: { harness: harnessFolder, project: undefined },
		hasModel: () => true,
	});

	const services = yield* Layer.build(piCliLayer(childExtensions));
	const cli = Context.get(services, PiCli);

	const stage = (entry: Entry) =>
		Effect.map(
			launch(cli)({
				entry,
				message,
				ref: "delegate-1",
				agentKey: "prompts",
				childSession: { cwd, dir: `${dir}/${entry.name}`, id: uuidv7() },
				passEnv: inheritedEnv(process.env),
			}),
			// In a real launch the systemd client's `wrap` sets the slice. A child without one fails to start.
			(spec): StagedLaunch => ({
				name: entry.name,
				role: entry.config.role,
				argv: spec.argv,
				env: { ...spec.env, PI_OWNED_WORK_SLICE: `pi-ow-prompts-${entry.name}` },
			}),
		);

	const launches = yield* Effect.forEach(Arr.fromIterable(registry.entries.values()), stage);

	return { launches, rejected: registry.rejected };
});
