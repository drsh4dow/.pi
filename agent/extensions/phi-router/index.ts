import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { phiRouter } from "../../../features/phi-router/index.ts";

export default function (pi: ExtensionAPI) {
	phiRouter(process.env)(pi);
}
