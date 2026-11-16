# UI properties

The dunify reference for a repo with a web UI. It adds a fourth gate, the **property run**. [Bombadil](https://github.com/antithesishq/bombadil) drives the running app with random actions and fails when a property stops holding. Checked on Bombadil 0.7.10 with a React and Vite app under the TypeScript ceiling.

Bombadil's `terminal` driver is marked experimental. For a terminal UI, ask the user before you build on it.

## Step 2. List the properties

Under the layout map, list one **property** per durable value the UI shows. A property is a sentence that holds in every state, such as "a note the list has shown stays shown". The user approves the properties with the map.

## Step 5. Build the property run

Install `@antithesishq/bombadil` as a dev dependency. Write one specification per UI runtime at `properties/<runtime>.ts`, and add `properties` to the tsconfig `include` so the ceiling covers it:

```ts
import { actions, always } from "@antithesishq/bombadil";
import { extract } from "@antithesishq/bombadil/browser";

const listShown = extract((state) => state.document.querySelector("main ul") !== null);
const noteCount = extract((state) => state.document.querySelectorAll("main li").length);

const notesAreNeverLost = always(() => {
	const shownBefore = listShown.current;
	const countBefore = noteCount.current;

	return always(() => !shownBefore || !listShown.current || noteCount.current >= countBefore);
});

const waitWhileLoading = actions(() => {
	if (listShown.current) {
		return [];
	}

	return ["Wait"];
});

export { notesAreNeverLost, waitWhileLoading };

export * from "@antithesishq/bombadil/browser/defaults";
```

- Import `extract` from `@antithesishq/bombadil/browser`, which types `state`. Import `actions`, `always`, `eventually`, `now` and `next` from `@antithesishq/bombadil`.
- The last line adds Bombadil's own actions and its four default properties: `noUncaughtExceptions`, `noUnhandledPromiseRejections`, `noConsoleErrors` and `noHttpErrorCodes`.
- An extractor runs in every state, the loading state included. Guard each property with a cell that says its value is on screen, or the property fails on the first reload.
- Export an action that returns `["Wait"]` while the app loads. Without it, a state with nothing to click ends the run with `Error: no actions available` and exit 1.

Run it against the running app:

```sh
bombadil browser test --headless --exit-on-violation --time-limit=30s --output-path .bombadil --output-path-overwrite http://localhost:5173 properties/web.ts
```

The run exits 0 at the time limit, 2 on a violation and 1 on any other error. On a violation it prints the property, the state that broke it, and a `--reproduce` command for the trace under `.bombadil`. Add `.bombadil` to `.gitignore`.

The fixture is a static page that breaks one property, since Bombadil takes a `file://` origin. Keep it under `properties/fixtures/`. The gate test expects exit 2 from a run on it.

Done when the run exits 0 on the app and 2 on the fixture.

## Step 6. Existing repos

Run the default properties on the untouched app. Where one fails, replace the `export *` line with `defaultActions` from `@antithesishq/bombadil/browser/defaults` and the names that hold from `@antithesishq/bombadil/browser/defaults/properties`. Put each property that fails on the cleanup plan with its trace.

## Step 7. Add it to the check

The `check` command starts the app on empty data, waits for the origin to answer, runs the property run, and stops what it started.
