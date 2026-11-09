import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";

import { webLayer } from "../../clients/web/index.ts";
import { cacheRootOf, noStoreLayer, Store, storeLayer } from "./store.ts";
import { webTools } from "./tools.ts";

/** Delegates get these skills too. */
const skillPaths = [import.meta.dirname];

export const web = (pi: Pick<ExtensionAPI, "registerTool">) => {
	const store = Option.match(cacheRootOf(process.env), {
		onNone: () => noStoreLayer,
		onSome: (root) => storeLayer(root).pipe(Layer.provide(NodeServices.layer)),
	});

	const runtime = ManagedRuntime.make(Layer.merge(webLayer, store));

	for (const tool of webTools(runtime)) {
		pi.registerTool(tool);
	}

	return {
		sessionStart: () => runtime.runPromise(Effect.flatMap(Store, ({ prune }) => prune)),
		resourcesDiscover: () => ({ skillPaths }),
		shutdown: () => runtime.dispose(),
	};
};
