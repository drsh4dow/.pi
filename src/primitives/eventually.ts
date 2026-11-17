import type * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Function from "effect/Function";
import * as Schedule from "effect/Schedule";

export const eventually: {
	(
		within: Duration.Input,
	): <Failure, Services>(
		holds: Effect.Effect<boolean, Failure, Services>,
	) => Effect.Effect<void, Failure | Cause.TimeoutError, Services>;
	<Failure, Services>(
		holds: Effect.Effect<boolean, Failure, Services>,
		within: Duration.Input,
	): Effect.Effect<void, Failure | Cause.TimeoutError, Services>;
} = Function.dual(
	2,
	<Failure, Services>(
		holds: Effect.Effect<boolean, Failure, Services>,
		within: Duration.Input,
	): Effect.Effect<void, Failure | Cause.TimeoutError, Services> =>
		holds.pipe(
			Effect.repeat({ until: (held) => held, schedule: Schedule.spaced("20 millis") }),
			Effect.timeout(within),
			Effect.asVoid,
		),
);
