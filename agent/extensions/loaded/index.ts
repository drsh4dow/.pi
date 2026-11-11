import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loaded } from "../../../features/loaded/index.ts";

export default function (pi: ExtensionAPI) {
	loaded(pi);
}
