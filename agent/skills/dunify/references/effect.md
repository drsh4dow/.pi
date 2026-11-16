# Effect

The dunify reference for a repo with `effect` as a dependency. It adds to [`typescript.md`](typescript.md), so read that first. Checked on `@effect/tsgo` 0.69.0, oxlint 1.93.0, oxlint-tsgolint 7.0.2007, TypeScript 7.0.2, effect 4.1.4 and ast-grep 0.51.3.

## Source root and edge file

`typescript.md` applies. Place Effect code by these rows:

- `shared/` holds `Schema` definitions, the `Schema.TaggedError` classes that type each failure, and `effect/rpc` groups.
- Each `client/` file is one `Context.Service` and its `Layer`. A feature reaches it with `yield*`.
- The runtime directory's entry file provides the layers and runs the program. It owns the `run*` ban below.

## Ceiling

`@effect/tsgo` patches the installed oxlint, oxlint-tsgolint and TypeScript so that oxlint carries the Effect rules as `effecttsgo/*`. Read the supported versions from the table between the `supported-components` markers in `node_modules/@effect/tsgo/README.md`. Pin `oxlint`, `oxlint-tsgolint` and `typescript` to exact versions from it, since they often trail npm `latest`. Add `"prepare": "effect-tsgo patch --oxlint"` to the `package.json` scripts.

Turn every Effect rule on by name, since the `strict` preset holds only the rules that are on by default. Generate the list from the patched oxlint after every `@effect/tsgo` upgrade:

```sh
./node_modules/.bin/oxlint -c <(echo '{}') --rules --format=json | node -e '
const rules = JSON.parse(require("fs").readFileSync(0, "utf8"))
  .filter((r) => r.scope === "effecttsgo" && r.category !== "nursery")
  .map((r) => [`effecttsgo/${r.value}`, "error"]);
console.log(JSON.stringify({ plugins: ["effecttsgo"], options: { typeAware: true }, rules: Object.fromEntries(rules) }, null, 2));
' > oxlint-effect.tmp && mv oxlint-effect.tmp oxlint-effect.json
```

The empty `-c` config keeps the repo's own config out of the listing, since that config may name a rule the upgrade removed. Extend the generated file from `.oxlintrc.json`. It brings the `effecttsgo` plugin and type-aware mode with it:

```json
{ "$schema": "./node_modules/@effect/tsgo/oxlint-schema.json", "extends": ["./oxlint-effect.json"] }
```

Keep the language service entry in `tsconfig.json` with its reports off. The patched `tsc` reports every Effect rule a second time when `diagnostics` is `true`.

```json
{ "compilerOptions": { "plugins": [{ "name": "@effect/language-service", "diagnostics": false }] } }
```

Set rule options such as `namespaceImportPackages` and `allowedUnstableApis` in that entry. Oxlint reads them from there.

An unsupported version makes `effect-tsgo patch` exit 1 with `UnsupportedTargetPackageVersionError`. Stock oxlint then rejects the config with `Unknown plugin: 'effecttsgo'`. Either message means a pin or the `prepare` run is wrong.

## Known collisions

This is a starting list. Prove each pair with a file before you turn a side off.

| Pair                                                                         | The file that proves it                                                                                                                                       |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effecttsgo/async-function` and `typescript/promise-function-async`          | A function that returns `Effect.runPromise(...)` fails one rule with `async` and the other without it.                                                        |
| `effecttsgo/prefer-effect-array` and `unicorn/no-array-method-this-argument` | `xs.map(f)` fails the first. `Array.map(xs, f)` from `effect` fails the second.                                                                               |
| `effecttsgo/prefer-namespace-import` and `import/no-namespace`               | Set `namespaceImportPackages: ["effect"]`. `import { Effect } from "effect"` fails the first, and `import * as Option from "effect/Option"` fails the second. |

Effect idioms also trip stock rules. These are not collisions, so each goes to the user in the one list. Expect these:

- `eslint/no-underscore-dangle` on `_tag`, Effect's discriminant.
- `eslint/new-cap` and `unicorn/throw-new-error` on capitalized calls such as `Schema.Struct(...)` and `Schema.TaggedError<X>()(...)`. Offer `{ "capIsNew": false }` for the first.
- `eslint/max-classes-per-file` on tagged errors and services, several per module.
- `eslint/no-redeclare` on a schema and its type, `const Turn` and `type Turn`.
- `eslint/func-names` on `Effect.gen(function* () {})`.
- `eslint/no-magic-numbers` on inline literals such as `Schedule.recurs(3)`.
- `promise/prefer-await-to-callbacks` and `unicorn/no-array-callback-reference`, which misread Effect combinator callbacks and the `Array` module.
- `typescript/prefer-readonly-parameter-types`, since Effect's types are not deeply readonly.
- `typescript/array-type`. Offer `{ "default": "generic", "readonly": "generic" }`, the style of Effect's own source.
- `import/no-named-export`, `import/group-exports`, `import/exports-last` and `import/prefer-default-export`, since Effect modules export each value by name, inline.
- `effecttsgo/unstable-api-usage` and `effecttsgo/api-stability-leak` on Effect's unstable modules, such as `effect/http`. Offer `allowedUnstableApis` with the modules the repo uses before either rule goes off.

## Boundaries

`typescript.md` applies.

## Bans

Ban an Effect function with `eslint/no-restricted-properties` and `property` alone. Effect code calls it through a namespace whose local name varies, such as `Effect.runPromise` or `E.runPromise`. Ban an Effect module with `no-restricted-imports`, as `typescript.md` shows. Turn the ban off in the owner's override. Where the rule also carries bans for other owners, repeat it there with every entry but the owner's.

```jsonc
{
	"rules": {
		"eslint/no-restricted-properties": [
			"error",
			{ "property": "runPromise", "message": "Return the Effect. src/server/main.ts runs it." },
		],
	},
	"overrides": [
		{
			"files": ["src/server/main.ts"],
			"rules": { "eslint/no-restricted-properties": "off" }, // main.ts owns the run functions
		},
	],
}
```

Seed the map with these bans:

| API                                                                                   | Owner                                  | Message                               |
| ------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------- |
| `runPromise`, `runFork`, `runSync`, `runCallback`, with their `Exit` and `With` forms | The runtime's entry file               | Return the Effect. `<entry>` runs it. |
| `effect/http`                                                                         | `client/http.ts`                       | Call `client/http.ts`.                |
| `effect/FileSystem`, `effect/sql`, `effect/persistence`                               | The `client/` file that owns the value | Call `client/<value>.ts`.             |

The `effecttsgo` rules `global-*`, `process-env*`, `node-builtin-import` and `new-promise` already ban the runtime globals everywhere, and each message names the Effect service to use. Give one an owner by turning its rule off in that owner's override.

## Comment check

`typescript.md` applies. Write every Effect suppression as `// oxlint-disable-next-line effecttsgo/<rule>`, which its oxlint pattern allows. Leave `@effect-diagnostics` out of the patterns, so the check flags it. Oxlint obeys that directive, but its unused-directive report never sees it.

## Baseline

`typescript.md` applies. Effect rules land in the same `oxlint --format=json` output with `code` set to `effecttsgo(<rule>)`, so its budget script counts them.

## Check command

`typescript.md` applies. The patched `oxlint` reports the Effect rules and the compiler errors in one run, so the check has no `tsc` step. Install with lifecycle scripts on in CI, so `prepare` runs before the check.
