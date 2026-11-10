import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { footer } from "../../../features/footer/index.ts";

export default function (pi: ExtensionAPI) {
	footer(pi);
}
