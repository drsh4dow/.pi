/** The models a `delegate` call or an instructions file names without spelling an id, so a skill survives a model swap. */
export interface ModelTable {
	/** Alias to `provider/id`. */
	readonly aliases: Readonly<Record<string, string>>;
	/** One model per provider, for work a skill runs once on each. */
	readonly panel: ReadonlyArray<string>;
}

export const modelTable: ModelTable = {
	aliases: {
		worker: "anthropic/claude-haiku-5-5",
		judgment: "anthropic/claude-opus-5-5",
	},
	panel: ["anthropic/claude-opus-5-5", "openai/gpt-6.1-sol"],
};
