"use strict";
/* Runs the real background.js against the mock browser and checks behavior end to end. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createBrowser } = require("./mock-browser.js");

const EXT = path.join(__dirname, "../extension");
const MIN = 60000;

function boot(setup) {
  const { browser, fetch } = createBrowser(EXT);
  setup(browser);
  const ctx = { browser, fetch, console, setTimeout: (f, ms) => setTimeout(f, Math.min(ms, 20)), clearTimeout, URL, Date, Math, JSON, Promise };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(EXT, "common/rules.js"), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(path.join(EXT, "background.js"), "utf8"), ctx);
  const msg = (m) => browser.runtime.onMessage.listeners[0](m);
  return { browser, ctx, msg };
}

const urls = (w) => w.tabs.map((t) => t.url);
const winOf = (b, url) => Array.from(b._windows.values()).find((w) => w.tabs.some((t) => t.url === url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("auto-binds windows by contents, labels them, and moves stray tabs on Tidy", async () => {
  let W1, W2;
  const { browser, msg } = boot((b) => {
    W1 = b._addWindow([
      { url: "https://github.com/a", active: true },
      { url: "https://github.com/b" },
      { url: "https://en.wikipedia.org/wiki/Fox" },
      { url: "https://stackoverflow.com/q/1" }
    ], { focused: true });
    W2 = b._addWindow([
      { url: "https://en.wikipedia.org/wiki/A", active: true },
      { url: "https://www.youtube.com/watch?v=1" },
      { url: "https://random.example/" }
    ]);
  });
  const s = await msg({ type: "getState" });
  assert.equal(s.activeId, "work");
  const bind = Object.fromEntries(s.windows.map((w) => [w.id, w.catId]));
  assert.equal(bind[W1.id], "code");
  assert.equal(bind[W2.id], "overview");
  assert.equal(W1.titlePreface, "[Code] ");
  assert.equal(W2.titlePreface, "[Overview] ");

  // timer pass right away: delay not reached, nothing moves
  await msg({ type: "setConfig", config: Object.assign(s.config, { settings: Object.assign(s.config.settings, { features: { move: true, dedupe: false, sort: false } }) }) });
  await browser.alarms.onAlarm.fire({ name: "nt-tick" });
  await sleep(20);
  assert.ok(urls(W1).includes("https://en.wikipedia.org/wiki/Fox"));

  const r = await msg({ type: "tidyNow" });
  assert.equal(r.moved, 2, "the Wikipedia tab, plus random.example into Random");
  assert.ok(urls(W2).includes("https://en.wikipedia.org/wiki/Fox"));
  assert.ok(!urls(W1).includes("https://en.wikipedia.org/wiki/Fox"));
  const rw = winOf(browser, "https://random.example/");
  assert.equal(rw.titlePreface, "[Random] ", "unmatched pages go to the Random window");
});

test("never moves the tab you're looking at, pinned or playing tabs", async () => {
  let W1;
  const { msg } = boot((b) => {
    W1 = b._addWindow([
      { url: "https://github.com/a" }, { url: "https://github.com/b" }, { url: "https://github.com/c" },
      { url: "https://en.wikipedia.org/wiki/Active", active: true },
      { url: "https://en.wikipedia.org/wiki/Pinned", pinned: true },
      { url: "https://www.youtube.com/watch?v=music", audible: true }
    ], { focused: true });
    b._addWindow([{ url: "https://en.wikipedia.org/wiki/A" }, { url: "https://en.wikipedia.org/wiki/B" }]);
  });
  const r = await msg({ type: "tidyNow" });
  assert.equal(r.moved, 0);
  assert.equal(W1.tabs.length, 6);
});

test("creates a window for a category that has none, and labels it", async () => {
  const { browser, msg } = boot((b) => {
    b._addWindow([{ url: "https://github.com/a", active: true }, { url: "https://github.com/b" }, { url: "https://claude.ai/chat/1" }], { focused: true });
  });
  const r = await msg({ type: "tidyNow" });
  assert.equal(r.moved, 1);
  assert.equal(r.created, 1);
  const w = winOf(browser, "https://claude.ai/chat/1");
  assert.equal(w.titlePreface, "[Prognostication] ");
  assert.equal(w.values.ninetails.catName, "Prognostication");
  assert.ok(browser._windows.size === 2);
});

test("closes idle duplicates, keeps the best copy, logs and restores", async () => {
  const old = Date.now() - 120 * MIN;
  let W1;
  const { browser, msg } = boot((b) => {
    W1 = b._addWindow([
      { url: "https://github.com/a", active: true },
      { url: "https://github.com/x?utm_source=feed", lastAccessed: old },
      { url: "https://github.com/x", lastAccessed: Date.now() - 1000 },
      { url: "https://github.com/y", lastAccessed: Date.now() - 5 * MIN },
      { url: "https://github.com/y#readme", lastAccessed: Date.now() - 6 * MIN }
    ], { focused: true });
  });
  const r = await msg({ type: "tidyNow" });
  assert.equal(r.closed, 1, "only the copy idle past 60 min goes");
  assert.deepEqual(urls(W1).filter((u) => u.includes("/x")), ["https://github.com/x"]);
  const s = await msg({ type: "getState" });
  assert.equal(s.closedLog[0].url, "https://github.com/x?utm_source=feed");
  const ok = await msg({ type: "restoreClosed", index: 0 });
  assert.equal(ok, true);
  assert.ok(winOf(browser, "https://github.com/x?utm_source=feed"));
});

test("sorts unfocused bound windows by rule order", async () => {
  let W2;
  const { msg } = boot((b) => {
    b._addWindow([{ url: "https://claude.ai/", active: true }], { focused: true });
    W2 = b._addWindow([
      { url: "https://pypi.org/p/x", active: true },
      { url: "https://stackoverflow.com/q/1" },
      { url: "https://github.com/a" },
      { url: "https://github.com/b" }
    ]);
  });
  const s = await msg({ type: "getState" });
  assert.equal(s.windows.find((w) => w.id === W2.id).catId, "code");
  const r = await msg({ type: "tidyNow" });
  assert.ok(r.sorted >= 1);
  assert.deepEqual(urls(W2), ["https://github.com/a", "https://github.com/b", "https://stackoverflow.com/q/1", "https://pypi.org/p/x"]);
});

test("a tab you drag by hand is left alone afterwards", async () => {
  let W1, W2;
  const { browser, msg } = boot((b) => {
    W1 = b._addWindow([{ url: "https://github.com/a", active: true }, { url: "https://github.com/b" }], { focused: true });
    W2 = b._addWindow([{ url: "https://en.wikipedia.org/wiki/A", active: true }, { url: "https://en.wikipedia.org/wiki/B" }]);
  });
  await msg({ type: "getState" });
  // simulate the user dragging a wikipedia tab into the Code window
  const t = W2.tabs.splice(1, 1)[0];
  t.active = false;
  W1.tabs.push(t);
  W1.tabs.forEach((x, i) => { x.index = i; x.windowId = W1.id; });
  await browser.tabs.onAttached.fire(t.id, { newWindowId: W1.id });
  const r = await msg({ type: "tidyNow" });
  assert.equal(r.moved, 0);
  assert.ok(urls(W1).includes("https://en.wikipedia.org/wiki/B"));
});

test("rename, reorder, merge with window consolidation", async () => {
  let W1, W2;
  const { msg } = boot((b) => {
    W1 = b._addWindow([{ url: "https://github.com/a", active: true }, { url: "https://github.com/b" }], { focused: true });
    W2 = b._addWindow([{ url: "https://en.wikipedia.org/wiki/A", active: true }, { url: "https://en.wikipedia.org/wiki/B" }]);
  });
  let s = await msg({ type: "getState" });
  const cfg = s.config;
  cfg.categories.find((c) => c.id === "code").name = "Code & Docs";
  await msg({ type: "setConfig", config: cfg });
  assert.equal(W1.titlePreface, "[Code & Docs] ");
  assert.equal(W1.values.ninetails.catName, "Code & Docs");

  await msg({ type: "mergeCategories", fromId: "overview", intoId: "code" });
  s = await msg({ type: "getState" });
  assert.ok(!s.config.categories.some((c) => c.id === "overview"));
  assert.ok(s.config.categories.find((c) => c.id === "code").patterns.includes("wikipedia.org"));
  assert.equal(W1.tabs.length, 4, "Overview window's tabs moved into Code");
});

test("profiles: create, switch (windows re-matched by name), default, import, delete", async () => {
  let W1;
  const { browser, msg } = boot((b) => {
    W1 = b._addWindow([{ url: "https://github.com/a", active: true }, { url: "https://github.com/b" }], { focused: true });
    b._addWindow([{ url: "https://linear.app/x", active: true }, { url: "https://www.notion.so/y" }]);
  });
  let s = await msg({ type: "getState" });
  assert.equal(JSON.stringify(s.profiles.map((p) => p.id).sort()), JSON.stringify(["personal", "work"]));
  assert.equal(s.defaultId, "work");

  await msg({ type: "switchProfile", id: "personal" });
  s = await msg({ type: "getState" });
  assert.equal(s.activeId, "personal");
  assert.equal(s.windows.find((w) => w.id === W1.id).catId, "code", "Code window keeps its role by name");
  const logistics = s.windows.find((w) => w.id !== W1.id);
  assert.equal(logistics.catId, null, "Personal has no Logistics window");

  await msg({ type: "setDefaultProfile", id: "personal" });
  s = await msg({ type: "getState" });
  assert.equal(s.defaultId, "personal");
  assert.equal(browser._store["nt.defaultProfileId"], "personal");

  const id = await msg({ type: "createProfile", name: "Play Laptop", copyFrom: "work" });
  assert.equal(id, "play-laptop");
  const exported = await msg({ type: "getProfile", id });
  exported.name = "Play Laptop v2";
  const same = await msg({ type: "importProfile", profile: exported, overwrite: true });
  assert.equal(same, "play-laptop");
  const copy = await msg({ type: "importProfile", profile: exported, overwrite: false });
  assert.equal(copy, "play-laptop-2");

  await msg({ type: "deleteProfile", id: "personal" });
  s = await msg({ type: "getState" });
  assert.ok(!s.profiles.some((p) => p.id === "personal"));
  assert.ok(s.profiles.some((p) => p.id === s.activeId));
  assert.ok(s.profiles.some((p) => p.id === s.defaultId));
});

test("launcher address opens the settings page", async () => {
  const { browser, msg } = boot((b) => { b._addWindow([{ url: "https://github.com/a", active: true }], { focused: true }); });
  await msg({ type: "getState" });
  const w = Array.from(browser._windows.values())[0];
  w.tabs.push({ id: 999, url: "about:blank", windowId: w.id, index: 1, groupId: -1 });
  await browser.tabs.onUpdated.fire(999, { url: "http://ninetails.localhost/settings" }, { id: 999, url: "http://ninetails.localhost/settings" });
  assert.equal(w.tabs.find((t) => t.id === 999).url, "moz-extension://test-uuid/options/options.html");
});

test("context menu: always send this site adds a rule and moves the tab", async () => {
  let W1;
  const { browser, msg } = boot((b) => {
    W1 = b._addWindow([{ url: "https://github.com/a", active: true }, { url: "https://github.com/b" }, { url: "https://www.arbor-supplier.example/catalog" }], { focused: true });
  });
  await msg({ type: "getState" });
  const tab = W1.tabs[2];
  assert.ok(browser._menus.some((m) => m.id === "nt-send:logistics"));
  await browser.menus.onClicked.fire({ menuItemId: "nt-send:logistics" }, Object.assign({}, tab));
  await sleep(50);
  const s = await msg({ type: "getState" });
  assert.ok(s.config.categories.find((c) => c.id === "logistics").patterns.includes("arbor-supplier.example"));
  const w = winOf(browser, "https://www.arbor-supplier.example/catalog");
  assert.notEqual(w.id, W1.id);
  assert.equal(w.titlePreface, "[Logistics] ");
});

test("paused means no actions and no window labels", async () => {
  let W1;
  const { msg } = boot((b) => {
    W1 = b._addWindow([{ url: "https://github.com/a", active: true }, { url: "https://github.com/b" }, { url: "https://claude.ai/" }], { focused: true });
  });
  await msg({ type: "getState" });
  await msg({ type: "setEnabled", value: false });
  assert.equal(W1.titlePreface, "");
  await msg({ type: "tidyNow" });
  assert.equal(W1.tabs.length, 3);
  await sleep(5);
});

test("one-click tidy: shortcut, address-bar button and NinetailsTidy.exe address", async () => {
  let W1;
  const { browser, msg } = boot((b) => {
    W1 = b._addWindow([{ url: "https://github.com/a", active: true }, { url: "https://github.com/b" },
      { url: "https://github.com/c" }, { url: "https://github.com/d" },
      { url: "https://claude.ai/1" }, { url: "https://claude.ai/2" }, { url: "https://claude.ai/3" }], { focused: true });
  });
  await msg({ type: "getState" });
  const claudeTabs = () => urls(W1).filter((u) => u.includes("claude.ai")).length;

  await browser.commands.onCommand.fire("tidy-now");
  await sleep(300);
  assert.equal(claudeTabs(), 0, "keyboard shortcut moved all three");
  assert.ok(browser._badges.includes("3"), "badge shows how many tabs moved");

  // put one back by hand-free means: new tab arrives
  W1.tabs.push({ id: 900, url: "https://claude.ai/4", windowId: W1.id, index: W1.tabs.length, pinned: false, active: false, groupId: -1, lastAccessed: Date.now() });
  await browser.pageAction.onClicked.fire({});
  await sleep(300);
  assert.equal(claudeTabs(), 0);

  // NinetailsTidy.exe opens http://ninetails.localhost/tidy
  W1.tabs.push({ id: 901, url: "https://claude.ai/5", windowId: W1.id, index: W1.tabs.length, pinned: false, active: false, groupId: -1, lastAccessed: Date.now() });
  W1.tabs.push({ id: 902, url: "about:blank", windowId: W1.id, index: W1.tabs.length, pinned: false, active: false, groupId: -1 });
  await browser.tabs.onUpdated.fire(902, { url: "http://ninetails.localhost/tidy" }, { id: 902, url: "http://ninetails.localhost/tidy" });
  await sleep(30);
  assert.ok(!W1.tabs.some((t) => t.id === 902), "the launcher tab closes itself");
  assert.equal(claudeTabs(), 0);
});

test("settings: open a window for a category, and assign an existing window", async () => {
  let W1, W2;
  const { browser, msg } = boot((b) => {
    W1 = b._addWindow([{ url: "https://github.com/a", active: true }, { url: "https://github.com/b" }], { focused: true });
    W2 = b._addWindow([{ url: "https://example.org/", active: true }]);
  });
  await msg({ type: "getState" });
  const id = await msg({ type: "openWindowForCat", catId: "research" });
  const nw = browser._windows.get(id);
  assert.equal(nw.titlePreface, "[Research] ");
  await msg({ type: "bindWindow", windowId: W2.id, catId: "email" });
  assert.equal(W2.titlePreface, "[Email] ");
  // re-assigning Email to another window moves the label
  await msg({ type: "bindWindow", windowId: id, catId: "email" });
  assert.equal(W2.titlePreface, "");
  assert.equal(nw.titlePreface, "[Email] ");
  const s = await msg({ type: "getState" });
  assert.equal(s.windows.find((w) => w.id === id).catId, "email");
});

test("Random catches everything no other window claims; never-touch still wins", async () => {
  let W1;
  const { browser, msg } = boot((b) => {
    W1 = b._addWindow([{ url: "https://github.com/a", active: true }, { url: "https://github.com/b" },
      { url: "https://some-blog.example/post" }, { url: "https://bank.example/acct" }], { focused: true });
  });
  let s = await msg({ type: "getState" });
  s.config.settings.exclude = ["bank.example"];
  await msg({ type: "setConfig", config: s.config });
  const c = await msg({ type: "classify", url: "https://some-blog.example/post" });
  assert.equal(c.match.name, "Random");
  await msg({ type: "tidyNow" });
  assert.equal(winOf(browser, "https://some-blog.example/post").titlePreface, "[Random] ");
  assert.ok(urls(W1).includes("https://bank.example/acct"));
});

test("auto-close: Zoom launch pages close after 10 unused minutes, meetings in Firefox don't", async () => {
  const old = Date.now() - 11 * MIN;
  let W1, W2;
  const { browser, msg } = boot((b) => {
    W1 = b._addWindow([{ url: "https://github.com/a", active: true }, { url: "https://github.com/b" },
      { url: "https://example.zoom.us/j/123456?pwd=x#success", lastAccessed: old },
      { url: "https://app.zoom.us/wc/123/join", lastAccessed: old },
      { url: "https://zoom.us/j/999", lastAccessed: Date.now() + 9 * MIN }], { focused: true });
    // a Zoom launch tab left as the visible tab of a background window
    W2 = b._addWindow([{ url: "https://example.zoom.us/j/777#success", active: true, lastAccessed: old }]);
  });
  await msg({ type: "getState" });
  // pretend Ninetails first saw these tabs 11 minutes ago
  // (the engine uses max(first seen, last used); first-seen is "now" at boot, so wind the clock)
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * MIN;
  try { await browser.alarms.onAlarm.fire({ name: "nt-tick" }); await sleep(100); } finally { Date.now = realNow; }
  assert.ok(!urls(W1).some((u) => u.includes("/j/123456")), "idle launch page closed");
  assert.ok(winOf(browser, "https://app.zoom.us/wc/123/join"), "web-client meeting kept (it may be filed under Random)");
  assert.ok(winOf(browser, "https://zoom.us/j/999"), "recently used launch page kept");
  assert.ok(!browser._windows.has(W2.id), "background launch window closed");
  const s = await msg({ type: "getState" });
  assert.ok(s.closedLog.some((e) => e.reason === "auto-close"));
});

test("upgrading adds Random to an existing Work profile once", async () => {
  const fs2 = require("node:fs");
  const work = JSON.parse(fs2.readFileSync(path.join(EXT, "profiles/work.json"), "utf8"));
  work.config.categories = work.config.categories.filter((c) => !c.catchAll);
  const { msg } = boot((b) => {
    b._store["nt.profiles"] = { work };
    b._store["nt.activeProfileId"] = "work";
    b._addWindow([{ url: "https://github.com/a", active: true }], { focused: true });
  });
  const s = await msg({ type: "getState" });
  const r = s.config.categories.filter((c) => c.catchAll);
  assert.equal(r.length, 1);
  assert.equal(r[0].name, "Random");
  assert.equal(s.config.settings.autoClose.minutes, 10);
});

test("per-window idle close: Random tabs unused for 3 days close; recent, pinned, showing and other windows stay", async () => {
  const DAY = 24 * 60 * MIN;
  const now = Date.now();
  let W1;
  const { browser, msg } = boot((b) => {
    W1 = b._addWindow([
      { url: "https://github.com/a", active: true, lastAccessed: now - 10 * DAY },
      { url: "https://github.com/old", lastAccessed: now - 10 * DAY },
      { url: "https://some-blog.example/old", lastAccessed: now - 4 * DAY },
      { url: "https://some-blog.example/new", lastAccessed: now - 1 * DAY },
      { url: "https://pinned.example/", pinned: true, lastAccessed: now - 30 * DAY }
    ], { focused: true });
  });
  let s = await msg({ type: "getState" });
  s.config.categories.find((c) => c.id === "random").closeIdleMin = 3 * 24 * 60;
  s.config.settings.features = { move: false, dedupe: false, sort: false };
  await msg({ type: "setConfig", config: s.config });
  s = await msg({ type: "getState" });
  assert.equal(s.idleDue.random, 1);
  await browser.alarms.onAlarm.fire({ name: "nt-tick" });
  await sleep(100);
  const u = urls(W1);
  assert.ok(!u.includes("https://some-blog.example/old"), "unused 4 days: closed");
  assert.ok(u.includes("https://some-blog.example/new"), "used yesterday: kept");
  assert.ok(u.includes("https://pinned.example/"), "pinned: kept");
  assert.ok(u.includes("https://github.com/old"), "Code has no idle setting: kept");
  s = await msg({ type: "getState" });
  assert.equal(s.closedLog[0].reason, "idle");
  assert.equal(s.closedLog[0].window, "Random");
  assert.equal(s.config.categories.find((c) => c.id === "random").closeIdleMin, 4320);
});
