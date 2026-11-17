import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { stateFolder } from "#src/features/state-folder/index.ts";

export default function stateFolderExtension(pi: ExtensionAPI) {
	stateFolder(pi);
}
