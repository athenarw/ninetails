"use strict";
/* A small in-memory imitation of the Firefox WebExtension APIs Ninetails uses. */
const fs = require("node:fs");
const path = require("node:path");

function ev() {
  const ls = [];
  return {
    addListener: (f) => ls.push(f),
    fire: (...a) => Promise.all(ls.map((f) => f(...a))),
    listeners: ls
  };
}

function createBrowser(extDir) {
  let nextTab = 100, nextWin = 10;
  const windows = new Map(); // id -> {id, focused, incognito, tabs:[], values:{}, titlePreface}
  const store = {};
  const recentlyClosed = [];
  const menus = [];
  const sent = [];

  const reindex = (w) => w.tabs.forEach((t, i) => { t.index = i; t.windowId = w.id; });
  const findTab = (id) => {
    for (const w of windows.values()) { const t = w.tabs.find((x) => x.id === id); if (t) return { w, t }; }
    return null;
  };
  const copyTab = (t) => Object.assign({}, t);
  const copyWin = (w, populate) => {
    const o = { id: w.id, focused: w.focused, incognito: !!w.incognito, type: "normal", titlePreface: w.titlePreface || "" };
    if (populate) o.tabs = w.tabs.map(copyTab);
    return o;
  };

  const b = {
    _windows: windows,
    _store: store,
    _menus: menus,
    _sent: sent,
    _recentlyClosed: recentlyClosed,
    _addWindow(tabs, opts) {
      const w = { id: nextWin++, focused: false, incognito: false, tabs: [], values: {}, titlePreface: "" };
      Object.assign(w, opts || {});
      for (const t of tabs) w.tabs.push(Object.assign({ id: nextTab++, pinned: false, active: false, audible: false, hidden: false, groupId: -1, title: "", lastAccessed: Date.now(), status: "complete" }, t));
      if (w.tabs.length && !w.tabs.some((t) => t.active)) w.tabs[0].active = true;
      reindex(w);
      windows.set(w.id, w);
      return w;
    },
    _focus(id) { for (const w of windows.values()) w.focused = w.id === id; },

    runtime: {
      getURL: (p) => "moz-extension://test-uuid/" + p.replace(/^\//, ""),
      sendMessage: async (m) => { sent.push(m); throw new Error("no receiver"); },
      onMessage: ev(),
      onStartup: ev(),
      openOptionsPage: async () => { b._openedOptions = (b._openedOptions || 0) + 1; }
    },
    storage: {
      local: {
        get: async (keys) => { const o = {}; for (const k of keys) if (k in store) o[k] = JSON.parse(JSON.stringify(store[k])); return o; },
        set: async (o) => { for (const [k, v] of Object.entries(o)) store[k] = JSON.parse(JSON.stringify(v)); }
      }
    },
    alarms: { create: () => {}, onAlarm: ev() },
    commands: { onCommand: ev() },
    pageAction: { onClicked: ev() },
    browserAction: {
      setBadgeText: (o) => { (b._badges = b._badges || []).push(o.text); },
      setBadgeBackgroundColor: () => {}
    },
    menus: {
      removeAll: async () => { menus.length = 0; },
      create: (m) => { menus.push(m); },
      onClicked: ev()
    },
    sessions: {
      getWindowValue: async (id, k) => { const w = windows.get(id); if (!w) throw new Error("no window"); return w.values[k]; },
      setWindowValue: async (id, k, v) => { const w = windows.get(id); if (!w) throw new Error("no window"); w.values[k] = JSON.parse(JSON.stringify(v)); },
      removeWindowValue: async (id, k) => { const w = windows.get(id); if (!w) throw new Error("no window"); delete w.values[k]; },
      getRecentlyClosed: async () => recentlyClosed.slice(),
      restore: async (sid) => { const i = recentlyClosed.findIndex((r) => r.tab.sessionId === sid); const r = recentlyClosed.splice(i, 1)[0]; b._addWindow([{ url: r.tab.url }]); }
    },
    windows: {
      getAll: async (q) => Array.from(windows.values()).map((w) => copyWin(w, q && q.populate)),
      getLastFocused: async () => copyWin(Array.from(windows.values()).find((w) => w.focused) || windows.values().next().value),
      update: async (id, u) => { const w = windows.get(id); if (!w) throw new Error("no window"); if ("titlePreface" in u) w.titlePreface = u.titlePreface; if (u.focused) b._focus(id); return copyWin(w); },
      create: async (o) => {
        const w = b._addWindow([]);
        if (o && o.tabId !== undefined) {
          const f = findTab(o.tabId);
          f.w.tabs.splice(f.w.tabs.indexOf(f.t), 1);
          reindex(f.w);
          f.t.active = true;
          w.tabs.push(f.t);
          reindex(w);
          if (!f.w.tabs.length) windows.delete(f.w.id);
          await b.tabs.onAttached.fire(f.t.id, { newWindowId: w.id, newPosition: 0 });
        }
        b._focus(w.id);
        await b.windows.onCreated.fire(copyWin(w));
        return copyWin(w, true);
      },
      onRemoved: ev(),
      onCreated: ev()
    },
    tabs: {
      query: async (q) => {
        let all = [];
        for (const w of windows.values()) all = all.concat(w.tabs);
        if (q.windowId !== undefined) all = all.filter((t) => t.windowId === q.windowId);
        if (q.active) all = all.filter((t) => t.active);
        if (q.currentWindow) all = all.filter((t) => windows.get(t.windowId).focused);
        return all.map(copyTab);
      },
      get: async (id) => { const f = findTab(id); if (!f) throw new Error("no tab"); return copyTab(f.t); },
      move: async (ids, o) => {
        ids = [].concat(ids);
        const dest = o.windowId !== undefined ? windows.get(o.windowId) : null;
        const moving = ids.map(findTab);
        const attached = [];
        for (const f of moving) {
          f.w.tabs.splice(f.w.tabs.indexOf(f.t), 1);
          reindex(f.w);
        }
        const target = dest || moving[0].w;
        let at = o.index === -1 ? target.tabs.length : o.index;
        for (const f of moving) {
          if (f.w !== target) { f.t.active = false; attached.push(f.t.id); }
          target.tabs.splice(at++, 0, f.t);
        }
        reindex(target);
        for (const f of moving) if (!f.w.tabs.length && f.w !== target) windows.delete(f.w.id);
        for (const id of attached) await b.tabs.onAttached.fire(id, { newWindowId: target.id });
        return ids.map((id) => copyTab(findTab(id).t));
      },
      remove: async (ids) => {
        for (const id of [].concat(ids)) {
          const f = findTab(id);
          if (!f) continue;
          f.w.tabs.splice(f.w.tabs.indexOf(f.t), 1);
          reindex(f.w);
          recentlyClosed.unshift({ tab: { url: f.t.url, sessionId: "s" + id } });
          await b.tabs.onRemoved.fire(id, { windowId: f.w.id });
          if (!f.w.tabs.length) { windows.delete(f.w.id); await b.windows.onRemoved.fire(f.w.id); }
        }
      },
      update: async (id, u) => { const f = findTab(id); Object.assign(f.t, u); return copyTab(f.t); },
      create: async (o) => { const w = Array.from(windows.values())[0]; const t = { id: nextTab++, url: o.url, title: "", pinned: false, active: false, groupId: -1 }; w.tabs.push(t); reindex(w); return copyTab(t); },
      onCreated: ev(), onUpdated: ev(), onRemoved: ev(), onAttached: ev()
    }
  };

  const fetchImpl = async (url) => {
    const rel = url.replace("moz-extension://test-uuid/", "");
    // the engine tests use a fixed set of profiles, independent of the shipped examples
    const fixture = rel.startsWith("profiles/") ? path.join(__dirname, "fixtures", rel) : null;
    const text = fs.readFileSync(fixture && fs.existsSync(fixture) ? fixture : path.join(extDir, rel), "utf8");
    return { json: async () => JSON.parse(text) };
  };

  return { browser: b, fetch: fetchImpl };
}

module.exports = { createBrowser };
