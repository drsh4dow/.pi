import { defineRule, eslintCompatPlugin, type ESTree } from "@oxlint/plugins";
import * as Arr from "effect/Array";
import * as Str from "effect/String";

type Layer = "entrypoint" | "feature" | "client" | "outside";

const layers = new Map<string, Layer>([
	["agent/extensions", "entrypoint"],
	["features", "feature"],
	["clients", "client"],
]);

const layered = /^.*\/(?<root>agent\/extensions|features|clients)\/(?<name>[^/]+)\/(?<rest>.+)$/u;

const mayImport: Readonly<Record<Layer, ReadonlyArray<Layer>>> = {
	entrypoint: ["feature"],
	feature: ["feature", "client", "outside"],
	client: ["client", "outside"],
	outside: ["feature", "client", "outside"],
};

const described: Readonly<Record<Layer, string>> = {
	entrypoint: "an entrypoint (agent/extensions/<name>/)",
	feature: "a feature (features/<name>/)",
	client: "a client (clients/<system>/)",
	outside: "a file outside agent/extensions, features and clients",
};

const placeOf = (file: string) => {
	const { root = "", name = "", rest = "" } = layered.exec(file)?.groups ?? {};

	return { layer: layers.get(root) ?? "outside", folder: `${root}/${name}`, file: rest };
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
		},
	},
	create(context) {
		const from = placeOf(context.filename);

		const check = (node: Sourced) => {
			const source = node.source?.value ?? "";
			const relative = Str.startsWith(".")(source);
			const to = placeOf(resolve(context.filename, source));

			if (relative && !Str.endsWith(".ts")(source)) {
				context.report({ node, messageId: "extension", data: { source } });
			}

			if (!relative || from.folder === to.folder) {
				return;
			}

			if (!mayImport[from.layer].includes(to.layer)) {
				context.report({
					node,
					messageId: "direction",
					data: { from: described[from.layer], to: described[to.layer], source },
				});
			} else if (to.layer !== "outside" && to.file !== "index.ts") {
				context.report({ node, messageId: "internals", data: { source, folder: to.folder } });
			}
		};

		return { ImportDeclaration: check, ExportAllDeclaration: check, ExportNamedDeclaration: check };
	},
});

const harnessPlugin = eslintCompatPlugin({
	meta: { name: "harness" },
	rules: { "import-boundaries": importBoundaries },
});

export default harnessPlugin;
