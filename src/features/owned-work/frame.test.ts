import { afterAll, expect, test } from "bun:test";

import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";

import { Hc, TerminalAddress, TerminalEnd } from "#src/client/hc/index.ts";
import { piSessionsLayer } from "#src/client/pi-sessions/index.ts";
import { Slices } from "#src/client/systemd/index.ts";
import { eventually } from "#src/primitives/eventually.ts";
import { Self } from "./child.ts";
import { type CommandRequest, watchOutputOf } from "./frame.ts";
import { commandSpec, Host, Ledger, ledgerLayer } from "./ledger.ts";
import { StartRequest, WorkRef } from "./work.ts";
import { node, sessionRoot } from "./world.fixture.ts";

const passEnv = { PATH: Bun.env["PATH"] ?? "/bin" };

const startTime = "10:00:00";

const serve = (command: string) => ({
	...StartRequest.Serve({ name: "dev server", command, ready: Option.none() }),
	startTime,
});

const watch = (command: string, name = "unit tests") => ({
	...StartRequest.Watch({
		name,
		command,
		deadline: Option.none(),
		log: `${sessionRoot}/${String(Bun.hash(`${name}${command}`))}.log`,
	}),
	startTime,
});

const screenOf = (bytes: string) =>
	Str.trimEnd(Str.replaceAll("\u001B[0m", "")(Str.replaceAll("\u001B[2m", "")(bytes)));

const spawned = (argv: ReadonlyArray<string>, env: Record<string, string>) =>
	Effect.andThen(
		Effect.promise(() => Bun.$`mkdir -p ${sessionRoot}`.quiet()),
		Effect.sync(() => Bun.spawn([...argv], { env, stdout: "pipe", stderr: "inherit" })),
	);

const started = (spawnAs: ReadonlyArray<string>, ref: string, request: CommandRequest) => {
	const { argv, env } = commandSpec({ cwd: "/", passEnv })(WorkRef(ref), request);

	return spawned([...spawnAs, ...argv], env);
};

const screenRunning = (argv: ReadonlyArray<string>, env: Record<string, string>) =>
	Effect.gen(function* () {
		const child = yield* spawned(argv, env);
		const bytes = yield* Effect.promise(() => new Response(child.stdout).text());

		return screenOf(bytes);
	});

const ran = (ref: string, request: CommandRequest) =>
	Effect.gen(function* () {
		const child = yield* started([], ref, request);
		const bytes = yield* Effect.promise(() => new Response(child.stdout).text());
		const code = yield* Effect.promise(() => child.exited);

		return { screen: screenOf(bytes), code, signal: child.signalCode ?? undefined };
	});

const exited = (code: number) => TerminalEnd.Exited({ code: Option.some(code), signal: Option.none() });

const outputOf = (ref: string, request: CommandRequest, code: number) => (screen: string) =>
	watchOutputOf({ frame: { ref: WorkRef(ref), cwd: "/", shown: request }, end: exited(code), screen });

test("a watch's pane shows its command, name and ref above the output and how it ended below, and its log and tail hold the output alone", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const request = watch("echo one; echo two >&2; exit 3");
			const { screen, code } = yield* ran("watch-1", request);
			const lines = Str.split(screen, "\n");
			const log = yield* Effect.promise(() => Bun.file(request.log).text());

			expect({ head: Arr.take(lines, 5), code, log }).toEqual({
				head: [
					"$ echo one; echo two >&2; exit 3",
					`unit tests · watch-1 · / · started 10:00:00 · log ${request.log}`,
					"one",
					"two",
					"",
				],
				code: 3,
				log: "one\ntwo\n",
			});
			expect(lines.at(-1)).toMatch(/^✗ exit 3 after \ds$/u);
			expect(outputOf("watch-1", request, code)(screen)).toBe("one\ntwo");
		}),
	));

test("a serve's pane shows its command, name and ref above the output, and nothing after it", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { screen, code } = yield* ran("serve-2", serve("echo up\necho again\t# tabbed"));

			expect(Str.split(screen, "\n")).toEqual([
				"$ echo up",
				"  echo again?# tabbed",
				"dev server · serve-2 · / · started 10:00:00",
				"up",
				"again",
			]);
			expect(code).toBe(0);
		}),
	));

const polling = watch("echo polling; sleep 60; echo done");

const header = [
	"$ echo polling; sleep 60; echo done",
	`unit tests · watch-5 · / · started 10:00:00 · log ${polling.log}`,
];

const output = [
	"polling",
	"⋯ still running after 30s, quiet for 30s",
	"watch-5 · real output",
	"✓ exit 0 after 1s",
	"done",
];

const kept = ["polling", "watch-5 · real output", "✓ exit 0 after 1s", "done"];

const footer = ["", "✓ exit 0 after 1m00s"];

test.each([
	{ screen: "is whole", lines: [...header, ...output, ...footer], code: 0, tail: kept },
	{
		screen: "has scrolled its first line out",
		lines: [...Arr.drop(header, 1), ...output, ...footer],
		code: 0,
		tail: kept,
	},
	{ screen: "has scrolled the header out", lines: [...output, ...footer], code: 0, tail: kept },
	{ screen: "has no footer yet", lines: [...header, ...output], code: 0, tail: kept },
	{
		screen: "ends in a footer for another code",
		lines: [...header, ...output, ...footer],
		code: 3,
		tail: [...kept, ...footer],
	},
	{
		screen: "opens with a line close to the header",
		lines: [`${header[0]} `, ...Arr.drop(header, 1), ...output],
		code: 0,
		tail: [`${header[0]} `, ...Arr.drop(header, 1), ...kept],
	},
])("a watch's tail drops only the harness's own lines when the screen $screen", ({ lines, code, tail }) => {
	expect(outputOf("watch-5", polling, code)(Arr.join(lines, "\n"))).toBe(Arr.join(tail, "\n"));
});

const headerEnd = "dev server · serve-3 · / · started 10:00:00";

test.each([
	{ kind: "serve", request: serve("echo up; exit 7"), code: 7, signal: undefined, last: "up" },
	{ kind: "serve", request: serve("kill -TERM $$"), code: 143, signal: "SIGTERM", last: headerEnd },
	{ kind: "serve", request: serve("kill -USR1 $$"), code: 138, signal: "SIGUSR1", last: headerEnd },
	{ kind: "watch", request: watch("exit 7"), code: 7, signal: undefined, last: "✗ exit 7" },
	{
		kind: "watch",
		request: watch("kill -TERM $$"),
		code: 143,
		signal: undefined,
		last: "✗ exit 143 (SIGTERM)",
	},
])("a $kind ends as its command did: code $code, signal $signal", ({ kind, request, code, signal, last }) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const ended = yield* ran(`${kind}-3`, request);

			const lastLine = Arr.lastNonEmpty(Str.split(ended.screen, "\n"));

			expect({ code: ended.code, signal: ended.signal, last: Str.replace(/ after \ds$/u, "")(lastLine) }).toEqual({
				code,
				signal,
				last,
			});
		}),
	),
);

test.each([
	{ kind: "serve", request: serve },
	{ kind: "watch", request: watch },
])("a cancel's hangup ends a $kind's command and its children", ({ kind, request }) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const pidFile = `${sessionRoot}/${kind}-cancel.pid`;
			const command = `sleep 300 & echo $! > ${pidFile}; sleep 301`;
			const child = yield* started(["setsid"], `${kind}-4`, request(command));

			yield* eventually(
				Effect.promise(() => Bun.file(pidFile).exists()),
				"5 seconds",
			);

			const pid = yield* Effect.promise(() => Bun.file(pidFile).text());

			const sleeperGone = Effect.promise(() => Bun.$`kill -0 ${Str.trim(pid)}`.nothrow().quiet()).pipe(
				Effect.map(({ exitCode }) => exitCode !== 0),
			);

			process.kill(-child.pid, "SIGHUP");
			yield* Effect.promise(() => child.exited);
			yield* eventually(sleeperGone, "5 seconds");
		}),
	),
);

/** An hc whose terminal runs the spec the ledger hands it to the end, then shows what it printed. */
const hcRunning = () => {
	const pane = { screen: "", waits: 0 };

	return Layer.succeed(Hc, {
		run: ({ argv, env }) =>
			Effect.map(screenRunning(argv, env), (screen) => {
				pane.screen = screen;

				return TerminalAddress("t1");
			}),
		open: () => Effect.succeed(TerminalAddress("t2")),
		labelsOf: () => Effect.succeed({}),
		follow: Effect.void,
		kill: () => Effect.void,
		label: () => Effect.void,
		waitForOutput: (_terminal, pattern) =>
			Effect.sync(() => {
				pane.waits += 1;

				return pane.waits === 1 && Str.includes(pattern)(pane.screen);
			}),
		read: () => Effect.sync(() => pane.screen),
		notices: Stream.never,
	});
};

const outside = Layer.mergeAll(
	Layer.succeed(Host, { wake: () => Effect.void, append: () => Effect.void }),
	Layer.succeed(Slices, { wrap: (spec) => spec, stop: () => Effect.void, stopAll: Effect.void }),
	piSessionsLayer,
);

const readyAfter = (command: string, ready: string, name = "dev server") =>
	Effect.gen(function* () {
		const request = StartRequest.Serve({ name, command, ready: Option.some(ready) });
		const self = Self.Root({ role: "root", level: 1 });
		const ledger = ledgerLayer({ self, cwd: "/", passEnv, firstRef: 1, carried: Option.none() });
		const layer = Layer.provide(ledger, Layer.merge(hcRunning(), outside));
		const context = yield* Layer.build(layer);
		const handle = yield* Context.get(context, Ledger).start(request);

		return handle.ready;
	}).pipe(Effect.scoped);

test("a serve whose command or name holds its ready text is not ready from the header that shows them", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const named = "Listening on 4000 · serve-1 · /";
			const echoed = yield* readyAfter("true # Listening on 4000", "Listening on 4000");
			const inName = yield* readyAfter("true", "Listening on 4000", named);
			const printed = yield* readyAfter("echo Listening on 4000", "Listening on 4000", named);

			expect({ echoed, inName, printed }).toEqual({
				echoed: Option.some(false),
				inName: Option.some(false),
				printed: Option.some(true),
			});
		}).pipe(Effect.provide(node)),
	));

test("a watch's header shows a name with control characters on one line, and its tail leaves that header out", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const name = "tests · watch-6 · /\n\u001B[2J";
			const request = watch("echo one", name);
			const { screen, code } = yield* ran("watch-6", request);
			const [, refLine] = Str.split(screen, "\n");

			expect(refLine).toStartWith("tests · watch-6 · /??[2J · watch-6 · / · started ");
			expect(outputOf("watch-6", request, code)(screen)).toBe("one");
		}),
	));

afterAll(() => Effect.runPromise(Effect.promise(() => Bun.$`rm -rf ${sessionRoot}`.quiet())));
