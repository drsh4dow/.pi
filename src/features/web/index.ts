import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { piHost } from "#src/client/pi-host/index.ts";
import { cacheRootOf, noStoreLayer, Store, storeLayer } from "#src/client/web-cache/index.ts";
import { webLayer } from "#src/client/web/index.ts";
import { webTools } from "./tools.ts";

const skillPaths = [import.meta.dirname];

export const web = (env: Readonly<Record<string, string | undefined>>) => (pi: Pick<ExtensionAPI, "registerTool">) => {
	const store = Option.match(cacheRootOf(env), {
		onNone: () => noStoreLayer,
		onSome: (root) => storeLayer(root).pipe(Layer.provide(NodeServices.layer)),
	});

	const runtime = piHost(Layer.merge(webLayer, store));

	for (const tool of webTools(runtime)) {
		pi.registerTool(tool);
	}

	return {
		sessionStart: () => runtime.run(Effect.flatMap(Store, ({ prune }) => prune)),
		resourcesDiscover: () => ({ skillPaths }),
		shutdown: () => runtime.dispose(),
	};
};
