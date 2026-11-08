import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ownedWork } from "../../../features/owned-work/index.ts";

const ownedWorkEntry = import.meta.filename;
const toolContextEntry = `${import.meta.dirname}/../tool-context/index.ts`;
const childExtensions = [ownedWorkEntry, toolContextEntry];

export default function (pi: ExtensionAPI) {
	const work = ownedWork(childExtensions)(pi);

	pi.on("session_start", work.sessionStart);
	pi.on("input", work.input);
	pi.on("agent_start", work.agentStart);
	pi.on("agent_before_settle", work.beforeSettle);
	pi.on("agent_settled", work.settled);
	pi.on("session_shutdown", work.shutdown);
}
