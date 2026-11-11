import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { childExtensions, ownedWork } from "../../../features/owned-work/index.ts";

export default function (pi: ExtensionAPI) {
	const work = ownedWork(childExtensions)(pi);

	pi.on("session_start", work.sessionStart);
	pi.on("input", work.input);
	pi.on("agent_start", work.agentStart);
	pi.on("agent_before_settle", work.beforeSettle);
	pi.on("agent_settled", work.settled);
	pi.on("tool_result", work.toolResult);
	pi.on("session_before_switch", work.beforeSwitch);
	pi.on("session_before_fork", work.beforeFork);
	pi.on("session_shutdown", work.shutdown);
}
