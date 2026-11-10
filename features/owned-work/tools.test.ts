import { expect, test } from "bun:test";

import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Str from "effect/String";

import { Self } from "./child.ts";
import { Ledger } from "./ledger.ts";
import { Tools } from "./tools.ts";

const runtime = ManagedRuntime.make(Layer.mergeAll(NodeServices.layer, Layer.mock(Ledger)({})));

const toolsOf = (self: Self) => {
	const tools: Array<Pick<ToolDefinition, "name" | "promptGuidelines" | "execute">> = [];

	Tools.register(
		{
			registerTool: (tool) => {
				tools.push(tool);
			},
		},
		runtime,
		self,
		{ cwd: "/", dir: "/d" },
	);

	return tools;
};

const levelRows = [
	{ name: "the root", self: Self.Root({ role: "root", level: 1 }), expect: { delegate: true, lastLevelLine: false } },
	{
		name: "a level-2 delegate, told its delegates cannot delegate,",
		self: Self.Delegate({ role: "delegate", level: 2, slice: "s" }),
		expect: { delegate: true, lastLevelLine: true },
	},
	{
		name: "a delegate at the last level",
		self: Self.Delegate({ role: "delegate", level: 3, slice: "s" }),
		expect: { delegate: false, lastLevelLine: false },
	},
];

for (const row of levelRows) {
	test(`${row.name} ${row.expect.delegate ? "gets" : "does not get"} the delegate tool, and always gets the rest`, () => {
		const tools = toolsOf(row.self);
		const names = Arr.map(tools, ({ name }) => name);

		expect({
			rest: Arr.filter(names, (name) => name !== "delegate"),
			delegate: Arr.contains(names, "delegate"),
			lastLevelLine: Arr.some(
				Arr.flatMap(tools, ({ promptGuidelines }) => promptGuidelines ?? []),
				Str.includes("cannot start delegates of their own"),
			),
		}).toEqual({ rest: ["serve", "watch", "group", "stop"], ...row.expect });
	});
}

const delegate = Tools.delegate(runtime, 2, { cwd: "/", dir: "/d" });

const validated = (message: string) => () => {
	validateToolArguments(delegate, { type: "toolCall", id: "c", name: "delegate", arguments: { message } });
};

test("pi refuses a delegate message of only spaces, tabs and newlines, and passes one with a word", () => {
	expect(validated(" \n\t ")).toThrow();
	expect(validated("\n Review it. ")).not.toThrow();
});
