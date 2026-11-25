/*
 * Ninetails — background engine.
 *
 * Everything here runs locally. The only fetch() calls read the extension's
 * own bundled profile files; Ninetails has no host permissions and makes no
 * network requests.
 */
"use strict";

/* global NT, browser */

const KEYS = {
  profiles: "nt.profiles",
  active: "nt.activeProfileId",
  dflt: "nt.defaultProfileId",
  enabled: "nt.enabled",
  startWithDefault: "nt.startWithDefault",
  log: "nt.closedLog",
  migrations: "nt.migrations"
};
const WIN_KEY = "ninetails";
const LAUNCH_RE = /^https?:\/\/ninetails\.localhost(\/|$)/i;
const OPTIONS_PATH = "options/options.html";
const LOG_MAX = 1000;

const S = {
  loaded: false,
  enabled: true,
  profiles: {},
  activeId: null,
  defaultId: null,
  startWithDefault: true,
  cfg: null,
  classifier: null,
  bindings: new Map(), // catId -> windowId
  winCat: new Map(),   // windowId -> catId
  seen: new Map(),     // tabId -> { catId, since }
  exempt: new Set(),   // tabIds the user placed by hand
  ourMoves: new Set(), // tabIds currently being moved by Ninetails
  titled: new Map(),   // windowId -> titlePreface we last set
  closedLog: [],
  lastTick: null,
  lastAction: null,
  rev: 0
};

let readyResolve;
const ready = new Promise((r) => (readyResolve = r));

/* ------------------------------------------------------------------ */
/* storage                                                             */
/* ------------------------------------------------------------------ */

async function loadBundled() {
  const get = async (p) => (await fetch(browser.runtime.getURL(p))).json();
  const idx = await get("profiles/index.json");
  const profiles = [];
  for (const f of idx.profiles || []) {
    try { profiles.push(NT.normalizeProfile(await get("profiles/" + f))); } catch (e) { console.warn("Ninetails: bad bundled profile", f, e); }
  }
  return { default: idx.default, profiles };
}

async function persist() {
  await browser.storage.local.set({
    [KEYS.profiles]: S.profiles,
    [KEYS.active]: S.activeId,
    [KEYS.dflt]: S.defaultId,
    [KEYS.enabled]: S.enabled,
    [KEYS.startWithDefault]: S.startWithDefault
  });
}

async function persistLog() {
  await browser.storage.local.set({ [KEYS.log]: S.closedLog.slice(0, LOG_MAX) });
}

function notify() {
  S.rev++;
  browser.runtime.sendMessage({ type: "nt:changed", rev: S.rev }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* classification + tracking                                           */
/* ------------------------------------------------------------------ */

function applyActive() {
  const p = S.profiles[S.activeId];
  S.cfg = NT.normalizeConfig(p ? p.config : {});
  S.classifier = NT.buildClassifier(S.cfg);
  // drop bindings for categories that no longer exist
  const ids = new Set(S.cfg.categories.map((c) => c.id));
  for (const [catId, winId] of Array.from(S.bindings)) {
    if (!ids.has(catId)) { S.bindings.delete(catId); S.winCat.delete(winId); }
  }
}

function classify(tab) {
  if (!S.classifier || !tab) return null;
  return S.classifier.classify(tab.url, tab.title);
}

function catById(id) {
  return S.cfg ? S.cfg.categories.find((c) => c.id === id) : null;
}

function track(tab, now) {
  const cls = classify(tab);
  const catId = cls ? cls.catId : null;
  const prev = S.seen.get(tab.id);
  if (!prev || prev.catId !== catId) {
    S.seen.set(tab.id, { catId, since: now });
    if (prev) S.exempt.delete(tab.id); // navigated somewhere new: hand placement no longer applies
  }
}

const inGroup = (t) => typeof t.groupId === "number" && t.groupId !== -1;

async function normalWindows(populate) {
  const ws = await browser.windows.getAll({ populate: !!populate, windowTypes: ["normal"] });
  return ws.filter((w) => !w.incognito);
}

/* ------------------------------------------------------------------ */
/* window <-> category bindings                                        */
/* ------------------------------------------------------------------ */

function setBind(catId, winId) {
  const oldWin = S.bindings.get(catId);
  if (oldWin !== undefined) S.winCat.delete(oldWin);
  const oldCat = S.winCat.get(winId);
  if (oldCat !== undefined) S.bindings.delete(oldCat);
  S.bindings.set(catId, winId);
  S.winCat.set(winId, catId);
}

function unbindWindow(winId) {
  const catId = S.winCat.get(winId);
  if (catId !== undefined) S.bindings.delete(catId);
  S.winCat.delete(winId);
}

async function persistBinding(winId) {
  const catId = S.winCat.get(winId);
  const cat = catId ? catById(catId) : null;
  try {
    if (cat) await browser.sessions.setWindowValue(winId, WIN_KEY, { catId: cat.id, catName: cat.name, profileId: S.activeId });
    else await browser.sessions.removeWindowValue(winId, WIN_KEY);
  } catch (e) { /* window may be gone */ }
}

function matchStoredValue(v) {
  if (!v || !S.cfg) return null;
  if (v.profileId === S.activeId) {
    const byId = catById(v.catId);
    if (byId) return byId;
  }
  const name = String(v.catName || "").toLowerCase();
  return S.cfg.categories.find((c) => c.name.toLowerCase() === name) || null;
}

/* Work out which window is which: saved window values first, then a guess from contents. */
async function bindAll() {
  const wins = await normalWindows(true);
  S.bindings.clear();
  S.winCat.clear();
  const unbound = [];
  for (const w of wins) {
    let v = null;
    try { v = await browser.sessions.getWindowValue(w.id, WIN_KEY); } catch (e) {}
    const cat = matchStoredValue(v);
    if (cat && !S.bindings.has(cat.id)) setBind(cat.id, w.id);
    else unbound.push(w);
  }
  if (S.cfg.settings.autoBind) guessBindings(unbound);
  for (const w of wins) await persistBinding(w.id);
  await refreshTitles(wins);
}

function guessBindings(wins) {
  const cands = [];
  for (const w of wins) {
    const tabs = w.tabs || [];
    if (!tabs.length) continue;
    const counts = new Map();
    for (const t of tabs) {
      const cls = classify(t);
      if (cls) counts.set(cls.catId, (counts.get(cls.catId) || 0) + 1);
    }
    for (const [catId, n] of counts) {
      const cat = catById(catId);
      // "everything else" is a weaker signal than a real rule match
      const score = cat && cat.catchAll ? n / 2 : n;
      if (score >= 2 && score / tabs.length >= 0.3) cands.push({ w: w.id, catId, n: score });
    }
  }
  cands.sort((a, b) => b.n - a.n);
  for (const c of cands) {
    if (S.bindings.has(c.catId) || S.winCat.has(c.w)) continue;
    setBind(c.catId, c.w);
  }
}

async function refreshTitles(wins) {
  wins = wins || (await normalWindows(false));
  for (const w of wins) {
    const cat = catById(S.winCat.get(w.id));
    const preface = cat && S.enabled ? "[" + cat.name + "] " : "";
    if (S.titled.get(w.id) === preface) continue;
    try { await browser.windows.update(w.id, { titlePreface: preface }); S.titled.set(w.id, preface); } catch (e) {}
  }
}

/* ------------------------------------------------------------------ */
/* moving                                                              */
/* ------------------------------------------------------------------ */

function movable(t) {
  const st = S.cfg.settings;
  if (t.pinned || t.active || t.audible || t.hidden) return false;
  if (S.exempt.has(t.id)) return false;
  if (st.respectTabGroups && inGroup(t)) return false;
  return NT.isManageable(t.url);
}

/* Move tab ids into the window for catId, creating it if allowed. Returns count moved. */
async function moveTabsToCat(ids, catId, allowCreate) {
  if (!ids.length) return 0;
  let target = S.bindings.get(catId);
  let moved = 0;
  ids.forEach((id) => S.ourMoves.add(id));
  try {
    let rest = ids.slice();
    if (target === undefined) {
      if (!allowCreate) return 0;
      let prevFocus = null;
      try { prevFocus = await browser.windows.getLastFocused(); } catch (e) {}
      const nw = await browser.windows.create({ tabId: rest.shift() });
      setBind(catId, nw.id);
      await persistBinding(nw.id);
      await refreshTitles();
      target = nw.id;
      moved++;
      if (prevFocus && prevFocus.id !== nw.id) {
        try { await browser.windows.update(prevFocus.id, { focused: true }); } catch (e) {}
      }
    }
    if (rest.length) {
      await browser.tabs.move(rest, { windowId: target, index: -1 });
      moved += rest.length;
    }
  } finally {
    setTimeout(() => ids.forEach((id) => S.ourMoves.delete(id)), 3000);
  }
  return moved;
}

async function doMoves(wins, res, budget, manual) {
  const st = S.cfg.settings;
  const now = Date.now();
  const delay = st.moveDelayMin * 60000;
  const plan = new Map();
  let n = 0;
  outer: for (const w of wins) {
    for (const t of w.tabs || []) {
      if (n >= budget) break outer;
      track(t, now);
      const cls = classify(t);
      if (!cls) continue;
      const target = S.bindings.get(cls.catId);
      if (target === w.id) continue;
      if (!movable(t)) continue;
      if (autoCloseOn() && S.classifier.isAutoClose(t.url, t.title)) continue; // about to be closed anyway
      if (!manual && now - S.seen.get(t.id).since < delay) continue;
      if (target === undefined && !st.createWindows) continue;
      if (!plan.has(cls.catId)) plan.set(cls.catId, []);
      plan.get(cls.catId).push(t.id);
      n++;
    }
  }
  for (const [catId, ids] of plan) {
    const hadWindow = S.bindings.has(catId);
    try {
      res.moved += await moveTabsToCat(ids, catId, st.createWindows);
      if (!hadWindow && S.bindings.has(catId)) res.created++;
    } catch (e) { res.errors.push("move: " + e.message); }
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* duplicates                                                          */
/* ------------------------------------------------------------------ */

function pickKeeper(list) {
  let best = null, bestScore = -Infinity;
  for (const x of list) {
    const t = x.t;
    const cls = classify(t);
    const home = cls && S.bindings.get(cls.catId) === x.w;
    const score = (t.pinned ? 8e15 : 0) + (t.active ? 4e15 : 0) + (home ? 2e15 : 0) + (t.lastAccessed || 0);
    if (score > bestScore) { bestScore = score; best = x; }
  }
  return best;
}

async function doDedupe(wins, res, budget) {
  const st = S.cfg.settings;
  const now = Date.now();
  const idle = st.dedupeIdleMin * 60000;
  const groups = new Map();
  for (const w of wins) {
    for (const t of w.tabs || []) {
      if (t.hidden) continue;
      if (S.classifier.isExcluded(t.url, t.title)) continue;
      const key = NT.normalizeUrl(t.url, st);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ t, w: w.id });
    }
  }
  const close = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const keep = pickKeeper(list);
    for (const x of list) {
      if (x === keep || close.length >= budget) continue;
      const t = x.t;
      if (t.pinned || t.active || t.audible) continue;
      if (st.respectTabGroups && inGroup(t)) continue;
      if (now - (t.lastAccessed || now) < idle) continue;
      close.push(t);
    }
  }
  if (!close.length) return 0;
  const at = Date.now();
  const entries = close.map((t) => ({ url: t.url, title: t.title || t.url, closedAt: at, profile: S.activeId }));
  try {
    await browser.tabs.remove(close.map((t) => t.id));
    res.closed += close.length;
    S.closedLog = entries.concat(S.closedLog).slice(0, LOG_MAX);
    await persistLog();
  } catch (e) { res.errors.push("dedupe: " + e.message); }
  return close.length;
}

/* ------------------------------------------------------------------ */
/* auto-close (e.g. Zoom launch pages)                                 */
/* ------------------------------------------------------------------ */

function autoCloseOn() {
  const ac = S.cfg.settings.autoClose;
  return !!(ac && ac.enabled && ac.patterns.length);
}

async function doAutoClose(wins, res, budget) {
  if (!autoCloseOn()) return 0;
  const wait = S.cfg.settings.autoClose.minutes * 60000;
  const now = Date.now();
  const close = [];
  for (const w of wins) {
    for (const t of w.tabs || []) {
      if (close.length >= budget) break;
      if (t.pinned || t.audible || t.hidden) continue;
      if (t.active && w.focused) continue; // you're looking at it
      if (!S.classifier.isAutoClose(t.url, t.title)) continue;
      track(t, now);
      const since = Math.max(S.seen.get(t.id).since, t.lastAccessed || 0);
      if (now - since < wait) continue;
      close.push(t);
    }
  }
  if (!close.length) return 0;
  const at = Date.now();
  try {
    await browser.tabs.remove(close.map((t) => t.id));
    res.autoClosed += close.length;
    S.closedLog = close.map((t) => ({ url: t.url, title: t.title || t.url, closedAt: at, profile: S.activeId, reason: "auto-close" }))
      .concat(S.closedLog).slice(0, LOG_MAX);
    await persistLog();
  } catch (e) { res.errors.push("auto-close: " + e.message); }
  return close.length;
}

/* ------------------------------------------------------------------ */
/* per-window idle close (e.g. "close Random tabs unused for 3 days")  */
/* ------------------------------------------------------------------ */

/* Tabs that a window's idle-close setting would close right now. */
function idleCandidates(wins) {
  const st = S.cfg.settings;
  const now = Date.now();
  const out = [];
  for (const w of wins) {
    for (const t of w.tabs || []) {
      if (t.pinned || t.audible || t.hidden || t.active) continue; // the tab showing in any window stays
      if (S.exempt.has(t.id)) continue;
      if (st.respectTabGroups && inGroup(t)) continue;
      const cls = classify(t);
      const cat = cls && catById(cls.catId);
      if (!cat || !cat.closeIdleMin) continue;
      if (!t.lastAccessed || now - t.lastAccessed < cat.closeIdleMin * 60000) continue;
      out.push({ t, catId: cat.id });
    }
  }
  return out;
}

async function doIdleClose(wins, res, budget) {
  const close = idleCandidates(wins).slice(0, Math.max(0, budget));
  if (!close.length) return 0;
  const at = Date.now();
  try {
    await browser.tabs.remove(close.map((x) => x.t.id));
    res.idleClosed += close.length;
    S.closedLog = close.map(({ t, catId }) => {
      const cat = catById(catId);
      return { url: t.url, title: t.title || t.url, closedAt: at, profile: S.activeId, reason: "idle", window: cat ? cat.name : "" };
    }).concat(S.closedLog).slice(0, LOG_MAX);
    await persistLog();
  } catch (e) { res.errors.push("idle-close: " + e.message); }
  return close.length;
}

/* ------------------------------------------------------------------ */
/* sorting                                                             */
/* ------------------------------------------------------------------ */

async function doSort(wins, res, manual) {
  const st = S.cfg.settings;
  const fn = (url, title) => S.classifier.classify(url, title);
  for (const w of wins) {
    if (w.focused && !st.sortFocusedWindow && !manual) continue;
    const catId = S.winCat.get(w.id);
    if (catId === undefined && !st.sortUnboundWindows) continue;
    const tabs = w.tabs || [];
    if (tabs.some((t) => t.hidden)) continue;
    if (st.respectTabGroups && tabs.some(inGroup)) continue;
    const pinned = tabs.filter((t) => t.pinned).length;
    const unpinned = tabs.filter((t) => !t.pinned);
    const desired = NT.sortTabs(unpinned, st.sortMode, fn, catId);
    const current = unpinned.map((t) => t.id);
    if (desired.every((id, i) => id === current[i])) continue;
    try {
      await browser.tabs.move(desired, { index: pinned });
      res.sorted++;
    } catch (e) { res.errors.push("sort: " + e.message); }
  }
}

/* ------------------------------------------------------------------ */
/* the tick                                                            */
/* ------------------------------------------------------------------ */

/* Passes run one at a time; a Tidy pressed mid-pass runs right after it. */
let tickChain = Promise.resolve();
let timerQueued = false;

function tick(reason) {
  if (reason === "timer") {
    if (timerQueued) return tickChain;
    timerQueued = true;
  }
  tickChain = tickChain.then(() => {
    if (reason === "timer") timerQueued = false;
    return runTick(reason);
  }).catch((e) => { console.error("Ninetails pass failed", e); return S.lastTick; });
  return tickChain;
}

async function runTick(reason) {
  await ready;
  if (!S.enabled) return S.lastTick;
  const manual = reason === "manual";
  const res = { at: Date.now(), reason, moved: 0, created: 0, closed: 0, autoClosed: 0, idleClosed: 0, sorted: 0, errors: [] };
  try {
    const st = S.cfg.settings;
    let budget = st.maxActionsPerTick * (manual ? 10 : 1);
    let wins = await normalWindows(true);
    const live = new Set(wins.map((w) => w.id));
    for (const winId of Array.from(S.winCat.keys())) if (!live.has(winId)) unbindWindow(winId);

    if (await doAutoClose(wins, res, budget)) wins = await normalWindows(true);
    if (await doIdleClose(wins, res, st.maxActionsPerTick)) wins = await normalWindows(true);
    if (st.features.move) {
      budget -= await doMoves(wins, res, budget, manual);
      if (res.moved) wins = await normalWindows(true);
    }
    if (st.features.dedupe && budget > 0) {
      budget -= await doDedupe(wins, res, budget);
      if (res.closed) wins = await normalWindows(true);
    }
    if (st.features.sort) await doSort(wins, res, manual);
    await refreshTitles(wins);
  } catch (e) {
    res.errors.push(String(e && e.message ? e.message : e));
  }
  S.lastTick = res;
  if (manual) showResultBadge(res);
  notify();
  return res;
}

/* Brief feedback on the toolbar button after a manual tidy. */
let badgeTimer = null;
function showResultBadge(res) {
  const n = res.moved + res.closed + res.autoClosed + res.idleClosed;
  const text = res.errors.length ? "!" : n ? String(n > 999 ? "999+" : n) : "✓";
  try {
    browser.browserAction.setBadgeBackgroundColor({ color: res.errors.length ? "#b3261e" : "#c8611c" });
    browser.browserAction.setBadgeText({ text });
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => browser.browserAction.setBadgeText({ text: "" }), 6000);
  } catch (e) {}
}

/* One-click tidy: keyboard shortcut, address-bar button, NinetailsTidy.exe. */
function tidyNow() { return tick("manual"); }

/* ------------------------------------------------------------------ */
/* profiles                                                            */
/* ------------------------------------------------------------------ */

async function switchProfile(id) {
  if (!S.profiles[id]) throw new Error("No such profile");
  S.activeId = id;
  applyActive();
  for (const [tabId] of S.seen) S.seen.set(tabId, { catId: null, since: Date.now() });
  await bindAll();
  await persist();
  await buildMenus();
  notify();
}

function uniqueProfileId(base) {
  let id = String(base || "profile").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "profile";
  if (!S.profiles[id]) return id;
  let i = 2;
  while (S.profiles[id + "-" + i]) i++;
  return id + "-" + i;
}

/* ------------------------------------------------------------------ */
/* context menus                                                       */
/* ------------------------------------------------------------------ */

async function buildMenus() {
  await browser.menus.removeAll();
  if (!S.cfg) return;
  const ctx = ["tab", "page"];
  browser.menus.create({ id: "nt", title: "Ninetails", contexts: ctx });
  const groups = [
    ["send", "Always send this site to"],
    ["move", "Move this tab to (once)"],
    ["bind", "Make this window"]
  ];
  for (const [key, title] of groups) {
    browser.menus.create({ id: "nt-" + key, parentId: "nt", title, contexts: ctx });
    for (const c of S.cfg.categories) {
      browser.menus.create({ id: "nt-" + key + ":" + c.id, parentId: "nt-" + key, title: c.name, contexts: ctx });
    }
  }
  browser.menus.create({ id: "nt-bind:", parentId: "nt-bind", title: "(no category)", contexts: ctx });
  browser.menus.create({ id: "nt-sep", parentId: "nt", type: "separator", contexts: ctx });
  browser.menus.create({ id: "nt-exempt", parentId: "nt", title: "Leave this tab where it is", contexts: ctx });
  browser.menus.create({ id: "nt-tidy", parentId: "nt", title: "Tidy now", contexts: ctx });
  browser.menus.create({ id: "nt-settings", parentId: "nt", title: "Settings…", contexts: ctx });
}

async function addSiteToCategory(url, catId) {
  const host = NT.hostOf(url);
  const u = NT.parseUrl(url);
  let pattern;
  if (u && u.protocol === "file:") pattern = "file:///*" + (u.pathname.match(/\.[a-z0-9]+$/i) || [""])[0] + "*";
  else if (host) pattern = host;
  else return null;
  const cfg = NT.clone(S.cfg);
  for (const c of cfg.categories) c.patterns = c.patterns.filter((p) => p !== pattern);
  const cat = cfg.categories.find((c) => c.id === catId);
  if (!cat) return null;
  cat.patterns.push(pattern);
  await setConfig(cfg);
  return pattern;
}

async function onMenuClick(info, tab) {
  await ready;
  const id = String(info.menuItemId);
  if (id === "nt-settings") return openSettings();
  if (id === "nt-tidy") return tick("manual");
  if (id === "nt-exempt") { if (tab) { S.exempt.add(tab.id); S.lastAction = "Tab will stay where it is."; notify(); } return; }
  const m = id.match(/^nt-(send|move|bind):(.*)$/);
  if (!m || !tab) return;
  const [, kind, catId] = m;
  if (kind === "bind") {
    if (catId) setBind(catId, tab.windowId); else unbindWindow(tab.windowId);
    await persistBinding(tab.windowId);
    await refreshTitles();
    notify();
    return;
  }
  if (kind === "send") {
    const pattern = await addSiteToCategory(tab.url, catId);
    const cls = classify(tab);
    const cat = catById(catId);
    S.lastAction = cls && cls.catId === catId
      ? `Added “${pattern}” to ${cat.name}.`
      : `Added “${pattern}” to ${cat ? cat.name : "?"}, but an earlier window's rule still wins for this page. Reorder windows in Settings.`;
  }
  // move (or send): move now, and keep it there
  if (S.bindings.get(catId) !== tab.windowId) {
    try { await moveTabsToCat([tab.id], catId, true); } catch (e) { S.lastAction = "Move failed: " + e.message; }
  }
  const now = classify(tab);
  if (kind === "move" || !now || now.catId !== catId) S.exempt.add(tab.id);
  notify();
}

/* ------------------------------------------------------------------ */
/* config changes from the UI                                          */
/* ------------------------------------------------------------------ */

async function setConfig(cfg) {
  const p = S.profiles[S.activeId];
  p.config = NT.normalizeConfig(cfg);
  applyActive();
  for (const [winId] of S.winCat) await persistBinding(winId); // renames
  await persist();
  await refreshTitles();
  await buildMenus();
  notify();
}

async function mergeCategories(fromId, intoId) {
  const fromWin = S.bindings.get(fromId);
  const intoWin = S.bindings.get(intoId);
  const cfg = NT.mergeCategories(S.cfg, fromId, intoId);
  if (fromWin !== undefined) {
    if (intoWin === undefined) {
      setBind(intoId, fromWin);
    } else if (fromWin !== intoWin) {
      const tabs = await browser.tabs.query({ windowId: fromWin });
      const ids = tabs.filter((t) => !t.pinned).map((t) => t.id);
      ids.forEach((id) => S.ourMoves.add(id));
      try { if (ids.length) await browser.tabs.move(ids, { windowId: intoWin, index: -1 }); }
      finally { setTimeout(() => ids.forEach((id) => S.ourMoves.delete(id)), 3000); }
      unbindWindow(fromWin);
    }
  }
  await setConfig(cfg);
  if (fromWin !== undefined) await persistBinding(fromWin);
  if (intoWin !== undefined || S.bindings.has(intoId)) await persistBinding(S.bindings.get(intoId));
}

async function openSettings(tabId) {
  const url = browser.runtime.getURL(OPTIONS_PATH);
  const existing = (await browser.tabs.query({})).filter((t) => t.url && t.url.startsWith(url) && t.id !== tabId);
  if (existing.length) {
    await browser.tabs.update(existing[0].id, { active: true });
    await browser.windows.update(existing[0].windowId, { focused: true });
    if (tabId !== undefined && tabId !== existing[0].id) browser.tabs.remove(tabId).catch(() => {});
    return;
  }
  if (tabId !== undefined) await browser.tabs.update(tabId, { url });
  else await browser.runtime.openOptionsPage();
}

async function stateForUI() {
  const wins = await normalWindows(true);
  const winInfo = wins.map((w) => {
    const active = (w.tabs || []).find((t) => t.active);
    return {
      id: w.id,
      catId: S.winCat.get(w.id) || null,
      tabCount: (w.tabs || []).length,
      focused: w.focused,
      activeTitle: active ? active.title : ""
    };
  });
  const idleDue = {};
  for (const x of idleCandidates(wins)) idleDue[x.catId] = (idleDue[x.catId] || 0) + 1;
  return {
    rev: S.rev,
    idleDue,
    closedTotal: S.closedLog.length,
    enabled: S.enabled,
    activeId: S.activeId,
    defaultId: S.defaultId,
    startWithDefault: S.startWithDefault,
    profiles: Object.values(S.profiles).map((p) => ({ id: p.id, name: p.name, categories: p.config.categories.length })),
    config: S.cfg,
    windows: winInfo,
    lastTick: S.lastTick,
    lastAction: S.lastAction,
    closedLog: S.closedLog.slice(0, 300),
    exemptCount: S.exempt.size
  };
}

async function handleMessage(msg) {
  await ready;
  switch (msg && msg.type) {
    case "getState":
      return stateForUI();
    case "getProfile":
      return S.profiles[msg.id] ? NT.clone(S.profiles[msg.id]) : null;
    case "setEnabled":
      S.enabled = !!msg.value;
      await persist();
      await refreshTitles();
      notify();
      if (S.enabled) tick("enabled");
      return true;
    case "setConfig":
      await setConfig(msg.config);
      return true;
    case "bindWindow":
      if (msg.catId) setBind(msg.catId, msg.windowId); else unbindWindow(msg.windowId);
      await persistBinding(msg.windowId);
      await refreshTitles();
      notify();
      return true;
    case "openWindowForCat": {
      if (!catById(msg.catId)) throw new Error("No such window category");
      const nw = await browser.windows.create({});
      setBind(msg.catId, nw.id);
      await persistBinding(nw.id);
      await refreshTitles();
      notify();
      return nw.id;
    }
    case "focusWindow":
      await browser.windows.update(msg.windowId, { focused: true });
      return true;
    case "tidyNow":
      return tick("manual");
    case "rebind":
      await bindAll();
      notify();
      return true;
    case "mergeCategories":
      await mergeCategories(msg.fromId, msg.intoId);
      return true;
    case "switchProfile":
      await switchProfile(msg.id);
      return true;
    case "createProfile": {
      const src = msg.copyFrom && S.profiles[msg.copyFrom];
      const id = uniqueProfileId(msg.name);
      S.profiles[id] = NT.normalizeProfile({
        id,
        name: msg.name || "New profile",
        config: src ? NT.clone(src.config) : { categories: [], settings: NT.clone(S.cfg.settings) }
      });
      await persist();
      notify();
      return id;
    }
    case "renameProfile":
      if (S.profiles[msg.id]) S.profiles[msg.id].name = String(msg.name || "").slice(0, 60) || S.profiles[msg.id].name;
      await persist();
      notify();
      return true;
    case "deleteProfile": {
      const ids = Object.keys(S.profiles);
      if (ids.length < 2 || !S.profiles[msg.id]) throw new Error("Can't delete the only profile");
      delete S.profiles[msg.id];
      const next = Object.keys(S.profiles)[0];
      if (S.defaultId === msg.id) S.defaultId = S.activeId === msg.id ? next : S.activeId;
      if (S.activeId === msg.id) await switchProfile(S.defaultId || next);
      await persist();
      notify();
      return true;
    }
    case "setDefaultProfile":
      if (S.profiles[msg.id]) S.defaultId = msg.id;
      await persist();
      notify();
      return true;
    case "setStartWithDefault":
      S.startWithDefault = !!msg.value;
      await persist();
      notify();
      return true;
    case "importProfile": {
      const p = NT.normalizeProfile(msg.profile);
      if (S.profiles[p.id] && !msg.overwrite) p.id = uniqueProfileId(p.id);
      S.profiles[p.id] = p;
      if (p.id === S.activeId) { applyActive(); await bindAll(); await buildMenus(); }
      await persist();
      notify();
      return p.id;
    }
    case "reloadBundled": {
      const b = await loadBundled();
      let n = 0;
      for (const p of b.profiles) {
        if (S.profiles[p.id] && !msg.overwrite) continue;
        S.profiles[p.id] = p;
        n++;
      }
      if (S.profiles[S.activeId]) { applyActive(); await bindAll(); await buildMenus(); }
      await persist();
      notify();
      return n;
    }
    case "classify": {
      const url = msg.url || "", title = msg.title || "";
      const ac = S.cfg.settings.autoClose;
      const autoClose = S.classifier.isAutoClose(url, title) ? { enabled: !!ac.enabled, minutes: ac.minutes } : null;
      const cls = S.classifier.classify(url, title);
      if (!cls) return { match: null, excluded: S.classifier.isExcluded(url, title), autoClose };
      const cat = catById(cls.catId);
      return { match: { catId: cls.catId, name: cat ? cat.name : cls.catId, pattern: cls.pattern }, autoClose };
    }
    case "exemptTab":
      if (msg.value) S.exempt.add(msg.tabId); else S.exempt.delete(msg.tabId);
      notify();
      return true;
    case "isExempt":
      return S.exempt.has(msg.tabId);
    case "restoreClosed": {
      const e = S.closedLog[msg.index];
      if (!e) return false;
      let restored = false;
      try {
        const recent = await browser.sessions.getRecentlyClosed({ maxResults: 25 });
        const hit = recent.find((r) => r.tab && r.tab.url === e.url);
        if (hit) { await browser.sessions.restore(hit.tab.sessionId); restored = true; }
      } catch (err) {}
      if (!restored && /^https?:/i.test(e.url)) { await browser.tabs.create({ url: e.url }); restored = true; }
      if (restored) { S.closedLog.splice(msg.index, 1); await persistLog(); notify(); }
      return restored;
    }
    case "clearLog":
      S.closedLog = [];
      await persistLog();
      notify();
      return true;
    case "openSettings":
      await openSettings();
      return true;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

browser.runtime.onMessage.addListener((msg) => handleMessage(msg).catch((e) => ({ error: e.message })));

browser.menus.onClicked.addListener((info, tab) => { onMenuClick(info, tab).catch((e) => console.error(e)); });

browser.commands.onCommand.addListener((name) => { if (name === "tidy-now") tidyNow(); });
browser.pageAction.onClicked.addListener(() => { tidyNow(); });

/* http://ninetails.localhost/tidy runs a tidy and closes itself; anything else there opens settings. */
const handledLaunch = new Set();
async function handleLaunch(tabId, url) {
  if (handledLaunch.has(tabId)) return;
  handledLaunch.add(tabId);
  setTimeout(() => handledLaunch.delete(tabId), 5000);
  const u = NT.parseUrl(url);
  if (u && /^\/tidy\/?$/i.test(u.pathname)) {
    await browser.tabs.remove(tabId).catch(() => {});
    return tidyNow();
  }
  return openSettings(tabId);
}

browser.tabs.onCreated.addListener(async (tab) => {
  await ready;
  if (tab.url && LAUNCH_RE.test(tab.url)) return handleLaunch(tab.id, tab.url);
  track(tab, Date.now());
});

browser.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  await ready;
  if (info.url && LAUNCH_RE.test(info.url)) return handleLaunch(tabId, info.url);
  if (info.url !== undefined || info.title !== undefined) track(tab, Date.now());
});

browser.tabs.onRemoved.addListener((tabId) => {
  S.seen.delete(tabId);
  S.exempt.delete(tabId);
});

browser.tabs.onAttached.addListener(async (tabId, info) => {
  await ready;
  if (S.ourMoves.has(tabId)) return;
  try {
    const tab = await browser.tabs.get(tabId);
    const cls = classify(tab);
    if (!cls) return;
    const target = S.bindings.get(cls.catId);
    if (target !== undefined && target !== info.newWindowId) S.exempt.add(tabId); // you put it there by hand
  } catch (e) {}
});

browser.windows.onRemoved.addListener((winId) => {
  unbindWindow(winId);
  S.titled.delete(winId);
  notify();
});

browser.windows.onCreated.addListener((w) => {
  // restored windows carry their saved category
  setTimeout(async () => {
    await ready;
    if (S.winCat.has(w.id) || w.incognito) return;
    let v = null;
    try { v = await browser.sessions.getWindowValue(w.id, WIN_KEY); } catch (e) { return; }
    const cat = matchStoredValue(v);
    if (cat && !S.bindings.has(cat.id)) {
      setBind(cat.id, w.id);
      await persistBinding(w.id);
      await refreshTitles();
      notify();
    }
  }, 1500);
});

browser.alarms.onAlarm.addListener((a) => { if (a.name === "nt-tick") tick("timer"); });

browser.runtime.onStartup.addListener(async () => {
  await ready;
  if (S.startWithDefault && S.defaultId && S.defaultId !== S.activeId && S.profiles[S.defaultId]) {
    await switchProfile(S.defaultId);
  }
  // windows can still be restoring when we first look; look again shortly
  setTimeout(() => bindAll().then(notify).catch(() => {}), 8000);
});

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

async function init() {
  const st = await browser.storage.local.get(Object.values(KEYS));
  S.profiles = st[KEYS.profiles] || {};
  if (!Object.keys(S.profiles).length) {
    const b = await loadBundled();
    for (const p of b.profiles) S.profiles[p.id] = p;
    S.defaultId = b.default;
    S.activeId = b.default;
  } else {
    for (const id of Object.keys(S.profiles)) S.profiles[id] = NT.normalizeProfile(S.profiles[id]);
    S.activeId = st[KEYS.active];
    S.defaultId = st[KEYS.dflt];
  }
  const ids = Object.keys(S.profiles);
  if (!S.profiles[S.activeId]) S.activeId = ids[0];
  if (!S.profiles[S.defaultId]) S.defaultId = S.activeId;
  S.enabled = st[KEYS.enabled] !== false;
  S.startWithDefault = st[KEYS.startWithDefault] !== false;
  S.closedLog = Array.isArray(st[KEYS.log]) ? st[KEYS.log] : [];

  // One-time upgrades for profiles created by earlier versions.
  const done = Array.isArray(st[KEYS.migrations]) ? st[KEYS.migrations] : [];
  if (!done.includes("random-catchall")) {
    for (const id of ["work", "personal"]) {
      const cats = S.profiles[id] && S.profiles[id].config.categories;
      if (cats && !cats.some((c) => c.catchAll || c.name.toLowerCase() === "random")) {
        cats.push({ id: "random", name: "Random", enabled: true, catchAll: true, patterns: [] });
      }
    }
    done.push("random-catchall");
  }
  await browser.storage.local.set({ [KEYS.migrations]: done });

  applyActive();
  await persist();
  await bindAll();
  const now = Date.now();
  for (const t of await browser.tabs.query({})) track(t, now);
  await buildMenus();
  browser.alarms.create("nt-tick", { periodInMinutes: 1 });
  S.loaded = true;
}

init()
  .catch((e) => console.error("Ninetails init failed", e))
  .finally(() => readyResolve());
