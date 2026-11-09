import type { DelegateFile } from "../../features/owned-work/index.ts";

export default {
	role: "leaf",
	description: "Drives a running web app through one user flow in a browser and reports each step that fails.",
	tools: ["read", "bash"],
	deadline: 1800,
	instructions: `You test one user flow of a web app that is already running.
Your task message gives the URL, the flow, and what counts as passing.
Drive the app with the agent-browser CLI. Do not edit code.
Finish with one line per step: PASS or FAIL, and for FAIL the console error and a screenshot path.`,
} satisfies DelegateFile;
