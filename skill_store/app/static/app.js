"use strict";
const $ = (s) => document.querySelector(s);
const el = (t, c, txt) => { const n = document.createElement(t);
  if (c) n.className = c; if (txt != null) n.textContent = txt; return n; };
const eur = (n) => "€" + Number(n || 0).toFixed(2);
const robot = () => $("#robot").value;
const STRUCTURE = "dualarm";

let plan = null;        // {plan_id, steps[], missing[], issues[], ...}
let catalogCache = [];
let credits = {};
let pollTimer = null;
let runActive = false;    // a plan is queued or running: its order is locked
let compiling = false;    // one compile at a time; a second click waits for the first
let handOverrides = {};   // step index -> 'left' | 'right'

/* Nothing should fail silently in a live demo. */
window.addEventListener("error", (e) =>
  showError((e.error && e.error.stack) || e.message));
window.addEventListener("unhandledrejection", (e) =>
  showError((e.reason && (e.reason.stack || e.reason.message)) || String(e.reason)));
function showError(msg) {
  const s = $("#status");
  s.className = "status err";
  s.textContent = String(msg).slice(0, 600);
}

/* Stable per-skill colour. */
const PALETTE = ["#FF4D0D","#2E7DF6","#35C07F","#E5A53F","#B57BFF","#FF6FA5",
                 "#17C3C3","#8AC926","#F2B705","#6C8AE4","#D45BCF","#E5604F"];
function colorFor(id) {
  let h = 0;
  for (let i = 0; i < String(id).length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const AVAIL = {
  skill_and_data: { cls: "a2", label: "SKILL + DATA", note: "trained, runnable" },
  data_only:      { cls: "a1", label: "DATA ONLY",    note: "needs training" },
  none:           { cls: "a0", label: "NO SKILL/DATA", note: "must be recorded" },
};

const SVGNS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};

/* Motion glyphs, one per category, drawn in a 76x50 box.
   A photo of someone else's dataset would misrepresent the skill, so the preview
   is generated from the skill's own manifest instead and cannot be wrong. */
const GLYPH = {
  perception:   "M8 25h10M58 25h10M38 11v6M38 33v6 M38 25m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0",
  manipulation: "M26 12v12q0 6 6 6h12q6 0 6-6V12 M38 30v10 M30 40h16",
  transport:    "M12 34q13-20 26 0t26-16 M58 18l6 0 0 6",
  pouring:      "M14 14l16 6-6 14-16-6z M32 24q10 4 14 12 M46 36v6 M40 40l12 0 0 6q0 4-4 4h-4q-4 0-4-4z",
  mixing:       "M38 25m-13 0a13 13 0 1 0 26 0a13 13 0 1 0 -26 0 M51 25l-4-5 M51 25l-5 4 M38 14v11",
  cleaning:     "M10 38h56 M20 30q18-16 36 0 M30 22v-8 M46 22v-8",
  finishing:    "M26 20h24l-4 20H30z M38 20V9 M32 9l6-5 6 5",
  household:    "M14 38V22l24-12 24 12v16z M30 38V28h16v10",
  composite:    "M8 25h12 M24 18h14v14H24z M42 25h12 M58 18h10v14H58z M8 18h12v14H8z",
};

function schematicEl(skill, cls, w, h) {
  const cat = (skill && skill.category) || "manipulation";
  const colour = colorFor((skill && (skill.id || skill.skill_id)) || cat);
  const a = AVAIL[(skill && skill.availability) || "none"] || AVAIL.none;
  const box = svg("svg", {
    class: cls, viewBox: "0 0 76 50", width: w || 76, height: h || 50,
    preserveAspectRatio: "xMidYMid meet",
  });
  box.appendChild(svg("rect", { x: 0, y: 0, width: 76, height: 50, fill: "#141414" }));
  // faint grid, so it reads as a technical drawing rather than a missing image
  for (let x = 9.5; x < 76; x += 9.5) {
    box.appendChild(svg("line",
      { x1: x, y1: 0, x2: x, y2: 50, stroke: "#1e1e1e", "stroke-width": .5 }));
  }
  for (let y = 10; y < 50; y += 10) {
    box.appendChild(svg("line",
      { x1: 0, y1: y, x2: 76, y2: y, stroke: "#1e1e1e", "stroke-width": .5 }));
  }
  box.appendChild(svg("path", {
    d: GLYPH[cat] || GLYPH.manipulation, fill: "none", stroke: colour,
    "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round",
    opacity: .95,
  }));
  box.appendChild(svg("rect",
    { x: 0, y: 47, width: 76, height: 3, fill: `var(--${a.cls})` }));
  return box;
}

function thumbEl(skillId, cls) {
  const s = catalogCache.find((x) => x.id === skillId) || { id: skillId };
  return schematicEl(s, cls);
}

/* ------------------------------------------------------------------ *
 * The sequence: every skill in order, including the ones that do not
 * exist yet. A gap is shown in its place, not relegated to a footnote.
 * ------------------------------------------------------------------ */
function sequence() {
  if (!plan) return [];
  const out = [];
  const gapsAt = (i) => (plan.missing || [])
    .filter((m) => (m.insert_after == null ? -1 : m.insert_after) === i)
    .map((m) => ({ gap: true, data: m }));
  out.push(...gapsAt(-1));
  (plan.steps || []).forEach((s, i) => {
    out.push({ gap: false, data: s, stepIndex: i });
    out.push(...gapsAt(i));
  });
  // Anything pointing past the end lands at the end.
  (plan.missing || []).forEach((m) => {
    const a = m.insert_after == null ? -1 : m.insert_after;
    if (a >= (plan.steps || []).length) out.push({ gap: true, data: m });
  });
  return out;
}

/* `seqPos` is how many rows (steps and gaps) sit above this bar. */
function insertBar(seqPos, label) {
  const bar = el("div", "ins");
  if (runActive) return bar;               // no edits while the robot has the plan
  const b = el("button", null, "+");
  b.title = label;
  b.addEventListener("click", (ev) => { ev.stopPropagation(); openPicker(seqPos); });
  bar.appendChild(b);
  return bar;
}

function renderSequence() {
  const wrap = $("#seq");
  wrap.textContent = "";
  const rows = sequence();

  if (!rows.length) {
    wrap.appendChild(el("div", "empty", plan
      ? "No skills matched this process — see the gaps below."
      : "Nothing yet."));
    if (plan) wrap.appendChild(insertBar(0, "Add a skill"));
    return;
  }

  let n = 0;
  wrap.appendChild(insertBar(0, "Insert at the start"));
  rows.forEach((item) => {
    n += 1;
    wrap.appendChild(item.gap ? gapRow(item.data, n) : skillRow(item.data, n, item.stepIndex));
    wrap.appendChild(insertBar(n, "Insert here"));
  });
}

function skillRow(s, n, stepIndex) {
  const row = el("div", "row");
  row.style.setProperty("--c", colorFor(s.skill_id));
  row.draggable = true;
  row.dataset.index = String(stepIndex);

  row.appendChild(el("div", "c-ord", String(n)));

  const name = el("div", "c-name", s.name || s.skill_id);
  const target = s.params && s.params.target;
  if (target) name.appendChild(el("small", "c-target", "→ " + target));
  row.appendChild(name);

  row.appendChild(el("div", "c-desc", s.title || ""));

  const io = el("div", "c-io");
  const chips = (preds, none) => {
    const b = el("b");
    if (!preds.length) { b.textContent = none; return b; }
    preds.forEach((p, k) => {
      if (k) b.appendChild(document.createTextNode(", "));
      const c = el("span", "pv", p);
      c.dataset.p = p;
      b.appendChild(c);
    });
    return b;
  };
  io.appendChild(chips(s.preconditions || [], "any state"));
  io.appendChild(el("span", "arr", "  →  "));
  io.appendChild(chips(s.postconditions || [], "—"));
  row.appendChild(io);

  row.appendChild(handCell(s, stepIndex));

  const a = AVAIL[s.availability] || AVAIL.none;
  const av = el("div", "avail " + a.cls);
  av.appendChild(el("i"));
  av.appendChild(document.createTextNode(a.label));
  av.appendChild(el("small", null, a.note));
  row.appendChild(av);

  const ds = el("div", "c-ds", s.dataset_name || "—");
  if (s.dataset_count > 1) ds.appendChild(el("small", "ds-more", `+${s.dataset_count - 1} more datasets`));
  if (s.n_trials) {
    ds.appendChild(el("small", null, Math.round(s.success_rate * 100) + "% over " + s.n_trials));
  }
  row.appendChild(ds);

  const price = el("div", "c-price" + (s.repeat_of != null ? " repeat" : ""));
  if (s.repeat_of != null) {
    price.appendChild(el("s", null, eur(s.list_price_eur)));
    const incl = el("small", null, "incl. above");
    incl.title = `Bought at step ${s.repeat_of + 1}`;
    price.appendChild(incl);
  } else {
    price.textContent = eur(s.price_eur);
  }
  row.appendChild(price);

  row.appendChild(schematicEl(
    { id: s.skill_id, category: s.category, availability: s.availability }, "shot"));
  row.appendChild(whyCell(s.rationale, "Added by hand, not by the planner."));
  row.addEventListener("click", () => openDetail(s.skill_id));
  row.addEventListener("mouseenter", () => traceRow(stepIndex));
  row.addEventListener("mouseleave", clearTrace);
  return row;
}

function gapRow(m, n) {
  const row = el("div", "row gap");
  row.dataset.after = String(m.insert_after == null ? -1 : m.insert_after);
  row.dataset.gap = String((plan.missing || []).indexOf(m));
  row.style.setProperty("--c", "#E5604F");
  row.appendChild(el("div", "c-ord", String(n)));

  row.appendChild(el("div", "c-name", m.name || m.proposed_id));

  row.appendChild(el("div", "c-desc", m.description || ""));

  const io = el("div", "c-io");
  io.appendChild(el("b", null, (m.preconditions || []).join(", ") || "any state"));
  io.appendChild(el("span", "arr", "  →  "));
  io.appendChild(el("b", null, (m.postconditions || []).join(", ") || "—"));
  row.appendChild(io);

  row.appendChild(el("div", "hand"));

  // A gap is never a skill, but an open dataset may already cover the motion.
  const hasData = !!m.dataset_id;
  const av = el("div", "avail " + (hasData ? "a1" : "a0"));
  av.appendChild(el("i"));
  av.appendChild(document.createTextNode(hasData ? "NO SKILL YET" : "NOT AVAILABLE"));
  av.appendChild(el("small", null, hasData ? "data exists to train it" : "no skill, no data"));
  row.appendChild(av);

  const ds = el("div", "c-ds", m.dataset_name || "—");
  if (hasData) ds.appendChild(el("small", null, "candidate source"));
  row.appendChild(ds);
  const price = el("div", "c-price", "—");
  price.appendChild(el("small", null, "unpriced"));
  row.appendChild(price);
  row.appendChild(schematicEl(
    { id: m.proposed_id, category: "composite",
      availability: hasData ? "data_only" : "none" }, "shot"));
  row.appendChild(whyCell(m.why_needed, "—"));

  row.addEventListener("click", () => openGapDetail(m));
  return row;
}

/* The planner's reason for a step, so the sequence is not a black box. */
function whyCell(text, fallback) {
  const cell = el("div", "c-why" + (text ? "" : " none"), text || fallback);
  if (text) cell.title = text;
  return cell;
}

function handCell(s, stepIndex) {
  const cell = el("div", "hand");
  if (!s.hands_required) {
    cell.appendChild(el("span", "na", "\u2014"));   // perception needs no hand
    return cell;
  }
  if (s.hands_required > 1) {
    cell.appendChild(el("span", "na", "BOTH"));
    return cell;
  }
  [["L", "left"], ["R", "right"]].forEach(([label, hand]) => {
    const b = el("button", s.hand === hand ? "on" : null, label);
    b.title = runActive ? "Locked while the robot runs this plan" : hand + " hand";
    b.disabled = runActive;
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();                      // do not open the detail popup
      if (s.hand === hand) return;
      handOverrides[stepIndex] = hand;
      revalidate(stepIndex);
    });
    cell.appendChild(b);
  });
  return cell;
}

function renderMeta() {
  const steps = (plan && plan.steps) || [];
  const gaps = (plan && plan.missing) || [];
  $("#panel-head").classList.toggle("hidden", !plan);
  $("#panel-meta").textContent = plan
    ? `${steps.length} skills · ${plan.executable_steps || 0} runnable · ${gaps.length} missing`
    : "";
  $("#foot-total").textContent = plan ? eur(plan.total_price_eur) : "";
  $("#foot-note").textContent = !plan
    ? ""
    : steps.length === 0
      ? "Nothing in the catalog covers this process yet."
      : plan.valid ? ""                       // the combi-skill offer speaks for itself
                   : "Validator blocked this order.";

  const box = $("#issues");
  box.textContent = "";
  const blocking = new Set(["unknown_skill","unmet_precondition","embodiment_mismatch","empty_plan","wrong_flow",
                            "wrong_object"]);
  ((plan && plan.issues) || []).forEach((i) => {
    const d = el("div", "issue" + (blocking.has(i.kind) ? " block" : ""));
    d.textContent = (i.step_index == null ? "Plan" : "Step " + (i.step_index + 1)) + ": " + i.detail;
    box.appendChild(d);
  });

  const btn = $("#install");
  btn.classList.toggle("hidden", !plan || steps.length === 0);
  const runnable = !runActive && !!(plan && plan.installable && steps.length);
  btn.disabled = !runnable;
  btn.firstElementChild.textContent = runActive ? "Running on the robot…"
    : runnable ? (robot().startsWith("OpenArm") ? "Deploy on the robot" : "Install & run")
    : plan && !plan.valid ? "Blocked by validator"
    : "Not runnable: " + ((plan && plan.install_blockers) || []).join(" · ");
  $("#runrobot").classList.toggle("hidden", !plan || steps.length === 0);
  const note = $("#robotnote");             // says which plan it was about
  if (note.dataset.plan !== String(plan && plan.plan_id)) note.classList.add("hidden");
}

/* ---------------- keeping step indices straight ---------------- */
/* Missing skills sit after a step index and hand choices are keyed by step
   index, so every insert or reorder carries both along. `map(oldIndex)` gives
   the step's new index. */
function reindexSteps(map) {
  const shifted = {};
  Object.entries(handOverrides).forEach(([k, v]) => {
    const to = map(Number(k));
    if (to != null) shifted[to] = v;
  });
  handOverrides = shifted;
  (plan.missing || []).forEach((m) => {
    const a = m.insert_after == null ? -1 : m.insert_after;
    if (a >= 0 && a < plan.steps.length) m.insert_after = map(a);
  });
}

/* Insert a step where a "+" bar sits, `seqPos` rows down the list. Every gap
   keeps its place in the list: its new insert_after is the number of steps
   that end up above it, minus one. */
function insertAtRow(seqPos, step) {
  const rows = sequence();
  const at = rows.slice(0, seqPos).filter((r) => !r.gap).length;
  const before = [];
  rows.forEach((r, d) => {
    if (!r.gap) return;
    const stepsAbove = rows.slice(0, d).filter((x) => !x.gap).length + (d >= seqPos ? 1 : 0);
    before.push([r.data, stepsAbove - 1]);
  });
  const overrides = {};
  Object.entries(handOverrides).forEach(([k, v]) => {
    overrides[Number(k) >= at ? Number(k) + 1 : Number(k)] = v;
  });
  handOverrides = overrides;
  plan.steps.splice(at, 0, step);
  before.forEach(([m, after]) => { m.insert_after = after; });
  return at;
}

function hideBalanceNote() {
  const warn = $("#handwarn");
  if (warn.classList.contains("balance-note")) {
    warn.textContent = "";
    warn.className = "handwarn hidden";
  }
}

/* ---------------- drag to reorder ---------------- */
let dragFrom = null;
function wireDrag() {
  if (runActive) {
    document.querySelectorAll(".row[draggable='true']").forEach((r) => { r.draggable = false; });
    return;
  }
  document.querySelectorAll(".row[draggable='true']").forEach((row) => {
    row.addEventListener("dragstart", (e) => {
      dragFrom = Number(row.dataset.index);
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", String(dragFrom)); } catch (_) {}
    });
    row.addEventListener("dragend", () => {
      dragFrom = null;
      row.classList.remove("dragging");
      document.querySelectorAll(".row").forEach((r) => r.classList.remove("over"));
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault(); e.dataTransfer.dropEffect = "move"; row.classList.add("over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("over"));
    row.addEventListener("drop", (e) => {
      e.preventDefault(); e.stopPropagation();
      const to = Number(row.dataset.index);
      const from = dragFrom;
      dragFrom = null;
      if (from === null || Number.isNaN(to) || from === to) return;
      const order = plan.steps.map((_, i) => i);
      order.splice(to, 0, ...order.splice(from, 1));
      const [moved] = plan.steps.splice(from, 1);
      plan.steps.splice(to, 0, moved);
      // Gaps stay after the step they followed; hand choices follow their step.
      const newIndex = [];
      order.forEach((old, i) => { newIndex[old] = i; });
      reindexSteps((k) => newIndex[k]);
      hideBalanceNote();
      draw();
      revalidate();
    });
  });
}

function draw() {
  renderSequence();
  renderMeta();
  wireDrag();
  renderGit();
  renderFlow3d();
  renderCombo();
  if (typeof renderAnim === "function") renderAnim();
}

let viewMode = "list";
document.querySelectorAll(".vt[data-view]").forEach((b) =>
  b.addEventListener("click", () => {
    viewMode = b.dataset.view;
    document.querySelectorAll(".vt[data-view]").forEach((x) =>
      x.classList.toggle("active", x === b));
    $("#flow3d").classList.toggle("hidden", viewMode !== "flow3d");
    // ANIMATION keeps the list under it, so the playing steps light up there.
    const rows = viewMode === "list" || viewMode === "anim";
    $("#anim").classList.toggle("hidden", viewMode !== "anim");
    $("#seq").classList.toggle("hidden", !rows);
    document.querySelector(".cols").classList.toggle("hidden", !rows);
    stopPlay();
    $("#gitkey").classList.add("hidden");
    if (rows) renderGit();
    if (viewMode === "flow3d") renderFlow3d(true);
    renderAnim();
  }));

/* ------------------------------------------------------------------ *
 * The state flow, drawn inside the Start → Target column.
 * Between two rows sit the states that matter there, one circle each: what
 * the step above leaves behind and what the step below needs. A state that
 * stays true runs on as a vertical line to the next step that uses it. A
 * step's input lines merge into it and its output lines split out of it, so
 * "needs three states, leaves one" reads as three lines becoming one.
 * A line ends where a step clears the state, or at its last use.
 * Hand states (hand_empty, holding, ...) are per hand and take that hand's
 * colour; world facts (glass_placed, vessel_filled) are grey.
 * ------------------------------------------------------------------ */
const LANE_ORDER = ["left", "right", "none"];
const LANE_COL = { left: "#5BA8FF", right: "#FFB15B", none: "#8E8E8E" };
// Mirrors HAND_SCOPED in app/validator.py.
const HAND_SCOPED = new Set(["hand_empty", "bottle_grasped", "glass_grasped",
  "shaker_grasped", "scoop_grasped", "cloth_grasped", "object_grasped",
  "object_located", "holding", "positioned"]);
// Mirrors WORLD_INITIAL and the per-hand hand_empty in app/validator.py.
const START_STATE = new Set(["hand_empty@left", "hand_empty@right", "hand_empty",
  "coaster_ready", "glass_placed"]);
const STATE_DX = 46;      // widest lane spacing; narrower when many states are live

function laneOf(n) { return n.hands_required ? (n.hand || "left") : "none"; }

/* Every row's states, scoped to its hand the way the validator scopes them. A
   gap counts too: it declares what it needs and leaves, it is done by the hand
   of the step before it, and it clears nothing. */
function rowStates() {
  let hand = null;
  return sequence().map((item) => {
    if (item.gap) {
      const m = item.data;
      const scope = (p) => (HAND_SCOPED.has(p) && hand ? `${p}@${hand}` : p);
      return { gap: true, hand, pre: (m.preconditions || []).map(scope),
               post: (m.postconditions || []).map(scope), del: [] };
    }
    const s = item.data;
    const sk = catalogCache.find((x) => x.id === s.skill_id) || {};
    const scope = (p) => (HAND_SCOPED.has(p) && s.hand ? `${p}@${s.hand}` : p);
    if (s.hand) hand = s.hand;
    return { gap: false, hand: s.hand, stepIndex: item.stepIndex,
             pre: (s.preconditions || sk.preconditions || []).map(scope),
             post: (s.postconditions || sk.postconditions || []).map(scope),
             del: (sk.deletes || []).map(scope) };
  });
}

/* One segment per stretch of time a state is true and relevant: from the row
   that makes it (or the start, -1) through every row that uses it, to the row
   that clears it or its last use. A state a row needs that nothing made and the
   start state does not hold is `unmet`: it begins just above that row. */
function stateSegments(items) {
  const segs = [], live = new Map(), opened = new Set();
  const needs = items.map(() => new Map()), makes = items.map(() => new Map());
  const open = (key, start, unmet = false) => {
    const g = { id: segs.length, key, start, unmet, touches: [], end: null };
    segs.push(g); live.set(key, g); opened.add(key); return g;
  };
  const close = (g, i) => {
    if (!g.touches.includes(i)) g.touches.push(i);
    g.end = i; live.delete(g.key);
  };
  items.forEach((st, i) => {
    st.pre.forEach((k) => {
      const g = live.get(k) || (START_STATE.has(k) && !opened.has(k) ? open(k, -1)
                                                                    : open(k, i, true));
      if (!g.touches.includes(i)) g.touches.push(i);
      needs[i].set(k, g);
    });
    st.del.forEach((k) => { if (live.has(k)) close(live.get(k), i); });
    st.post.forEach((k) => {
      if (live.has(k)) close(live.get(k), i);      // re-asserted: in, then out again
      makes[i].set(k, open(k, i));
    });
  });
  live.forEach((g) => { g.end = g.touches.length ? g.touches[g.touches.length - 1] : null; });
  return { segs, needs, makes };
}

/* Columns, git-style: a segment keeps the column its state last used if that is
   free, else takes the leftmost free one. Positions are in half-rows: row r's
   centre is 2r+1, the boundary below it 2r+2. Segments index rows, gaps included. */
function assignColumns(segs) {
  const span = (g) => {
    const a = g.start < 0 ? 0 : g.unmet ? 2 * g.start : 2 * g.start + 1;
    const b = g.end == null ? 2 * g.start + 2 : 2 * g.end + 1;
    return [a, b];
  };
  const busyUntil = [], lastCol = new Map();
  [...segs].sort((x, y) => span(x)[0] - span(y)[0] || x.id - y.id).forEach((g) => {
    const [a, b] = span(g);
    const free = (c) => busyUntil[c] == null || busyUntil[c] <= a;
    let c = lastCol.get(g.key);
    if (c == null || !free(c)) {
      c = 0;
      while (!free(c)) c += 1;
    }
    g.col = c; busyUntil[c] = b; lastCol.set(g.key, c);
  });
  return Math.max(0, ...segs.map((g) => g.col + 1));
}

/* A state's name, wrapped at underscores onto at most three lines. */
function stateLabel(key) {
  const parts = key.split("@")[0].split("_");
  const lines = [];
  parts.forEach((p, k) => {
    const word = p + (k < parts.length - 1 ? "_" : "");
    const last = lines.length - 1;
    if (last >= 0 && (lines[last].length + word.length <= 10 || lines.length === 3)) {
      lines[last] += word;
    } else {
      lines.push(word);
    }
  });
  return lines;
}

function renderGit() {
  const wrap = $("#seq");
  wrap.querySelectorAll(".gitsvg").forEach((x) => x.remove());
  const panel = document.querySelector(".stage .panel");
  const steps = (plan && plan.steps) || [];
  const rows = [...wrap.querySelectorAll(".row")];
  const cell = rows.length && rows[0].querySelector(".c-io");
  // Draw only where the Start → Target column is on screen.
  const on = steps.length > 0 && (viewMode === "list" || viewMode === "anim") && cell && cell.offsetWidth > 0;
  panel.classList.toggle("git", !!on);
  $("#gitkey").classList.toggle("hidden", !on);
  if (!on) return;

  const top = rows.map((r) => r.offsetTop), bot = rows.map((r) => r.offsetTop + r.offsetHeight);
  const mid = rows.map((r, k) => (top[k] + bot[k]) / 2);
  const boundary = (b) => b === 0 ? top[0] - 8 : b === rows.length ? bot[b - 1] + 8
    : (bot[b - 1] + top[b]) / 2;

  const items = rowStates();
  if (items.length !== rows.length) return;        // mid-redraw; the next draw fixes it
  const { segs, needs, makes } = stateSegments(items);
  const ncols = assignColumns(segs);
  const x0 = cell.offsetLeft, w = cell.offsetWidth;
  const dx = Math.min(STATE_DX, w / Math.max(1, ncols));
  const colX = (c) => x0 + (w - dx * ncols) / 2 + dx * (c + 0.5);
  const R = Math.max(8, Math.min(21, dx / 2 - 2));
  const colour = (key) => LANE_COL[key.includes("@") ? key.split("@")[1] : "none"];

  // Where each row's lines meet: the middle of the columns it touches.
  const touching = items.map(() => []);
  segs.forEach((g) => {
    if (g.start >= 0 && !g.unmet) touching[g.start].push(g);
    g.touches.forEach((i) => { if (i !== g.start || g.unmet) touching[i].push(g); });
  });
  const node = items.map((it, i) => {
    const xs = touching[i].map((g) => colX(g.col));
    return { x: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : x0 + w / 2,
             y: mid[i] };
  });

  const box = svg("svg", { class: "gitsvg", width: wrap.offsetWidth, height: wrap.scrollHeight });
  const curve = (x1, y1, x2, y2) => {
    const k = (y2 - y1) / 2;
    return `C${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}`;
  };

  segs.forEach((g) => {
    const x = colX(g.col);
    let d, y;
    if (g.start < 0 || g.unmet) {
      y = boundary(g.unmet ? g.start : 0); d = `M${x} ${y}`;
    } else {
      const n = node[g.start], r = g.start;
      d = `M${n.x} ${n.y} ` + curve(n.x, n.y, x, bot[r]);
      y = bot[r];
      if (g.end == null) d += ` L${x} ${boundary(r + 1)}`;
    }
    g.touches.filter((i) => i !== g.start || g.unmet).sort((a, b) => a - b).forEach((i) => {
      const n = node[i], r = i;
      d += ` L${x} ${top[r]} ` + curve(x, top[r], n.x, n.y);
      if (i !== g.end) d += ` M${n.x} ${n.y} ` + curve(n.x, n.y, x, bot[r]);
    });
    box.appendChild(svg("path", { class: "glane" + (g.unmet ? " unmet" : ""), d,
      stroke: g.unmet ? "var(--a0)" : colour(g.key),
      "data-seg": g.id, "data-rows": [g.start, ...g.touches].join(",") }));
  });

  items.forEach((it, i) => box.appendChild(svg("circle", {
    class: "gdot" + (it.gap ? " gapdot" : ""), "data-row": i,
    cx: node[i].x, cy: node[i].y, r: it.gap ? 5.5 : 4.5,
    fill: it.gap ? "var(--row)" : LANE_COL[it.hand || "none"] })));

  // One circle per state per boundary: the step above's targets and the step
  // below's starts. The same state on both sides is the same circle.
  const drawn = new Set();
  const circle = (b, g) => {
    const x = colX(g.col), y = boundary(b), tag = `${b}|${g.col}|${g.key}`;
    if (drawn.has(tag)) return;
    drawn.add(tag);
    const unmet = g.unmet && b === g.start;
    const grp = svg("g", { class: "gstate" + (unmet ? " unmet" : ""), "data-seg": g.id });
    grp.appendChild(svg("circle", { cx: x, cy: y, r: R,
                                    stroke: unmet ? "var(--a0)" : colour(g.key) }));
    const lines = stateLabel(g.key);
    const longest = Math.max(...lines.map((l) => l.length));
    // Fit the widest line across the circle and all lines inside its height.
    const fs = Math.min(8.5, (2 * R - 5) / (longest * 0.6),
                        (2 * R - 6) / (lines.length * 1.1));
    if (fs >= 5) {
      lines.forEach((l, k) => {
        const t = svg("text", { x, y: y + (k - (lines.length - 1) / 2) * fs * 1.1 + fs * 0.35,
                                "font-size": fs.toFixed(2) });
        t.textContent = l;
        grp.appendChild(t);
      });
    }
    const tip = svg("title", {});
    const [name, hand] = g.key.split("@");
    tip.textContent = name + (hand ? ` (${hand} hand)` : "") +
      (unmet ? " -- needed here, but no earlier step establishes it" : "");
    grp.appendChild(tip);
    grp.addEventListener("mouseenter", () => traceSeg(g.id));
    grp.addEventListener("mouseleave", clearTrace);
    box.appendChild(grp);
  };
  segs.filter((g) => g.start < 0).forEach((g) => circle(0, g));   // the start state
  items.forEach((it, i) => {
    needs[i].forEach((g) => circle(i, g));
    makes[i].forEach((g) => circle(i + 1, g));
  });

  wrap.appendChild(box);
}

/* Hover: light the states a row needs and makes, and the rows they connect. */
function traceRow(index) {
  const wrap = $("#seq");
  const box = wrap.querySelector(".gitsvg");
  if (!box) return;
  const k = [...wrap.querySelectorAll(".row")].findIndex((r) => r.dataset.index === String(index));
  const ids = [...box.querySelectorAll(".glane")]
    .filter((p) => p.dataset.rows.split(",").map(Number).includes(k))
    .map((p) => p.dataset.seg);
  highlight(ids, k);
}
function traceSeg(id) { highlight([String(id)], null); }

function highlight(ids, index) {
  const wrap = $("#seq");
  const box = wrap.querySelector(".gitsvg");
  clearTrace();
  wrap.classList.add("tracing");
  const linked = new Set(index == null ? [] : [index]);
  box.querySelectorAll(".glane, .gstate").forEach((p) => {
    if (!ids.includes(p.dataset.seg)) return;
    p.classList.add("hot");
    if (p.dataset.rows) p.dataset.rows.split(",").map(Number)
      .filter((i) => i >= 0).forEach((i) => linked.add(i));
  });
  box.querySelectorAll(".gdot").forEach((c) =>
    c.classList.toggle("hot", linked.has(Number(c.dataset.row))));
  wrap.querySelectorAll(".row").forEach((r, k) =>
    r.classList.toggle("linked", linked.has(k) && k !== index));
}
function clearTrace() {
  const wrap = $("#seq");
  wrap.classList.remove("tracing");
  wrap.querySelectorAll(".hot").forEach((x) => x.classList.remove("hot"));
  wrap.querySelectorAll(".linked").forEach((x) => x.classList.remove("linked"));
}

let gitResize = null;
window.addEventListener("resize", () => {
  clearTimeout(gitResize);
  gitResize = setTimeout(renderGit, 120);
});

/* ------------------------------------------------------------------ *
 * FLOWCHART: the plan as it will actually run, left to right, with
 * everything that can happen at once stacked in the same column.
 * Switch a card's hand and the chart re-lays itself out in place, so you
 * watch two sub-chains slide into the same columns.
 * ------------------------------------------------------------------ */
const FW = 186, FH = 104, FGX = 86, FGY = 26, FPX = 12, FPY = 24;
let flowPos = new Map();        // step index -> {x, y} from the last render

function upstreamOf(nodes, index) {
  const by = new Map(nodes.map((n) => [n.index, n]));
  const out = new Set();
  const walk = (i) => (by.get(i).deps || []).forEach((d) => {
    if (d.step >= 0 && !out.has(d.step)) { out.add(d.step); walk(d.step); }
  });
  walk(index);
  return out;
}
function downstreamOf(nodes, index) {
  const out = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    nodes.forEach((n) => {
      if (out.has(n.index)) return;
      if ((n.deps || []).some((d) => d.step === index || out.has(d.step))) {
        out.add(n.index); grew = true;
      }
    });
  }
  return out;
}

function renderFlow3d(animate) {
  stopPlay();                 // a redraw replaces the cards the player was lighting
  const stage = $("#flowstage");
  const stats = $("#flowstats");
  stage.textContent = "";
  stats.textContent = "";
  const nodes = (plan && plan.graph) || [];
  if (!nodes.length) {
    stage.style.height = "90px";
    stage.appendChild(el("div", "empty", "Compile a process to see the flowchart."));
    flowPos = new Map();
    return;
  }

  const byLayer = new Map();
  nodes.forEach((n) => {
    if (!byLayer.has(n.layer)) byLayer.set(n.layer, []);
    byLayer.get(n.layer).push(n);
  });
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  const pos = new Map();
  layers.forEach((L, col) => {
    // left hand on top, right hand below, so the two arms read as two rows
    byLayer.get(L).sort((a, b) => LANE_ORDER.indexOf(laneOf(a)) - LANE_ORDER.indexOf(laneOf(b))
                                  || a.index - b.index)
      .forEach((n, i) => {
        pos.set(n.index, { x: FPX + col * (FW + FGX), y: FPY + i * (FH + FGY), n });
      });
  });

  const rows = Math.max(...layers.map((L) => byLayer.get(L).length));
  const W = FPX * 2 + layers.length * FW + (layers.length - 1) * FGX;
  const H = FPY + rows * FH + (rows - 1) * FGY + 10;
  stage.style.width = W + "px";
  stage.style.height = H + "px";

  const edges = svg("svg", { class: "flow-edges", viewBox: `0 0 ${W} ${H}`,
                             width: W, height: H });
  nodes.forEach((n) => {
    const to = pos.get(n.index);
    (n.deps || []).forEach((d) => {
      if (d.step < 0) return;
      const from = pos.get(d.step);
      if (!from) return;
      const x1 = from.x + FW, y1 = from.y + FH / 2;
      const x2 = to.x, y2 = to.y + FH / 2;
      const mx = (x1 + x2) / 2;
      const colour = d.kind === "hand" ? LANE_COL[laneOf(n)]
                   : d.kind === "resource" ? "#E5604F"
                   : colorFor(from.n.skill_id);
      const g = svg("g", { class: "fedge " + d.kind, "data-from": d.step,
                           "data-to": n.index });
      g.appendChild(svg("path", {
        class: "gedge " + d.kind,
        d: `M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`,
        stroke: colour,
        "stroke-dasharray": d.kind === "requires" ? "" : "4 4",
      }));
      if (d.kind !== "hand") {
        const lab = svg("text", { class: "flabel", x: mx, y: (y1 + y2) / 2 - 5,
                                  "text-anchor": "middle" });
        lab.textContent = d.via;
        g.appendChild(lab);
      }
      edges.appendChild(g);
    });
  });
  stage.appendChild(edges);

  layers.forEach((L, col) => {
    const tag = el("div", "flow-col", col === 0 ? "START" : "T+" + col);
    tag.dataset.col = String(col);
    tag.style.left = (FPX + col * (FW + FGX)) + "px";
    stage.appendChild(tag);
  });

  nodes.forEach((n) => {
    const p = pos.get(n.index);
    const card = el("div", "fnode");
    card.dataset.i = String(n.index);
    card.dataset.col = String(layers.indexOf(n.layer));
    card.style.setProperty("--c", colorFor(n.skill_id));
    card.appendChild(el("div", "fn-n", "STEP " + (n.index + 1)));
    card.appendChild(el("div", "fn-t", n.name));
    const step = (plan.steps || [])[n.index] || {};
    const target = step.params && step.params.target;
    card.appendChild(el("div", "fn-a", (n.title || "") + (target ? ` · ${target}` : "")));

    const foot = el("div", "fn-foot");
    if (n.hands_required === 1) {
      [["L", "left"], ["R", "right"]].forEach(([label, hand]) => {
        const b = el("button", "fn-hb " + hand + (n.hand === hand ? " on" : ""), label);
        b.title = runActive ? "Locked while the robot runs this plan" : `Run on the ${hand} hand`;
        b.disabled = runActive;
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (n.hand === hand) return;
          handOverrides[n.index] = hand;
          revalidate(n.index);
        });
        foot.appendChild(b);
      });
    } else {
      foot.appendChild(el("span", "fn-h both", n.hands_required ? "BOTH HANDS" : "NO HAND"));
    }
    card.appendChild(foot);

    card.addEventListener("click", () => openDetail(n.skill_id));
    card.addEventListener("mouseenter", () => focusFlow(nodes, n.index));
    card.addEventListener("mouseleave", () => focusFlow(nodes, null));

    // Slide from where this step was last time, so a hand switch reads as motion.
    const was = !animate && flowPos.get(n.index);
    card.style.left = (was ? was.x : p.x) + "px";
    card.style.top = (was ? was.y : p.y) + "px";
    stage.appendChild(card);
    if (was) {
      card.classList.add("in", "moving");
      void card.offsetWidth;            // commit the old position, then slide
      card.style.left = p.x + "px";
      card.style.top = p.y + "px";
    } else {
      const delay = (animate ? 90 : 0) * (layers.indexOf(n.layer) + 1);
      setTimeout(() => card.classList.add("in"), animate ? delay : 0);
    }
  });
  if (!animate && flowPos.size) {
    edges.classList.add("late");
    setTimeout(() => edges.classList.remove("late"), 450);
  }
  flowPos = new Map([...pos].map(([i, v]) => [i, { x: v.x, y: v.y }]));

  if (animate) {
    stage.classList.add("spin");
    setTimeout(() => stage.classList.remove("spin"), 900);
  }

  const serial = nodes.length;
  const depth = (plan && plan.depth) || layers.length;
  const saved = serial > 0 ? Math.round((1 - depth / serial) * 100) : 0;
  const add = (label, value, cls) => {
    const d = el("div");
    d.appendChild(el("b", cls, value));
    d.appendChild(document.createTextNode(" " + label));
    stats.appendChild(d);
    return d;
  };
  add("steps", String(serial));
  add("time slots", String(depth));
  add("widest branch", String((plan && plan.max_parallel) || 1));
  if (saved > 0) add("shorter than running them one by one", saved + "%", "win");
  const now = el("div", "flow-now");
  now.id = "flownow";
  stats.appendChild(now);
}

function focusFlow(nodes, index) {
  const stage = $("#flowstage");
  if (index == null) {
    stage.classList.remove("focus");
    stage.querySelectorAll(".up,.down,.me,.hot").forEach((x) =>
      x.classList.remove("up", "down", "me", "hot"));
    return;
  }
  const up = upstreamOf(nodes, index);
  const down = downstreamOf(nodes, index);
  stage.classList.add("focus");
  stage.querySelectorAll(".fnode").forEach((c) => {
    const i = Number(c.dataset.i);
    c.classList.toggle("me", i === index);
    c.classList.toggle("up", up.has(i));
    c.classList.toggle("down", down.has(i));
  });
  // An edge is on the trace if both ends sit on the same side of this card.
  const upSide = new Set([index, ...up]);
  const downSide = new Set([index, ...down]);
  stage.querySelectorAll(".fedge").forEach((g) => {
    const f = Number(g.dataset.from), t = Number(g.dataset.to);
    g.classList.toggle("hot", (upSide.has(f) && upSide.has(t))
                           || (downSide.has(f) && downSide.has(t)));
  });
}

/* PLAY: walk the time slots, lighting what runs together. */
let playTimer = null;
function stopPlay() {
  clearInterval(playTimer);
  playTimer = null;
  const btn = $("#flowplay");
  if (btn) btn.innerHTML = "&#9654; PLAY SCHEDULE";
  document.querySelectorAll(".fnode.running,.fnode.done,.flow-col.now").forEach((c) =>
    c.classList.remove("running", "done", "now"));
  $("#flowstage").classList.remove("playing");
  const now = $("#flownow");
  if (now) now.textContent = "";
}
$("#flowplay").addEventListener("click", () => {
  if (playTimer) { stopPlay(); return; }
  const cards = [...document.querySelectorAll(".fnode")];
  if (!cards.length) return;
  const cols = Math.max(...cards.map((c) => Number(c.dataset.col))) + 1;
  let t = 0;
  $("#flowplay").innerHTML = "&#9632; STOP";
  $("#flowstage").classList.add("playing");
  const tick = () => {
    if (t >= cols) { stopPlay(); return; }
    let running = 0;
    cards.forEach((c) => {
      const col = Number(c.dataset.col);
      c.classList.toggle("done", col < t);
      c.classList.toggle("running", col === t);
      if (col === t) running += 1;
    });
    document.querySelectorAll(".flow-col").forEach((c) =>
      c.classList.toggle("now", Number(c.dataset.col) === t));
    const now = $("#flownow");
    if (now) now.textContent = `T+${t}: ${running} step${running > 1 ? "s" : ""} at once`
      + (running > 1 ? " — both hands busy" : "");
    t += 1;
  };
  tick();
  playTimer = setInterval(tick, 750);
});

/* ------------------------------------------------------------------ *
 * Sell the whole chain as one new skill.
 * ------------------------------------------------------------------ */
function renderCombo() {
  const wrap = $("#combo");
  const steps = (plan && plan.steps) || [];
  // Only a chain the robot can run end to end is worth selling as one skill.
  const ok = plan && plan.installable && steps.length > 1;
  wrap.classList.toggle("hidden", !ok);
  if (!ok) return;
  const name = plan.combo_name || "This Process";
  $("#combo-label").textContent = `Create the totally new combi-skill for ${name}`;
  $("#combo-price").textContent = eur(plan.total_price_eur);
  $("#compose").disabled = false;
}

$("#compose").addEventListener("click", async () => {
  if (!plan) return;
  const btn = $("#compose");
  btn.disabled = true;
  $("#combo-label").textContent = "Composing\u2026";
  try {
    const r = await postJSON("/api/compose",
      { plan_id: plan.plan_id, name: plan.combo_name || "" });
    $("#combo-label").textContent =
      `${r.skill.name} created from ${r.parts} skills \u2014 now in your catalog`;
    await loadCatalog();
  } catch (e) {
    showError("Could not compose: " + e.message);
    btn.disabled = false;
    renderCombo();
  }
});

async function revalidate(changedStep) {
  $("#foot-note").textContent = "Re-checking…";
  let body;
  try {
    body = await postJSON("/api/validate", {
    steps: plan.steps.map((s) => ({ skill_id: s.skill_id, params: s.params,
                                    rationale: s.rationale || "",
                                    planned_hand: s.planned_hand || null })),
    missing: plan.missing || [],
    robot_model: robot(), structure: STRUCTURE, plan_id: plan.plan_id,
    hand_overrides: handOverrides,
    changed_step: changedStep == null ? null : changedStep,
    });
  } catch (e) {
    // The server refused (a run started, say). The page already moved the step
    // locally, so take the server's copy back rather than show something else.
    showError(e.message);
    if (plan.plan_id) {
      try { plan = await getJSON(`/api/plans/${plan.plan_id}`); } catch (_) {}
      handOverrides = {};
    }
    draw();
    return;
  }
  Object.assign(plan, {
    valid: body.valid, issues: body.issues, steps: body.steps, graph: body.graph,
    hands: body.hands, depth: body.depth, max_parallel: body.max_parallel,
    total_price_eur: body.total_price_eur, executable_steps: body.executable_steps,
    installable: body.installable, install_blockers: body.install_blockers || [],
  });
  const warn = $("#handwarn");
  if (changedStep != null) warn.classList.remove("balance-note");
  if (body.hand_warning) {
    warn.className = "handwarn";
    warn.textContent = body.hand_warning;
  } else if (!warn.classList.contains("balance-note")) {
    warn.textContent = "";
    warn.classList.add("hidden");
  }
  draw();
}

$("#balance").addEventListener("click", async () => {
  if (!plan || !(plan.steps || []).length || runActive) return;
  const btn = $("#balance");
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "SEARCHING\u2026";
  try {
    const r = await postJSON("/api/autobalance", {
      steps: plan.steps.map((s) => ({ skill_id: s.skill_id, params: s.params,
                                      planned_hand: s.planned_hand || null })),
      structure: STRUCTURE,
    });
    handOverrides = r.overrides || {};
    await revalidate(null);
    const warn = $("#handwarn");
    const gain = r.before.depth - r.after.depth;
    warn.className = "balance-note";
    warn.textContent = gain > 0
      ? `Searched ${r.searched} hand assignments (${r.method}): ` +
        `${r.before.depth} \u2192 ${r.after.depth} time slots, ` +
        `widest branch ${r.before.max_parallel} \u2192 ${r.after.max_parallel}.`
      : `Searched ${r.searched} assignments \u2014 ${r.before.depth} time slots is ` +
        `already the best this chain allows.`;
    warn.classList.remove("hidden");
  } catch (e) {
    showError("Auto-balance failed: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

/* ---------------- fetch helpers ---------------- */
async function postJSON(url, payload) {
  const r = await fetch(url, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch (_) { throw new Error(`${url} returned non-JSON (HTTP ${r.status}): ${text.slice(0,180)}`); }
  if (!r.ok) {
    const d = body.detail;
    // FastAPI input errors arrive as a list: say which field and why.
    if (Array.isArray(d)) {
      throw new Error(d.map((x) => `${(x.loc || []).slice(-1)[0] || "input"}: ${x.msg}`)
        .join("; "));
    }
    throw new Error(typeof d === "string" ? d : JSON.stringify(d || body).slice(0, 300));
  }
  return body;
}
async function getJSON(url) {
  const r = await fetch(url);
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch (_) { throw new Error(`${url} returned non-JSON (HTTP ${r.status})`); }
  if (!r.ok) throw new Error((body && body.detail) || `HTTP ${r.status}`);
  return body;
}

/* ---------------- compile ---------------- */
async function compile() {
  const prompt = $("#prompt").value.trim();
  if (!prompt || compiling) return;
  compiling = true;
  stopFollowing();
  $("#go").disabled = true;
  $("#status").className = "status";
  $("#status").textContent = "Breaking it into skills…";
  $("#runlog").classList.add("hidden");
  try {
    handOverrides = {};
    $("#handwarn").classList.add("hidden");
    plan = await postJSON("/api/compile",
      { prompt, robot_model: robot(), structure: STRUCTURE });
    $("#status").textContent = plan.summary + (plan.cached ? "   (cached)" : "");
    draw();
    loadGaps().catch(() => {});
  } catch (e) {
    showError(e.message);
    plan = null;
    draw();
  } finally {
    compiling = false;
    $("#go").disabled = false;
  }
}
$("#go").addEventListener("click", compile);
// Enter sends it. It is a single-line input, so there is no newline to lose.
$("#prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); compile(); }
});
document.querySelectorAll(".chip").forEach((c) =>
  c.addEventListener("click", () => { $("#prompt").value = c.dataset.ex; compile(); }));

/* ---------------- detail popup ---------------- */
function mrow(label, value) {
  const r = el("div", "m-row");
  r.appendChild(el("b", null, label));
  const v = el("div");
  if (value instanceof Node) v.appendChild(value); else v.textContent = value == null ? "—" : value;
  r.appendChild(v);
  return r;
}
function closeModal() {
  $("#modal").classList.add("hidden");
  $("#modal").querySelectorAll("video").forEach((v) => v.pause());
}

/* A few seconds of real footage from a dataset. Local clips play anywhere; AV1
   streams from the Hub need a browser that decodes AV1, and say so if not. */
const AV1 = 'video/mp4; codecs="av01.0.05M.08"';
function clipEl(clip, caption) {
  const fig = el("figure", "m-clip");
  if (!clip || clip.kind === "none") {
    fig.classList.add("none");
    fig.appendChild(el("div", "m-clip-empty",
      "No preview footage" + (clip && clip.why ? " — " + clip.why : "")));
    if (caption) fig.appendChild(el("figcaption", null, caption));
    return fig;
  }
  const v = el("video");
  Object.assign(v, { muted: true, autoplay: true, playsInline: true, controls: true });
  v.setAttribute("muted", "");
  const start = clip.kind === "stream" ? (clip.start || 0) : 0;
  const end = start + (clip.length || 6);
  if (clip.kind === "stream") {
    if (!v.canPlayType(AV1)) {
      fig.classList.add("none");
      fig.appendChild(el("div", "m-clip-empty",
        "This footage is AV1, which this browser cannot play. Open the page in " +
        "Chrome, or run `brew install ffmpeg` and `python tools/fetch_clips.py` " +
        "to convert it."));
      fig.appendChild(el("figcaption", null, caption));
      return fig;
    }
    // start only: an end in the fragment makes the browser pause there, even
    // after the viewer has scrubbed past it; the timeupdate loop owns the end
    v.src = `${clip.url}#t=${start}`;
    v.preload = "metadata";
  } else {
    v.src = "/static/" + clip.path;
    v.loop = true;
  }
  // loop just the segment, not the whole hour-long Hub file — until the viewer
  // scrubs, after which the timeline is theirs and snapping back would fight them
  // (a seek to `start` is the initial #t= jump or the loop itself, not a scrub)
  let scrubbed = false;
  v.addEventListener("seeking", () => {
    if (Math.abs(v.currentTime - start) > 0.1) scrubbed = true;
  });
  v.addEventListener("timeupdate", () => {
    if (scrubbed || v.currentTime < end) return;
    v.currentTime = start;
    v.play().catch(() => {});
  });
  v.addEventListener("error", () => {
    fig.classList.add("none");
    v.replaceWith(el("div", "m-clip-empty", "Could not load the footage."));
  });
  fig.appendChild(v);
  fig.appendChild(el("figcaption", null, caption));
  return fig;
}
$("#modal-close").addEventListener("click", closeModal);
$("#modal").addEventListener("click", (e) => { if (e.target === $("#modal")) closeModal(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeModal(); $("#picker").classList.add("hidden"); }
});

async function openDetail(skillId) {
  const d = await getJSON(`/api/skills/${encodeURIComponent(skillId)}?robot_model=${encodeURIComponent(robot())}`);
  const card = $(".modal-card");
  card.style.setProperty("--c", colorFor(skillId));
  const b = $("#modal-body");
  b.textContent = "";

  const hero = el("div", "m-hero");
  hero.appendChild(schematicEl(
    { id: skillId, category: d.category, availability: d.availability }, "", 190, 124));
  const ht = el("div");
  ht.appendChild(el("h3", null, d.name));
  ht.appendChild(el("div", "m-sub", `${d.title} · ${d.vendor} · ${d.category}`));
  hero.appendChild(ht);
  b.appendChild(hero);

  // Caption the footage that is actually shown: the dataset the clip came
  // from, which may be a candidate rather than the skill's primary dataset.
  const shown = d.clip_dataset || null;
  const dsInfo = (shown && shown.detail) || (d.dataset && d.dataset.detail) || null;
  const trained = (shown || d.dataset || {}).status === "trained_on";
  b.appendChild(clipEl(d.clip, dsInfo
    ? `${trained ? "Demonstration data this skill was trained on" : "Candidate data source for this skill"}: ` +
      `${dsInfo.name}${d.clip && d.clip.repo_id ? " (" + d.clip.repo_id + ")" : ""}. ` +
      "Real footage from the dataset — not a recording of this skill on " + robot() + "."
    : "No demonstration data has been identified for this skill yet."));

  const body = el("div", "m-body");
  const a = AVAIL[d.availability] || AVAIL.none;
  const av = el("span", "avail " + a.cls);
  av.appendChild(el("i")); av.appendChild(document.createTextNode(a.label + " · " + a.note));

  body.appendChild(mrow("Availability", av));
  body.appendChild(mrow("Description", d.description));
  body.appendChild(mrow("Start → Target",
    ((d.preconditions || []).join(", ") || "any state") + "  →  " +
    ((d.postconditions || []).join(", ") || "—")));
  body.appendChild(mrow("Clears", (d.deletes || []).join(", ") || "nothing"));
  body.appendChild(mrow("Price", eur(d.price_eur) + "  ·  " + d.vendor));
  body.appendChild(mrow("Accuracy", d.success_rate == null
    ? "no runs logged on " + robot()
    : Math.round(d.success_rate * 100) + "% over " + d.n_trials + " trials on " + robot()));
  if (d.rating) body.appendChild(mrow("Customer rating", ratingBlock(skillId, d.rating)));
  if (d.by_robot && d.by_robot.length) {
    body.appendChild(mrow("Per robot", d.by_robot
      .map((x) => `${x.robot_model}: ${Math.round(x.success_rate * 100)}% (n=${x.n_trials})`)
      .join("   ·   ")));
  }

  const ds = (d.dataset && d.dataset.detail) || null;
  if (ds) {
    const dv = el("div");
    dv.appendChild(el("div", null, `${ds.name} — ${ds.publisher}`));
    dv.appendChild(el("div", "m-sub",
      [ds.license, ds.access, ds.hours ? ds.hours.toLocaleString() + " h" : null, ds.size]
        .filter(Boolean).join("  ·  ")));
    if (ds.repo_id) { const c = el("div", "m-sub"); c.appendChild(el("code", null, ds.repo_id)); dv.appendChild(c); }
    dv.appendChild(el("div", "m-sub", ds.notes || ""));
    body.appendChild(mrow("Dataset", dv));
    body.appendChild(mrow("Episodes collected", String((d.dataset || {}).episodes || 0)));
  } else {
    body.appendChild(mrow("Dataset", "none identified — this one has to be recorded"));
  }
  // Every other open dataset that shows this motion, with what it shows.
  const more = (d.datasets || []).filter((x) => !ds || x.id !== ds.id);
  if (more.length) {
    const list = el("div", "ds-list");
    more.forEach((x) => {
      const info = x.detail || {};
      const item = el("div", "ds-item");
      const a = el("a", null, info.name || x.id);
      a.href = info.url || "#"; a.target = "_blank"; a.rel = "noopener";
      item.appendChild(a);
      item.appendChild(el("div", "m-sub", [info.robot, x.episodes ? x.episodes.toLocaleString() + " episodes" : null,
        info.kind === "sim" ? "simulation" : null, info.license].filter(Boolean).join("  ·  ")));
      if (x.match) item.appendChild(el("div", "m-sub ds-match", "“" + x.match + "”"));
      list.appendChild(item);
    });
    body.appendChild(mrow(`More data (${more.length})`, list));
  }

  if (d.composed_of && d.composed_of.length) {
    const chain = el("div", "combi-chain");
    d.composed_of.forEach((id, i) =>
      chain.appendChild(el("span", null, `${i + 1}. ${partName(id)}`)));
    body.appendChild(mrow("Composed of", chain));
  }
  body.appendChild(mrow("Checkpoint", d.checkpoint
    ? el("code", null, d.checkpoint) : "not trained"));
  if (d.prompt) body.appendChild(mrow("Policy prompt", el("code", null, d.prompt)));
  body.appendChild(mrow("Embodiment",
    `${(d.embodiment || {}).structure} · ${(d.embodiment || {}).gripper} · ` +
    `${((d.embodiment || {}).cameras || []).join(", ")}`));
  body.appendChild(mrow("Used in", `${d.usage.plans} plans · ${d.usage.runs} runs`));

  body.appendChild(el("div", "m-note",
    "The preview is drawn from this skill's own manifest, not a photograph. " +
    "Until episodes are recorded for it, any real frame would be someone " +
    "else's data and would misrepresent the skill."));
  b.appendChild(body);
  $("#modal").classList.remove("hidden");
}

function openGapDetail(m) {
  const card = $(".modal-card");
  card.style.setProperty("--c", "#E5604F");
  const b = $("#modal-body");
  b.textContent = "";
  const hero = el("div", "m-hero");
  const ht = el("div");
  ht.appendChild(el("h3", null, m.name));
  ht.appendChild(el("div", "m-sub", "proposed skill — not in the catalog"));
  hero.appendChild(ht);
  b.appendChild(hero);
  const body = el("div", "m-body");
  const av = el("span", "avail " + (m.dataset_id ? "a1" : "a0"));
  av.appendChild(el("i")); av.appendChild(document.createTextNode(
    m.dataset_id ? "NO SKILL, DATA EXISTS" : "NO SKILL, NO DATA"));
  body.appendChild(mrow("Availability", av));
  body.appendChild(mrow("Proposed id", el("code", null, m.proposed_id)));
  body.appendChild(mrow("Description", m.description));
  body.appendChild(mrow("Start → Target",
    ((m.preconditions || []).join(", ") || "any state") + "  →  " +
    ((m.postconditions || []).join(", ") || "—")));
  body.appendChild(mrow("Why it is needed", m.why_needed));
  body.appendChild(mrow("Candidate data", m.dataset_name ||
    "No open dataset covers this motion yet."));
  body.appendChild(el("div", "m-note",
    "This request has been logged as demand. Collect demonstrations for it, or " +
    "teleoperate it once and publish it as a skill."));
  b.appendChild(body);
  $("#modal").classList.remove("hidden");
}

/* ---------------- + insert a skill ---------------- */
let pickAt = 0;
function openPicker(seqPos) {
  pickAt = seqPos;
  $("#picker-where").textContent =
    seqPos === 0 ? "Insert at the start" : "Insert after row " + seqPos;
  $("#picker-filter").value = "";
  drawPicker();
  $("#picker").classList.remove("hidden");
  $("#picker-filter").focus();
}
$("#picker-close").addEventListener("click", () => $("#picker").classList.add("hidden"));
$("#picker").addEventListener("click", (e) => {
  if (e.target === $("#picker")) $("#picker").classList.add("hidden");
});
$("#picker-filter").addEventListener("input", drawPicker);

function drawPicker() {
  const q = $("#picker-filter").value.toLowerCase();
  const list = $("#picker-list");
  list.textContent = "";
  catalogCache
    .filter((s) => !q || (s.id + s.name + s.title + s.category).toLowerCase().includes(q))
    .slice(0, 60)
    .forEach((s) => {
      const a = AVAIL[s.availability] || AVAIL.none;
      const row = el("div", "pick");
      const dot = el("i"); dot.style.background = `var(--${a.cls})`;
      row.appendChild(dot);
      const mid = el("div");
      mid.appendChild(el("div", "pn", s.name));
      mid.appendChild(el("div", "pd", s.title));
      row.appendChild(mid);
      row.appendChild(el("div", null, eur(s.price_eur)));
      row.addEventListener("click", () => insertSkill(s.id));
      list.appendChild(row);
    });
}

async function insertSkill(skillId) {
  $("#picker").classList.add("hidden");
  if (!plan) plan = { plan_id: null, steps: [], missing: [], issues: [], valid: false };
  insertAtRow(pickAt, { skill_id: skillId, params: {} });
  hideBalanceNote();
  draw();
  if (plan.plan_id) await revalidate();
  else {
    const body = await postJSON("/api/validate", {
      steps: plan.steps.map((s) => ({ skill_id: s.skill_id, params: s.params,
                                    rationale: s.rationale || "",
                                    planned_hand: s.planned_hand || null })),
      robot_model: robot(), structure: STRUCTURE });
    Object.assign(plan, body);
    draw();
  }
}

/* ---------------- run robot (placeholder) ---------------- */
/* Not connected to hardware yet: the button only calls runRobot, so hooking up
   a robot means replacing this one function. It reports progress (0..1) through
   onProgress, which fills the button like a loading bar, and resolves to
   { ok, detail }. The placeholder just fills it over RUN_ROBOT_MS. */
const RUN_ROBOT_MS = 5000;
function runRobot(p, onProgress) {
  return new Promise((done) => {
    const t0 = performance.now();
    const tick = (now) => {
      const u = Math.min((now - t0) / RUN_ROBOT_MS, 1);
      onProgress(u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);   // ease in-out
      if (u < 1) { requestAnimationFrame(tick); return; }
      done({ ok: false, detail: `No robot connected yet. Plan ${p.plan_id || "(unsaved)"} ` +
        `(${p.steps.length} steps) would run on ${robot()}.` });
    };
    requestAnimationFrame(tick);
  });
}
let robotRunning = false;
$("#runrobot").addEventListener("click", async () => {
  if (robotRunning || !plan || !(plan.steps || []).length) return;
  const btn = $("#runrobot"), label = btn.firstElementChild, note = $("#robotnote");
  const id = plan.plan_id;
  robotRunning = true;
  btn.classList.add("loading");
  note.classList.add("hidden");
  const r = await runRobot(plan, (f) => {
    btn.style.setProperty("--p", f.toFixed(4));
    label.textContent = `Running\u2026 ${Math.round(f * 100)}%`;
  });
  robotRunning = false;
  btn.classList.remove("loading");
  btn.style.removeProperty("--p");
  label.textContent = "Run robot";
  note.dataset.plan = String(id);
  note.textContent = "";
  note.appendChild(el("div", r.ok ? "ok" : "no", r.detail));
  if (plan && plan.plan_id === id) note.classList.remove("hidden");
});

/* ---------------- install + run ---------------- */
$("#install").addEventListener("click", async () => {
  if (!plan || !plan.installable) return;
  $("#install").disabled = true;
  try { await postJSON("/api/install", { plan_id: plan.plan_id }); }
  catch (e) { showError("Install refused: " + e.message); $("#install").disabled = false; return; }
  const log = $("#runlog");
  log.classList.remove("hidden"); log.textContent = "";
  const seen = new Set();
  const id = plan.plan_id;                 // follow this plan, whatever is compiled next
  const started = Date.now();
  let failures = 0, warned = false;
  stopFollowing();
  runActive = true;
  draw();                                  // drop the + bars, drag and L/R
  pollTimer = setInterval(async () => {
    if (Date.now() - started > RUN_FOLLOW_MS) {
      log.appendChild(el("div", "no", "Stopped following after 30 minutes."));
      finishRun(); return;
    }
    try {
      const s = await getJSON(`/api/plans/${id}/status`);
      failures = 0;
      if (s.status === "queued" && !warned && Date.now() - started > 15000) {
        warned = true;
        const note = el("div", null,
          "Still queued: no runner has picked it up. Start one with " +
          "python runner/runner.py --mock, or ");
        const cancel = el("button", "linkish", "take it off the queue");
        cancel.addEventListener("click", async () => {
          try { await postJSON(`/api/plans/${id}/cancel`, {}); }
          catch (e) { showError("Could not cancel: " + e.message); return; }
          log.appendChild(el("div", null, "Taken off the queue."));
          finishRun();
        });
        note.appendChild(cancel);
        log.appendChild(note);
      }
      s.runs.forEach((run) => {
        const key = `${run.step_index}:${run.created_at}:${run.success}`;
        if (seen.has(key)) return;
        seen.add(key);
        const d = el("div");
        d.appendChild(el("span", run.success ? "ok" : "no", run.success ? "PASS " : "FAIL "));
        d.appendChild(el("span", null, `step ${run.step_index + 1} · ${run.skill_id}` +
          (run.duration_s != null ? ` · ${run.duration_s.toFixed(1)}s` : "")));
        log.appendChild(d); log.scrollTop = log.scrollHeight;
      });
      if (s.status === "done" || s.status === "failed") {
        finishRun();
        loadCatalog();
      }
    } catch (e) {
      failures += 1;
      if (failures >= 10) {
        finishRun();
        showError("Lost contact with the server while following the run: " + e.message);
      }
    }
  }, 500);
});

const RUN_FOLLOW_MS = 30 * 60 * 1000;
function stopFollowing() {
  clearInterval(pollTimer);
  pollTimer = null;
  if (runActive) { runActive = false; $("#install").disabled = false; }
}
function finishRun() {
  stopFollowing();
  if (plan) draw();
}

/* ---------------- catalog + datasets ---------------- */
async function loadCatalog() {
  const body = await getJSON("/api/skills?robot_model=" + encodeURIComponent(robot()));
  catalogCache = body.skills;
  if (plan) renderGit();      // the state flow needs each skill's deletes from here
  const n = (t) => catalogCache.filter((s) => s.availability === t).length;
  $("#catalog-count").textContent =
    `${body.count} skills · ${n("skill_and_data")} trained · ` +
    `${n("data_only")} data only · ${n("none")} neither`;
  drawCatalog();
}
function partName(id) {
  const m = catalogCache.find((x) => x.id === id);
  return m ? m.name : id;
}

/* ---------------- customer ratings ---------------- */
/* Stars shown as a filled overlay over five outlines, so 4.3 reads as 4.3. */
function starsEl(avg, count, cls) {
  const wrap = el("span", "stars" + (cls ? " " + cls : ""));
  if (avg == null) {
    wrap.appendChild(el("span", "stars-none", "No ratings yet"));
    return wrap;
  }
  const bar = el("span", "stars-bar");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", `${avg.toFixed(1)} out of 5 stars`);
  bar.appendChild(el("span", "stars-bg", "★★★★★"));
  const fill = el("span", "stars-fill", "★★★★★");
  fill.style.width = (avg / 5 * 100).toFixed(1) + "%";
  bar.appendChild(fill);
  wrap.appendChild(bar);
  wrap.appendChild(el("span", "stars-num", avg.toFixed(1)));
  wrap.appendChild(el("span", "stars-count", `(${count})`));
  return wrap;
}

/* The popup's rating section: average, how many of each star, the newest
   reviews, and a form to add one. Re-renders itself after a submit. */
function ratingBlock(skillId, r) {
  const box = el("div", "rating");
  const head = el("div", "rating-head");
  head.appendChild(el("div", "rating-avg", r.avg == null ? "–" : r.avg.toFixed(1)));
  const hs = el("div");
  hs.appendChild(starsEl(r.avg, r.count, "big"));
  hs.appendChild(el("div", "m-sub", r.count === 1 ? "1 review" : `${r.count} reviews`));
  head.appendChild(hs);
  box.appendChild(head);

  const hist = el("div", "rating-hist");
  const max = Math.max(1, ...r.histogram);
  r.histogram.forEach((n, i) => {
    const row = el("div", "hist-row");
    row.appendChild(el("span", "hist-label", `${5 - i}★`));
    const track = el("span", "hist-track");
    const fill = el("span", "hist-fill");
    fill.style.width = (n / max * 100).toFixed(1) + "%";
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el("span", "hist-n", String(n)));
    hist.appendChild(row);
  });
  box.appendChild(hist);

  if (r.samples) {
    box.appendChild(el("div", "rating-sample",
      `${r.samples} of these are sample reviews, seeded for the demo.`));
  }
  const list = el("div", "rating-list");
  r.reviews.forEach((v) => {
    const item = el("div", "review");
    const top = el("div", "review-top");
    top.appendChild(starsEl(v.stars, 0, "small"));
    top.appendChild(el("span", "review-who",
      `${v.author} · ${v.robot_model} · ${v.created_at.slice(0, 10)}`));
    if (v.sample) top.appendChild(el("span", "review-tag", "sample"));
    item.appendChild(top);
    if (v.comment) item.appendChild(el("div", "review-text", v.comment));
    list.appendChild(item);
  });
  box.appendChild(list);

  const form = el("form", "review-form");
  form.appendChild(el("div", "review-form-title", `Rate this skill on ${robot()}`));
  const pick = el("div", "star-pick");
  pick.setAttribute("role", "radiogroup");
  pick.setAttribute("aria-label", "Stars");
  // Built 5..1 and shown reversed, so "this star and every one before it" lights
  // up with a plain sibling selector.
  for (let k = 5; k >= 1; k--) {
    const id = `rv-star-${k}`;
    const input = el("input"); input.type = "radio"; input.name = "rv-stars";
    input.id = id; input.value = String(k); if (k === 5) input.checked = true;
    const label = el("label", null, "★"); label.htmlFor = id;
    label.title = `${k} star${k > 1 ? "s" : ""}`;
    pick.append(input, label);
  }
  form.appendChild(pick);
  const comment = el("textarea"); comment.id = "rv-comment"; comment.maxLength = 500;
  comment.placeholder = "What worked, what did not? (optional)"; comment.rows = 2;
  const author = el("input"); author.id = "rv-author"; author.maxLength = 40;
  author.placeholder = "Your name or team (optional)";
  const send = el("button", "cta small", "Post rating"); send.type = "submit";
  form.append(comment, author, send);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    send.disabled = true;
    try {
      const stars = Number(form.querySelector("input[name=rv-stars]:checked").value);
      const next = await postJSON(`/api/skills/${encodeURIComponent(skillId)}/reviews`, {
        stars, comment: comment.value, author: author.value, robot_model: robot() });
      box.replaceWith(ratingBlock(skillId, next));
      const s = catalogCache.find((x) => x.id === skillId);
      if (s) { s.rating = { avg: next.avg, count: next.count }; drawCatalog(); }
    } catch (e) {
      showError("Could not post the rating: " + e.message);
      send.disabled = false;
    }
  });
  box.appendChild(form);
  return box;
}

function combiCard(s) {
  const card = el("div", "card combi");
  card.style.setProperty("--c", "#FF4D0D");
  card.appendChild(schematicEl(s, "ph", "100%", 92));
  const b = el("div", "body");
  b.appendChild(el("h4", null, s.name));
  b.appendChild(el("div", "sub", s.title || ""));
  b.appendChild(starsEl((s.rating || {}).avg ?? null, (s.rating || {}).count || 0));

  const parts = s.composed_of || [];
  const chain = el("div", "combi-chain");
  // Collapse the repeats -- a 14-step chain is usually a handful of distinct skills.
  const seen = [];
  parts.forEach((id) => { if (!seen.includes(id)) seen.push(id); });
  seen.slice(0, 6).forEach((id) => chain.appendChild(el("span", null, partName(id))));
  if (seen.length > 6) chain.appendChild(el("span", "more", `+${seen.length - 6} more`));
  b.appendChild(chain);

  const stat = el("div", "combi-stat");
  const add = (label, value) => {
    const d = el("div");
    d.appendChild(el("b", null, value));
    d.appendChild(document.createTextNode(" " + label));
    stat.appendChild(d);
  };
  add("steps", String(parts.length));
  add("distinct", String(seen.length));
  if (s.est_duration_s) add("sec", String(Math.round(s.est_duration_s)));
  stat.appendChild(el("div", null, ""));
  b.appendChild(stat);

  const foot = el("div", "foot");
  foot.appendChild(el("span", "price", eur(s.price_eur)));
  const a = AVAIL[s.availability] || AVAIL.none;
  const av = el("span", "avail " + a.cls);
  av.appendChild(el("i")); av.appendChild(document.createTextNode(a.label));
  foot.appendChild(av);
  b.appendChild(foot);
  card.appendChild(b);
  card.addEventListener("click", () => openDetail(s.id));
  return card;
}

function atomCard(s) {
  const a = AVAIL[s.availability] || AVAIL.none;
  const card = el("div", "card");
  card.style.setProperty("--c", colorFor(s.id));
  card.appendChild(schematicEl(s, "ph", "100%", 110));
  const b = el("div", "body");
  b.appendChild(el("h4", null, s.name));
  b.appendChild(el("div", "sub", s.title));
  b.appendChild(starsEl((s.rating || {}).avg ?? null, (s.rating || {}).count || 0));
  const av = el("div", "avail " + a.cls);
  av.appendChild(el("i")); av.appendChild(document.createTextNode(a.label));
  b.appendChild(av);
  const foot = el("div", "foot");
  foot.appendChild(el("span", null, eur(s.price_eur)));
  foot.appendChild(el("span", "sub", (s.dataset_name || "no dataset") +
    (s.dataset_count > 1 ? ` +${s.dataset_count - 1}` : "")));
  b.appendChild(foot);
  card.appendChild(b);
  card.addEventListener("click", () => openDetail(s.id));
  return card;
}

function drawCatalog() {
  const q = ($("#filter").value || "").toLowerCase();
  const grid = $("#grid");
  grid.textContent = "";
  const match = (s) => !q ||
    (s.id + s.name + s.title + s.category + s.vendor).toLowerCase().includes(q);
  const all = catalogCache.filter(match);
  const combis = all.filter((s) => s.category === "composite");
  const atoms = all.filter((s) => s.category !== "composite");

  if (combis.length) {
    grid.appendChild(el("div", "grid-sep",
      `COMPOSED HERE \u00b7 ${combis.length} combi-skill${combis.length > 1 ? "s" : ""}`));
    combis.forEach((s) => grid.appendChild(combiCard(s)));
    grid.appendChild(el("div", "grid-sep", `SINGLE SKILLS \u00b7 ${atoms.length}`));
  }
  atoms.forEach((s) => grid.appendChild(atomCard(s)));
}
$("#filter").addEventListener("input", drawCatalog);
$("#robot").addEventListener("change", loadCatalog);

async function loadDatasets() {
  const body = await getJSON("/api/datasets");
  credits = body.thumb_credits || {};
  const ds = body.datasets;
  const hours = ds.reduce((a, d) => a + (d.hours || 0), 0);
  $("#data-meta").textContent =
    `${ds.length} sources · ${hours.toLocaleString()}+ hours of egocentric and teleop data`;
  const grid = $("#datasets");
  grid.textContent = "";
  ds.forEach((d) => {
    const card = el("div", "card");
    card.style.setProperty("--c", colorFor(d.id));
    const img = el("img", "ph");
    img.src = "/static/thumbs/ds_" + d.id + ".jpg";
    img.loading = "lazy";
    img.onerror = () => { try { img.replaceWith(el("div", "ph none",
      d.access === "gated-auto" ? "gated — set HF_TOKEN" : "no preview")); } catch (_) {} };
    card.appendChild(img);
    const b = el("div", "body");
    b.appendChild(el("h4", null, d.name));
    b.appendChild(el("div", "sub", `${d.publisher} · ${d.kind}` +
      (d.hours ? " · " + d.hours.toLocaleString() + "h" : "")));
    b.appendChild(el("p", null, d.notes));
    const foot = el("div", "foot");
    foot.appendChild(el("span", "lic", d.license));
    foot.appendChild(el("span", "sub",
      d.skills ? `${d.skills} skills · ${d.episodes} eps` : d.access));
    b.appendChild(foot);
    card.appendChild(b);
    card.style.cursor = "pointer";
    card.addEventListener("click", () => openDatasetDetail(d));
    grid.appendChild(card);
  });
  drawCatalog();
}

function openDatasetDetail(d) {
  const card = $(".modal-card");
  card.style.setProperty("--c", colorFor(d.id));
  const b = $("#modal-body");
  b.textContent = "";
  const hero = el("div", "m-hero");
  const ht = el("div");
  ht.appendChild(el("h3", null, d.name));
  ht.appendChild(el("div", "m-sub", `${d.publisher} · ${d.kind}`));
  hero.appendChild(ht);
  b.appendChild(hero);
  const clip = d.clip;
  b.appendChild(clipEl(clip, clip && clip.kind !== "none"
    ? `${clip.length || 6}s from ${clip.repo_id}` +
      (clip.kind === "stream" ? ", streamed from the Hub" : "") + "."
    : ""));
  const body = el("div", "m-body");
  body.appendChild(mrow("Access", d.access));
  body.appendChild(mrow("Licence", d.license));
  if (d.hours) body.appendChild(mrow("Size", `${d.hours.toLocaleString()} h` + (d.size ? " · " + d.size : "")));
  if (d.repo_id) body.appendChild(mrow("Repo", el("code", null, d.repo_id)));
  if (d.url) {
    const a = el("a", null, d.url);
    a.href = d.url; a.target = "_blank"; a.rel = "noopener";
    body.appendChild(mrow("Source", a));
  }
  body.appendChild(mrow("Used by", d.skills ? `${d.skills} skills · ${d.episodes} episodes` : "no skills yet"));
  body.appendChild(mrow("Notes", d.notes || "—"));
  b.appendChild(body);
  $("#modal").classList.remove("hidden");
}

/* ---------------- demand ---------------- */
async function loadGaps() {
  const g = await getJSON("/api/gaps?limit=24");
  $("#demand-meta").textContent =
    `${g.total_requests} requests \u00b7 ${g.distinct_gaps} distinct gaps`;
  const wrap = $("#gaps");
  wrap.textContent = "";
  if (!g.gaps.length) {
    wrap.appendChild(el("p", "demand-lede",
      "No gaps logged yet. Compile a few processes and they appear here."));
    return;
  }
  g.gaps.forEach((x) => {
    const c = el("div", "gapcard");
    c.appendChild(el("span", "count", x.requests + "\u00d7"));
    c.appendChild(el("h4", null, x.name));
    c.appendChild(el("div", "gid", x.proposed_id));
    if (x.covered_by) {
      // Not a gap after all: the catalog already has this motion. Trained means
      // the binder missed it; untrained means it is a data order, not a new skill.
      const cb = x.covered_by;
      const tag = el("div", "covered " + (cb.trained ? "trained" : "untrained"),
        (cb.trained ? "already available: " : "listed, needs training: ") + cb.name);
      tag.title = cb.trained
        ? "A trained skill covers this; the compiler should bind to it."
        : "The catalog lists this skill without a checkpoint; demand here is a data order for it.";
      c.appendChild(tag);
    }
    c.appendChild(el("p", null, x.description));
    x.example_prompts.forEach((q) =>
      c.appendChild(el("div", "quote", "\u201c" + q + "\u201d")));
    wrap.appendChild(c);
  });
}

/* ---------------- benchmark ---------------- */
function ciBar(r) {
  const cell = el("div", "cibar");
  [0, 25, 50, 75, 100].forEach((pct) => {
    const t = el("div", "tick");
    t.style.left = pct + "%";
    cell.appendChild(t);
  });
  const range = el("div", "range");
  range.style.left = (r.ci_low * 100) + "%";
  range.style.width = ((r.ci_high - r.ci_low) * 100) + "%";
  cell.appendChild(range);
  const point = el("div", "point");
  point.style.left = (r.rate * 100) + "%";
  cell.appendChild(point);
  return cell;
}

async function loadBenchmark() {
  const b = await getJSON("/api/benchmark?robot_model=" + encodeURIComponent(robot()));
  const wrap = $("#bench-table");
  wrap.textContent = "";
  if (!b.rows.length) {
    $("#bench-meta").textContent = "no runs recorded";
    wrap.appendChild(el("p", "bench-lede",
      "Nothing measured yet. Run: python tools/run_eval.py --all-trained --trials 20"));
    return;
  }
  $("#bench-meta").textContent =
    `${b.total_trials} trials \u00b7 overall ` +
    `${(b.overall_rate * 100).toFixed(1)}% ` +
    `[${(b.overall_ci[0] * 100).toFixed(0)}\u2013${(b.overall_ci[1] * 100).toFixed(0)}%]`;

  const table = el("table", "btable");
  const head = el("tr");
  ["Skill", "Status", "Episodes", "Trials", "Success", "95% interval", "", "Mean time"]
    .forEach((h) => head.appendChild(el("th", null, h)));
  table.appendChild(head);

  b.rows.forEach((r) => {
    const tr = el("tr");
    const nameCell = el("td");
    nameCell.appendChild(el("div", "bname", r.name));
    if (r.top_failures && r.top_failures.length) {
      nameCell.appendChild(el("div", "bfail",
        r.top_failures.map((f) => `${f.count}\u00d7 ${f.note}`).join("  \u00b7  ")));
    }
    tr.appendChild(nameCell);
    tr.appendChild(el("td", null, r.status));
    tr.appendChild(el("td", "num", String(r.episodes || 0)));
    tr.appendChild(el("td", "num", String(r.n)));
    const pct = Math.round(r.rate * 100);
    const rateCell = el("td", "num");
    rateCell.appendChild(el("span",
      "brate " + (pct >= 90 ? "hi" : pct >= 70 ? "mid" : "lo"), pct + "%"));
    rateCell.appendChild(el("div", "citext", `${r.successes}/${r.n}`));
    tr.appendChild(rateCell);
    const ciCell = el("td");
    ciCell.appendChild(ciBar(r));
    tr.appendChild(ciCell);
    tr.appendChild(el("td", "citext",
      `${(r.ci_low * 100).toFixed(0)}\u2013${(r.ci_high * 100).toFixed(0)}%`));
    tr.appendChild(el("td", "num",
      r.mean_duration_s != null ? r.mean_duration_s.toFixed(1) + "s" : "\u2014"));
    table.appendChild(tr);
  });
  wrap.appendChild(table);

  const foot = el("div", "bench-foot");
  foot.innerHTML =
    `An interval this wide is what ${b.rows[0].n} trials buys. For \u00b110pp around ` +
    `90% you need <b>${b.trials_for_10pp}</b> trials; for \u00b15pp, ` +
    `<b>${b.trials_for_5pp}</b>. Judge a skill by the lower bound.`;
  wrap.appendChild(foot);
}

$("#robot").addEventListener("change", () => loadBenchmark().catch(() => {}));

// Independent, so one failing section does not leave the others blank.
[loadDatasets, loadCatalog, loadGaps, loadBenchmark].forEach((load) =>
  load().catch((e) => showError(e.message)));
