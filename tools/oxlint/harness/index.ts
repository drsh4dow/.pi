import { defineRule, eslintCompatPlugin, type ESTree } from "@oxlint/plugins";
import * as Arr from "effect/Array";
import * as Str from "effect/String";

type Layer = "entrypoint" | "feature" | "client" | "tool" | "scenario" | "outside";

const layers = new Map<string, Layer>([
	["agent/extensions", "entrypoint"],
	["features", "feature"],
	["clients", "client"],
	["tools", "tool"],
]);

const layered = /^.*\/(?<root>agent\/extensions|features|clients|tools)\/(?<name>[^/]+)\/(?<rest>.+)$/u;

/**
 * No layer lists "scenario", and only a scenario lists "tool": `bun test` can never load a scenario, and the runtime
 * driver is reachable only from `*.scenario.ts` files, through its index.ts.
 */
const mayImport: Readonly<Record<Layer, ReadonlyArray<Layer>>> = {
	entrypoint: ["feature"],
	feature: ["feature", "client", "outside"],
	client: ["client", "outside"],
	tool: ["feature", "client", "outside"],
	scenario: ["feature", "client", "tool", "outside"],
	outside: ["feature", "client", "outside"],
};

const described: Readonly<Record<Layer, string>> = {
	entrypoint: "an entrypoint (agent/extensions/<name>/)",
	feature: "a feature (features/<name>/)",
	client: "a client (clients/<system>/)",
	tool: "a tool (tools/<name>/)",
	scenario: "a scenario (*.scenario.ts)",
	outside: "a file outside agent/extensions, features, clients and tools",
};

/** A `*.scenario.ts` file is a scenario wherever it sits; every other file's layer is where it sits. */
const placeOf = (file: string) => {
	const { root = "", name = "", rest = "" } = layered.exec(file)?.groups ?? {};
	const layer: Layer = Str.endsWith(".scenario.ts")(file) ? "scenario" : (layers.get(root) ?? "outside");

	return { layer, folder: `${root}/${name}`, file: rest };
};

/** Joins path segments by hand, since a URL would read `%`, `#` and `?` in a folder name as escapes, a fragment or a query. */
const resolve = (importer: string, source: string) => {
	const parts: Array<string> = [];

	for (const part of Str.split(`${importer}/../${source}`, "/")) {
		if (part === "..") {
			parts.pop();
		} else if (part !== ".") {
			parts.push(part);
		}
	}

	return Arr.join(parts, "/");
};

type Sourced = ESTree.ImportDeclaration | ESTree.ExportAllDeclaration | ESTree.ExportNamedDeclaration;

/** The module an `import()` names, when it names one by a literal. */
const literalSource = (node: ESTree.ImportExpression) =>
	node.source.type === "Literal" ? String(node.source.value) : "";

type Place = ReturnType<typeof placeOf>;

type Problem =
	| { readonly messageId: "extension" | "scenario"; readonly data: { readonly source: string } }
	| {
			readonly messageId: "direction";
			readonly data: { readonly from: string; readonly to: string; readonly source: string };
	  }
	| { readonly messageId: "internals"; readonly data: { readonly source: string; readonly folder: string } };

/** The layer rule an import from `from` to `to` breaks, if any. Bare package imports break none. */
const layerProblem = (from: Place, to: Place, source: string): ReadonlyArray<Problem> => {
	if (to.layer === "scenario") {
		return [{ messageId: "scenario", data: { source } }];
	}

	if (from.folder === to.folder) {
		return [];
	}

	if (!mayImport[from.layer].includes(to.layer)) {
		return [{ messageId: "direction", data: { from: described[from.layer], to: described[to.layer], source } }];
	}

	return to.layer !== "outside" && to.file !== "index.ts"
		? [{ messageId: "internals", data: { source, folder: to.folder } }]
		: [];
};

const problemsOf = (from: Place, importer: string, source: string): ReadonlyArray<Problem> => {
	if (!Str.startsWith(".")(source)) {
		return [];
	}

	const extension: ReadonlyArray<Problem> = Str.endsWith(".ts")(source)
		? []
		: [{ messageId: "extension", data: { source } }];

	return [...extension, ...layerProblem(from, placeOf(resolve(importer, source)), source)];
};

const importBoundaries = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Keep entrypoints, features and clients to the import graph in docs/adr/0001-harness-layout.md, and end relative imports in .ts.",
		},
		messages: {
			direction: "{{from}} may not import {{to}}: {{source}}.",
			internals: "{{source}} reaches inside {{folder}}/. Import {{folder}}/index.ts, its public interface.",
			extension: "{{source}} must end in .ts, as AGENTS.md requires of relative imports.",
			scenario: "{{source}} is a scenario. Nothing imports a scenario; run it with bun <file>.",
		},
	},
	create(context) {
		const from = placeOf(context.filename);

		const report = (node: Sourced | ESTree.ImportExpression, source: string) => {
			for (const problem of problemsOf(from, context.filename, source)) {
				context.report({ node, ...problem });
			}
		};

		const check = (node: Sourced) => {
			report(node, node.source?.value ?? "");
		};

		return {
			ImportDeclaration: check,
			ExportAllDeclaration: check,
			ExportNamedDeclaration: check,
			ImportExpression: (node) => {
				report(node, literalSource(node));
			},
		};
	},
});

const harnessPlugin = eslintCompatPlugin({
	meta: { name: "harness" },
	rules: { "import-boundaries": importBoundaries },
});

export default harnessPlugin;
