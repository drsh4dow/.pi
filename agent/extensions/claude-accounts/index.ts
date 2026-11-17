import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { claudeAccounts } from "../../../features/claude-accounts/index.ts";
import { phiBorder } from "../../../features/phi-router/index.ts";

export default function (pi: ExtensionAPI) {
	claudeAccounts(phiBorder(pi).wrap)(pi);
}
