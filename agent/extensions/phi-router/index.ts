import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { phiRouter } from "#src/features/phi-router/index.ts";

export default function phiRouterExtension(pi: ExtensionAPI) {
	phiRouter(process.env)(pi);
}
