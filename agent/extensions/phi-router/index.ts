import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { delegateModelIds } from "#src/features/owned-work/index.ts";
import { phiRouter } from "#src/features/phi-router/index.ts";

export default function phiRouterExtension(pi: ExtensionAPI) {
	phiRouter({ env: process.env, ids: delegateModelIds })(pi);
}
