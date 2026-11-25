"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const NT = require("../extension/common/rules.js");

const work = JSON.parse(fs.readFileSync(path.join(__dirname, "../extension/profiles/work.json"), "utf8"));
const personal = JSON.parse(fs.readFileSync(path.join(__dirname, "../extension/profiles/personal.json"), "utf8"));

test("bundled profiles normalize and every pattern compiles", () => {
  for (const p of [work, personal]) {
    const n = NT.normalizeProfile(p);
    assert.equal(n.id, p.id);
    for (const c of n.config.categories) for (const pat of c.patterns) assert.equal(NT.validatePattern(pat), null, pat);
  }
});

test("work profile routes its sites", () => {
  const { classify } = NT.buildClassifier(NT.normalizeConfig(work.config));
  const cases = [
    ["https://linear.app/team/issue/ABC-1", "", "logistics"],
    ["https://www.notion.so/Page-123", "", "logistics"],
    ["https://docs.google.com/spreadsheets/d/abc/edit", "", "logistics"],
    ["https://mail.google.com/mail/u/0/#inbox", "", "email"],
    ["https://outlook.office.com/mail/", "", "email"],
    ["https://claude.ai/new", "", "prognostication"],
    ["https://calendar.google.com/calendar/r", "", "prognostication"],
    ["https://www.nature.com/articles/s41586-024-0001", "", "research"],
    ["https://www.biorxiv.org/content/10.1101/2024", "", "research"],
    ["file:///C:/Users/me/Downloads/paper.pdf", "", "research"],
    ["file:///C:/Users/me/Downloads/paper.pdf#page=3", "", "research"],
    ["https://en.wikipedia.org/wiki/Fox", "", "overview"],
    ["https://www.youtube.com/watch?v=x", "", "overview"],
    ["https://www.google.com/search?q=guide+tube", "", "open-questions"],
    ["https://www.google.co.uk/search?q=x", "", "open-questions"],
    ["https://cad.onshape.com/documents/1", "Arbor v3", "onshape"],
    ["https://github.com/gumyr/build123d", "", "code"],
    ["https://stackoverflow.com/questions/1", "", "code"],
    ["https://math.stackexchange.com/questions/1", "", "code"],
    ["https://build123d.readthedocs.io/en/latest/", "", "code"]
  ];
  for (const [url, title, want] of cases) {
    const r = classify(url, title);
    assert.equal(r && r.catId, want, url + " " + title);
  }
  assert.equal(classify("https://www.google.com/maps", "").catId, "random");
  assert.equal(classify("https://docs.google.com/document/d/x", "").catId, "random");
  assert.equal(classify("about:newtab", ""), null);
  assert.equal(classify("https://notnotion.so/", "").catId, "random", "domain match must be on a dot boundary");
});

test("pattern kinds", () => {
  const m = (p, url, title) => NT.compilePattern(p)(url, title);
  assert.ok(m("example.com", "https://a.b.example.com/x"));
  assert.ok(!m("example.com", "https://example.com.evil.net/"));
  assert.ok(m("example.com/docs", "https://example.com/docs/a?b"));
  assert.ok(!m("example.com/docs", "https://example.com/blog"));
  assert.ok(m("https://*.example.*/x*", "https://a.example.org/xyz"));
  assert.ok(m("re:^https://foo\\.", "https://foo.bar"));
  assert.ok(m("title:Hello", "https://x", "say hello world"));
  assert.match(NT.validatePattern("re:("), /Bad regex/);
  assert.match(NT.validatePattern("  "), /Empty/);
});

test("disabled category and excludes are skipped", () => {
  const cfg = NT.normalizeConfig({
    categories: [
      { id: "a", name: "A", enabled: false, patterns: ["github.com"] },
      { id: "b", name: "B", patterns: ["github.com", "bank.com"] }
    ],
    settings: { exclude: ["bank.com"] }
  });
  const { classify, isExcluded } = NT.buildClassifier(cfg);
  assert.equal(classify("https://github.com/x").catId, "b");
  assert.equal(classify("https://bank.com/"), null);
  assert.ok(isExcluded("https://www.bank.com/acct"));
});

test("normalizeUrl for duplicates", () => {
  const s = NT.DEFAULT_SETTINGS;
  assert.equal(NT.normalizeUrl("https://www.Example.com/a/?utm_source=x#frag", s), NT.normalizeUrl("https://example.com/a", s));
  assert.notEqual(NT.normalizeUrl("https://example.com/a?id=1", s), NT.normalizeUrl("https://example.com/a?id=2", s));
  assert.equal(NT.normalizeUrl("about:blank", s), null);
  const keepHash = Object.assign({}, s, { ignoreHashInDupes: false });
  assert.notEqual(NT.normalizeUrl("https://x.com/#a", keepHash), NT.normalizeUrl("https://x.com/#b", keepHash));
});

test("merge unions patterns and drops the source", () => {
  const cfg = NT.normalizeConfig({ categories: [
    { id: "a", name: "A", patterns: ["x.com", "y.com"] },
    { id: "b", name: "B", patterns: ["y.com", "z.com"] }
  ] });
  const out = NT.mergeCategories(cfg, "a", "b");
  assert.deepEqual(out.categories.map((c) => c.id), ["b"]);
  assert.deepEqual(out.categories[0].patterns, ["y.com", "z.com", "x.com"]);
});

test("sortTabs rule mode: own-window tabs by rule order, strays after, unknown last", () => {
  const cfg = NT.normalizeConfig({ categories: [
    { id: "code", name: "Code", patterns: ["github.com", "stackoverflow.com"] },
    { id: "wiki", name: "Wiki", patterns: ["wikipedia.org"] }
  ] });
  const { classify } = NT.buildClassifier(cfg);
  const tabs = [
    { id: 1, url: "https://random.net/" },
    { id: 2, url: "https://stackoverflow.com/q/1" },
    { id: 3, url: "https://en.wikipedia.org/wiki/A" },
    { id: 4, url: "https://github.com/a" },
    { id: 5, url: "https://github.com/b" }
  ];
  assert.deepEqual(NT.sortTabs(tabs, "rule", classify, "code"), [4, 5, 2, 3, 1]);
  assert.deepEqual(NT.sortTabs(tabs, "domain", classify, "code"), [3, 4, 5, 1, 2]);
});

test("normalizeConfig clamps bad settings", () => {
  const c = NT.normalizeConfig({ settings: { moveDelayMin: -5, sortMode: "nope", maxActionsPerTick: 99999 } });
  assert.equal(c.settings.moveDelayMin, 0);
  assert.equal(c.settings.sortMode, "rule");
  assert.equal(c.settings.maxActionsPerTick, 500);
  assert.equal(c.settings.features.move, true);
});

test("auto-close patterns: Zoom launch pages yes, web client no", () => {
  const cfg = NT.normalizeConfig({ categories: [] });
  const { isAutoClose } = NT.buildClassifier(cfg);
  assert.ok(isAutoClose("https://example.zoom.us/j/123?pwd=x#success", ""));
  assert.ok(isAutoClose("https://zoom.us/s/123", ""));
  assert.ok(isAutoClose("https://us02web.zoom.us/postattendee?mn=1", ""));
  assert.ok(!isAutoClose("https://app.zoom.us/wc/123/join", ""));
  assert.ok(!isAutoClose("https://zoom.us/", ""));
});

test("auto-close can target Firefox pages like about:newtab and What's New", () => {
  const cfg = NT.normalizeConfig({ categories: [], settings: { autoClose: { enabled: true, minutes: 10,
    patterns: ["about:newtab", "about:home", "*/whatsnew*", "getadblock.com"] } } });
  const { isAutoClose, classify } = NT.buildClassifier(cfg);
  assert.ok(isAutoClose("about:newtab", "New Tab"));
  assert.ok(isAutoClose("about:home", ""));
  assert.ok(!isAutoClose("about:addons", ""));
  assert.ok(!isAutoClose("about:newtabx", ""));
  assert.ok(isAutoClose("https://www.firefox.com/en-US/firefox/154.0/whatsnew/", "What's New in Firefox"));
  assert.ok(isAutoClose("https://www.mozilla.org/en-US/firefox/140.0/whatsnew/?oldversion=139.0", ""));
  assert.ok(isAutoClose("https://getadblock.com/en/installed/", ""));
  assert.equal(classify("about:newtab", ""), null, "about: pages are never moved or sorted");
  assert.equal(NT.validatePattern("about:newtab"), null);
});
