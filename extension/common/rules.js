/*
 * Ninetails — shared rule logic (used by the background script, the
 * settings page, the popup and the Node tests). No network, no I/O.
 *
 * Pattern syntax (one pattern per entry):
 *   example.com             domain: matches example.com and any subdomain
 *   example.com/path        domain + path prefix (path includes ?query)
 *   https://*.example.*\/x*  glob on the full URL (* = anything); used when the
 *                           pattern contains "*" or "://"
 *   re:^https://foo\.        regular expression on the full URL
 *   title:Some Text         case-insensitive substring of the tab title
 */
(function (root) {
  "use strict";

  const NT = {};

  NT.SCHEMA_VERSION = 1;

  NT.DEFAULT_SETTINGS = Object.freeze({
    features: { move: true, dedupe: true, sort: true },
    moveDelayMin: 10,          // minutes a tab must exist in the wrong window before moving
    dedupeIdleMin: 60,         // minutes a duplicate must be idle before closing
    sortMode: "rule",          // rule | domain | recent | opened
    sortFocusedWindow: false,  // also sort the window you're looking at
    sortUnboundWindows: false, // also sort windows with no category
    createWindows: true,       // open a new window for a category that has none
    autoBind: true,            // guess which window is which after a restart
    respectTabGroups: true,    // leave tabs in native Firefox tab groups alone
    ignoreHashInDupes: true,
    stripTrackingParams: true,
    maxActionsPerTick: 40,
    exclude: [],               // patterns Ninetails never touches
    autoClose: {               // close these once they've sat unused this long
      enabled: true,
      minutes: 10,
      // Zoom's "launch meeting" / post-meeting pages. The in-browser meeting
      // client (zoom.us/wc/...) is deliberately not listed.
      patterns: ["zoom.us/j/", "zoom.us/s/", "zoom.us/w/", "zoom.us/my/", "zoom.us/postattendee", "zoom.us/launch"]
    }
  });

  /* ---------- helpers ---------- */

  NT.uid = function (prefix) {
    const r = Math.random().toString(36).slice(2, 8);
    return (prefix || "id") + "-" + Date.now().toString(36) + "-" + r;
  };

  NT.clone = (o) => JSON.parse(JSON.stringify(o));

  function escapeRe(s) {
    return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }

  function globToRegex(glob) {
    const parts = glob.split("*").map(escapeRe);
    return new RegExp("^" + parts.join(".*") + "$", "i");
  }

  NT.parseUrl = function (url) {
    try { return new URL(url); } catch (e) { return null; }
  };

  NT.hostOf = function (url) {
    const u = NT.parseUrl(url);
    if (!u) return "";
    return u.hostname.replace(/^www\./, "").toLowerCase();
  };

  /* Pages Ninetails should never act on. */
  NT.isManageable = function (url) {
    if (!url) return false;
    return /^(https?|file):/i.test(url);
  };

  /* ---------- pattern compilation ---------- */

  NT.describePattern = function (p) {
    const s = String(p || "").trim();
    if (!s) return { kind: "empty" };
    if (s.toLowerCase().startsWith("re:")) return { kind: "regex", body: s.slice(3) };
    if (s.toLowerCase().startsWith("title:")) return { kind: "title", body: s.slice(6).trim() };
    if (/^about:[a-z-]+$/i.test(s)) return { kind: "about", body: s.toLowerCase() };
    if (s.includes("*") || s.includes("://")) return { kind: "glob", body: s };
    const slash = s.indexOf("/");
    if (slash > 0) return { kind: "domainPath", body: s, domain: s.slice(0, slash), path: s.slice(slash) };
    return { kind: "domain", body: s };
  };

  /* Returns a function(url, title) -> bool, or throws with a readable message. */
  NT.compilePattern = function (p) {
    const d = NT.describePattern(p);
    switch (d.kind) {
      case "empty":
        throw new Error("Empty pattern");
      case "regex": {
        let re;
        try { re = new RegExp(d.body, "i"); } catch (e) { throw new Error("Bad regex: " + e.message); }
        return (url) => re.test(url || "");
      }
      case "title": {
        const needle = d.body.toLowerCase();
        if (!needle) throw new Error("title: needs some text");
        return (url, title) => (title || "").toLowerCase().includes(needle);
      }
      case "about": {
        // Firefox's own pages, e.g. about:newtab (only used by auto-close)
        return (url) => String(url || "").toLowerCase().split(/[?#]/)[0] === d.body;
      }
      case "glob": {
        const re = globToRegex(d.body);
        return (url) => re.test(url || "");
      }
      case "domainPath": {
        const dom = d.domain.toLowerCase().replace(/^www\./, "");
        const path = d.path.toLowerCase();
        return (url) => {
          const u = NT.parseUrl(url);
          if (!u || !/^https?:$/.test(u.protocol)) return false;
          const h = u.hostname.toLowerCase();
          if (!(h === dom || h.endsWith("." + dom))) return false;
          return (u.pathname + u.search).toLowerCase().startsWith(path);
        };
      }
      case "domain": {
        const dom = d.body.toLowerCase().replace(/^www\./, "");
        return (url) => {
          const u = NT.parseUrl(url);
          if (!u || !/^https?:$/.test(u.protocol)) return false;
          const h = u.hostname.toLowerCase();
          return h === dom || h.endsWith("." + dom);
        };
      }
    }
    throw new Error("Unknown pattern");
  };

  NT.validatePattern = function (p) {
    try { NT.compilePattern(p); return null; } catch (e) { return e.message; }
  };

  /*
   * Build a classifier for a config. Categories are checked top to bottom;
   * the first enabled category with a matching pattern wins.
   * classify(url, title) -> { catId, catIndex, patternIndex, pattern } | null
   */
  NT.buildClassifier = function (config) {
    const cats = (config.categories || []).map((c, ci) => ({
      id: c.id,
      index: ci,
      enabled: c.enabled !== false,
      catchAll: !!c.catchAll,
      tests: (c.patterns || []).map((p, pi) => {
        try { return { fn: NT.compilePattern(p), pi, p }; } catch (e) { return null; }
      }).filter(Boolean)
    }));
    const excl = ((config.settings && config.settings.exclude) || []).map((p) => {
      try { return NT.compilePattern(p); } catch (e) { return null; }
    }).filter(Boolean);

    function isExcluded(url, title) {
      return excl.some((fn) => fn(url, title));
    }

    const ac = (config.settings && config.settings.autoClose) || { patterns: [] };
    const acTests = (ac.patterns || []).map((p) => {
      try { return NT.compilePattern(p); } catch (e) { return null; }
    }).filter(Boolean);

    /* Pages the auto-close section covers (ignores the on/off switch). */
    function isAutoClose(url, title) {
      // web pages and local files, plus Firefox pages like about:newtab if listed
      if (!(NT.isManageable(url) || /^about:/i.test(url || "")) || isExcluded(url, title)) return false;
      return acTests.some((fn) => fn(url, title));
    }

    // The "everything else" window (at most one) catches whatever no rule claims.
    const catchAll = cats.find((c) => c.enabled && c.catchAll) || null;

    function classify(url, title) {
      if (!NT.isManageable(url)) return null;
      if (isExcluded(url, title)) return null;
      for (const c of cats) {
        if (!c.enabled) continue;
        for (const t of c.tests) {
          if (t.fn(url, title)) return { catId: c.id, catIndex: c.index, patternIndex: t.pi, pattern: t.p };
        }
      }
      if (catchAll) return { catId: catchAll.id, catIndex: catchAll.index, patternIndex: 9998, pattern: "(everything else)" };
      return null;
    }

    return { classify, isExcluded, isAutoClose };
  };

  /* ---------- duplicate detection ---------- */

  const TRACKING = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|_hsenc|_hsmi|ref_src)$/i;

  NT.normalizeUrl = function (url, settings) {
    const s = settings || NT.DEFAULT_SETTINGS;
    const u = NT.parseUrl(url);
    if (!u || !/^(https?|file):$/.test(u.protocol)) return null;
    if (s.ignoreHashInDupes) u.hash = "";
    if (s.stripTrackingParams) {
      for (const k of Array.from(u.searchParams.keys())) {
        if (TRACKING.test(k)) u.searchParams.delete(k);
      }
    }
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    let out = u.toString();
    if (out.endsWith("/") && u.pathname !== "/") out = out.slice(0, -1);
    if (out.endsWith("?")) out = out.slice(0, -1);
    return out;
  };

  /* ---------- config / profile shape ---------- */

  NT.normalizeConfig = function (cfg) {
    const c = cfg ? NT.clone(cfg) : {};
    c.categories = Array.isArray(c.categories) ? c.categories : [];
    c.categories = c.categories.map((cat) => ({
      id: cat.id || NT.uid("cat"),
      name: String(cat.name || "Untitled").slice(0, 60),
      enabled: cat.enabled !== false,
      catchAll: !!cat.catchAll,
      // close this window's tabs once unused this many minutes (null = never)
      closeIdleMin: Number(cat.closeIdleMin) > 0 ? Math.min(Number(cat.closeIdleMin), 365 * 24 * 60) : null,
      patterns: Array.isArray(cat.patterns) ? cat.patterns.map(String).filter((p) => p.trim()) : []
    }));
    // only one "everything else" window
    let seenCatchAll = false;
    for (const cat of c.categories) {
      if (cat.catchAll && seenCatchAll) cat.catchAll = false;
      if (cat.catchAll) seenCatchAll = true;
    }
    const def = NT.clone(NT.DEFAULT_SETTINGS);
    const s = Object.assign(def, c.settings || {});
    s.features = Object.assign(NT.clone(NT.DEFAULT_SETTINGS.features), (c.settings && c.settings.features) || {});
    s.exclude = Array.isArray(s.exclude) ? s.exclude.map(String) : [];
    const ac = (c.settings && c.settings.autoClose) || {};
    s.autoClose = {
      enabled: ac.enabled !== undefined ? !!ac.enabled : NT.DEFAULT_SETTINGS.autoClose.enabled,
      minutes: clampNum(ac.minutes, 1, 7 * 24 * 60, NT.DEFAULT_SETTINGS.autoClose.minutes),
      patterns: Array.isArray(ac.patterns) ? ac.patterns.map(String).filter((p) => p.trim()) : NT.DEFAULT_SETTINGS.autoClose.patterns.slice()
    };
    s.moveDelayMin = clampNum(s.moveDelayMin, 0, 24 * 60, 10);
    s.dedupeIdleMin = clampNum(s.dedupeIdleMin, 0, 7 * 24 * 60, 60);
    s.maxActionsPerTick = clampNum(s.maxActionsPerTick, 1, 500, 40);
    if (!["rule", "domain", "recent", "opened"].includes(s.sortMode)) s.sortMode = "rule";
    c.settings = s;
    return c;
  };

  function clampNum(v, lo, hi, dflt) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }

  NT.normalizeProfile = function (p) {
    return {
      schema: NT.SCHEMA_VERSION,
      id: (p && p.id) || NT.uid("profile"),
      name: String((p && p.name) || "Profile").slice(0, 60),
      config: NT.normalizeConfig(p && p.config)
    };
  };

  /* Merge category `fromId` into `intoId` (patterns unioned, order kept). */
  NT.mergeCategories = function (config, fromId, intoId) {
    const c = NT.clone(config);
    const from = c.categories.find((x) => x.id === fromId);
    const into = c.categories.find((x) => x.id === intoId);
    if (!from || !into || from === into) return c;
    for (const p of from.patterns) if (!into.patterns.includes(p)) into.patterns.push(p);
    if (from.catchAll) into.catchAll = true;
    c.categories = c.categories.filter((x) => x.id !== fromId);
    return c;
  };

  /* ---------- sorting ---------- */

  /*
   * Returns tab ids (unpinned, in the given list) in the desired order.
   * `classify` is the classifier fn; `windowCatId` the category bound to the window.
   */
  NT.sortTabs = function (tabs, mode, classify, windowCatId) {
    const keyed = tabs.map((t, i) => {
      const cls = classify(t.url, t.title);
      return { t, i, cls, host: NT.hostOf(t.url) };
    });
    const cmp = {
      rule: (a, b) => {
        const ra = rank(a), rb = rank(b);
        for (let k = 0; k < ra.length; k++) if (ra[k] !== rb[k]) return ra[k] < rb[k] ? -1 : 1;
        return a.i - b.i;
      },
      domain: (a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : a.i - b.i),
      recent: (a, b) => ((b.t.lastAccessed || 0) - (a.t.lastAccessed || 0)) || a.i - b.i,
      opened: (a, b) => (a.t.id - b.t.id)
    }[mode] || null;
    if (!cmp) return tabs.map((t) => t.id);

    function rank(x) {
      // 0 = belongs here, 1 = belongs elsewhere (exempt/kept), 2 = unclassified
      const group = !x.cls ? 2 : x.cls.catId === windowCatId ? 0 : 1;
      const catIdx = x.cls ? x.cls.catIndex : 9999;
      const patIdx = x.cls ? x.cls.patternIndex : 9999;
      return [group, catIdx, patIdx, x.host];
    }

    return keyed.slice().sort(cmp).map((x) => x.t.id);
  };

  if (typeof module !== "undefined" && module.exports) module.exports = NT;
  else root.NT = NT;
})(typeof self !== "undefined" ? self : this);
