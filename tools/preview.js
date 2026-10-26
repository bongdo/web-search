#!/usr/bin/env node
// Preview real launcher results:
//   node tools/preview.js [--data-dir DIR] [query ...]
const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require(path.join(__dirname, "..", "lib.js"));
const { resolveDataDir } = require("./import-history.js");

const DATA_DIR = resolveDataDir(process.argv.slice(2), process.env, os.homedir());

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const settings = readJson(path.join(DATA_DIR, "settings.json"), {}) || {};
const imported = readJson(path.join(DATA_DIR, "history.json"), { items: [], bookmarks: [] }) || {};
const localHistory = Array.isArray(settings.history) ? settings.history : [];
const importedItems = Array.isArray(imported.items) ? imported.items : [];
const localBookmarks = Array.isArray(settings.bookmarks) ? settings.bookmarks : [];
const importedBookmarks = Array.isArray(imported.bookmarks) ? imported.bookmarks : [];

const historyByUrl = new Map();
for (const h of [...localHistory, ...importedItems]) {
  if (!h || !h.url) continue;
  const ts = Number(h.ts) || 0;
  const prev = historyByUrl.get(h.url);
  if (!prev || ts > prev.ts) {
    historyByUrl.set(h.url, { title: h.title || h.url, url: h.url, ts });
  }
}
const history = [...historyByUrl.values()].sort((a, b) => b.ts - a.ts);

// Settings bookmarks win titles; imported Zen bookmarks add new URLs.
const bookmarksByUrl = new Map();
for (const b of [...importedBookmarks, ...localBookmarks]) {
  if (!b || !b.url) continue;
  const prev = bookmarksByUrl.get(b.url);
  bookmarksByUrl.set(b.url, {
    title: (b.title || "").trim() || (prev && prev.title) || b.url,
    url: b.url,
    visits: Math.max(Number(b.visits) || 0, (prev && prev.visits) || 0)
  });
}
const bookmarks = [...bookmarksByUrl.values()];

const engines = L.allEngines(settings.engines);
const rawMax = Math.round(Number(settings.max_results));
const maxResults = isFinite(rawMax) ? Math.min(20, Math.max(1, rawMax)) : 8;

function results(text) {
  return L.getResults({
    text,
    engines,
    defaultEngineKey: settings.search_engine || "ddg",
    bookmarks,
    shortcuts: settings.shortcuts || [],
    history,
    directUrl: settings.direct_url !== false,
    maxResults
  });
}

const queries = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--data-dir") {
    i++;
    continue;
  }
  if (argv[i].startsWith("--data-dir=")) continue;
  queries.push(argv[i]);
}
if (!queries.length) {
  queries.push("ma", "yh", "y history", "gh noctalia", "b wiki", "arch", "github.com", "zzz nothing");
}

for (const q of queries) {
  console.log(`\n> ${q}`);
  for (const r of results(q)) {
    console.log(`  [${r.score}] ${r.kind.padEnd(8)} ${r.name}  ->  ${r.url}`);
  }
}
