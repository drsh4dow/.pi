---
description: Run a web performance audit via the web-performance-auditor persona
argument-hint: "[url or files]"
---

`/webperf` targets web applications specifically. Do not use it for utility libraries, CLIs, or server-only code with no browser-facing output.

## Determine the mode

**Deep mode** — activate when any of these is available:

- A Lighthouse JSON report file (e.g. `npx lighthouse <url> --output json --output-path ./report.json`)
- A PageSpeed Insights JSON response (includes Lighthouse + CrUX)
- A CrUX API response (requires `CRUX_API_KEY` or `GOOGLE_API_KEY`)
- A DevTools performance trace
- A live URL (the agent can capture metrics directly with the `agent-browser` skill: `agent-browser vitals` and `agent-browser profiler`)

**Quick mode** — default when none of the above are available. The agent scans source code for structural anti-patterns and labels every finding as `potential impact`.

## Run the audit

Start a delegate with `instructionsFile: "~/.pi/agent/instructions/web-performance-auditor.md"`. Pass it explicitly, in its `message`:

- The files, components, or diff under review
- Any artifact paths (Lighthouse JSON, PSI JSON, CrUX response, trace) or pasted JSON content
- The target URL or page name when known: ${@:-not given}
- A note on which mode you expect (Quick or Deep), so the agent surfaces missing inputs if Deep was intended

The delegate returns a scorecard (only populated with sourced values), a ranked list of findings, positive observations, and proactive recommendations.

## Output

Return the full audit report to the user. No synthesis or merge step is needed — this is a single-persona command.
