import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";

type Event = Data.TaggedEnum<{
	Output: { readonly bytes: Uint8Array; readonly at: number };
	Tick: { readonly at: number };
}>;

const Event = Data.taggedEnum<Event>();

interface Pane {
	readonly startedAt: number;
	readonly lastOutputAt: number;
	readonly atLineStart: boolean;
	readonly beats: number;
}

const newline = 10;

const quietBefore = (beats: number): Duration.Duration => Duration.seconds([30, 60, 120][beats] ?? 300 * (beats - 2));

const twoDigits = (value: number) => Str.padStart(2, "0")(String(value));

const spanOf = (millis: number): string => {
	const seconds = Math.floor(millis / 1000);

	if (seconds < 60) {
		return `${String(seconds)}s`;
	}

	if (seconds < 3600) {
		return `${String(Math.floor(seconds / 60))}m${twoDigits(seconds % 60)}s`;
	}

	return `${String(Math.floor(seconds / 3600))}h${twoDigits(Math.floor(seconds / 60) % 60)}m`;
};

const heartbeatLine = /^⋯ still running after \w+, quiet for \w+$/u;

export const isHeartbeat = (line: string): boolean => heartbeatLine.test(line);

const heartbeatOf = (pane: Pane, now: number) =>
	`⋯ still running after ${spanOf(now - pane.startedAt)}, quiet for ${spanOf(now - pane.lastOutputAt)}\n`;

type Emitted = readonly [Pane, ReadonlyArray<string | Uint8Array>];

const afterOutput = (pane: Pane, bytes: Uint8Array, now: number): Emitted => [
	{ ...pane, lastOutputAt: now, atLineStart: bytes.at(-1) === newline, beats: 0 },
	[bytes],
];

const afterTick = (pane: Pane, now: number): Emitted => {
	const due = now - pane.lastOutputAt >= Duration.toMillis(quietBefore(pane.beats));

	return pane.atLineStart && due ? [{ ...pane, beats: pane.beats + 1 }, [heartbeatOf(pane, now)]] : [pane, []];
};

const step = (log: FileSystem.File) => (pane: Pane, event: Event) =>
	Event.$match(event, {
		Output: ({ bytes, at }) => Effect.as(log.writeAll(bytes), afterOutput(pane, bytes, at)),
		Tick: ({ at }) => Effect.succeed(afterTick(pane, at)),
	});

const stamped = <Value>(make: (at: number) => Value) => Effect.map(Clock.currentTimeMillis, make);

export const teeWithHeartbeats = (log: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const stdio = yield* Stdio.Stdio;
			const fs = yield* FileSystem.FileSystem;
			const file = yield* fs.open(log, { flag: "w" });
			const startedAt = yield* Clock.currentTimeMillis;

			const outputs = Stream.mapEffect(stdio.stdin, (bytes) => stamped((at) => Event.Output({ bytes, at })));
			const ticks = Stream.mapEffect(Stream.tick("1 second"), () => stamped((at) => Event.Tick({ at })));
			const events = Stream.merge(outputs, ticks, { haltStrategy: "left" });

			const pane: Pane = { startedAt, lastOutputAt: startedAt, atLineStart: true, beats: 0 };

			yield* Stream.run(
				Stream.mapAccumEffect(events, () => pane, step(file)),
				stdio.stdout(),
			);
		}),
	);
