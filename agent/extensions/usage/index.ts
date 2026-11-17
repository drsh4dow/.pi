import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { usage } from "#src/features/usage/index.ts";

export default function usageExtension(pi: ExtensionAPI) {
	const feature = usage(pi);

	pi.on("session_shutdown", feature.shutdown);
}
