interface Registry {
	readonly find: (provider: string, id: string) => string;
}

export const lookup = (ctx: { readonly modelRegistry: Registry }) => ctx.modelRegistry.find("openai", "gpt");
