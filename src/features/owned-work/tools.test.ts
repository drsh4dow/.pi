import { expect, test } from "bun:test";

import { type JsonObject, validateToolArguments } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { briefSourcesLayer } from "#src/client/brief-sources/index.ts";
import { Gh } from "#src/client/gh/index.ts";
import { Self } from "./child.ts";
import { Ledger } from "./ledger.ts";
import { modelTable } from "./models.ts";
import { Tools } from "./tools.ts";

const runtime = ManagedRuntime.make(
	Layer.mergeAll(
		Layer.provideMerge(briefSourcesLayer, NodeServices.layer),
		Layer.mock(Ledger)({}),
		Layer.mock(Gh)({}),
	),
);

const toolsOf = (self: Self) => {
	const tools: Array<Pick<ToolDefinition, "name" | "description" | "parameters" | "promptGuidelines" | "execute">> =
		[];

	Tools.register(
		{
			registerTool: (tool) => {
				tools.push(tool);
			},
		},
		runtime,
		self,
		{ cwd: "/", dir: "/d" },
		{ getSessionDir: () => "/d", getSessionId: () => "self" },
	);

	return tools;
};

const levelRows = [
	{
		name: "the root",
		self: Self.Root({ role: "root", level: 1 }),
		expect: { roles: ["owner", "leaf"], lastLevelLine: false, ownerLine: true },
	},
	{
		name: "a level-2 owner",
		self: Self.Delegate({ role: "owner", level: 2, slice: "s" }),
		expect: { roles: ["owner", "leaf"], lastLevelLine: false, ownerLine: true },
	},
	{
		name: "an owner at the last level, told its delegates cannot delegate,",
		self: Self.Delegate({ role: "owner", level: 3, slice: "s" }),
		expect: { roles: ["leaf"], lastLevelLine: true, ownerLine: false },
	},
	{
		name: "a level-2 leaf",
		self: Self.Delegate({ role: "leaf", level: 2, slice: "s" }),
		expect: { roles: undefined, lastLevelLine: false, ownerLine: false },
	},
	{
		name: "a level-4 leaf",
		self: Self.Delegate({ role: "leaf", level: 4, slice: "s" }),
		expect: { roles: undefined, lastLevelLine: false, ownerLine: false },
	},
];

const RoleParam = Schema.Struct({ enum: Schema.Array(Schema.String) });

const RoleEnum = Schema.Struct({ properties: Schema.Struct({ role: RoleParam }) });

const decodeRoleEnum = Schema.decodeUnknownOption(RoleEnum);

const startableRoles = (tools: ReturnType<typeof toolsOf>) =>
	Arr.findFirst(tools, ({ name }) => name === "delegate").pipe(
		Option.flatMap(({ parameters }) => decodeRoleEnum(parameters)),
		Option.map(({ properties }) => properties.role.enum),
		Option.getOrUndefined,
	);

for (const row of levelRows) {
	test(`${row.name} starts ${row.expect.roles === undefined ? "no delegates" : Arr.join(row.expect.roles, " or ")}, and always gets the rest of the tools`, () => {
		const tools = toolsOf(row.self);
		const names = Arr.map(tools, ({ name }) => name);
		const guidelines = Arr.flatMap(tools, ({ promptGuidelines }) => promptGuidelines ?? []);

		expect({
			rest: Arr.filter(names, (name) => name !== "delegate"),
			roles: startableRoles(tools),
			lastLevelLine: Arr.some(guidelines, Str.includes("cannot start delegates of their own")),
			ownerLine: Arr.some(guidelines, Str.includes("one owner per slice")),
		}).toEqual({ rest: ["serve", "watch", "group", "cancel"], ...row.expect });
	});
}

const delegate = Tools.delegate(runtime, ["owner", "leaf"], { cwd: "/", dir: "/d" }, modelTable, Option.none());

const validated = (tool: Pick<ToolDefinition, "name" | "description" | "parameters">, args: JsonObject) => () => {
	validateToolArguments(tool, { type: "toolCall", id: "c", name: tool.name, arguments: args });
};

test("pi refuses a delegate name or message of only spaces, tabs and newlines, and passes them with a word", () => {
	expect(validated(delegate, { name: "review", message: " \n\t " })).toThrow();
	expect(validated(delegate, { name: " ", message: "Review it." })).toThrow();
	expect(validated(delegate, { name: "review", message: "\n Review it. " })).not.toThrow();
});

test("pi refuses a delegate role other than owner or leaf", () => {
	expect(validated(delegate, { name: "review", message: "Review it.", role: "delegate" })).toThrow();
	expect(validated(delegate, { name: "review", message: "Review it.", role: "root" })).toThrow();
	expect(validated(delegate, { name: "review", message: "Review it.", role: "owner" })).not.toThrow();
	expect(validated(delegate, { name: "review", message: "Review it.", role: "leaf" })).not.toThrow();
});

test("pi refuses an owner from a last-level owner's delegate tool", () => {
	const lastLevel = Tools.delegate(runtime, ["leaf"], { cwd: "/", dir: "/d" }, modelTable, Option.none());

	expect(validated(lastLevel, { name: "review", message: "Review it.", role: "owner" })).toThrow();
	expect(validated(lastLevel, { name: "review", message: "Review it.", role: "leaf" })).not.toThrow();
});

const group = Arr.findFirst(toolsOf(Self.Root({ role: "root", level: 1 })), ({ name }) => name === "group");

test("pi refuses a group call with no name or a blank one, and passes one with a name", () => {
	const tool = Option.getOrThrow(group);
	const args = { of: [{ ref: "delegate-1" }] };

	expect(validated(tool, args)).toThrow();
	expect(validated(tool, { ...args, name: " " })).toThrow();
	expect(validated(tool, { ...args, name: "review auth" })).not.toThrow();
});
