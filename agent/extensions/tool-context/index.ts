import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { restoreToolContext } from "../../../features/tool-context/index.ts";

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", restoreToolContext);
}
