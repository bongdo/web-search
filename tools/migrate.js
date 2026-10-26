#!/usr/bin/env node
// One-time (re-runnable) migration: ww config + Zen bookmarks -> plugin settings.json
//
// Sources:
//   ~/.config/ww/shortcuts.json   [{alias,name,url}]
//   ~/.config/ww/engines.json     {key:{name,url,domain}}
//   ~/.config/ww/bookmarks.json   [{title,url,visits}]
//   <zen profile>/places.sqlite   moz_bookmarks (type=1)
//
// Target: <data-dir>/settings.json (default ~/.config/noctalia/plugins/web-search)
// Idempotent and non-destructive: bookmark/engine/shortcut entries already in
// settings.json win over imported ones, and all other settings keys are kept.
//
// Data dir: --data-dir DIR | --data-dir=DIR | $WEB_SEARCH_DATA_DIR

const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveDataDir, zenProfile, bookmarks: zenBookmarks } = require("./import-history.js");

const HOME = os.homedir();
const WW = path.join(HOME, ".config/ww");
const DATA_DIR = resolveDataDir(process.argv.slice(2), process.env, HOME);
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

const ENGINE_NAME_TO_KEY = {
  Google: "g",
  DuckDuckGo: "ddg",
  Bing: "bing",
  Brave: "brave",
  Yandex: "ya",
  YouTube: "y",
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function httpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function loadZenBookmarks() {
  const profile = zenProfile(HOME);
  if (!profile) return [];
  return zenBookmarks(path.join(profile, "places.sqlite")) || [];
}

// Existing entries are passed first, so their non-empty title wins; visits are
// the max seen anywhere.
function mergeBookmarks(existing, incoming) {
  const byUrl = new Map();
  for (const e of [...existing, ...incoming]) {
    if (!e || !httpUrl(e.url)) continue;
    const url = e.url.trim();
    const title = typeof e.title === "string" ? e.title.trim() : "";
    const visits = Number(e.visits) || 0;
    const prev = byUrl.get(url);
    if (!prev) {
      byUrl.set(url, { title, url, visits });
    } else {
      prev.visits = Math.max(prev.visits, visits);
      if (!prev.title) prev.title = title;
    }
  }
  return [...byUrl.values()]
    .map((b) => ({ title: b.title || b.url, url: b.url, visits: b.visits }))
    .sort((a, b) => b.visits - a.visits || a.title.localeCompare(b.title));
}

function loadShortcuts() {
  const src = readJson(path.join(WW, "shortcuts.json"), []);
  const seen = new Set();
  const out = [];
  for (const s of src) {
    if (!s || !s.alias || !httpUrl(s.url)) continue;
    const alias = String(s.alias).trim();
    if (!alias || seen.has(alias)) continue;
    seen.add(alias);
    out.push({ alias, name: (s.name || alias).trim(), url: s.url.trim() });
  }
  return out;
}

function loadEngines() {
  const src = readJson(path.join(WW, "engines.json"), {});
  const out = [];
  for (const [key, eng] of Object.entries(src)) {
    if (!eng || !key || !eng.url) continue;
    out.push({
      key,
      name: eng.name || key,
      url: eng.url,
      domain: eng.domain || "",
    });
  }
  return out;
}

// Imported entries fill gaps; existing valid entries with the same key/alias win.
function mergeBy(existing, imported, key) {
  const merged = new Map();
  for (const entry of imported) {
    if (entry && entry[key] && entry.url) merged.set(entry[key], entry);
  }
  for (const entry of existing) {
    if (entry && entry[key] && entry.url) merged.set(entry[key], entry);
  }
  return [...merged.values()];
}

function main() {
  const settings = readJson(SETTINGS_FILE, {});
  const wwBookmarks = readJson(path.join(WW, "bookmarks.json"), []);

  settings.bookmarks = mergeBookmarks(
    Array.isArray(settings.bookmarks) ? settings.bookmarks : [],
    [...wwBookmarks, ...loadZenBookmarks()]
  );
  settings.shortcuts = mergeBy(
    Array.isArray(settings.shortcuts) ? settings.shortcuts : [],
    loadShortcuts(),
    "alias"
  );
  settings.engines = mergeBy(
    Array.isArray(settings.engines) ? settings.engines : [],
    loadEngines(),
    "key"
  );

  const engineName = settings.search_engine;
  if (ENGINE_NAME_TO_KEY[engineName]) settings.search_engine = ENGINE_NAME_TO_KEY[engineName];
  else if (!engineName) settings.search_engine = "ddg";

  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Atomic write: the plugin may read this file concurrently.
  const tmp = `${SETTINGS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  fs.renameSync(tmp, SETTINGS_FILE);
  console.log(
    `migrated -> ${SETTINGS_FILE}\n` +
      `  engines:   ${settings.engines.length}\n` +
      `  bookmarks: ${settings.bookmarks.length}\n` +
      `  shortcuts: ${settings.shortcuts.length}\n` +
      `  engine:    ${settings.search_engine}`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("migrate: failed: " + (err && err.message ? err.message : err));
    process.exitCode = 1;
  }
}
