# A root labels its terminal with its session tree's spend

herdr-app's status bar shows what the shown tab's pi session has spent at API list prices, delegates at every level included. pi stores a list price on every model call it records: `usage.cost.total` on each reply and on each tool result that called a model, and on the entry itself for a compaction or a branch summary. pi's own footer sums only the root's file, and only messages, so it leaves out every delegate and every compaction.

So the root pi computes the whole tree and herdr-app only draws it, as ADR 0003 does for context. The cost extension (`features/cost/`) follows the root's session file and, through each `delegate-started` entry's `child_session_id`, every delegate's file in the root's `delegates/` folder, at any level. Every two seconds it reads the bytes appended since its last read, up to the last newline, and writes `{ own, delegates }` to the `pi.cost` label on the root's own terminal. It removes the label when the session ends. The status bar (`herdr/mods/ow-status/`) sums the labels of the pi agents in the shown tab.

A fork copies its source's entries with their original timestamps, so an entry older than the session's own header counts in the source and not in the fork.

## Considered options

- **Each agent labels its own terminal, and the bar sums the tree, as the Skills panel does.** Rejected. A delegate's terminal goes away when it settles, and its spend would leave the bar with it. After `/resume`, every earlier delegate is gone.
- **The bar reads the session files.** Rejected. A mod would need to map a terminal to its session file, and a root's file runs to tens of megabytes.
- **Refresh on the root's own events.** Rejected. A delegate's spend lands in the delegate's file, and pi sends the root no event for it. The root would show a running delegate's spend only after its own next turn.

## Consequences

- The bar trails a reply by up to two seconds. A tick stats each file in the tree and reads only what was appended, so an idle tree costs one `stat` per file every two seconds.
- Checked on 8 real session trees with 49 delegates between them: the label matched an independent sum of the same files to the 1/100 cent. One reply's stored cost matched Anthropic's published Opus 5.5 rates.
- The number is what the API would charge. It does not depend on what the account bills, so a subscription session shows a price nobody paid. A model pi has no price for counts as $0.
- Under `--no-session`, or outside herdr-core, there is no label, and the bar shows no cost.
