import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text, type TUI } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";

import { type Block, blockLines, type Card } from "./card.ts";

const nothing = () => {};

const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** The card's frame: pi's background for extension output, with the title above the blocks. */
const framed = (theme: Theme, lines: ReadonlyArray<string>) => {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	const text = new Text(Arr.join(lines, "\n"), 0, 0);

	box.addChild(text);

	return { box, text };
};

const titled = (theme: Theme, title: string, blocks: ReadonlyArray<Block>) => [
	title,
	"",
	...blockLines({ blocks, theme }),
];

/** A finished card, as the transcript shows it now and after a reload. */
export const cardComponent = ({ card, theme }: { readonly card: Card; readonly theme: Theme }): Component => {
	const title = `${theme.bold("Usage")}  ${theme.fg("dim", card.readAt)}`;

	return framed(theme, titled(theme, title, card.blocks)).box;
};

/** A card while its accounts are still being read. It shows each account as soon as it answers. */
export interface LiveCard {
	readonly update: (index: number, block: Block) => void;
	/** Moves the spinner one frame. */
	readonly tick: () => void;
	readonly component: (tui: TUI, theme: Theme) => Component;
}

export const liveCard = (initial: ReadonlyArray<Block>): LiveCard => {
	const blocks = [...initial];
	let frame = 0;
	let redraw: () => void = nothing;

	const title = (theme: Theme) => {
		const read = Arr.filter(blocks, ({ body }) => body.kind !== "reading").length;
		const glyph = theme.fg("accent", spinner[frame % spinner.length] ?? "");

		return `${glyph} ${theme.bold("Usage")}  ${theme.fg("dim", `${read} of ${blocks.length} accounts read`)}`;
	};

	return {
		update: (index, block) => {
			blocks[index] = block;
			redraw();
		},
		tick: () => {
			frame += 1;
			redraw();
		},
		component: (tui, theme) => {
			const { box, text } = framed(theme, titled(theme, title(theme), blocks));

			redraw = () => {
				const lines = titled(theme, title(theme), blocks);

				text.setText(Arr.join(lines, "\n"));
				tui.requestRender();
			};

			return box;
		},
	};
};
