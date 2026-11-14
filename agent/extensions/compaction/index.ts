import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { compaction } from "../../../features/compaction/index.ts";

export default function (pi: ExtensionAPI) {
	compaction(process.env)(pi);
}
