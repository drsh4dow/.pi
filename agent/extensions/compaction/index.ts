import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { compaction } from "#src/features/compaction/index.ts";

export default function compactionExtension(pi: ExtensionAPI) {
	compaction(process.env)(pi);
}
