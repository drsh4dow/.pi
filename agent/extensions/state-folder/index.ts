import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { stateFolder } from "#src/features/state-folder/index.ts";

export default function (pi: ExtensionAPI) {
	stateFolder(pi);
}
