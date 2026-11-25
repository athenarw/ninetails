/* Ninetails toolbar popup */
"use strict";
/* global browser */

const $ = (id) => document.getElementById(id);
const send = (m) => browser.runtime.sendMessage(m).then((r) => { if (r && r.error) throw new Error(r.error); return r; });

let tab = null;

function opt(value, text, selected) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = text;
  o.selected = !!selected;
  return o;
}

async function render() {
  const s = await send({ type: "getState" });
  [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  $("enabled").checked = s.enabled;
  $("profile").replaceChildren(...s.profiles.map((p) => opt(p.id, p.name + (p.id === s.defaultId ? "  ★" : ""), p.id === s.activeId)));
  const me = s.windows.find((w) => tab && w.id === tab.windowId);
  const elsewhere = new Set(s.windows.filter((w) => w.catId && (!me || w.id !== me.id)).map((w) => w.catId));
  $("win").replaceChildren(opt("", "— not a Ninetails window —", !me || !me.catId),
    ...s.config.categories.map((c) => opt(c.id, c.name + (elsewhere.has(c.id) ? "  (takes over from another window)" : ""), me && me.catId === c.id)));
  const cat = me && s.config.categories.find((c) => c.id === me.catId);
  $("win-hint").textContent = cat
    ? `Tabs that belong in ${cat.name} will gather here; this window's title bar shows [${cat.name}].`
    : "Pick a name to make this window the home for those sites.";
  $("exempt").checked = tab ? await send({ type: "isExempt", tabId: tab.id }) : false;
  const t = s.lastTick;
  $("status").textContent = (s.enabled ? "" : "Paused. ") +
    (t ? `Last pass: moved ${t.moved}, closed ${t.closed + (t.autoClosed || 0) + (t.idleClosed || 0)}, sorted ${t.sorted}.` : "");
  $("action").textContent = s.lastAction || "";
}

$("enabled").addEventListener("change", (e) => send({ type: "setEnabled", value: e.target.checked }).then(render));
$("profile").addEventListener("change", (e) => send({ type: "switchProfile", id: e.target.value }).then(render));
$("win").addEventListener("change", (e) => send({ type: "bindWindow", windowId: tab.windowId, catId: e.target.value || null }).then(render));
$("exempt").addEventListener("change", (e) => send({ type: "exemptTab", tabId: tab.id, value: e.target.checked }));
$("tidy").addEventListener("click", async () => {
  $("tidy").disabled = true;
  const r = await send({ type: "tidyNow" });
  $("tidy").disabled = false;
  $("action").textContent = r ? `Moved ${r.moved}, closed ${r.closed + (r.autoClosed || 0) + (r.idleClosed || 0)}, sorted ${r.sorted} window(s).` : "";
});
$("settings").addEventListener("click", () => { send({ type: "openSettings" }); window.close(); });

render();
