import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { prompt } from "../../../features/prompt/index.ts";

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", prompt(pi));
}
