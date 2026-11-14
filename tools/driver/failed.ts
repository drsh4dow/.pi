import * as Schema from "effect/Schema";

/** The scenario's claim did not hold: a `check`, a timeout, the root dying. Exit 1. */
export class ScenarioFailed extends Schema.TaggedError<ScenarioFailed, { readonly brand: unique symbol }>()(
	"ScenarioFailed",
	{ message: Schema.String },
) {}

/** The driver could not build the run, so nothing about the harness was tested. Exit 2. */
export class SetupFailed extends Schema.TaggedError<SetupFailed, { readonly brand: unique symbol }>()("SetupFailed", {
	message: Schema.String,
}) {}
