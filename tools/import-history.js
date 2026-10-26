#!/usr/bin/env node
// Incremental import of Zen browser history/bookmarks into the web-search plugin.
//
// State file (owned by this tool): <data-dir>/history.json
//   { version, profile, dbSignature, pageWatermark, searchWatermark, bookmarks:[{title,url,visits}], items:[{title,url,ts}] }
//
// Each run reads only rows at/after the stored watermark (a PRTime in µs,
// monotonic), merges them into the item list, and writes the state back. The
// plugin reads this file and merges it with its own settings.history, so the
// two writers never touch the same file (no lost updates).
//
// Data dir: --data-dir DIR | --data-dir=DIR | $WEB_SEARCH_DATA_DIR |
//           ~/.config/noctalia/plugins/web-search

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");
const Lib = require(path.join(__dirname, "..", "lib.js"));

const TOTAL_LIMIT = 5000; // keep in sync with the cap in LauncherProvider.qml
const PAGE_LIMIT = 5000; // newest rows considered in a single run

const HOME = os.homedir();
const DATA_DIR = resolveDataDir(process.argv.slice(2), process.env, HOME);
const STATE_FILE = path.join(DATA_DIR, "history.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

function resolveDataDir(argv = [], env = {}, home = os.homedir()) {
  let dir = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--data-dir") {
      dir = argv[i + 1] || "";
      break;
    }
    if (argv[i].startsWith("--data-dir=")) {
      dir = argv[i].slice("--data-dir=".length);
      break;
    }
  }
  if (!dir) dir = env.WEB_SEARCH_DATA_DIR || "";
  if (!dir) dir = "~/.config/noctalia/plugins/web-search";
  if (dir === "~") return home;
  if (dir.startsWith("~/")) return path.join(home, dir.slice(2));
  return path.resolve(dir);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Zen keeps places.sqlite open with Firefox's unix-excl VFS, which blocks a
// second process from opening it in place. Falling back to a temp copy of the
// db + WAL is what lets a sync read live history. The copy is made once per db
// and removed when the process exits.
const snapshots = new Map();
let snapshotsWatched = false;

function snapshotDb(db) {
  if (snapshots.has(db)) return snapshots.get(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-search-sqlite-"));
  const copy = path.join(dir, path.basename(db));
  fs.copyFileSync(db, copy);
  // No -shm copy: SQLite rebuilds it from the WAL, which also avoids trusting
  // an shm that is newer than the copied WAL.
  if (fs.existsSync(db + "-wal")) fs.copyFileSync(db + "-wal", copy + "-wal");
  snapshots.set(db, copy);
  if (!snapshotsWatched) {
    snapshotsWatched = true;
    process.once("exit", () => {
      for (const file of snapshots.values()) {
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
      }
    });
  }
  return copy;
}

function query(db, sql) {
  if (!fs.existsSync(db)) return [];
  const run = (file, quiet) => {
    const uri = pathToFileURL(file).href + "?mode=ro&busy_timeout=2000";
    const opts = { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 };
    if (quiet) opts.stdio = ["ignore", "pipe", "ignore"];
    const out = execFileSync("sqlite3", ["-json", uri, sql], opts).trim();
    return out ? JSON.parse(out) : [];
  };
  try {
    return run(db, true);
  } catch {
    return run(snapshotDb(db));
  }
}

function httpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

// Newest profile that has a places.sqlite. $ZEN_PROFILE wins when valid.
function zenProfile(home = os.homedir()) {
  const fromEnv = process.env.ZEN_PROFILE;
  if (fromEnv && fs.existsSync(path.join(fromEnv, "places.sqlite"))) {
    return path.resolve(fromEnv);
  }
  const roots = [
    path.join(home, ".zen"),
    path.join(home, ".var/app/app.zen_browser.zen/.zen"),
    path.join(home, ".var/app/io.github.zen_browser.zen/.zen"),
  ];
  let best = "";
  let bestMtime = -1;
  for (const root of roots) {
    let names;
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = path.join(root, name);
      const db = path.join(dir, "places.sqlite");
      let stat;
      try {
        stat = fs.statSync(db);
      } catch {
        continue;
      }
      if (stat.isFile() && stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs;
        best = dir;
      }
    }
  }
  return best;
}

// Cheap change detector for the two live DBs: a launcher open must not copy a
// 20 MB places.sqlite when Zen has not written anything since the last sync.
function dbSignature(places) {
  const files = [
    places,
    places + "-wal",
    path.join(path.dirname(places), "formhistory.sqlite"),
    path.join(path.dirname(places), "formhistory.sqlite-wal"),
  ];
  return files
    .map((file) => {
      try {
        const stat = fs.statSync(file);
        return `${path.basename(file)}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return `${path.basename(file)}:-`;
      }
    })
    .join("|");
}

// Rows at/after `wm`; the returned watermark is the DB-wide max, so the next
// run starts exactly where this snapshot ended. A row exactly on the watermark
// is re-read once; mergeHistory dedups it by URL.
function pages(places, wm) {
  if (!fs.existsSync(places)) return { items: [], watermark: wm };
  const rows = query(
    places,
    `SELECT p.url AS url,
            COALESCE(NULLIF(p.title,''), p.url) AS title,
            CAST(MAX(h.visit_date) / 1000 AS INTEGER) AS ts
     FROM moz_historyvisits h JOIN moz_places p ON p.id = h.place_id
     WHERE p.hidden = 0 AND p.url LIKE 'http%' AND h.visit_date >= ${wm}
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
       AND value IS NOT NULL AND trim(value) <> '' AND lastUsed >= ${wm}
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

// Zen bookmarks (type 1 = bookmark), http(s) only, deduped by URL.
function bookmarks(places) {
  if (!fs.existsSync(places)) return null;
  const rows = query(
    places,
    `SELECT p.url AS url, p.title AS title, p.visit_count AS visits
     FROM moz_bookmarks b JOIN moz_places p ON p.id = b.fk
     WHERE b.type = 1 AND p.hidden = 0`
  );
  const byUrl = new Map();
  for (const r of rows) {
    if (!httpUrl(r.url)) continue;
    const url = r.url.trim();
    const title = String(r.title || "").trim();
    const visits = Number(r.visits) || 0;
    const prev = byUrl.get(url);
    if (!prev) {
      byUrl.set(url, { title, url, visits });
    } else {
      if (visits > prev.visits) prev.visits = visits;
      if (!prev.title) prev.title = title;
    }
  }
  return [...byUrl.values()]
    .map((b) => ({ title: b.title || b.url, url: b.url, visits: b.visits }))
    .sort((a, b) => b.visits - a.visits || a.title.localeCompare(b.title));
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
  const profile = zenProfile(HOME);
  if (!profile) {
    console.error(
      "import-history: no Zen profile with places.sqlite found in ~/.zen or the Flatpak data dirs.\n" +
        "  Set ZEN_PROFILE=/path/to/profile to override. history.json left untouched."
    );
    return;
  }

  const firstRun = !fs.existsSync(STATE_FILE);
  const state = readJson(STATE_FILE, {});
  const settings = readJson(SETTINGS_FILE, {});

  const places = path.join(profile, "places.sqlite");
  const signature = dbSignature(places);
  if (
    !firstRun &&
    state.version === 2 &&
    state.profile === profile &&
    state.dbSignature === signature &&
    Array.isArray(state.items) &&
    Array.isArray(state.bookmarks)
  ) {
    console.log(`unchanged -> ${STATE_FILE}\n  profile:   ${profile}`);
    return;
  }

  // A different profile means the old watermarks point into another DB.
  const profileChanged = Boolean(state.profile) && state.profile !== profile;
  const pageWatermark = profileChanged ? 0 : Number(state.pageWatermark) || 0;
  const searchWatermark = profileChanged ? 0 : Number(state.searchWatermark) || 0;

  // First run: seed from any history the plugin already recorded, so nothing is
  // lost (the plugin then merges both sources, deduped by URL).
  const seed = firstRun && Array.isArray(settings.history) ? settings.history : [];
  const existing = mergeHistory(seed, Array.isArray(state.items) ? state.items : [], TOTAL_LIMIT);

  const p = pages(places, pageWatermark);
  const s = searches(path.join(profile, "formhistory.sqlite"), engineSearchUrl(settings), searchWatermark);
  const foundBookmarks = bookmarks(places);
  const importedBookmarks =
    foundBookmarks === null && Array.isArray(state.bookmarks) ? state.bookmarks : foundBookmarks || [];

  const items = mergeHistory(existing, [...p.items, ...s.items], TOTAL_LIMIT);
  const next = {
    version: 2,
    profile,
    dbSignature: signature,
    pageWatermark: p.watermark,
    searchWatermark: s.watermark,
    bookmarks: importedBookmarks,
    items,
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Atomic write: the plugin may read this file concurrently.
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  fs.renameSync(tmp, STATE_FILE);
  console.log(
    `synced -> ${STATE_FILE}\n` +
      `  profile:   ${profile}\n` +
      `  new:       ${p.items.length + s.items.length}\n` +
      `  total:     ${items.length}\n` +
      `  bookmarks: ${importedBookmarks.length}`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("import-history: sync failed: " + (err && err.message ? err.message : err));
    process.exitCode = 1;
  }
}

module.exports = {
  resolveDataDir,
  pages,
  searches,
  bookmarks,
  mergeHistory,
  engineSearchUrl,
  zenProfile,
  dbSignature,
};
