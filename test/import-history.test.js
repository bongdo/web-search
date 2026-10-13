// Minimal assert-based checks for tools/import-history.js. Run: node test/import-history.test.js
const assert = require("assert");
const { mergeHistory, pages } = require("../tools/import-history.js");

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

console.log(`\n${passed} checks passed`);
