import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Rec from "effect/Record";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { Hc, HcError, HcNotice, type RunSpec, TerminalAddress, TerminalEnd } from "../../clients/hc/index.ts";
import { Slices } from "../../clients/systemd/index.ts";
import type { World } from "./world.fixture.ts";

/** Fakes of hc and systemd that record into `world` what the ledger asked of each. */
const hangUp = (terminal: TerminalAddress) =>
	HcNotice.Ended({ terminal, end: TerminalEnd.Exited({ code: Option.none(), signal: Option.some(1) }) });

/** Linux MAX_ARG_STRLEN, which counts the closing NUL: execve fails with E2BIG on a longer argv word. */
const argvWordLimit = 128 * 1024;

const tooLong = (spec: RunSpec) => Arr.some(spec.argv, (word) => Buffer.byteLength(word) >= argvWordLimit);

const failed = (why: string) => HcError.make({ method: "terminal.run", kind: "spawn_failed", message: why });

const shownAs = (what: string, labels: Readonly<Record<string, string>>) => {
	const pairs = Arr.map(Rec.toEntries(labels), Arr.join("="));

	return `${what} (${Arr.join(pairs, ", ")})`;
};

const recordSpawn = (world: Omit<World, "ledger" | "fs">, spec: RunSpec): void => {
	world.slices.add(spec.ref);
	world.spawnLevels.push(`${spec.ref} at level ${spec.env["PI_OWNED_WORK_LEVEL"] ?? "none"}`);
	world.shown.push(shownAs(spec.name, spec.labels));
};

export const hcOf = (world: Omit<World, "ledger" | "fs">) => {
	const spawned = { count: 0 };

	const recorded = (terminal: TerminalAddress) => () => {
		world.kills.push(terminal);
		world.gone.add(terminal);
	};

	const kill = (terminal: TerminalAddress) =>
		Effect.andThen(Effect.sync(recorded(terminal)), Queue.offer(world.notices, hangUp(terminal)));

	const run = Effect.fn("run")(function* (spec: RunSpec) {
		const held = world.spawns.shift();

		if (held !== undefined) {
			yield* Semaphore.take(world.gate, 1);
		}

		if (tooLong(spec)) {
			return yield* failed("E2BIG");
		}

		if (held === "fails") {
			return yield* failed("no such program");
		}

		recordSpawn(world, spec);

		return TerminalAddress(`t${String((spawned.count += 1))}`);
	});

	return Layer.succeed(Hc, {
		run,
		kill,
		label: (terminal, labels) =>
			Effect.sync(() => {
				world.shown.push(shownAs(terminal, labels));
			}),
		waitForOutput: () => Effect.succeed(true),
		tail: () => Effect.succeed("tail"),
		notices: Stream.fromQueue(world.notices),
	});
};

export const slicesOf = (world: Omit<World, "ledger" | "fs">) =>
	Layer.succeed(Slices, {
		wrap: (spec) => spec,
		stop: (ref) =>
			Effect.sync(() => {
				world.slices.delete(ref);
			}),
	});
