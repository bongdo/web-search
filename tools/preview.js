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

const settings = readJson(path.join(DATA_DIR, "settings.json"), {});
const imported = readJson(path.join(DATA_DIR, "history.json"), { items: [], bookmarks: [] });
const history = imported.items || [];

// Settings bookmarks win titles; imported Zen bookmarks add new URLs.
const bookmarksByUrl = new Map();
for (const b of [...(imported.bookmarks || []), ...(settings.bookmarks || [])]) {
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

function results(text) {
  return L.getResults({
    text,
    engines,
    defaultEngineKey: settings.search_engine || "ddg",
    bookmarks,
    shortcuts: settings.shortcuts || [],
    history,
    directUrl: settings.direct_url !== false,
    maxResults: settings.max_results || 8
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
