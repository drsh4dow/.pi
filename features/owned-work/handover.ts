import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hash from "effect/Hash";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { PiCli } from "../../clients/pi-cli/index.ts";
import { Slices, stopRoot } from "../../clients/systemd/index.ts";
import { Ledger } from "./ledger.ts";
import type { LedgerState } from "./step.ts";

/** Names a pi's terminals in hc and its slice in systemd, and stamps the code that laid out its ledger state. */
export interface Lineage {
	readonly agentKey: string;
	readonly stamp: number;
}

/** What one load of this extension hands the next when pi reloads in the same process, so its work keeps running. */
export interface Handover extends Lineage {
	readonly state: LedgerState;
}

declare global {
	var piOwnedWorkHandover: Handover | undefined;
}

/**
 * A hash of the files that lay out `LedgerState`. A reload that changed them would read state written by other code, so
 * it stops the old work instead. An unreadable file gives a stamp no other load shares.
 */
export const ledgerStamp = Effect.flatMap(FileSystem.FileSystem, (fs) =>
	Effect.forEach(["work.ts", "step.ts"], (file) => fs.readFileString(`${import.meta.dirname}/${file}`)).pipe(
		Effect.map((texts) => Hash.string(Arr.join(texts, "\n"))),
		Effect.orElseSucceed(() => Hash.string(uuidv7())),
	),
);

/** Empties the slot, so a handover reaches at most the one session start after it. */
export const take = (): Option.Option<Handover> => {
	const found = Option.fromUndefinedOr(globalThis.piOwnedWorkHandover);

	globalThis.piOwnedWorkHandover = undefined;

	return found;
};

/** What a session start takes from the load before it. `agentKey` is the key this load runs under. */
export type Inheritance = Data.TaggedEnum<{
	/** Nothing was handed over, or this start is not a reload. */
	Fresh: { readonly agentKey: string };
	/** The work keeps running, under the same agent key and slice. */
	Carried: { readonly agentKey: string; readonly state: LedgerState };
	/** The reload changed the ledger's layout, so the old work, under `stale`, has to stop. */
	Stale: { readonly agentKey: string; readonly stale: string };
}>;

export const Inheritance = Data.taggedEnum<Inheritance>();

export const newAgentKey = (): string => Str.takeRight(uuidv7(), 8);

const ownedScope = /\/(?<unit>pi-ow-[^/\n]+)\.scope$/mu;

/**
 * Names a root's slice from its `/proc/self/cgroup`. A root that runs inside owned work, such as a `pi -p` that a watch
 * started with a scrubbed env, nests its slice in that work's, so stopping the work stops the root's delegates too.
 */
export const rootSliceOf =
	(cgroup: string) =>
	(agentKey: string): string =>
		Option.match(Option.fromNullishOr(ownedScope.exec(cgroup)?.groups?.["unit"]), {
			onNone: () => `pi-ow-${agentKey}`,
			onSome: (unit) => `${unit}-${agentKey}`,
		});

/** This process's root slice names. Off Linux there is no cgroup to read, and a root gets a slice of its own. */
export const rootSlices = Effect.flatMap(FileSystem.FileSystem, (fs) =>
	Effect.map(
		Effect.orElseSucceed(fs.readFileString("/proc/self/cgroup"), () => ""),
		rootSliceOf,
	),
);

export const inheritanceOf =
	({ stamp, agentKey }: Lineage) =>
	(reason: SessionStartEvent["reason"], handover: Option.Option<Handover>): Inheritance =>
		Option.match(
			Option.filter(handover, () => reason === "reload"),
			{
				onNone: () => Inheritance.Fresh({ agentKey }),
				onSome: (handed) =>
					handed.stamp === stamp
						? Inheritance.Carried({ agentKey: handed.agentKey, state: handed.state })
						: Inheritance.Stale({ agentKey, stale: handed.agentKey }),
			},
		);

export const stateOf = (inheritance: Inheritance): Option.Option<LedgerState> =>
	Inheritance.$is("Carried")(inheritance) ? Option.some(inheritance.state) : Option.none();

/** A reload that changed the ledger's layout cannot take the old work over, so it stops it, as a session switch would. */
export const stopStale =
	({ ui, sliceOf }: { readonly ui: ExtensionContext["ui"]; readonly sliceOf: (agentKey: string) => string }) =>
	(inheritance: Inheritance) =>
		Inheritance.$is("Stale")(inheritance)
			? Effect.andThen(
					stopRoot(sliceOf(inheritance.stale)),
					Effect.sync(() => {
						ui.notify(
							"This reload changed owned-work's ledger, so the work the last load started was stopped.",
							"warning",
						);
					}),
				)
			: Effect.void;

/** A reload hands the ledger's state to the next load, and the work keeps running. Anything else that ends the session stops it. */
const handOver = (lineage: Lineage) =>
	Effect.gen(function* () {
		const state = yield* Effect.flatMap(Ledger, (ledger) => ledger.freeze);

		yield* Effect.flatMap(PiCli, (cli) => cli.release);
		globalThis.piOwnedWorkHandover = { ...lineage, state };
	});

export const leave =
	(lineage: Lineage) =>
	({ reason }: SessionShutdownEvent) =>
		reason === "reload" ? handOver(lineage) : Effect.flatMap(Slices, (slices) => slices.stopAll);
