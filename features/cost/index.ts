import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { labelTerminal, TerminalAddress } from "../../clients/hc/index.ts";
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

const newline = 10;

const usd = (amount: number) => Math.round(amount * 10_000) / 10_000;

/**
 * Adds the whole lines appended since `before`. The last line may still be half written, so reading stops at the last
 * newline. A file shorter than what was read was replaced, so it is read again from the start.
 */
const readAppended = Effect.fn("readAppended")(function* (path: string, before: Followed) {
	const fs = yield* FileSystem.FileSystem;
	const info = yield* fs.stat(path);
	const size = Number(info.size);
	const from = size < before.offset ? unread : before;

	const bytes = yield* Effect.scoped(
		Effect.flatMap(fs.open(path), (file) => file.readAlloc(size - from.offset, { position: BigInt(from.offset) })),
	);

	const appended = Option.getOrElse(bytes, () => new Uint8Array());
	const end = appended.lastIndexOf(newline) + 1;

	return {
		offset: from.offset + end,
		tally: tallyLines({ tally: from.tally, text: new TextDecoder().decode(appended.subarray(0, end)) }),
	} satisfies Followed;
});

/** Finds a delegate's session file by the id in its name, and remembers it, since a delegate never moves its file. */
const locate = Effect.fn("locate")(function* (located: Map<string, string>, dir: string, { id }: Started) {
	const fs = yield* FileSystem.FileSystem;
	const known = located.get(id);

	if (known !== undefined || !(yield* fs.exists(dir))) {
		return Option.fromUndefinedOr(known);
	}

	const names = yield* fs.readDirectory(dir);
	const path = Option.map(Arr.findFirst(names, Str.endsWith(`_${id}.jsonl`)), (name) => `${dir}/${name}`);

	if (Option.isSome(path)) {
		located.set(id, path.value);
	}

	return path;
});

/**
 * Reads a root's session tree. A root's session file runs to tens of megabytes, so each read takes only the bytes
 * appended since the last one.
 */
export const makeReader = (files: TreeFiles) => {
	const followed = new Map<string, Followed>();
	const located = new Map<string, string>();

	// A session file appears at its first reply, so one that is not there yet has spent nothing.
	const advance = Effect.fn("advance")(function* (path: string) {
		const fs = yield* FileSystem.FileSystem;

		if (!(yield* fs.exists(path))) {
			return emptyTally;
		}

		const next = yield* readAppended(path, followed.get(path) ?? unread);

		followed.set(path, next);

		return next.tally;
	});

	/** Each delegate, then the ones it started, in the order they started. */
	const spentBelow = (
		started: ReadonlyArray<Started>,
	): Effect.Effect<CostLabel["delegates"], PlatformError.PlatformError, FileSystem.FileSystem> =>
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
	const reader = makeReader(files);
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

		const fiber = start.pipe(Effect.provide(NodeServices.layer), Effect.runFork);

		running = Option.some(fiber);
	});

	pi.on("session_shutdown", () => {
		const fiber = running;

		running = Option.none();

		return Option.match(fiber, {
			onNone: () => Promise.resolve(),
			onSome: (started) => Fiber.interrupt(started).pipe(Effect.runPromise),
		});
	});
};
