import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { cache } from "../../../features/cache/index.ts";

export default function (pi: ExtensionAPI) {
	cache(pi);
}
