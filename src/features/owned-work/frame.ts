import * as Arr from "effect/Array";
import type * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Str from "effect/String";

import { type Hc, type HcError, type TerminalAddress, TerminalEnd } from "#src/client/hc/index.ts";
import { isHeartbeat } from "#src/client/heartbeat/index.ts";
import type { TimedRequest, WatchWork, WorkRef } from "./work.ts";

export type CommandRequest = Data.TaggedEnum.Value<TimedRequest, "Serve" | "Watch">;

type PaneCommand = CommandRequest | WatchWork;

interface Frame {
	readonly ref: WorkRef;
	readonly cwd: string;
	readonly shown: PaneCommand;
}

interface Reading {
	readonly hc: Hc["Service"];
	readonly terminal: TerminalAddress;
	readonly frame: Frame;
}

const twoDigits = (value: number) => Str.padStart(2, "0")(String(value));

export const startTimeNow: Effect.Effect<string> = Effect.map(DateTime.now, (now) => {
	const { hour, minute, second } = DateTime.toParts(DateTime.setZone(now, DateTime.zoneMakeLocal()));

	return `${twoDigits(hour)}:${twoDigits(minute)}:${twoDigits(second)}`;
});

const heartbeatEntry = `${import.meta.dirname}/../../../agent/bin/heartbeat.ts`;

const printHeader = `printf '\\033[2m%s\\033[0m\\n' "$1"
`;

const serveScript = `${printHeader}exec sh -c "$2"`;

const watchScript = `${printHeader}start=$(date +%s)
set -o pipefail
sh -c "$2" 2>&1 | bun "$4" "$3"
code=$?
s=$(($(date +%s) - start))
if [ $s -lt 60 ]; then took="$s"s
elif [ $s -lt 3600 ]; then took=$((s / 60))m$(printf %02d $((s % 60)))s
else took=$((s / 3600))h$(printf %02d $((s / 60 % 60)))m
fi
if [ $code -eq 0 ]; then mark=✓; else mark=✗; fi
signal=$([ $code -gt 128 ] && kill -l $code 2>/dev/null)
printf '\\n\\033[2m%s exit %s%s after %s\\033[0m\\n' "$mark" "$code" "\${signal:+ (SIG$signal)}" "$took"
exit $code`;

const footerPatternOf = (code: number) =>
	new RegExp(
		`^${code === 0 ? "✓" : "✗"} exit ${String(code)}(?: \\(SIG[A-Z0-9]+\\))? after (?:\\d+s|\\d+m\\d\\ds|\\d+h\\d\\dm)$`,
		"u",
	);

/** Control characters show as `?`, so each header line reads back from the screen as the harness built it. */
const visible = Str.replaceAll(/\p{Cc}/gu, "?");

const extrasOf = (shown: PaneCommand): ReadonlyArray<string> =>
	Match.valueTags(shown, {
		Serve: () => [],
		Watch: ({ deadline, log }) => [
			...Option.toArray(Option.map(deadline, (after) => `deadline ${Duration.format(after)}`)),
			`log ${log}`,
		],
	});

const headerOf = ({ ref, cwd, shown }: Frame): ReadonlyArray<string> => {
	const [first, ...rest] = Arr.map(Str.split(shown.command, "\n"), visible);
	const where = Arr.join([shown.name, ref, cwd, `started ${shown.startTime}`, ...extrasOf(shown)], " · ");

	return Arr.map([`$ ${first}`, ...Arr.map(rest, (line) => `  ${line}`), visible(where)], Str.trimEnd);
};

export const framedArgv = ({ ref, cwd, request }: { ref: WorkRef; cwd: string; request: CommandRequest }) => {
	const header = Arr.join(headerOf({ ref, cwd, shown: request }), "\n");

	return Match.valueTags(request, {
		Serve: ({ command }) => ["-c", serveScript, "sh", header, command],
		Watch: ({ command, log }) => ["-c", watchScript, "sh", header, command, log, heartbeatEntry],
	});
};

const sameLines = Arr.makeEquivalence(Str.Equivalence);

const startsWith = (lines: ReadonlyArray<string>, prefix: ReadonlyArray<string>) =>
	sameLines(Arr.take(lines, prefix.length), prefix);

const belowHeader = (frame: Frame, screen: string): ReadonlyArray<string> => {
	const lines = Str.split(screen, "\n");
	const header = headerOf(frame);

	const scrolledOut = Arr.findFirst(Arr.range(0, header.length - 1), (count) =>
		startsWith(lines, Arr.drop(header, count)),
	);

	return Option.match(scrolledOut, {
		onNone: () => lines,
		onSome: (count) => Arr.drop(lines, header.length - count),
	});
};

export const watchOutputOf = ({ frame, end, screen }: { frame: Frame; end: TerminalEnd; screen: string }) => {
	const lines = belowHeader(frame, screen);
	const code = TerminalEnd.$is("Exited")(end) ? end.code : Option.none();

	const ended = Option.exists(Option.all({ code, last: Arr.last(lines) }), (exit) =>
		footerPatternOf(exit.code).test(exit.last),
	);

	const output = Arr.filter(ended ? Arr.dropRight(lines, 1) : lines, (line) => !isHeartbeat(line));

	return Str.trimEnd(Arr.join(output, "\n"));
};

const tailLines = 40;

export const watchTail = ({ hc, terminal, frame, end }: Reading & { readonly end: TerminalEnd }) =>
	Effect.map(hc.read(terminal, tailLines), (screen) => {
		const lines = Str.split(watchOutputOf({ frame, end, screen }), "\n");

		return Arr.join(Arr.takeRight(lines, tailLines), "\n");
	});

const readyHistory = 1000;

const readyTimeout = Duration.seconds(60);

export const serveReady = ({ hc, terminal, frame, text }: Reading & { readonly text: string }) => {
	const commandPrinted = Effect.map(hc.read(terminal, readyHistory), (screen) =>
		Str.includes(text)(Arr.join(belowHeader(frame, screen), "\n")),
	);

	const ready: Effect.Effect<boolean, HcError> = Effect.gen(function* () {
		const printing = yield* Effect.forkChild(hc.waitForOutput(terminal, text, readyTimeout));
		const printed = yield* commandPrinted;

		if (printed) {
			yield* Fiber.interrupt(printing);

			return true;
		}

		const anyonePrinted = yield* Fiber.join(printing);

		return yield* anyonePrinted ? ready : commandPrinted;
	});

	return Effect.timeoutOrElse(ready, { duration: readyTimeout, orElse: () => commandPrinted });
};
