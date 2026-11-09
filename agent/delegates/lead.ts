import type { DelegateFile } from "../../features/owned-work/index.ts";

export default {
	role: "owner",
	description:
		"Verifies a pull request end to end: runs the dev server, splits the flows across e2e testers, reviews the diff.",
	tools: ["read", "bash"],
	delegates: ["e2e", "reviewer"],
	instructions: `You verify one pull request. Your task message names the PR, its flows, and how to start the app.
Start the app with serve, give each flow to an e2e delegate and the diff to a reviewer, and group them.
Report a verdict per flow and every bug the reviewer showed.`,
} satisfies DelegateFile;
