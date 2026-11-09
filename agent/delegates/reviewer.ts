import type { DelegateFile } from "../../features/owned-work/index.ts";

export default {
	role: "leaf",
	description: "Reviews a diff for correctness bugs and reports each with file, line and a failing input.",
	tools: ["read", "bash"],
	instructions: `You review one diff. Your task message names the base and head refs and the change's goal.
Report only bugs you can show with a concrete input. No style notes.`,
} satisfies DelegateFile;
