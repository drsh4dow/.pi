import type * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

export interface PiHost<Services, LayerFailure> {
	readonly run: <Value, Failure>(effect: Effect.Effect<Value, Failure, Services>) => Promise<Value>;
	readonly fork: <Value, Failure>(
		effect: Effect.Effect<Value, Failure, Services>,
	) => Fiber.Fiber<Value, Failure | LayerFailure>;
	readonly dispose: () => Promise<void>;
}

export const piHost = <Services, Failure>(layer: Layer.Layer<Services, Failure>): PiHost<Services, Failure> => {
	const runtime = ManagedRuntime.make(layer);

	return {
		run: <Value, Failed>(effect: Effect.Effect<Value, Failed, Services>): Promise<Value> =>
			runtime.runPromise(effect),
		fork: <Value, Failed>(effect: Effect.Effect<Value, Failed, Services>): Fiber.Fiber<Value, Failed | Failure> =>
			runtime.runFork(effect),
		dispose: (): Promise<void> => runtime.dispose(),
	};
};
