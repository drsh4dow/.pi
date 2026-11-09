import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { web } from "../../../features/web/index.ts";

export default function (pi: ExtensionAPI) {
	const feature = web(pi);

	pi.on("session_start", feature.sessionStart);
	pi.on("resources_discover", feature.resourcesDiscover);
	pi.on("session_shutdown", feature.shutdown);
}
