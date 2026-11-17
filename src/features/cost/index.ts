import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { labelTerminal, TerminalAddress } from "#src/client/hc/index.ts";
import { piHost } from "#src/client/pi-host/index.ts";
import { appendedLines, sessionFileById } from "#src/client/pi-sessions/index.ts";
import { emptyTally, type Started, type Tally, tallyLines } from "./tally.ts";

/** The hc label on a root agent's own terminal that holds its `CostLabel`, which herdr-app's status bar reads. */
export const labelKey = "pi.cost";

const Usd = Schema.Finite;

/** What a root's session has spent at list prices: its own model calls, and each delegate's below it at any level. */
export const CostLabel = Schema.Struct({
	own: Usd,
	delegates: Schema.Array(Schema.Struct({ name: Schema.String, usd: Usd })),
});

export type CostLabel = typeof CostLabel.Type;

const encodeLabel = Schema.encodeEffect(Schema.fromJsonString(CostLabel));

/** A root's own session file, and the folder that holds every delegate's session file below it, at any level. */
export interface TreeFiles {
	readonly root: string;
	readonly delegates: string;
}

/** How far a session file has been read, and what the whole lines up to there add up to. */
interface Followed {
	readonly offset: number;
	readonly tally: Tally;
}

const unread: Followed = { offset: 0, tally: emptyTally };

const usd = (amount: number) => Math.round(amount * 10_000) / 10_000;

/** Finds a delegate's session file by the id in its name, and remembers it, since a delegate never moves its file. */
const locate = Effect.fn("locate")(function* (located: Map<string, string>, dir: string, { id }: Started) {
	const known = located.get(id);

	if (known !== undefined) {
		return Option.some(known);
	}

	const path = yield* sessionFileById({ dir, id });

	if (Option.isSome(path)) {
		located.set(id, path.value);
	}

	return path;
});

/**
 * Reads a root's session tree. A root's session file runs to tens of megabytes, so each read takes only the bytes
 * appended since the last one.
 */
export const treeReader = (files: TreeFiles) => {
	const followed = new Map<string, Followed>();
	const located = new Map<string, string>();

	// A session file appears at its first reply, so one that is not there yet has spent nothing.
	const advance = Effect.fn("advance")(function* (path: string) {
		const before = followed.get(path) ?? unread;
		const appended = yield* appendedLines({ path, offset: before.offset });

		if (Option.isNone(appended)) {
			return emptyTally;
		}

		const { replaced, text, offset } = appended.value;
		const next: Followed = { offset, tally: tallyLines({ tally: replaced ? emptyTally : before.tally, text }) };

		followed.set(path, next);

		return next.tally;
	});

	/** Each delegate, then the ones it started, in the order they started. */
	const spentBelow = (
		started: ReadonlyArray<Started>,
	): Effect.Effect<CostLabel["delegates"], PlatformError.PlatformError, Effect.Services<ReturnType<typeof locate>>> =>
		Effect.map(
			Effect.forEach(started, (delegate) =>
				Effect.gen(function* () {
					const path = yield* locate(located, files.delegates, delegate);
					const tally = Option.isSome(path) ? yield* advance(path.value) : emptyTally;
					const below = yield* spentBelow(tally.started);

					return [{ name: delegate.name, usd: usd(tally.usd) }, ...below];
				}),
			),
			Arr.flatten,
		);

	const read = Effect.gen(function* () {
		const own = yield* advance(files.root);
		const delegates = yield* spentBelow(own.started);

		return { own: usd(own.usd), delegates } satisfies CostLabel;
	});

	return { read };
};

const ownTerminal = Effect.map(Effect.option(Config.String("HC_TERMINAL_ID")), Option.map(TerminalAddress));

/**
 * Rereads the tree every two seconds, since a delegate's spend lands in its own file, which pi sends no event for, and
 * removes the label when interrupted.
 */
const publish = (files: TreeFiles, terminal: TerminalAddress) => {
	const reader = treeReader(files);
	let published = "";

	const refresh = Effect.gen(function* () {
		const label = yield* reader.read;
		const text = yield* encodeLabel(label);

		if (text !== published) {
			yield* labelTerminal({ terminal, labels: { [labelKey]: text } });
			published = text;
		}
	});

	const clear = Effect.ignore(labelTerminal({ terminal, labels: { [labelKey]: "" } }), { log: "Warn" });

	return refresh.pipe(
		Effect.ignore({ log: "Warn" }),
		Effect.repeat(Schedule.spaced("2 seconds")),
		Effect.ensuring(clear),
	);
};

/**
 * Keeps the `pi.cost` label on a root agent's hc terminal equal to what its session tree has spent at list prices, and
 * removes it when the session ends. Delegates never load it: their spend reaches the root's label through their files.
 * Outside herdr-core, or without a session file, it does nothing.
 */
export const cost = (pi: Pick<ExtensionAPI, "on">) => {
	const host = piHost(NodeServices.layer);
	let running: Option.Option<Fiber.Fiber<unknown>> = Option.none();

	pi.on("session_start", (_event, ctx) => {
		const root = ctx.sessionManager.getSessionFile();

		if (root === undefined) {
			return;
		}

		// Where owned-work puts a root's delegates, at every level (`delegatesDirOf`).
		const files = { root, delegates: `${ctx.sessionManager.getSessionDir()}/delegates` };

		const start = Effect.flatMap(
			ownTerminal,
			Option.match({ onNone: () => Effect.void, onSome: (terminal) => publish(files, terminal) }),
		);

		const fiber = host.fork(start);

		running = Option.some(fiber);
	});

	pi.on("session_shutdown", () => {
		const fiber = running;

		running = Option.none();

		return Option.match(fiber, {
			onNone: () => Promise.resolve(),
			onSome: (started) => host.run(Fiber.interrupt(started)),
		});
	});
};
