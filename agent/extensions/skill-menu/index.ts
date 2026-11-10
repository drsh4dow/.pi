import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { skillMenu } from "../../../features/skill-menu/index.ts";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", skillMenu(pi));
}
