// Minimal assert-based checks for lib.js. Run: node test/lib.test.js
const assert = require("assert");
const L = require("../lib.js");

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

const engines = L.allEngines();
const data = {
  engines,
  defaultEngineKey: "ddg",
  directUrl: true,
  maxResults: 20,
  bookmarks: [
    { title: "Arch Wiki", url: "https://wiki.archlinux.org", visits: 5 },
    { title: "YouTube History", url: "https://www.youtube.com/feed/history", visits: 1 },
    { title: "GitHub", url: "https://github.com", visits: 2 }
  ],
  shortcuts: [
    { alias: "ma", name: "Yandex Market", url: "https://market.yandex.ru/" },
    { alias: "yh", name: "YouTube History", url: "https://www.youtube.com/feed/history" }
  ],
  history: [
    { title: "Recently Opened", url: "https://recent.example.com", ts: 2 },
    { title: "Old Page", url: "https://old.example.com", ts: 1 }
  ]
};
function run(text, extra) {
  return L.getResults(Object.assign({}, data, extra, { text }));
}

check("stripCommand removes >web", () => {
  assert.strictEqual(L.stripCommand(">web cats"), "cats");
  assert.strictEqual(L.stripCommand("cats"), "cats");
});

check("engine modifier parsed with y and ya", () => {
  const y = L.parseQuery("y cats", engines);
  assert.strictEqual(y.modifier.type, "engine");
  assert.strictEqual(y.modifier.key, "y");
  assert.strictEqual(y.query, "cats");
  assert.strictEqual(L.parseQuery("ya dogs", engines).modifier.engine.name, "Yandex");
});

check("subset modifier parsed with b and sh", () => {
  assert.strictEqual(L.parseQuery("b wiki", engines).modifier.subset, "bookmarks");
  assert.strictEqual(L.parseQuery("sh ma", engines).modifier.subset, "shortcuts");
  assert.strictEqual(L.parseQuery("h foo", engines).modifier.subset, "history");
});

check("trailing space after a subset lists its pool", () => {
  const b = run("b ");
  assert.ok(b.length > 0 && b.every((x) => x.kind === "bookmark"));
  const h = run("h ");
  assert.ok(h.length > 0 && h.every((x) => x.kind === "history"));
});

check("history subset is ordered most-recent-first", () => {
  const h = run("h ");
  assert.strictEqual(h[0].url, "https://recent.example.com");
  assert.strictEqual(h[1].url, "https://old.example.com");
});

check("history shows in default results and filters under h", () => {
  assert.ok(run("recent").some((x) => x.kind === "history"));
  assert.ok(run("h recent").every((x) => x.kind === "history"));
});

check("empty input contributes nothing", () => {
  assert.strictEqual(run("").length, 0);
});

check("bare engine key is not a modifier", () => {
  assert.strictEqual(L.parseQuery("g", engines).modifier, null);
  assert.strictEqual(L.parseQuery("g", engines).query, "g");
});

check("exact shortcut floats and suppresses web-search row", () => {
  const r = run("ma");
  assert.strictEqual(r[0].kind, "shortcut");
  assert.strictEqual(r[0].url, "https://market.yandex.ru/");
  assert.ok(!r.some((x) => x.kind === "search"));
});

check("engine modifier filters pool by domain and puts search on top", () => {
  const r = run("y history");
  assert.strictEqual(r[0].kind, "search");
  assert.ok(r[0].url.startsWith("https://www.youtube.com/results?search_query="));
  assert.ok(r.slice(1).every((x) => x.url.includes("youtube")));
});

check("fallback query yields a single low-priority search row", () => {
  const r = run("zzz nothing");
  assert.strictEqual(r[0].kind, "search");
  assert.strictEqual(r[0].score, L.SCORE.fallbackSearch);
});

check("subset sh returns only shortcuts and no search row", () => {
  const r = run("sh you");
  assert.ok(r.every((x) => x.kind === "shortcut"));
  assert.ok(!r.some((x) => x.kind === "search"));
});

check("subset b returns only bookmarks", () => {
  const r = run("b wiki");
  assert.strictEqual(r[0].kind, "bookmark");
  assert.ok(r.every((x) => x.kind === "bookmark"));
});

check("domain query matches bookmark by host", () => {
  const r = run("arch");
  assert.strictEqual(r[0].kind, "bookmark");
  assert.strictEqual(r[0].url, "https://wiki.archlinux.org");
});

check("bookmark exact title beats prefix matches", () => {
  const r = run("github");
  assert.strictEqual(r[0].url, "https://github.com");
});

check("direct URL detected and normalized", () => {
  assert.ok(L.isUrl("github.com/noctalia-dev"));
  assert.strictEqual(L.normalizeUrl("github.com"), "https://github.com");
  assert.strictEqual(L.normalizeUrl("localhost:3000"), "http://localhost:3000");
  const r = run("localhost:3000");
  assert.strictEqual(r[0].kind, "url");
});

check("typed URL ranks above domain matches", () => {
  const r = run("github.com");
  assert.strictEqual(r[0].kind, "url");
  assert.strictEqual(r[0].score, L.SCORE.urlTyped);
});

check("results carry a favicon domain", () => {
  assert.strictEqual(run("arch")[0].faviconDomain, "wiki.archlinux.org");
  assert.strictEqual(run("y cats")[0].faviconDomain, "www.youtube.com");
});

check("scores interoperate with normalized 0..1 app scores", () => {
  assert.ok(L.SCORE.fallbackSearch < 0, "fallback search must sit below applications");
  assert.ok(L.SCORE.substring < 1 && L.SCORE.prefix < 1 && L.SCORE.domain < 1, "fuzzy matches must not outrank strong apps");
  assert.ok(L.SCORE.engineSearch > 1 && L.SCORE.exactShortcut > 1 && L.SCORE.urlTyped > 1, "explicit results must win over apps");
});

check("maxResults caps output", () => {
  const r = run("", { maxResults: 2 });
  assert.ok(r.length <= 2);
});

check("bookmark action parses as an action modifier", () => {
  const p = L.parseQuery("bookmark https://example.com", engines);
  assert.strictEqual(p.modifier.type, "action");
  assert.strictEqual(p.modifier.action, "bookmark");
  assert.strictEqual(p.query, "https://example.com");
});

check("bookmark action returns a single add row for a URL", () => {
  const r = run("bookmark example.com");
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].kind, "bookmark-add");
  assert.strictEqual(r[0].url, "https://example.com");
  assert.strictEqual(r[0].score, L.SCORE.bookmarkAction);
});

check("bookmark action strips surrounding quotes", () => {
  assert.strictEqual(run('bookmark "https://example.com"')[0].url, "https://example.com");
});

check("bookmark with a non-URL falls through to a normal query", () => {
  const r = run("bookmark manager");
  assert.ok(!r.some((x) => x.kind === "bookmark-add"));
  assert.ok(r.some((x) => x.kind === "search"));
});

console.log("\n" + passed + " checks passed" + (process.exitCode ? ", some failed" : ""));
