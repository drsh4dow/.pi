import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { prompt } from "#src/features/prompt/index.ts";

export default function promptExtension(pi: ExtensionAPI) {
	prompt(process.env)(pi);
}
