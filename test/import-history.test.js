// Minimal assert-based checks for tools/import-history.js. Run: node test/import-history.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const {
  mergeHistory,
  pages,
  searches,
  bookmarks,
  resolveDataDir,
  zenProfile,
  dbSignature,
} = require("../tools/import-history.js");

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok  " + name);
  } catch (err) {
    console.error("FAIL  " + name + "\n      " + err.message);
    process.exitCode = 1;
  }
}

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-search-test-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

check("newest ts wins per url, sorted desc, existing preserved", () => {
  const merged = mergeHistory(
    [{ title: "old", url: "a", ts: 1 }],
    [
      { title: "new", url: "a", ts: 5 },
      { title: "b", url: "b", ts: 9 },
      { title: "c", url: "c", ts: 3 },
    ],
    10
  );
  assert.deepStrictEqual(merged.map((x) => x.url), ["b", "a", "c"]);
  assert.strictEqual(merged.find((x) => x.url === "a").title, "new");
});

check("caps to totalLimit keeping newest", () => {
  const capped = mergeHistory(
    [],
    [
      { url: "a", ts: 1 },
      { url: "b", ts: 2 },
    ],
    1
  );
  assert.deepStrictEqual(capped.map((x) => x.url), ["b"]);
});

check("pages keeps the watermark when the db is missing", () => {
  assert.deepStrictEqual(pages("/nonexistent/places.sqlite", 42), { items: [], watermark: 42 });
});

check("resolveDataDir: arg forms, env, default", () => {
  const home = "/tmp/web-search-home";
  const def = path.join(home, ".config/noctalia/plugins/web-search");
  assert.strictEqual(resolveDataDir(["--data-dir", "/x/y"], {}, home), "/x/y");
  assert.strictEqual(resolveDataDir(["--data-dir=/x/y"], {}, home), "/x/y");
  assert.strictEqual(resolveDataDir([], { WEB_SEARCH_DATA_DIR: "/env/dir" }, home), "/env/dir");
  assert.strictEqual(resolveDataDir([], {}, home), def);
  assert.strictEqual(
    resolveDataDir(["--data-dir", "/arg"], { WEB_SEARCH_DATA_DIR: "/env/dir" }, home),
    "/arg"
  );
  assert.strictEqual(resolveDataDir(["--data-dir=~/data"], {}, home), path.join(home, "data"));
  assert.strictEqual(
    resolveDataDir([], { WEB_SEARCH_DATA_DIR: "~/env-data" }, home),
    path.join(home, "env-data")
  );
});

check("zenProfile: newest places.sqlite across Zen roots", () =>
  withEnv("ZEN_PROFILE", undefined, () =>
    withTmp((home) => {
      const old = path.join(home, ".zen", "old.default");
      const flat = path.join(home, ".var/app/app.zen_browser.zen/.zen", "flat.default");
      fs.mkdirSync(old, { recursive: true });
      fs.mkdirSync(flat, { recursive: true });
      fs.writeFileSync(path.join(old, "places.sqlite"), "");
      fs.writeFileSync(path.join(flat, "places.sqlite"), "");
      fs.utimesSync(path.join(old, "places.sqlite"), new Date(1000000), new Date(1000000));
      fs.utimesSync(path.join(flat, "places.sqlite"), new Date(2000000), new Date(2000000));
      assert.strictEqual(zenProfile(home), flat);

      const empty = path.join(home, "empty-home");
      fs.mkdirSync(empty);
      assert.strictEqual(zenProfile(empty), "");
    })
  ));

check("zenProfile: ZEN_PROFILE wins when it has places.sqlite", () =>
  withTmp((home) => {
    const custom = path.join(home, "custom-profile");
    const scanned = path.join(home, ".zen", "newer.default");
    fs.mkdirSync(custom, { recursive: true });
    fs.mkdirSync(scanned, { recursive: true });
    fs.writeFileSync(path.join(custom, "places.sqlite"), "");
    fs.writeFileSync(path.join(scanned, "places.sqlite"), "");
    fs.utimesSync(path.join(scanned, "places.sqlite"), new Date(Date.now() + 60000), new Date(Date.now() + 60000));

    withEnv("ZEN_PROFILE", custom, () => assert.strictEqual(zenProfile(home), custom));
    // An invalid ZEN_PROFILE is ignored and the scan runs.
    withEnv("ZEN_PROFILE", path.join(home, "missing"), () =>
      assert.strictEqual(zenProfile(home), scanned)
    );
  }));

check("dbSignature changes when the DB or WAL changes", () =>
  withTmp((tmp) => {
    const places = path.join(tmp, "places.sqlite");
    const form = path.join(tmp, "formhistory.sqlite");
    fs.writeFileSync(places, "db");
    fs.writeFileSync(form, "fh");

    const first = dbSignature(places);
    assert.strictEqual(dbSignature(places), first);
    assert.ok(first.includes("places.sqlite:2:"));

    fs.writeFileSync(places, "db2");
    const afterDb = dbSignature(places);
    assert.notStrictEqual(afterDb, first);

    fs.writeFileSync(places + "-wal", "wal");
    const afterWal = dbSignature(places);
    assert.notStrictEqual(afterWal, afterDb);
    assert.ok(afterWal.includes("places.sqlite-wal:3:"));

    fs.writeFileSync(form, "fh2");
    assert.notStrictEqual(dbSignature(places), afterWal);
  }));

const hasSqlite = spawnSync("sqlite3", ["--version"], { encoding: "utf8" }).status === 0;
if (!hasSqlite) {
  console.log("  skip sqlite checks (sqlite3 not available)");
} else {
  check("bookmarks: http(s) only, dedup by url, max visits, first title", () =>
    withTmp((tmp) => {
      const db = path.join(tmp, "places.sqlite");
      execFileSync("sqlite3", [
        db,
        `CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, hidden INTEGER DEFAULT 0, visit_count INTEGER DEFAULT 0);
         CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, title TEXT);
         INSERT INTO moz_places VALUES (1, 'https://a.example/', 'A', 0, 7);
         INSERT INTO moz_places VALUES (2, 'https://hidden.example/', 'Hidden', 1, 99);
         INSERT INTO moz_places VALUES (3, 'ftp://files.example/', 'FTP', 0, 3);
         INSERT INTO moz_places VALUES (4, 'https://a.example/', '', 0, 9);
         INSERT INTO moz_places VALUES (5, 'https://b.example/', 'B', 0, 2);
         INSERT INTO moz_bookmarks VALUES (1, 1, 1, 'Bookmark A');
         INSERT INTO moz_bookmarks VALUES (2, 1, 2, NULL);
         INSERT INTO moz_bookmarks VALUES (3, 1, 3, NULL);
         INSERT INTO moz_bookmarks VALUES (4, 1, 1, NULL);
         INSERT INTO moz_bookmarks VALUES (5, 1, 4, NULL);
         INSERT INTO moz_bookmarks VALUES (6, 1, 5, 'Bookmark B');`,
      ]);
      assert.deepStrictEqual(bookmarks(db), [
        { title: "Bookmark A", url: "https://a.example/", visits: 9 },
        { title: "Bookmark B", url: "https://b.example/", visits: 2 },
      ]);
      assert.strictEqual(bookmarks(path.join(tmp, "missing.sqlite")), null);
    }));

  check("pages includes a row exactly at the watermark", () =>
    withTmp((tmp) => {
      const db = path.join(tmp, "places.sqlite");
      execFileSync("sqlite3", [
        db,
        `CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, hidden INTEGER DEFAULT 0);
         CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER);
         INSERT INTO moz_places VALUES (1, 'https://old.example/', 'Old', 0);
         INSERT INTO moz_places VALUES (2, 'https://edge.example/', 'Edge', 0);
         INSERT INTO moz_places VALUES (3, 'https://new.example/', 'New', 0);
         INSERT INTO moz_historyvisits VALUES (1, 1, 1000);
         INSERT INTO moz_historyvisits VALUES (2, 2, 2000);
         INSERT INTO moz_historyvisits VALUES (3, 3, 3000);`,
      ]);

      const atEdge = pages(db, 2000);
      assert.deepStrictEqual(atEdge.items.map((x) => x.url).sort(), [
        "https://edge.example/",
        "https://new.example/",
      ]);
      assert.strictEqual(atEdge.watermark, 3000);

      const atMax = pages(db, 3000);
      assert.deepStrictEqual(atMax.items.map((x) => x.url), ["https://new.example/"]);
      assert.strictEqual(atMax.watermark, 3000);
    }));

  check("searches includes a row exactly at the watermark", () =>
    withTmp((tmp) => {
      const db = path.join(tmp, "formhistory.sqlite");
      execFileSync("sqlite3", [
        db,
        `CREATE TABLE moz_formhistory (id INTEGER PRIMARY KEY, fieldname TEXT, value TEXT, lastUsed INTEGER);
         INSERT INTO moz_formhistory VALUES (1, 'searchbar-history', 'old term', 1000);
         INSERT INTO moz_formhistory VALUES (2, 'searchbar-history', 'edge term', 2000);
         INSERT INTO moz_formhistory VALUES (3, 'searchbar-history', 'new term', 3000);
         INSERT INTO moz_formhistory VALUES (4, 'other', 'ignored', 4000);`,
      ]);

      const atEdge = searches(db, "https://e.example/?q=", 2000);
      assert.deepStrictEqual(atEdge.items.map((x) => x.url), [
        "https://e.example/?q=new%20term",
        "https://e.example/?q=edge%20term",
      ]);
      assert.strictEqual(atEdge.watermark, 4000);
    }));
}

console.log(`\n${passed} checks passed`);
