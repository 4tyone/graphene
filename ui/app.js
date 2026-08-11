/* Graphene UI — read-only.
   The only path back to an agent is the clipboard: copy a node id, paste it
   into a fresh session. There is no write endpoint to call. */

const SVG = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);

const state = {
  graph: null,
  fold: null,
  awaiting: [],
  selected: new Set(),
  view: { x: 0, y: 0, k: 1 },
  // Set once the user pans or zooms; from then on the view is theirs to keep.
  viewPinned: false,
  /// Every graph in the store, refreshed alongside the fold so the picker is
  /// never showing counts from ten minutes ago.
  graphs: [],
  /// Last-rendered signatures. A poll that changes nothing must not redraw
  /// anything, or every entry animation replays four times a minute.
  inboxSig: null,
  pickerSig: null,
  detailSig: null,
  /// The node the canvas was last panned to, so a re-render does not pan again.
  focused: null,
  stream: null,
  layout: null,
  seq: 0,
};

// ─────────────────────────────────────────────────────── layered DAG layout
//
// Written here rather than pulled from npm: the binary embeds these assets and
// must build with no network. A Sugiyama-lite pass is ~90 lines and gives a
// readable left-to-right graph, which is all this view needs.

const NODE_W = 196, NODE_H = 56, GAP_X = 70, GAP_Y = 24;

function layout(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const preds = new Map(nodes.map((n) => [n.id, []]));
  const succs = new Map(nodes.map((n) => [n.id, []]));

  for (const [from, to] of edges) {
    if (!byId.has(from) || !byId.has(to)) continue;
    succs.get(from).push(to);
    preds.get(to).push(from);
  }

  // Longest-path layering: a node sits one column right of its deepest input.
  const depth = new Map();
  const resolve = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const d = preds.get(id).length
      ? Math.max(...preds.get(id).map((p) => resolve(p, seen))) + 1
      : 0;
    depth.set(id, d);
    return d;
  };
  nodes.forEach((n) => resolve(n.id));

  const columns = [];
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    (columns[d] ||= []).push(n.id);
  }

  // Barycentre ordering, a few sweeps. Reduces crossings enough to read.
  const pos = new Map();
  columns.forEach((col) => col.forEach((id, i) => pos.set(id, i)));

  for (let sweep = 0; sweep < 4; sweep++) {
    const forward = sweep % 2 === 0;
    const order = forward ? columns : [...columns].reverse();
    for (const col of order) {
      const bary = new Map();
      for (const id of col) {
        const neigh = forward ? preds.get(id) : succs.get(id);
        const vals = neigh.map((n) => pos.get(n)).filter((v) => v !== undefined);
        bary.set(id, vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : pos.get(id));
      }
      col.sort((a, b) => bary.get(a) - bary.get(b));
      col.forEach((id, i) => pos.set(id, i));
    }
  }

  const tallest = Math.max(1, ...columns.map((c) => c.length));
  const placed = new Map();
  columns.forEach((col, ci) => {
    const colH = col.length * NODE_H + (col.length - 1) * GAP_Y;
    const top = ((tallest * NODE_H + (tallest - 1) * GAP_Y) - colH) / 2;
    col.forEach((id, ri) => {
      placed.set(id, {
        x: ci * (NODE_W + GAP_X),
        y: top + ri * (NODE_H + GAP_Y),
      });
    });
  });

  return {
    placed,
    width: columns.length * NODE_W + Math.max(0, columns.length - 1) * GAP_X,
    height: tallest * NODE_H + Math.max(0, tallest - 1) * GAP_Y,
  };
}

// ─────────────────────────────────────────────────────── rendering

function draw() {
  const svg = $("graph");
  svg.replaceChildren();
  if (!state.fold) return;

  const nodes = Object.values(state.fold.nodes || {});
  $("canvas-empty").hidden = nodes.length > 0;
  if (!nodes.length) return;

  const edges = (state.fold.edges || []).map((e) => [e[0], e[1], e[2]]);
  const lay = layout(nodes, edges);
  state.layout = lay;

  const root = el("g", { id: "viewport" });
  svg.append(root);

  const edgeLayer = el("g");
  const nodeLayer = el("g");
  root.append(edgeLayer, nodeLayer);

  for (const [from, to, kind] of edges) {
    const a = lay.placed.get(from), b = lay.placed.get(to);
    if (!a || !b) continue;
    const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
    const x2 = b.x, y2 = b.y + NODE_H / 2;
    const mid = x1 + (x2 - x1) / 2;
    const hot = liveNode(state.fold.nodes[from]) || liveNode(state.fold.nodes[to]);
    edgeLayer.append(
      el("path", {
        class: "edge",
        "data-kind": kind === "model-decided" ? "model-decided" : "deterministic",
        "data-hot": hot ? "1" : "0",
        d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`,
      })
    );
    edgeLayer.append(
      el("path", {
        class: hot ? "arrow arrow-hot" : "arrow",
        d: `M${x2},${y2} l-6,-3.4 v6.8 z`,
      })
    );
  }

  for (const n of nodes) {
    const p = lay.placed.get(n.id);
    if (!p) continue;
    nodeLayer.append(nodeGlyph(n, p));
  }

  applyView();
}

function nodeGlyph(n, p) {
  const kind = n.spec?.kind ?? "agent";
  const g = el("g", {
    class: "node",
    "data-s": n.state,
    "data-sel": state.selected.has(n.id) ? "1" : "0",
    transform: `translate(${p.x},${p.y})`,
  });

  if (n.state === "awaiting") {
    g.append(el("rect", {
      class: "halo", x: -3, y: -3, width: NODE_W + 6, height: NODE_H + 6, rx: 5,
      style: `transform-origin:${NODE_W / 2}px ${NODE_H / 2}px`,
    }));
  }

  g.append(el("rect", { class: "n-box", width: NODE_W, height: NODE_H, rx: 3 }));
  g.append(el("rect", { class: "n-tick", x: 0, y: 0, width: 3, height: NODE_H, rx: 1.5 }));

  const name = el("text", { class: "n-name", x: 14, y: 24 });
  name.textContent = clip(n.name, 23);
  g.append(name);

  const meta = el("text", { class: "n-kind", x: 14, y: 41 });
  meta.textContent = kind.toUpperCase();
  g.append(meta);

  const holder = sessionHolding(n.id);
  if (holder) {
    const s = el("text", { class: "n-session", x: NODE_W - 13, y: 41, "text-anchor": "end" });
    s.textContent = clip(holder, 14);
    g.append(s);
  } else if (n.state !== "done") {
    const st = el("text", { class: "n-state", x: NODE_W - 13, y: 41, "text-anchor": "end" });
    st.textContent = n.state.toUpperCase();
    g.append(st);
  }

  if (nodeInJeopardy(n)) {
    g.append(el("circle", { class: "n-jeopardy", cx: NODE_W - 14, cy: 20, r: 3.4 }));
  }

  g.addEventListener("click", (ev) => {
    if (ev.shiftKey) toggleSelect(n.id);
    else selectOnly(n.id);
  });
  return g;
}

function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m` : `${Math.round(m / 60)}h`;
}

/// What the inbox actually draws. Rebuilding when this has not changed replays
/// every card's entry animation on each poll, which reads as a flicker.
function inboxSignature(awaiting) {
  return JSON.stringify(
    awaiting.map((h) => [
      h.node,
      h.ask,
      h.asked_at,
      h.escalated_after_ms ?? null,
      (h.context || []).map((c) => [c.id, c.state, c.stale]),
    ]),
  );
}

function renderInbox() {
  const sig = inboxSignature(state.awaiting);
  if (sig === state.inboxSig) return;
  state.inboxSig = sig;

  const list = $("inbox-list");
  list.replaceChildren();
  const count = state.awaiting.length;
  $("awaiting-count").textContent = count;
  $("awaiting-count").dataset.zero = count ? "0" : "1";
  $("inbox-empty").hidden = count > 0;

  state.awaiting.forEach((h, i) => {
    const jeopardy = (h.context || []).filter(inJeopardy);
    const card = node("article", "ask-card");
    card.dataset.jeopardy = jeopardy.length ? "1" : "0";
    card.style.animationDelay = `${Math.min(i, 8) * 45}ms`;

    const q = node("p", "ask-q");
    q.textContent = h.ask;
    card.append(q);

    // An escalation nobody can see is the same as no escalation: an overdue
    // gate has to read differently from a patient one.
    if (h.escalated_after_ms != null) {
      card.dataset.overdue = "1";
      const esc = node("div", "overdue");
      esc.textContent = `overdue — escalated after ${duration(h.escalated_after_ms)}`;
      card.append(esc);
    }

    // The whole reason beliefs and work share a graph: an approver must see
    // that a premise died before acting on the draft resting on it.
    if (jeopardy.length) {
      const warn = node("div", "jeopardy");
      warn.innerHTML =
        `<svg viewBox="0 0 16 16"><path d="M8 1.6 15 14.4H1z" opacity=".9"/></svg>` +
        `<span>${jeopardy.length === 1 ? "a premise" : jeopardy.length + " premises"} ` +
        `${jeopardy.length === 1 ? "has" : "have"} died since this was drafted</span>`;
      card.append(warn);
    }

    if ((h.context || []).length) {
      const ul = node("ul", "ask-context");
      h.context.slice(0, 4).forEach((c) => {
        const li = document.createElement("li");
        li.append(chipFor(c), textNode("span", "sum", clip(c.summary, 96)));
        ul.append(li);
      });
      if (h.context.length > 4) ul.dataset.more = `+${h.context.length - 4} more`;
      card.append(ul);
    }

    const foot = node("div", "ask-foot");
    foot.append(textNode("span", "ask-age", ageOf(h)));
    foot.append(node("span", "grow"));
    foot.append(copyButton(h.node, "copy id"));
    card.append(foot);

    card.addEventListener("click", (ev) => {
      if (ev.target.closest("button")) return;
      selectOnly(h.node);
    });
    list.append(card);
  });
}

function renderDetail() {
  const body = $("detail-body");
  const stage = document.querySelector(".stage");
  const [id] = [...state.selected];

  // Rebuilding on every poll threw away your scroll position, which on a long
  // output means the panel snapped to the top every four seconds. `seq` only
  // moves when something actually happened.
  const sig = `${id ?? ""}|${state.seq}`;
  if (sig === state.detailSig) return;
  state.detailSig = sig;

  if (!id || !state.fold) {
    stage.dataset.detail = "closed";
    body.hidden = true;
    $("detail-empty").hidden = false;
    return;
  }

  const n = state.fold.nodes?.[id];
  if (!n) return;
  stage.dataset.detail = "open";
  $("detail-empty").hidden = true;
  body.hidden = false;
  body.replaceChildren();

  const head = node("div", "d-head");
  head.append(textNode("h2", "d-name", n.name));
  const idline = node("div", "d-id");
  const code = document.createElement("code");
  code.textContent = id;
  idline.append(code, copyButton(id, "copy"));
  head.append(idline);
  body.append(head);

  const human = state.awaiting.find((h) => h.node === id);

  body.append(
    section("state", rows([
      ["state", n.state],
      ["kind", n.spec?.kind ?? "agent"],
      ["capability", n.capability],
      ["attempts", n.attempts ?? 0],
      ["holder", sessionHolding(id) ?? "—"],
    ]))
  );

  if (human) {
    const wrap = node("div");
    wrap.append(textNode("p", "ask-q", human.ask));
    (human.context || []).forEach((c) => wrap.append(beliefCard(c)));
    body.append(section("the ask", wrap));

    const conseq = (human.consequence || [])
      .map(([choice, unblocks]) => [choice, unblocks.length ? `unblocks ${unblocks.length}` : "unblocks nothing"]);
    if (conseq.length) body.append(section("consequence", rows(conseq)));
  }

  if (n.bindings?.length) {
    body.append(section("inputs", rows(
      n.bindings.map((b) => [b.into, `${b.select} ← ${shortId(b.from)}`])
    )));
  }

  if (n.output) body.append(section("output", pre(n.output), sizeOf(n.output)));
  if (n.checkpoints?.length) {
    body.append(section(`checkpoints (${n.checkpoints.length})`, pre(n.checkpoints.at(-1).state)));
  }

  const spend = n.spend || {};
  if (spend.tokens || spend.micros_usd) {
    body.append(section("spend", rows([
      ["tokens", spend.tokens ?? 0],
      ["usd", ((spend.micros_usd ?? 0) / 1e6).toFixed(4)],
    ])));
  }

  if (n.failure) body.append(section("failure", textNode("p", "b-why", n.failure)));
}

function beliefCard(c) {
  const d = node("div", "d-belief");
  d.dataset.jeopardy = inJeopardy(c) ? "1" : "0";
  d.append(textNode("div", "b-sum", c.summary));
  const meta = node("div", "b-meta");
  meta.append(chipFor(c));
  meta.append(chip(c.fidelity, { f: c.fidelity }));
  meta.append(chip(c.source, {}));
  d.append(meta);
  if (c.contradiction) d.append(textNode("div", "b-why", c.contradiction));
  else if (c.stale) d.append(textNode("div", "b-why", "its source changed after this was read"));
  return d;
}

function renderHeader() {
  const g = state.fold?.graph;
  $("graph-title").textContent = g?.title ?? "No graph";
  $("graph-task").textContent = g?.task ?? "";

  const n = Object.values(state.fold?.nodes || {});
  const by = (s) => n.filter((x) => x.state === s).length;
  const contested = Object.values(state.fold?.beliefs || {})
    .filter((b) => b.state === "both" || b.stale).length;

  const counts = [
    ["awaiting", by("awaiting"), "c-awaiting"],
    ["running", by("running") + by("claimed"), ""],
    ["done", by("done"), ""],
    ["contested", contested, "c-contested"],
  ];
  $("counts").replaceChildren(...counts.map(([label, v, cls]) => {
    const s = node("div", `count ${cls}`);
    s.append(textNode("b", "", v), document.createTextNode(" "), textNode("span", "", label));
    return s;
  }));
}

// ─────────────────────────────────────────────────────── helpers

const liveNode = (n) => n && (n.state === "running" || n.state === "claimed");
const inJeopardy = (c) => c.stale || c.state === "both" || c.state === "out";

function nodeInJeopardy(n) {
  const h = state.awaiting.find((a) => a.node === n.id);
  return h ? (h.context || []).some(inJeopardy) : false;
}

function sessionHolding(nodeId) {
  const claimId = state.fold?.active_claims?.[nodeId];
  if (!claimId) return null;
  return state.fold?.claims?.[claimId]?.session ?? null;
}

function chipFor(c) {
  const s = c.stale ? "stale" : (c.state || "").toLowerCase();
  return chip(c.stale ? "stale" : c.state, { s });
}

function chip(text, data) {
  const c = node("span", "chip");
  c.textContent = String(text ?? "").toLowerCase();
  Object.entries(data).forEach(([k, v]) => v && (c.dataset[k] = String(v).toLowerCase()));
  return c;
}

function copyButton(value, label) {
  const b = node("button", "copy");
  b.textContent = label;
  b.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    await copy(value);
    b.textContent = "copied";
    b.classList.add("done");
    setTimeout(() => { b.textContent = label; b.classList.remove("done"); }, 1400);
  });
  return b;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.append(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
  toast("copied — paste it into an agent session");
}

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.dataset.show = "1";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.dataset.show = "0"), 2200);
}

function section(title, content, note) {
  const s = node("div", "d-sec");
  const h = textNode("h3", "", title);
  if (note) h.append(textNode("span", "d-note", note));
  s.append(h);
  s.append(content);
  return s;
}

function rows(pairs) {
  const dl = node("dl", "d-rows");
  for (const [k, v] of pairs) {
    const r = node("div", "d-row");
    r.append(textNode("dt", "", k), textNode("dd", "", String(v)));
    dl.append(r);
  }
  return dl;
}

/// A node's output can be arbitrarily large. Rendered whole and unwrapped it
/// makes the panel scroll forever and pushes long string values off to the
/// right, so it gets its own bounded, wrapping box — with its size on the label
/// when it is big enough to be worth knowing.
function pre(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const p = node("pre", "d-json");
  p.textContent = text;
  const lines = text.split("\n").length;
  if (lines > 14 || text.length > 1200) p.dataset.big = "1";
  return p;
}

function sizeOf(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const lines = text.split("\n").length;
  if (lines <= 14 && text.length <= 1200) return null;
  return `${lines} lines`;
}

const node = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
const textNode = (tag, cls, text) => { const e = node(tag, cls); e.textContent = text; return e; };
const el = (tag, attrs = {}) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s ?? "");
const shortId = (id) => (id ? id.slice(0, 9) + "…" : "");

function ageOf(h) {
  if (!h.asked_at) return "waiting";
  return `waiting · seq ${h.asked_at}`;
}

// ─────────────────────────────────────────────────────── selection & view

function selectOnly(id) { state.selected = new Set([id]); afterSelect(); }
function toggleSelect(id) {
  state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
  afterSelect();
}
function afterSelect() {
  document.querySelectorAll(".node").forEach((g) => {
    const id = nodeIdOf(g);
    g.dataset.sel = state.selected.has(id) ? "1" : "0";
  });
  $("copy-selection").disabled = state.selected.size === 0;
  renderDetail();

  // Bring the selection into view rather than re-centring the whole graph —
  // the panel just changed the canvas width, and what you clicked matters more
  // than the overview. Only when the selection *changed*: a poll that selects
  // the same node again must not drag the canvas back under the cursor.
  const [first] = [...state.selected];
  if (first && first !== state.focused) {
    state.focused = first;
    setTimeout(() => focusNode(first), 340);
  } else if (!first) {
    state.focused = null;
  }
}

function reframe() {
  if (state.viewPinned) return applyView();
  const [first] = [...state.selected];
  if (first) focusNode(first);
  else fit();
}

function focusNode(id) {
  const p = state.layout?.placed.get(id);
  if (!p) return;
  const c = $("canvas").getBoundingClientRect();
  const { k } = state.view;
  const cx = (p.x + NODE_W / 2) * k;
  const cy = (p.y + NODE_H / 2) * k;
  const margin = 90;

  let { x, y } = state.view;
  if (cx + x < margin) x = margin - cx;
  if (cx + x > c.width - margin) x = c.width - margin - cx;
  if (cy + y < margin) y = margin - cy;
  if (cy + y > c.height - margin) y = c.height - margin - cy;

  state.view.x = x;
  state.view.y = y;
  applyView();
}

function nodeIdOf(g) {
  const t = g.getAttribute("transform") || "";
  const m = t.match(/translate\(([\d.-]+),([\d.-]+)\)/);
  if (!m || !state.layout) return null;
  for (const [id, p] of state.layout.placed) {
    if (Math.abs(p.x - +m[1]) < .5 && Math.abs(p.y - +m[2]) < .5) return id;
  }
  return null;
}

function applyView() {
  const vp = $("graph").querySelector("#viewport");
  if (!vp) return;
  const { x, y, k } = state.view;
  vp.setAttribute("transform", `translate(${x},${y}) scale(${k})`);
}

function fit() {
  if (!state.layout) return;
  const c = $("canvas").getBoundingClientRect();
  if (c.width < 10) { requestAnimationFrame(fit); return; }
  // Never shrink below legibility. A wide graph overflows and the user pans —
  // an unreadable overview is worse than a partial one.
  const pad = 48;
  const k = Math.max(
    0.82,
    Math.min(
      1.3,
      (c.width - pad * 2) / Math.max(1, state.layout.width),
      (c.height - pad * 2) / Math.max(1, state.layout.height)
    )
  );
  state.view = {
    k,
    x: (c.width - state.layout.width * k) / 2,
    y: (c.height - state.layout.height * k) / 2,
  };
  applyView();
}

function wireCanvas() {
  const canvas = $("canvas");
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;

  canvas.addEventListener("mousedown", (e) => {
    if (e.target.closest(".node")) return;
    dragging = true; state.viewPinned = true;
    sx = e.clientX; sy = e.clientY;
    ox = state.view.x; oy = state.view.y;
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    state.view.x = ox + (e.clientX - sx);
    state.view.y = oy + (e.clientY - sy);
    applyView();
  });
  window.addEventListener("mouseup", () => (dragging = false));

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    state.viewPinned = true;
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const next = Math.max(.28, Math.min(2.4, state.view.k * (e.deltaY < 0 ? 1.09 : 1 / 1.09)));
    const ratio = next / state.view.k;
    state.view.x = mx - (mx - state.view.x) * ratio;
    state.view.y = my - (my - state.view.y) * ratio;
    state.view.k = next;
    applyView();
  }, { passive: false });

  $("fit").addEventListener("click", () => { state.viewPinned = false; fit(); });

  // The detail panel opening shrinks the canvas without firing a window resize,
  // which left the graph clipped at its old offset. React to the element's own
  // box instead — keeping the selection in view rather than re-centring on top
  // of `focusNode`, and leaving the view alone once the user has taken it over.
  new ResizeObserver(() => reframe()).observe(canvas);
  $("copy-selection").addEventListener("click", () => copy([...state.selected].join("\n")));
  canvas.addEventListener("click", (e) => {
    if (!e.target.closest(".node") && !e.shiftKey) { state.selected.clear(); afterSelect(); }
  });
}

// ─────────────────────────────────────────────────────── the graph picker

/// Attention first, then whatever moved most recently. A store with fifty
/// finished graphs and one waiting on a person should open on the one waiting.
function pickerOrder(graphs) {
  const rank = (g) => (g.nodes_awaiting > 0 ? 0 : g.beliefs_contested > 0 ? 1 : g.nodes_outstanding > 0 ? 2 : 3);
  return [...graphs].sort((a, b) => rank(a) - rank(b) || (b.updated_at ?? 0) - (a.updated_at ?? 0));
}

function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function pickerSignature(graphs) {
  return JSON.stringify(
    graphs.map((g) => [
      g.id, g.title, g.state, g.nodes_done, g.nodes_total,
      g.nodes_awaiting, g.beliefs_contested, g.updated_at,
    ]),
  );
}

/// `force` for the filter box, where the data has not changed but what to show
/// has.
function renderPicker(force = false) {
  const q = $("picker-filter").value.trim().toLowerCase();
  const sig = pickerSignature(state.graphs || []) + "|" + q + "|" + state.graph;
  if (!force && sig === state.pickerSig) return;
  state.pickerSig = sig;

  const list = $("picker-list");
  const all = pickerOrder(state.graphs || []);
  const shown = q
    ? all.filter((g) =>
        (g.title || "").toLowerCase().includes(q) ||
        (g.task || "").toLowerCase().includes(q) ||
        (g.tags || []).some((t) => t.toLowerCase().includes(q)))
    : all;

  $("picker-count").textContent = q ? `${shown.length}/${all.length}` : `${all.length}`;
  $("picker-empty").hidden = shown.length > 0;
  list.replaceChildren();

  for (const g of shown) {
    const row = node("button", "g-row");
    row.type = "button";
    row.dataset.state = g.state;
    row.dataset.current = g.id === state.graph ? "1" : "0";
    row.dataset.attention = g.nodes_awaiting > 0 || g.beliefs_contested > 0 ? "1" : "0";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", g.id === state.graph ? "true" : "false");

    row.append(node("span", "g-dot"));

    const main = node("div", "g-main");
    main.append(textNode("div", "g-title", g.title || g.task || g.id));

    const sub = node("div", "g-sub");
    sub.append(textNode("span", "", g.state));
    sub.append(textNode("span", "", `${g.nodes_done}/${g.nodes_total} done`));
    if (g.nodes_awaiting > 0) {
      sub.append(textNode("span", "warn", `${g.nodes_awaiting} awaiting you`));
    }
    if (g.beliefs_contested > 0) {
      sub.append(textNode("span", "bad", `${g.beliefs_contested} contested`));
    }
    for (const t of (g.tags || []).slice(0, 3)) sub.append(textNode("span", "g-tag", t));
    main.append(sub);
    row.append(main);

    row.append(textNode("span", "g-when", ago(g.updated_at)));
    row.addEventListener("click", () => switchGraph(g.id));
    list.append(row);
  }
}

/// Switching is a reload of the fold, not of the page — the socket is already
/// open and the URL should stay shareable.
async function switchGraph(id) {
  closePicker();
  if (id === state.graph) return;
  state.graph = id;
  state.fold = null;
  state.seq = 0;
  state.selected.clear();
  state.viewPinned = false;
  state.layout = null;
  state.inboxSig = null;
  state.pickerSig = null;
  state.detailSig = null;
  state.focused = null;

  const url = new URL(location.href);
  url.searchParams.set("graph", id);
  history.replaceState(null, "", url);

  await load(true);
  subscribe();
}

function openPicker() {
  renderPicker(true);
  $("picker").hidden = false;
  $("graph-switch").setAttribute("aria-expanded", "true");
  const f = $("picker-filter");
  f.value = "";
  f.focus();
}

function closePicker() {
  $("picker").hidden = true;
  $("graph-switch").setAttribute("aria-expanded", "false");
}

function wirePicker() {
  $("graph-switch").addEventListener("click", () =>
    $("picker").hidden ? openPicker() : closePicker());
  $("picker-scrim").addEventListener("click", closePicker);
  $("picker-filter").addEventListener("input", () => renderPicker(true));

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("picker").hidden) { closePicker(); return; }
    // `g` opens it, unless you are typing somewhere.
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "");
    if (e.key === "g" && !typing && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      $("picker").hidden ? openPicker() : closePicker();
    }
  });
}

// ─────────────────────────────────────────────────────── data

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

async function load(first = false) {
  try {
    if (!state.graph) {
      const params = new URLSearchParams(location.search);
      const wanted = params.get("graph");
      const graphs = await api("/api/graphs");
      state.graphs = graphs;
      const pick = wanted ? graphs.find((g) => g.id === wanted) : pickLiveliest(graphs);
      if (!pick) { document.documentElement.dataset.state = "empty"; return; }
      state.graph = pick.id;
    }

    const [fold, awaiting, graphs] = await Promise.all([
      api(`/api/graph/${state.graph}`),
      api(`/api/awaiting/${state.graph}`).catch(() => []),
      api("/api/graphs").catch(() => state.graphs),
    ]);
    state.graphs = graphs;

    const changed = fold.seq !== state.seq;
    state.fold = fold;
    state.awaiting = awaiting;
    state.seq = fold.seq;

    renderHeader();
    renderInbox();
    renderPicker();
    // A push can add or drop a node, so the view has to follow the new bounds —
    // otherwise a live update quietly moves something off-canvas. `reframe`
    // leaves the view alone once the user has panned or zoomed.
    if (changed || first) { draw(); requestAnimationFrame(reframe); }
    afterSelect();
    setConn("open");
    document.documentElement.dataset.state = "ready";
  } catch {
    setConn("lost");
  }
}

/** Prefer a graph that needs a person, then one that is running. */
function pickLiveliest(graphs) {
  const rank = (g) =>
    (g.nodes_awaiting > 0 ? 0 : 1) * 10 + (g.state === "running" ? 0 : 1);
  return [...graphs].sort((a, b) => rank(a) - rank(b) || b.updated_at - a.updated_at)[0];
}

function setConn(status) {
  document.documentElement.dataset.conn = status;
  const c = $("conn");
  c.dataset.c = status;
  c.textContent = status === "open" ? "connected" : "reconnecting…";
}

function subscribe() {
  if (!state.graph) return;
  // The stream is per-graph, so switching has to drop the old one or the view
  // keeps waking on a graph nobody is looking at.
  state.stream?.close();
  const src = new EventSource(`/events?graph=${state.graph}`);
  state.stream = src;
  src.onmessage = () => load();
  src.onerror = () => {
    if (state.stream !== src) return;
    setConn("lost");
    src.close();
    setTimeout(subscribe, 2000);
  };
}

async function main() {
  wireCanvas();
  wirePicker();
  await load(true);
  $("store-path").textContent = (await api("/api/health").catch(() => ({}))).store ?? "";
  subscribe();
  setInterval(load, 4000);
  window.addEventListener("resize", reframe);
}

main();
