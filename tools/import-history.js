#!/usr/bin/env node
// Import browser history into the web-search plugin's launcher history.
//
// Sources (Zen profile):
//   places.sqlite       visited pages (latest visit per URL, visible http(s))
//   formhistory.sqlite  typed search queries -> a search URL on the configured
//                       engine, so selecting one re-runs the search
//
// Target: settings.json -> `history` [{title,url,ts}]
// Re-runnable: entries are rebuilt from the DBs, deduped by URL keeping the
// newest `ts`, then merged with the existing history (so plugin-recorded
// entries survive). Newest first.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Lib = require(path.join(__dirname, "..", "lib.js"));

const HOME = os.homedir();
const PLUGIN = path.join(HOME, ".config/noctalia/plugins/web-search");
const ZEN = path.join(HOME, ".zen/eeujjh69.Default Profile");
const PLACES = path.join(ZEN, "places.sqlite");
const FORMHISTORY = path.join(ZEN, "formhistory.sqlite");

const PAGE_LIMIT = 1000; // newest visited pages imported from the browser
const TOTAL_LIMIT = 5000; // keep in sync with the cap in LauncherProvider.qml

function query(db, sql) {
  if (!fs.existsSync(db)) return [];
  const out = execFileSync("sqlite3", ["-json", `file:${db}?immutable=1`, sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
  return out ? JSON.parse(out) : [];
}

function httpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function pages() {
  const rows = query(
    PLACES,
    `SELECT p.url AS url,
            COALESCE(NULLIF(p.title,''), p.url) AS title,
            CAST(MAX(h.visit_date) / 1000 AS INTEGER) AS ts
     FROM moz_historyvisits h JOIN moz_places p ON p.id = h.place_id
     WHERE p.hidden = 0 AND p.url LIKE 'http%'
     GROUP BY p.id
     ORDER BY ts DESC`
  );
  return rows
    .filter((r) => httpUrl(r.url))
    .map((r) => ({ title: (r.title || r.url).trim(), url: r.url.trim(), ts: Number(r.ts) || 0 }));
}

function searches(engineUrl) {
  const rows = query(
    FORMHISTORY,
    `SELECT value AS query, CAST(MAX(lastUsed) / 1000 AS INTEGER) AS ts
     FROM moz_formhistory
     WHERE fieldname IN ('searchbar-history','search-query-input')
       AND value IS NOT NULL AND trim(value) <> ''
     GROUP BY value
     ORDER BY ts DESC`
  );
  return rows
    .filter((r) => r.query)
    .map((r) => {
      const q = String(r.query).trim();
      return { title: q, url: engineUrl + encodeURIComponent(q), ts: Number(r.ts) || 0 };
    });
}

// Dedup by URL (newest ts wins), newest first, capped.
function mergeHistory(existing, incoming, totalLimit) {
  const byUrl = new Map();
  for (const e of [...incoming, ...existing]) {
    if (!e || !e.url) continue;
    const ts = Number(e.ts) || 0;
    const prev = byUrl.get(e.url);
    if (!prev || ts > (Number(prev.ts) || 0)) {
      byUrl.set(e.url, { title: e.title || e.url, url: e.url, ts });
    }
  }
  return [...byUrl.values()].sort((a, b) => b.ts - a.ts).slice(0, totalLimit);
}

function engineSearchUrl(settings) {
  const engines = Object.assign({}, Lib.BUILTIN_ENGINES);
  for (const e of settings.engines || []) {
    if (e && e.key && e.url) engines[e.key] = e;
  }
  const engine = engines[settings.search_engine] || Lib.BUILTIN_ENGINES.ddg;
  return engine.url;
}

function main() {
  const file = path.join(PLUGIN, "settings.json");
  const settings = JSON.parse(fs.readFileSync(file, "utf8"));
  const existing = Array.isArray(settings.history) ? settings.history : [];

  // All typed searches (few) + the newest pages; merge caps the total.
  const incoming = [...pages().slice(0, PAGE_LIMIT), ...searches(engineSearchUrl(settings))];
  const history = mergeHistory(existing, incoming, TOTAL_LIMIT);

  settings.history = history;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  console.log(
    `imported -> ${file}\n` + `  from browser: ${incoming.length}\n` + `  total:        ${history.length}`
  );
}

if (require.main === module) main();
module.exports = { pages, searches, mergeHistory, engineSearchUrl };
