#!/usr/bin/env node
// One-time (re-runnable) migration: ww config + Zen bookmarks -> plugin settings.json
//
// Sources:
//   ~/.config/ww/shortcuts.json   [{alias,name,url}]
//   ~/.config/ww/engines.json     {key:{name,url,domain}}
//   ~/.config/ww/bookmarks.json   [{title,url,visits}]
//   <zen profile>/places.sqlite   moz_bookmarks (type=1)
//
// Target: ~/.config/noctalia/plugins/web-search/settings.json
// Idempotent: rebuilds `engines`, `bookmarks`, `shortcuts` from the sources on
// every run and preserves all other settings keys.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOME = os.homedir();
const WW = path.join(HOME, ".config/ww");
const PLUGIN = path.join(HOME, ".config/noctalia/plugins/web-search");
const ZEN_PROFILE = path.join(HOME, ".zen/eeujjh69.Default Profile");
const ZEN_DB = path.join(ZEN_PROFILE, "places.sqlite");

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

function zenBookmarks() {
  if (!fs.existsSync(ZEN_DB)) return [];
  try {
    const out = execFileSync(
      "sqlite3",
      [
        "-json",
        `file:${ZEN_DB}?immutable=1`,
        `SELECT p.url AS url, COALESCE(NULLIF(p.title,''), p.url) AS title, p.visit_count AS visits
         FROM moz_bookmarks b JOIN moz_places p ON b.fk = p.id
         WHERE b.type = 1 AND p.hidden = 0
         ORDER BY p.visit_count DESC`,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    ).trim();
    return out ? JSON.parse(out) : [];
  } catch (err) {
    console.error("zenBookmarks:", err.message);
    return [];
  }
}

function mergeBookmarks(entries) {
  const byUrl = new Map();
  for (const e of entries) {
    if (!e || !httpUrl(e.url)) continue;
    const url = e.url.trim();
    const prev = byUrl.get(url);
    const next = {
      title: (e.title || "").trim() || url,
      url,
      visits: Number(e.visits) || 0,
    };
    if (!prev || next.visits > prev.visits) byUrl.set(url, next);
  }
  return [...byUrl.values()].sort((a, b) => b.visits - a.visits || a.title.localeCompare(b.title));
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
    if (!eng || !key) continue;
    out.push({
      key,
      name: eng.name || key,
      url: eng.url || "",
      domain: eng.domain || "",
    });
  }
  return out;
}

function main() {
  const settingsFile = path.join(PLUGIN, "settings.json");
  const settings = readJson(settingsFile, {});

  const engineName = settings.search_engine;
  if (ENGINE_NAME_TO_KEY[engineName]) settings.search_engine = ENGINE_NAME_TO_KEY[engineName];
  else if (!engineName) settings.search_engine = "ddg";

  const wwBookmarks = readJson(path.join(WW, "bookmarks.json"), []);
  settings.bookmarks = mergeBookmarks([...wwBookmarks, ...zenBookmarks()]);
  settings.shortcuts = loadShortcuts();
  settings.engines = loadEngines();

  fs.mkdirSync(PLUGIN, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
  console.log(
    `migrated -> ${settingsFile}\n` +
      `  engines:   ${settings.engines.length}\n` +
      `  bookmarks: ${settings.bookmarks.length}\n` +
      `  shortcuts: ${settings.shortcuts.length}\n` +
      `  engine:    ${settings.search_engine}`
  );
}

main();
