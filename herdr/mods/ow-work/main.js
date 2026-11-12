import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { theme, props, layout, readTextFile } from "herdr";
import { stateFolder, parseTodo, parseTrail, parseActions } from "./work.js";

// One copy per panel: props().view is "trace" or "actions".
const VIEWS = {
  trace: { title: "Trace", icon: "mods/ow-work/trace.svg", files: ["TODO.md", "decisions.tsv"] },
  actions: { title: "Actions", icon: "mods/ow-work/actions.svg", files: ["USER_ACTION_ITEMS.md"] },
};
const POLL = 2000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const pad = (n) => String(n).padStart(2, "0");

function when(ts) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === new Date().toDateString() ? time : `${MONTHS[date.getMonth()]} ${date.getDate()}, ${time}`;
}

function phaseColor(t, phase) {
  const colors = [t.ansi4, t.ansi5, t.ansi2, t.ansi3, t.ansi6, t.ansi1];
  let hash = 0;
  for (const ch of phase) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}

// Whether this copy's block is on screen: no hidden node above it, and every stack above it shows its branch.
function isShown(view) {
  const path = (node) => {
    if (node?.content?.mod === "ow-work" && node.content.props?.view === view) return [node];
    for (const child of node?.children ?? []) {
      const below = path(child);
      if (below) return [node, ...below];
    }
    return null;
  };
  const nodes = path(layout());
  return nodes !== null && nodes.every((n, i) => !n.hidden && (n.type !== "stack" || n.active === nodes[i + 1]?.id));
}

export default class Work extends View {
  init() {
    this.view = VIEWS[props()?.view] ? props().view : "trace";
    this.folder = undefined;
    this.texts = [];
    this.error = null;
    this.ticking = false;
  }

  // Reads the files at once when the folder changes, then every POLL ms while the panel is on screen.
  follow(cx) {
    const folder = stateFolder();
    if (folder !== this.folder) {
      this.folder = folder;
      this.texts = [];
      this.error = null;
      this.load(cx);
    }
    if (!this.ticking && isShown(this.view)) {
      this.ticking = true;
      this.load(cx);
      cx.timer.after(POLL, (cx) => this.tick(cx));
    }
  }

  tick(cx) {
    if (!isShown(this.view)) { this.ticking = false; return; }
    this.load(cx);
    cx.timer.after(POLL, (cx) => this.tick(cx));
  }

  load(cx) {
    const folder = this.folder;
    if (!folder) return;
    cx.spawn(async (cx) => {
      // readTextFile resolves null for a missing file, so a rejection is a failed read: say so, never "nothing here".
      let texts = this.texts, error = null;
      try {
        texts = await Promise.all(VIEWS[this.view].files.map((name) => readTextFile(`${folder}/${name}`)));
      } catch (e) {
        error = String(e?.message ?? e);
      }
      if (folder !== this.folder || (error === this.error && texts.every((text, i) => text === this.texts[i]))) return;
      this.texts = texts;
      this.error = error;
      cx.notify();
    });
  }

  header(t, right) {
    const work = this.folder?.split("/").slice(-2).join(" / ");
    return h_flex().h(42).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child(VIEWS[this.view].title))
      .when(Boolean(work), (el) => el.child(div().id("work").min_w(0).truncate().text_size(11).text_color(t.dim).tooltip(this.folder).child(work)))
      .child(div().flex_1())
      .when(Boolean(right), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(right)));
  }

  empty(t, title, body) {
    return v_flex().flex_1().items_center().justify_center().gap(6).p(24)
      .child(svg(VIEWS[this.view].icon).size(18).text_color(t.dim))
      .child(div().text_color(t.muted).font_semibold().child(title))
      .child(div().text_size(12).text_color(t.dim).text_center().max_w(240).child(body));
  }

  section(t, title, right) {
    return h_flex().gap(8).items_center().text_size(11)
      .child(div().font_semibold().text_color(t.muted).child(title))
      .child(div().flex_1().h(1).bg(t.border))
      .when(Boolean(right), (el) => el.child(div().text_color(t.dim).child(right)));
  }

  marker(t, item) {
    const ring = (color) => div().size(14).flex_none().rounded(7).border_1().border_color(color);
    if (item.state === "done") return div().size(14).flex_none().rounded(7).bg(t.ansi2).flex().items_center().justify_center()
      .child(svg("mods/ow-work/check.svg").size(9).text_color(t.background));
    if (item.state === "skipped") return ring(t.dim).flex().items_center().justify_center().child(div().w(6).h(1.5).bg(t.dim));
    if (item.current) return ring(t.accent).border_2().flex().items_center().justify_center().child(div().size(4).rounded(2).bg(t.accent));
    return ring(t.dim);
  }

  todo(t, todo) {
    const row = (item, key) => {
      if (item.state === "text") return div().id(key).pl(24).text_size(12).text_color(t.muted).child(item.text);
      const color = item.state === "skipped" ? t.dim : item.state === "done" ? t.muted : t.foreground;
      return h_flex().id(key).items_start().gap(10).px(6).py(4).rounded(6)
        .when(Boolean(item.current), (el) => el.bg(t.raised))
        .child(div().pt(2).child(this.marker(t, item)))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(h_flex().items_start().gap(6)
            .when(item.number !== null, (el) => el.child(div().flex_none().text_color(t.dim).child(`${item.number}.`)))
            .child(div().flex_1().min_w(0).text_color(color).when(item.state === "skipped", (el) => el.line_through()).child(item.text)))
          .when(item.reason !== null, (el) => el.child(div().text_size(11.5).text_color(t.dim).child(`Skipped: ${item.reason}`))))
        .when(Boolean(item.current), (el) => el.child(div().flex_none().mt(1).px(6).py(1).rounded(4).text_size(10).font_semibold().bg(t.accent).text_color(t.accent_foreground).child("NOW")));
    };
    const share = todo.total === 0 ? 0 : todo.resolved / todo.total;
    return v_flex().gap(8)
      .child(this.section(t, "Todo", `${todo.resolved} of ${todo.total}`))
      .child(div().h(3).rounded(2).bg(t.border).child(div().h_full().rounded(2).bg(t.ansi2).w(`${Math.round(share * 100)}%`)))
      .children(todo.groups.map((group, g) => v_flex().gap(1)
        .when(group.name !== null, (el) => el.child(h_flex().pt(4).pb(2).px(6).gap(6).items_center().text_size(11.5).font_semibold().text_color(t.muted)
          .when(group.name !== "task", (el) => el.child(svg("mods/ow-skills/playbook.svg").size(12).text_color(t.ansi2)))
          .child(group.name)))
        .children(group.items.map((item, i) => row(item, `todo-${g}-${i}`)))));
  }

  trail(t, rows) {
    const decisions = rows.filter((r) => r.kind === "row").length;
    const row = (r, key) => {
      if (r.kind === "text") return div().id(key).py(4).text_size(12).text_color(t.muted).child(r.text);
      if (r.kind === "start") return v_flex().id(key).py(6).gap(3)
        .child(h_flex().gap(8).items_center().text_size(10.5).text_color(t.dim)
          .child(div().flex_1().h(1).bg(t.border)).child(`New run · ${when(r.ts)}`).child(div().flex_1().h(1).bg(t.border)))
        .when(Boolean(r.decision), (el) => el.child(div().text_size(11.5).text_color(t.dim).text_center().child(r.decision)));
      const color = phaseColor(t, r.phase);
      return h_flex().id(key).items_start().gap(10).py(6)
        .child(div().pt(5).child(div().size(7).rounded(4).bg(color)))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().gap(6).text_size(11)
            .child(div().text_color(t.dim).child(when(r.ts)))
            .child(div().text_color(color).child(r.phase)))
          .child(div().text_color(t.foreground).child(r.decision))
          .when(Boolean(r.why), (el) => el.child(div().text_size(12).text_color(t.muted).child(r.why)))
          .when(Boolean(r.result), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(`→ ${r.result}`)))
          .when(Boolean(r.evidence), (el) => el.child(div().id(`${key}-evidence`).truncate().text_size(11.5).text_color(t.dim).tooltip(r.evidence).child(r.evidence))));
    };
    return v_flex().gap(4)
      .child(this.section(t, "Decisions", plural(decisions, "decision")))
      .children(rows.map((r, i) => row(r, `row-${i}`)));
  }

  traceBody(t) {
    const [todoText, trailText] = this.texts;
    const todo = todoText ? parseTodo(todoText) : null;
    const rows = trailText ? parseTrail(trailText) : [];
    if (!todo?.groups.length && rows.length === 0) return this.empty(t, "Nothing traced yet", "The todo list and the decisions show here once the agent writes TODO.md or decisions.tsv.");
    return v_flex().id("trace-list").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(18)
      .when(Boolean(todo?.groups.length), (el) => el.child(this.todo(t, todo)))
      .when(rows.length > 0, (el) => el.child(this.trail(t, rows)));
  }

  actionsBody(t, actions) {
    if (actions.items.length === 0) return this.empty(t, "Nothing waits on you", actions.note || "Calls the agent leaves for you show here.");
    const card = (item, i) => v_flex().id(`item-${i}`).gap(8).p(12).rounded(8).bg(t.surface).border_1().border_color(t.border)
      .child(h_flex().items_start().gap(10)
        .child(div().size(20).flex_none().rounded(10).bg(t.blocked).text_color(t.background).text_size(11).font_semibold()
          .flex().items_center().justify_center().child(String(i + 1)))
        .child(div().flex_1().min_w(0).pt(1).font_semibold().text_color(t.foreground).child(item.title)))
      .when(Boolean(item.body), (el) => el.child(div().pl(30).text_size(12.5).text_color(t.muted).child(TextView.markdown(`body-${i}`, item.body).selectable(true))));
    return v_flex().id("actions-list").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(10)
      .when(Boolean(actions.note), (el) => el.child(div().text_size(12).text_color(t.dim).child(actions.note)))
      .children(actions.items.map(card));
  }

  render(cx) {
    const t = theme();
    this.follow(cx);
    let body, right = null;
    if (!this.folder) {
      body = this.empty(t, "No work here", "Focus a pi agent that keeps its work in a state folder to see it here.");
    } else if (this.error) {
      body = this.empty(t, "Could not read this work", this.error);
    } else if (this.view === "trace") {
      body = this.traceBody(t);
    } else {
      const actions = parseActions(this.texts[0] ?? "");
      if (actions.items.length > 0) right = `${actions.items.length} waiting`;
      body = this.actionsBody(t, actions);
    }
    return v_flex().id("work").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13)
      .child(this.header(t, right))
      .child(body);
  }
}
