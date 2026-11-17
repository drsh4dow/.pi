import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { cache } from "#src/features/cache/index.ts";

export default function cacheExtension(pi: ExtensionAPI) {
	cache(pi);
}
