import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { claudeAccounts } from "../../../features/claude-accounts/index.ts";

export default function (pi: ExtensionAPI) {
	claudeAccounts(pi);
}
