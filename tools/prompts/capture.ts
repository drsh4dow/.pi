import type { BeforeProviderRequestEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const target = Config.option(Config.String("PI_PROMPTS_CAPTURE"));

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: "\t" }));

/** Writes the payload to `PI_PROMPTS_CAPTURE` and aborts the run, so pi never sends the request. */
const save = (event: BeforeProviderRequestEvent, ctx: ExtensionContext) =>
	Effect.gen(function* () {
		const file = yield* target;

		if (Option.isNone(file)) {
			return;
		}

		const fs = yield* FileSystem.FileSystem;
		const json = yield* encode(event.payload);

		yield* fs.writeFileString(file.value, json);
		ctx.abort();
	});

/** Loaded with `-e` by `tools/prompts`. Does nothing while `PI_PROMPTS_CAPTURE` is unset. */
export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) =>
		Effect.runPromise(save(event, ctx).pipe(Effect.provide(NodeServices.layer))),
	);
}
