/* Ninetails settings page */
"use strict";
/* global NT, browser */

const $ = (id) => document.getElementById(id);
const send = (msg) => browser.runtime.sendMessage(msg).then((r) => {
  if (r && r.error) throw new Error(r.error);
  return r;
});

let state = null;   // from background
let cfg = null;     // working copy of the active profile's config
let pendingRender = false;

/* tiny DOM helper; never uses innerHTML for data */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

function sw(checked, onchange, label) {
  const input = h("input", { type: "checkbox" });
  input.checked = !!checked;
  input.addEventListener("change", () => onchange(input.checked));
  return h("label", { class: "switch" }, input, h("span", { class: "track" }), label || "");
}

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return new Date(ts).toLocaleDateString();
}

/* ------------------------------------------------------------ */

async function refresh(force) {
  const fresh = await send({ type: "getState" });
  const editing = document.activeElement && document.activeElement.matches("input[type=text], input[type=url], input[type=number]");
  // Don't swap the working copy out from under a pending save or a field being typed in.
  if (dirty || (editing && !force)) {
    state = Object.assign(fresh, { config: state ? state.config : fresh.config });
    pendingRender = true;
    renderHeader();
    return;
  }
  state = fresh;
  cfg = NT.clone(state.config);
  render();
}

let saveTimer = null;
let dirty = false;
function save(immediate) {
  clearTimeout(saveTimer);
  dirty = true;
  const go = () => send({ type: "setConfig", config: cfg })
    .catch(showErr)
    .finally(() => { dirty = false; refresh(false); });
  if (immediate) return go();
  saveTimer = setTimeout(go, 350);
}

function showErr(e) {
  const m = $("profile-msg");
  m.className = "error";
  m.textContent = String(e.message || e);
}
function showOk(text) {
  const m = $("profile-msg");
  m.className = "okmsg";
  m.textContent = text;
  setTimeout(() => { if (m.textContent === text) m.textContent = ""; }, 5000);
}

document.addEventListener("focusout", () => {
  setTimeout(() => {
    if (pendingRender && !(document.activeElement && document.activeElement.matches("input[type=text], input[type=url], input[type=number]"))) {
      pendingRender = false;
      setTimeout(() => refresh(false), 400); // after any change-event save has gone out
    }
  }, 0);
});

/* ------------------------------------------------------------ */

function render() {
  renderHeader();
  renderProfiles();
  renderCats();
  renderWins();
  renderBehavior();
  renderExclude();
  renderAutoClose();
  renderLog();
}

function renderHeader() {
  $("enabled").checked = state.enabled;
  $("enabled-label").textContent = state.enabled ? "On" : "Paused";
  const t = state.lastTick;
  $("tick-status").textContent = t
    ? `Last pass ${ago(t.at)}: moved ${t.moved}, closed ${t.closed + (t.autoClosed || 0) + (t.idleClosed || 0)}, sorted ${t.sorted} window${t.sorted === 1 ? "" : "s"}` + (t.errors.length ? ` · ${t.errors.length} error(s)` : "")
    : "";
  $("tick-status").title = t && t.errors.length ? t.errors.join("\n") : "";
}

function renderProfiles() {
  const sel = $("profile-select");
  sel.replaceChildren(...state.profiles.map((p) =>
    h("option", { value: p.id, selected: p.id === state.activeId }, p.name + (p.id === state.defaultId ? "  ★" : ""))));
  $("default-badge").hidden = state.activeId !== state.defaultId;
  $("p-default").disabled = state.activeId === state.defaultId;
  $("p-delete").disabled = state.profiles.length < 2;
  $("start-default").checked = state.startWithDefault;
}

function catWindow(catId) {
  return state.windows.find((w) => w.catId === catId) || null;
}

function renderCats() {
  const box = $("cats");
  const others = (id) => cfg.categories.filter((c) => c.id !== id);
  box.replaceChildren(...cfg.categories.map((c, i) => {
    const w = catWindow(c.id);
    const name = h("input", { type: "text", class: "name", value: c.name, maxlength: 60, "aria-label": "Window name" });
    name.addEventListener("change", () => {
      const v = name.value.trim();
      if (!v) { name.value = c.name; return; }
      c.name = v;
      save(true);
    });

    const catchAll = sw(c.catchAll, (v) => {
      for (const k of cfg.categories) k.catchAll = false;
      c.catchAll = v;
      save(true);
      renderCats();
    }, "Also catch everything no other window claims");
    catchAll.classList.add("small");
    catchAll.title = "Only one window can do this. Pages on the never-touch list are still left alone.";

    const pats = h("div", { class: "pats" }, c.catchAll ? h("span", { class: "chip" }, h("span", { text: "everything else" })) : null, c.patterns.length ? c.patterns.map((p, pi) => {
      const err = NT.validatePattern(p);
      return h("span", { class: "chip" + (err ? " bad" : ""), title: err || p },
        h("span", { text: p }),
        h("button", { title: "Remove", "aria-label": "Remove " + p, onclick: () => { c.patterns.splice(pi, 1); save(true); renderCats(); } }, "×"));
    }) : c.catchAll ? null : h("span", { class: "muted small" }, "No rules yet — add a site below."));

    const inp = h("input", { type: "text", placeholder: "Add site or pattern (comma-separate several)", "aria-label": "Add pattern to " + c.name });
    const err = h("div", { class: "error" });
    const add = () => {
      const items = inp.value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
      const bad = items.map((p) => [p, NT.validatePattern(p)]).filter(([, e]) => e);
      if (bad.length) { err.textContent = bad.map(([p, e]) => `${p}: ${e}`).join("; "); return; }
      for (const p of items) if (!c.patterns.includes(p)) c.patterns.push(p);
      inp.value = "";
      err.textContent = "";
      save(true);
      renderCats();
      const again = box.querySelectorAll(".addpat input")[i];
      if (again) again.focus();
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });

    const merge = h("select", { "aria-label": "Merge " + c.name + " into another window" },
      h("option", { value: "" }, "Merge into…"),
      others(c.id).map((o) => h("option", { value: o.id }, o.name)));
    merge.addEventListener("change", async () => {
      const into = cfg.categories.find((o) => o.id === merge.value);
      merge.value = "";
      if (!into) return;
      const wi = catWindow(into.id);
      const msg = `Merge “${c.name}” into “${into.name}”?\n\n• Its ${c.patterns.length} rule(s) move to “${into.name}”.` +
        (w && wi ? `\n• Its window's ${w.tabCount} tab(s) move into the “${into.name}” window.` : w ? `\n• Its window becomes the “${into.name}” window.` : "");
      if (!confirm(msg)) return;
      try { await send({ type: "mergeCategories", fromId: c.id, intoId: into.id }); } catch (e) { showErr(e); }
      refresh(true);
    });

    return h("div", { class: "cat" + (c.enabled ? "" : " off") },
      h("div", { class: "row" },
        sw(c.enabled, (v) => { c.enabled = v; save(true); renderCats(); }),
        name,
        h("span", { class: "winstate" + (w ? " has" : "") }, w ? `● ${w.tabCount} tabs` : "○ no window yet"),
        windowPicker(c, w),
        w ? h("button", { class: "icon", title: "Bring this window forward", onclick: () => send({ type: "focusWindow", windowId: w.id }) }, "Show")
          : h("button", { class: "icon primary", title: "Open a new Firefox window for " + c.name, onclick: () => openFor(c) }, "Open window"),
        h("span", { class: "grow" }),
        h("button", { class: "icon", title: "Move up (higher priority)", "aria-label": "Move up", disabled: i === 0, onclick: () => { move(i, -1); } }, "↑"),
        h("button", { class: "icon", title: "Move down", "aria-label": "Move down", disabled: i === cfg.categories.length - 1, onclick: () => { move(i, 1); } }, "↓"),
        merge,
        h("button", { class: "icon danger", title: "Delete window category", onclick: () => {
          if (!confirm(`Delete “${c.name}” and its ${c.patterns.length} rule(s)? Its window stays open; Ninetails just stops managing it.`)) return;
          cfg.categories.splice(i, 1); save(true); renderCats();
        } }, "Delete")),
      pats,
      h("div", { class: "addpat" }, inp, h("button", { onclick: add }, "Add")),
      h("div", { style: "margin-top:6px" }, catchAll),
      idleCloseRow(c),
      err);
  }));
}

/* "Close this window's tabs once unused for N hours/days" */
const UNITS = [["minutes", 1], ["hours", 60], ["days", 1440]];
function idleCloseRow(c) {
  const mins = c.closeIdleMin;
  const unit = !mins ? 1440 : mins % 1440 === 0 ? 1440 : mins % 60 === 0 ? 60 : 1;
  const num = h("input", { type: "number", min: 1, max: 525600, value: mins ? mins / unit : 3, "aria-label": "How long unused", style: "width:5em" });
  const sel = h("select", { "aria-label": "Unit" }, UNITS.map(([n, m]) => h("option", { value: m, selected: m === unit }, n)));
  num.disabled = sel.disabled = !mins;
  const apply = () => {
    const v = Number(num.value);
    if (!(v > 0)) return;
    c.closeIdleMin = Math.round(v * Number(sel.value));
    save(true);
  };
  num.addEventListener("change", apply);
  sel.addEventListener("change", apply);
  const toggle = sw(!!mins, (on) => {
    if (on) {
      const v = Number(num.value) > 0 ? Number(num.value) : 3;
      c.closeIdleMin = Math.round(v * Number(sel.value));
      if (!confirm(`Close ${c.name} tabs nobody has used for ${v} ${sel.selectedOptions[0].textContent}?\n\nPinned tabs, tabs playing sound and the tab showing in each window are kept. Closed tabs are listed under “Closed tabs” with Reopen.`)) {
        c.closeIdleMin = null; renderCats(); return;
      }
    } else c.closeIdleMin = null;
    save(true);
    renderCats();
  }, "Close this window's tabs unused for");
  toggle.classList.add("small");
  const due = state.idleDue && state.idleDue[c.id];
  return h("div", { class: "row small", style: "margin-top:6px" }, toggle, num, sel,
    mins && due ? h("span", { class: "muted" }, `(${due} due now; they close a few at a time)`) : null);
}

function winLabel(w) {
  const t = (w.activeTitle || "Untitled").slice(0, 48);
  return `${w.focused ? "★ " : ""}${t} · ${w.tabCount} tabs`;
}

async function openFor(c) {
  try { await send({ type: "openWindowForCat", catId: c.id }); } catch (e) { showErr(e); }
  refresh(true);
}

/* "Which Firefox window is this?" — pick an open window, unassign, or open a new one. */
function windowPicker(c, w) {
  const sel = h("select", { "aria-label": "Firefox window for " + c.name, title: "Choose which Firefox window is " + c.name },
    h("option", { value: "" }, w ? "— unassign window —" : "Use an open window…"),
    state.windows.map((x) => {
      const owner = x.catId && x.catId !== c.id ? cfg.categories.find((k) => k.id === x.catId) : null;
      return h("option", { value: String(x.id), selected: w && w.id === x.id }, winLabel(x) + (owner ? `  (now ${owner.name})` : ""));
    }),
    h("option", { value: "new" }, "＋ Open a new window"));
  if (!w) sel.value = "";
  sel.addEventListener("change", async () => {
    const v = sel.value;
    try {
      if (v === "new") await send({ type: "openWindowForCat", catId: c.id });
      else if (v === "") { if (w) await send({ type: "bindWindow", windowId: w.id, catId: null }); }
      else await send({ type: "bindWindow", windowId: Number(v), catId: c.id });
    } catch (e) { showErr(e); }
    refresh(true);
  });
  return sel;
}

function move(i, d) {
  const j = i + d;
  if (j < 0 || j >= cfg.categories.length) return;
  const [c] = cfg.categories.splice(i, 1);
  cfg.categories.splice(j, 0, c);
  save(true);
  renderCats();
}

function renderWins() {
  const rows = state.windows.map((w) => {
    const sel = h("select", { "aria-label": "Category for window" },
      h("option", { value: "" }, "— none —"),
      cfg.categories.map((c) => h("option", { value: c.id, selected: c.id === w.catId }, c.name)));
    sel.addEventListener("change", async () => { await send({ type: "bindWindow", windowId: w.id, catId: sel.value || null }); refresh(true); });
    return h("tr", {},
      h("td", {}, sel),
      h("td", { class: "small muted" }, w.tabCount + " tabs"),
      h("td", { class: "t small", title: w.activeTitle }, (w.focused ? "★ " : "") + (w.activeTitle || "")),
      h("td", {}, h("button", { class: "icon", onclick: () => send({ type: "focusWindow", windowId: w.id }) }, "Show")));
  });
  $("wins").replaceChildren(h("table", { class: "wins" }, rows));
}

function getPath(obj, path) { return path.split(".").reduce((o, k) => (o ? o[k] : undefined), obj); }
function setPath(obj, path, v) {
  const ks = path.split(".");
  const last = ks.pop();
  const o = ks.reduce((x, k) => (x[k] = x[k] || {}), obj);
  o[last] = v;
}

function renderBehavior() {
  for (const el of document.querySelectorAll("#behavior [data-s]")) {
    const v = getPath(cfg.settings, el.dataset.s);
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = v;
  }
}

document.querySelectorAll("#behavior [data-s]").forEach((el) => {
  el.addEventListener("change", () => {
    const v = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
    setPath(cfg.settings, el.dataset.s, v);
    save();
  });
});

function renderExclude() {
  const list = cfg.settings.exclude;
  const inp = h("input", { type: "text", class: "grow", placeholder: "e.g. bank.example.com", "aria-label": "Add never-touch pattern" });
  const err = h("div", { class: "error" });
  const add = () => {
    const p = inp.value.trim();
    if (!p) return;
    const e = NT.validatePattern(p);
    if (e) { err.textContent = e; return; }
    if (!list.includes(p)) list.push(p);
    save(true);
    renderExclude();
  };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  $("exclude").replaceChildren(
    h("div", { class: "pats", style: "display:flex;flex-wrap:wrap;gap:6px;margin:8px 0" },
      list.length ? list.map((p, i) => h("span", { class: "chip" }, h("span", { text: p }),
        h("button", { "aria-label": "Remove " + p, onclick: () => { list.splice(i, 1); save(true); renderExclude(); } }, "×")))
        : h("span", { class: "muted small" }, "Nothing excluded.")),
    h("div", { class: "row" }, inp, h("button", { onclick: add }, "Add")),
    err);
}

function renderAutoClose() {
  const ac = cfg.settings.autoClose;
  $("ac-enabled").checked = ac.enabled;
  if (document.activeElement !== $("ac-minutes")) $("ac-minutes").value = ac.minutes;
  const list = ac.patterns;
  const inp = h("input", { type: "text", class: "grow", placeholder: "e.g. zoom.us/j/ or title:Launch Meeting", "aria-label": "Add auto-close pattern" });
  const err = h("div", { class: "error" });
  const add = () => {
    const items = inp.value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    const bad = items.map((p) => [p, NT.validatePattern(p)]).filter(([, e]) => e);
    if (bad.length) { err.textContent = bad.map(([p, e]) => `${p}: ${e}`).join("; "); return; }
    for (const p of items) if (!list.includes(p)) list.push(p);
    save(true);
    renderAutoClose();
  };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  $("ac-pats").replaceChildren(
    h("div", { style: "display:flex;flex-wrap:wrap;gap:6px;margin:8px 0" },
      list.length ? list.map((p, i) => h("span", { class: "chip" }, h("span", { text: p }),
        h("button", { "aria-label": "Remove " + p, onclick: () => { list.splice(i, 1); save(true); renderAutoClose(); } }, "×")))
        : h("span", { class: "muted small" }, "Nothing set to auto-close.")),
    h("div", { class: "row" }, inp, h("button", { onclick: add }, "Add")),
    err);
}

$("ac-enabled").addEventListener("change", (e) => { cfg.settings.autoClose.enabled = e.target.checked; save(true); });
$("ac-minutes").addEventListener("change", (e) => { cfg.settings.autoClose.minutes = Number(e.target.value) || 10; save(true); });

function renderLog() {
  const log = state.closedLog;
  $("log").replaceChildren(...(log.length ? log.map((e, i) => h("div", { class: "item" },
    h("span", { class: "small muted" }, ago(e.closedAt) + (e.reason === "auto-close" ? " · auto-close" : e.reason === "idle" ? ` · unused (${e.window || "window"})` : " · duplicate")),
    h("span", { class: "t", title: e.url }, e.title),
    h("button", { class: "icon", onclick: async () => {
      const ok = await send({ type: "restoreClosed", index: i });
      if (!ok) alert("Couldn't reopen that one (local files can only be restored from Firefox's own History → Recently Closed Tabs).");
      refresh(true);
    } }, "Reopen")))
    : [h("p", { class: "muted small" }, "Nothing closed yet.")]));
}

/* ------------------------------------------------------------ */
/* static controls                                              */
/* ------------------------------------------------------------ */

$("enabled").addEventListener("change", (e) => send({ type: "setEnabled", value: e.target.checked }).then(() => refresh(true)));
$("tidy").addEventListener("click", async () => {
  $("tidy").disabled = true;
  try { await send({ type: "tidyNow" }); } catch (e) { showErr(e); }
  $("tidy").disabled = false;
  refresh(true);
});
$("rebind").addEventListener("click", async () => { await send({ type: "rebind" }); refresh(true); });
$("clear-log").addEventListener("click", async () => { await send({ type: "clearLog" }); refresh(true); });

$("add-cat").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("new-cat-name").value.trim();
  if (!name) return;
  cfg.categories.push({ id: NT.uid("cat"), name, enabled: true, patterns: [] });
  $("new-cat-name").value = "";
  save(true);
  renderCats();
  const inputs = document.querySelectorAll(".addpat input");
  if (inputs.length) inputs[inputs.length - 1].focus();
});

$("test").addEventListener("submit", async (e) => {
  e.preventDefault();
  await save(true);
  const r = await send({ type: "classify", url: $("test-url").value.trim(), title: $("test-title").value });
  const out = $("test-result");
  out.className = "small";
  if (r.match) out.textContent = `→ ${r.match.name}  (rule: ${r.match.pattern})`;
  else if (r.excluded) out.textContent = "→ on the never-touch list";
  else out.textContent = "→ no window; Ninetails leaves it where it is";
  if (r.autoClose) {
    out.textContent += r.autoClose.enabled
      ? ` · auto-closes after ${r.autoClose.minutes} unused minutes`
      : " · matches auto-close, but auto-close is switched off";
  }
});

/* profiles */
$("profile-select").addEventListener("change", async (e) => {
  try { await send({ type: "switchProfile", id: e.target.value }); showOk("Switched profile."); } catch (err) { showErr(err); }
  refresh(true);
});
$("p-default").addEventListener("click", async () => { await send({ type: "setDefaultProfile", id: state.activeId }); refresh(true); });
$("start-default").addEventListener("change", (e) => send({ type: "setStartWithDefault", value: e.target.checked }));
$("p-new").addEventListener("click", async () => {
  const name = prompt("Name for the new, empty profile:");
  if (!name) return;
  const id = await send({ type: "createProfile", name });
  if (confirm(`Switch to “${name}” now?`)) await send({ type: "switchProfile", id });
  refresh(true);
});
$("p-dup").addEventListener("click", async () => {
  const cur = state.profiles.find((p) => p.id === state.activeId);
  const name = prompt("Name for the copy:", cur.name + " copy");
  if (!name) return;
  const id = await send({ type: "createProfile", name, copyFrom: state.activeId });
  if (confirm(`Switch to “${name}” now?`)) await send({ type: "switchProfile", id });
  refresh(true);
});
$("p-rename").addEventListener("click", async () => {
  const cur = state.profiles.find((p) => p.id === state.activeId);
  const name = prompt("Rename profile:", cur.name);
  if (!name) return;
  await send({ type: "renameProfile", id: state.activeId, name });
  refresh(true);
});
$("p-delete").addEventListener("click", async () => {
  const cur = state.profiles.find((p) => p.id === state.activeId);
  if (!confirm(`Delete profile “${cur.name}”? Export it first if you might want it back.`)) return;
  try { await send({ type: "deleteProfile", id: state.activeId }); } catch (e) { showErr(e); }
  refresh(true);
});
$("p-export").addEventListener("click", async () => {
  const p = await send({ type: "getProfile", id: state.activeId });
  const blob = new Blob([JSON.stringify(p, null, 2) + "\n"], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: p.id + ".json" });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  showOk(`Saved ${p.id}.json to your Downloads. Put it in the repo's extension/profiles/ folder to carry it to another computer.`);
});
$("p-import").addEventListener("click", () => $("p-import-file").click());
$("p-import-file").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = "";
  for (const f of files) {
    try {
      const data = JSON.parse(await f.text());
      if (!data || !data.config || !Array.isArray(data.config.categories)) throw new Error(f.name + " isn't a Ninetails profile");
      const exists = state.profiles.find((p) => p.id === data.id);
      const overwrite = exists ? confirm(`A profile “${exists.name}” already exists. Replace it with the one in ${f.name}?\n\nCancel keeps both.`) : false;
      const id = await send({ type: "importProfile", profile: data, overwrite });
      showOk(`Imported “${data.name || id}”.`);
    } catch (err) { showErr(err); }
  }
  refresh(true);
});
$("p-bundled").addEventListener("click", async () => {
  try {
    const n = await send({ type: "reloadBundled", overwrite: false });
    showOk(n ? `Added ${n} bundled profile(s).` : "You already have every bundled profile.");
  } catch (e) { showErr(e); }
  refresh(true);
});

browser.runtime.onMessage.addListener((m) => { if (m && m.type === "nt:changed") refresh(false); });

refresh(true);
