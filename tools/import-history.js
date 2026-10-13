#!/usr/bin/env node
// Incremental import of Zen browser history into the web-search plugin.
//
// State file (owned by this tool): <plugin>/history.json
//   { version, pageWatermark, searchWatermark, items:[{title,url,ts}] }
//
// Each run reads only rows newer than the stored watermark (a PRTime in µs,
// monotonic), merges them into the item list, and writes the state back. The
// plugin reads this file and merges it with its own settings.history, so the
// two writers never touch the same file (no lost updates).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Lib = require(path.join(__dirname, "..", "lib.js"));

const HOME = os.homedir();
const PLUGIN = path.join(HOME, ".config/noctalia/plugins/web-search");
const STATE_FILE = path.join(PLUGIN, "history.json");
const SETTINGS_FILE = path.join(PLUGIN, "settings.json");

const TOTAL_LIMIT = 5000; // keep in sync with the cap in LauncherProvider.qml
const PAGE_LIMIT = 5000; // newest rows considered in a single run

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

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

// Newest Zen profile that has a places.sqlite (falls back to the legacy path).
function zenProfile() {
  const root = path.join(HOME, ".zen");
  let best = "";
  let bestMtime = -1;
  try {
    for (const name of fs.readdirSync(root)) {
      const db = path.join(root, name, "places.sqlite");
      if (fs.existsSync(db) && fs.statSync(db).mtimeMs > bestMtime) {
        bestMtime = fs.statSync(db).mtimeMs;
        best = path.join(root, name);
      }
    }
  } catch {}
  return best || path.join(root, "eeujjh69.Default Profile");
}

// Rows newer than `wm`; the returned watermark is the DB-wide max, so the next
// run starts exactly where this snapshot ended.
function pages(places, wm) {
  if (!fs.existsSync(places)) return { items: [], watermark: wm };
  const rows = query(
    places,
    `SELECT p.url AS url,
            COALESCE(NULLIF(p.title,''), p.url) AS title,
            CAST(MAX(h.visit_date) / 1000 AS INTEGER) AS ts
     FROM moz_historyvisits h JOIN moz_places p ON p.id = h.place_id
     WHERE p.hidden = 0 AND p.url LIKE 'http%' AND h.visit_date > ${wm}
     GROUP BY p.id
     ORDER BY ts DESC
     LIMIT ${PAGE_LIMIT}`
  );
  const maxRow = query(places, `SELECT COALESCE(MAX(visit_date), 0) AS wm FROM moz_historyvisits`);
  const items = rows
    .filter((r) => httpUrl(r.url))
    .map((r) => ({ title: (r.title || r.url).trim(), url: r.url.trim(), ts: Number(r.ts) || 0 }));
  return { items, watermark: Number(maxRow[0] && maxRow[0].wm) || wm };
}

// Typed searches become a search URL on the configured engine, so selecting one
// re-runs the search.
function searches(formhistory, engineUrl, wm) {
  if (!fs.existsSync(formhistory)) return { items: [], watermark: wm };
  const rows = query(
    formhistory,
    `SELECT value AS query, CAST(MAX(lastUsed) / 1000 AS INTEGER) AS ts
     FROM moz_formhistory
     WHERE fieldname IN ('searchbar-history','search-query-input')
       AND value IS NOT NULL AND trim(value) <> '' AND lastUsed > ${wm}
     GROUP BY value
     ORDER BY ts DESC`
  );
  const maxRow = query(formhistory, `SELECT COALESCE(MAX(lastUsed), 0) AS wm FROM moz_formhistory`);
  const items = rows
    .filter((r) => r.query)
    .map((r) => {
      const q = String(r.query).trim();
      return { title: q, url: engineUrl + encodeURIComponent(q), ts: Number(r.ts) || 0 };
    });
  return { items, watermark: Number(maxRow[0] && maxRow[0].wm) || wm };
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
  const firstRun = !fs.existsSync(STATE_FILE);
  const state = readJson(STATE_FILE, { version: 1, pageWatermark: 0, searchWatermark: 0, items: [] });
  const settings = readJson(SETTINGS_FILE, {});

  // First run: seed from any history the plugin already recorded, so nothing is
  // lost (the plugin then merges both sources, deduped by URL).
  const seed = firstRun && Array.isArray(settings.history) ? settings.history : [];
  const existing = mergeHistory(seed, state.items || [], TOTAL_LIMIT);

  const profile = zenProfile();
  const p = pages(path.join(profile, "places.sqlite"), Number(state.pageWatermark) || 0);
  const s = searches(
    path.join(profile, "formhistory.sqlite"),
    engineSearchUrl(settings),
    Number(state.searchWatermark) || 0
  );

  const items = mergeHistory(existing, [...p.items, ...s.items], TOTAL_LIMIT);
  const next = {
    version: 1,
    pageWatermark: p.watermark,
    searchWatermark: s.watermark,
    items,
  };

  fs.mkdirSync(PLUGIN, { recursive: true });
  // Atomic write: the plugin may read this file concurrently.
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  fs.renameSync(tmp, STATE_FILE);
  console.log(
    `synced -> ${STATE_FILE}\n` +
      `  profile: ${profile}\n` +
      `  new:     ${p.items.length + s.items.length}\n` +
      `  total:   ${items.length}`
  );
}

if (require.main === module) main();
module.exports = { pages, searches, mergeHistory, engineSearchUrl, zenProfile };
