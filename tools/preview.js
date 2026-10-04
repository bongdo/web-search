#!/usr/bin/env node
// Preview real launcher results: node tools/preview.js [query ...]
const path = require("path");
const L = require(path.join(__dirname, "..", "lib.js"));
const settings = require(path.join(__dirname, "..", "settings.json"));

const engines = L.allEngines(settings.engines);

function results(text) {
  return L.getResults({
    text,
    engines,
    defaultEngineKey: settings.search_engine || "ddg",
    bookmarks: settings.bookmarks || [],
    shortcuts: settings.shortcuts || [],
    directUrl: settings.direct_url !== false,
    maxResults: settings.max_results || 8
  });
}

const queries = process.argv.slice(2);
if (!queries.length) {
  queries.push("ma", "yh", "y history", "gh noctalia", "b wiki", "arch", "github.com", "zzz nothing");
}

for (const q of queries) {
  console.log(`\n> ${q}`);
  for (const r of results(q)) {
    console.log(`  [${r.score}] ${r.kind.padEnd(8)} ${r.name}  ->  ${r.url}`);
  }
}
