import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { type Classify, decisionsModel, decisionsPieceJudge } from "#src/features/phi-router/decisions.ts";
import { Judge } from "#src/features/phi-router/policy/engine.ts";

class ModelsUnavailable extends Schema.TaggedError<ModelsUnavailable, { readonly brand: unique symbol }>()(
	"ModelsUnavailable",
	{ authPath: Schema.String },
) {}

class ClassifierMissing extends Schema.TaggedError<ClassifierMissing, { readonly brand: unique symbol }>()(
	"ClassifierMissing",
	{ message: Schema.String },
) {}

/**
 * OpenAI Decisions on the credentials in pi's `auth.json`, without a running pi. Errors name the file, never its
 * contents.
 */
export const liveClassify = Effect.gen(function* () {
	const home = yield* Config.String("HOME");
	const authPath = `${home}/.pi/agent/auth.json`;

	const runtime = yield* Effect.tryPromise({
		try: () => ModelRuntime.create({ authPath }),
		catch: () => ModelsUnavailable.make({ authPath }),
	});

	const registry = new ModelRegistry(runtime);
	const model = registry.findOfType("classifier", "openai", decisionsModel);

	if (model === undefined) {
		return yield* ClassifierMissing.make({
			message: `pi knows no classifier openai/${decisionsModel}; check pi's version and ${authPath}`,
		});
	}

	const classify: Classify = (context, options) => registry.classify(model, context, options);

	return classify;
});

export const judgeOn = (classify: Classify) =>
	Effect.map(Layer.build(decisionsPieceJudge(classify)), Context.get(Judge));
