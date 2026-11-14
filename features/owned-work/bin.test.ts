import { expect, test } from "bun:test";

import { withAgentBin } from "./child.ts";

const binRows = [
	{
		name: "a PATH without the agent's bin folder gets it first",
		path: "/usr/bin:/bin",
		expect: "/a/agent/bin:/usr/bin:/bin",
	},
	{
		name: "a PATH that holds the agent's bin folder later gets it first, once",
		path: "/usr/bin:/a/agent/bin:/bin",
		expect: "/a/agent/bin:/usr/bin:/bin",
	},
	{ name: "no PATH becomes the agent's bin folder alone", path: undefined, expect: "/a/agent/bin" },
];

for (const row of binRows) {
	test(row.name, () => {
		const env: Readonly<Record<string, string | undefined>> = withAgentBin("/a/agent")({
			HOME: "/h",
			PATH: row.path,
		});

		expect(env).toEqual({ HOME: "/h", PATH: row.expect });
	});
}
