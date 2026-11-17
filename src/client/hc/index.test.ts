import { expect, test } from "bun:test";

import { terminalNameOf } from "./index.ts";

/** What `hc run --name` accepts, from its own error: 1-32 of `[a-z0-9_.-]`, starting with a letter or digit, not like `t7`. */
const accepted = (name: string) => /^[a-z0-9][a-z0-9_.-]{0,31}$/u.test(name) && !/^t\d[0-9a-z]*$/u.test(name);

const rows = [
	{ text: "Review the retry cap, again!", name: "review-the-retry-cap-again" },
	{ text: "bun test --watch", name: "bun-test-watch" },
	{ text: "./scripts/check.sh", name: "scripts-check.sh" },
	{ text: "audit attack-the-premise principle file", name: "audit-attack-the-premise" },
	{ text: "classify the principles index on opus", name: "classify-the-principles-index-on" },
	{ text: "supercalifragilisticexpialidocious-extra", name: "supercalifragilisticexpialidocio" },
	{ text: "t7", name: "t7-1" },
	{ text: "_private", name: "private" },
	{ text: "!!!", name: "work" },
];

for (const row of rows) {
	test(`"${row.text}" becomes the terminal name ${row.name}`, () => {
		const name: string = terminalNameOf(row.text);

		expect({ name, accepted: accepted(name) }).toEqual({ name: row.name, accepted: true });
	});
}
