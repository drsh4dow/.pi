import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";

export class HerdrAppError extends Schema.TaggedError<HerdrAppError, { readonly brand: unique symbol }>()(
	"HerdrAppError",
	{ command: Schema.String, message: Schema.String },
) {}

/** The herdr-app window: it shows the terminals hc runs, in spaces and tabs. */
export class HerdrApp extends Context.Service<
	HerdrApp,
	{
		/** Shows `terminal` and puts the person's typing there. Fails when no window is open. */
		readonly focus: (terminal: string) => Effect.Effect<void, HerdrAppError>;
	}
>()("pi-harness/clients/herdr-app/HerdrApp") {}

const failed = (command: string) => (message: string) => HerdrAppError.make({ command, message });

const run = (
	spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
	command: string,
	args: ReadonlyArray<string>,
) =>
	spawner.spawn(ChildProcess.make("herdr-app", ["do", command, ...args])).pipe(
		Effect.flatMap((handle) =>
			Effect.all(
				{ code: handle.exitCode, output: handle.all.pipe(Stream.decodeText, Stream.mkString) },
				{ concurrency: 2 },
			),
		),
		Effect.scoped,
		Effect.mapError((error) => error.message),
		Effect.filterOrFail(
			({ code }) => code === 0,
			({ output }) => Str.trim(output),
		),
		Effect.mapError(failed(command)),
		Effect.asVoid,
	);

export const herdrAppLayer: Layer.Layer<HerdrApp, never, ChildProcessSpawner.ChildProcessSpawner> = Layer.effect(
	HerdrApp,
	Effect.map(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
		HerdrApp.of({ focus: (terminal) => run(spawner, "agent.focus", ["--terminal", terminal]) }),
	),
);
