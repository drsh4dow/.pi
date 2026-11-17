import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { cost } from "#src/features/cost/index.ts";

export default function (pi: ExtensionAPI) {
	cost(pi);
}
