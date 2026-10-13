// Pure query logic for the web-search launcher provider.
// No Qt/QML dependencies: imported by LauncherProvider.qml and unit-tested with node.

var BUILTIN_ENGINES = {
    g:    { name: "Google",     url: "https://www.google.com/search?q=",                domain: "google",     suggest: "https://suggestqueries.google.com/complete/search?client=chrome&q=" },
    ddg:  { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=",                      domain: "duckduckgo", suggest: "https://duckduckgo.com/ac/?q=" },
    bing: { name: "Bing",       url: "https://www.bing.com/search?q=",                  domain: "bing",       suggest: "https://www.bing.com/osjson.aspx?query=" },
    brave:{ name: "Brave",      url: "https://search.brave.com/search?q=",              domain: "brave",      suggest: "https://search.brave.com/api/suggest?q=" },
    ya:   { name: "Yandex",     url: "https://yandex.com/search/?text=",                domain: "yandex",     suggest: "https://suggest.yandex.com/suggest-ya.cgi?v=4&part=" },
    y:    { name: "YouTube",    url: "https://www.youtube.com/results?search_query=",   domain: "youtube",    suggest: "https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q=" }
};

// Subset modifiers: restrict the pool to one kind of user data.
var SUBSETS = { h: "history", b: "bookmarks", sh: "shortcuts" };

// Action modifiers: full words that trigger a side effect on activation.
var ACTIONS = { bookmark: "bookmark" };

// Scores live on the launcher's normalized 0..1 scale, which is what built-in
// providers use (FuzzySort normalizes app matches to 0..1). Values > 1 always
// win over applications; fuzzy web matches stay below strong apps; the fallback
// search row is negative so it sits under everything else.
var SCORE = {
    // A `bookmark <url>` action outranks everything: it is an explicit command.
    bookmarkAction: 2.5,
    engineSearch: 2.0,
    directUrl: 2.0,
    urlTyped: 1.5,
    exactShortcut: 1.4,
    exactBookmark: 1.1,
    domain: 0.5,
    prefix: 0.45,
    substring: 0.3,
    suggestion: 0.2,
    fallbackSearch: -0.5,
    // History is launcher-local and less deliberate than a bookmark.
    historyExact: 0.75,
    historyDomain: 0.4,
    historyPrefix: 0.35,
    historySubstring: 0.25
};

function enginesFromSettings(list) {
    var map = {};
    if (!list || !list.length) {
        return map;
    }
    for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (e && e.key && e.url) {
            map[e.key] = {
                name: e.name || e.key,
                url: e.url,
                domain: e.domain || "",
                suggest: e.suggest || ""
            };
        }
    }
    return map;
}

function allEngines(customList) {
    var merged = {};
    for (var k in BUILTIN_ENGINES) {
        merged[k] = BUILTIN_ENGINES[k];
    }
    var custom = enginesFromSettings(customList);
    for (var c in custom) {
        merged[c] = custom[c];
    }
    return merged;
}

function stripCommand(text) {
    var t = (text || "").replace(/^\s+/, "");
    if (t.indexOf(">web") === 0) {
        return t.slice(4).replace(/^\s+/, "");
    }
    return t;
}

// Parse "<modifier> <query>" where modifier is an engine key or a subset key.
// The modifier is only recognized when followed by whitespace, so single-letter
// engine keys (g, y) do not shadow shortcuts typed without a trailing space.
function parseQuery(text, engines) {
    var raw = (text || "").replace(/^\s+/, "");
    if (raw.replace(/\s+$/, "") === "") {
        return { modifier: null, query: "" };
    }
    var m = /^(\S+)(\s+)([\s\S]*)$/.exec(raw);
    if (m) {
        var key = m[1].toLowerCase();
        var rest = m[3].replace(/^\s+/, "");
        if (engines && engines[key]) {
            return { modifier: { key: key, type: "engine", engine: engines[key] }, query: rest };
        }
        if (SUBSETS[key]) {
            return { modifier: { key: key, type: "subset", subset: SUBSETS[key] }, query: rest };
        }
        if (ACTIONS[key]) {
            return { modifier: { key: key, type: "action", action: ACTIONS[key] }, query: rest };
        }
    }
    return { modifier: null, query: raw.replace(/\s+$/, "") };
}

function hostOf(url) {
    var m = /^https?:\/\/([^\/]+)/i.exec(url || "");
    return m ? m[1].replace(/^.*@/, "").toLowerCase() : "";
}

function isUrl(text) {
    if (!text || text.indexOf(" ") !== -1) {
        return false;
    }
    if (/^[a-z0-9]+:\/\/\S+/i.test(text)) {
        return true;
    }
    if (/^localhost(\/\S*)?$/i.test(text)) {
        return true;
    }
    if (/^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(:[0-9]+)?(\/\S*)?$/.test(text)) {
        return true;
    }
    if (/^([a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,}(:[0-9]+)?(\/\S*)?$/i.test(text)) {
        return true;
    }
    if (/^[a-zA-Z0-9-]+:[0-9]+(\/\S*)?$/i.test(text)) {
        return true;
    }
    return false;
}

function normalizeUrl(text) {
    var t = (text || "").replace(/^\s+/, "").replace(/\s+$/, "");
    if (!t) {
        return "";
    }
    if (/^[a-z0-9]+:\/\/\S+/i.test(t)) {
        return t;
    }
    if (/^localhost(\/\S*)?$/i.test(t) || /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(:[0-9]+)?(\/\S*)?$/.test(t) || /^[a-zA-Z0-9-]+:[0-9]+(\/\S*)?$/i.test(t)) {
        return "http://" + t;
    }
    return "https://" + t;
}

function scoreBookmark(bookmark, q, poolDomain) {
    var title = (bookmark.title || "").toLowerCase();
    var url = (bookmark.url || "").toLowerCase();
    var host = hostOf(bookmark.url);

    if (poolDomain && url.indexOf(poolDomain) === -1) {
        return -1;
    }
    if (q === "") {
        return poolDomain ? SCORE.domain : SCORE.substring;
    }
    if (title === q) {
        return SCORE.exactBookmark;
    }
    if (q.length >= 3 && host.indexOf(q) === 0) {
        return SCORE.domain;
    }
    if (title.indexOf(q) === 0) {
        return SCORE.prefix;
    }
    if (title.indexOf(q) !== -1 || url.indexOf(q) !== -1) {
        return SCORE.substring;
    }
    return -1;
}

function scoreShortcut(shortcut, q, poolDomain) {
    var alias = (shortcut.alias || "").toLowerCase();
    var name = (shortcut.name || "").toLowerCase();
    var url = (shortcut.url || "").toLowerCase();
    var host = hostOf(shortcut.url);

    if (poolDomain && url.indexOf(poolDomain) === -1) {
        return -1;
    }
    if (q === "") {
        return poolDomain ? SCORE.domain : SCORE.substring;
    }
    if (alias === q) {
        return SCORE.exactShortcut;
    }
    if (alias.indexOf(q) === 0) {
        return SCORE.prefix;
    }
    if (name.indexOf(q) === 0) {
        return SCORE.prefix - 1;
    }
    if (q.length >= 3 && host.indexOf(q) === 0) {
        return SCORE.domain;
    }
    if (alias.indexOf(q) !== -1 || name.indexOf(q) !== -1 || url.indexOf(q) !== -1) {
        return SCORE.substring;
    }
    return -1;
}

function byVisitsThenTitle(a, b) {
    var va = a.visits || 0;
    var vb = b.visits || 0;
    if (va !== vb) {
        return vb - va;
    }
    return (a.title || a.alias || "").localeCompare(b.title || b.alias || "");
}

function scoreHistory(item, q, poolDomain) {
    var title = (item.title || "").toLowerCase();
    var url = (item.url || "").toLowerCase();
    var host = hostOf(item.url);

    if (poolDomain && url.indexOf(poolDomain) === -1) {
        return -1;
    }
    if (q === "") {
        return poolDomain ? SCORE.historyDomain : SCORE.historySubstring;
    }
    if (url === q || title === q) {
        return SCORE.historyExact;
    }
    if (q.length >= 3 && host.indexOf(q) === 0) {
        return SCORE.historyDomain;
    }
    if (title.indexOf(q) === 0) {
        return SCORE.historyPrefix;
    }
    if (title.indexOf(q) !== -1 || url.indexOf(q) !== -1) {
        return SCORE.historySubstring;
    }
    return -1;
}

// Core entry point. Returns plain descriptors; the QML layer attaches activation.
function getResults(opts) {
    var raw = stripCommand(opts.text || "");
    var engines = opts.engines || allEngines();
    var defaultKey = opts.defaultEngineKey && engines[opts.defaultEngineKey] ? opts.defaultEngineKey : "g";
    var parsed = parseQuery(raw, engines);
    var modifier = parsed.modifier;
    var query = parsed.query;
    var q = query.toLowerCase();

    var engine = modifier && modifier.type === "engine" ? modifier.engine : engines[defaultKey];
    var poolDomain = modifier && modifier.type === "engine" ? (engine.domain || "") : "";
    var subset = modifier && modifier.type === "subset" ? modifier.subset : null;

    // Plain empty input contributes nothing; subset/engine modifiers with an
    // empty query still list their pool ("b ", "sh ", "h ", "y ").
    if (raw === "") {
        return [];
    }

    // `bookmark <url>` is an action: the row is committed by the QML layer on
    // activation (nothing is written while the user is still typing).
    if (modifier && modifier.type === "action" && modifier.action === "bookmark") {
        var target = query.replace(/^["']+|["']+$/g, "");
        if (isUrl(target)) {
            var bookmarkUrl = normalizeUrl(target);
            return [{
                kind: "bookmark-add",
                id: "bookmark-add:" + bookmarkUrl,
                name: bookmarkUrl,
                description: bookmarkUrl,
                url: bookmarkUrl,
                faviconDomain: hostOf(bookmarkUrl),
                score: SCORE.bookmarkAction
            }];
        }
        // Not a URL: treat the remainder as an ordinary query.
        modifier = null;
    }

    var out = [];

    if (opts.directUrl && query !== "" && isUrl(query)) {
        out.push({
            kind: "url",
            id: "url:" + query,
            name: "Open " + normalizeUrl(query),
            description: "",
            url: normalizeUrl(query),
            faviconDomain: hostOf(normalizeUrl(query)),
            score: modifier || opts.isCommand ? SCORE.directUrl : SCORE.urlTyped
        });
    }

    var hasExact = false;

    if (subset === null || subset === "bookmarks") {
        var bms = opts.bookmarks || [];
        for (var i = 0; i < bms.length; i++) {
            var bs = scoreBookmark(bms[i], q, poolDomain);
            if (bs < 0) {
                continue;
            }
            if (bs === SCORE.exactBookmark) {
                hasExact = true;
            }
            out.push({
                kind: "bookmark",
                id: "bookmark:" + bms[i].url,
                name: bms[i].title || bms[i].url,
                description: bms[i].url,
                url: bms[i].url,
                faviconDomain: hostOf(bms[i].url),
                visits: bms[i].visits || 0,
                score: bs
            });
        }
    }

    if (subset === null || subset === "shortcuts") {
        var scs = opts.shortcuts || [];
        for (var j = 0; j < scs.length; j++) {
            var ss = scoreShortcut(scs[j], q, poolDomain);
            if (ss < 0) {
                continue;
            }
            if (ss === SCORE.exactShortcut) {
                hasExact = true;
            }
            out.push({
                kind: "shortcut",
                id: "shortcut:" + scs[j].alias,
                name: scs[j].name || scs[j].alias,
                description: scs[j].url,
                url: scs[j].url,
                faviconDomain: hostOf(scs[j].url),
                visits: 0,
                score: ss
            });
        }
    }

    if (subset === null || subset === "history") {
        var his = opts.history || [];
        for (var k = 0; k < his.length; k++) {
            var hs = scoreHistory(his[k], q, poolDomain);
            if (hs < 0) {
                continue;
            }
            out.push({
                kind: "history",
                id: "history:" + his[k].url,
                name: his[k].title || his[k].url,
                description: his[k].url,
                url: his[k].url,
                faviconDomain: hostOf(his[k].url),
                // Recency: most recent first when scores tie.
                visits: his.length - k,
                score: hs
            });
        }
    }

    // Subsets only filter user data; they never add a web-search row.
    var addSearchRow = subset === null && query !== "" && (!hasExact || modifier !== null);
    if (addSearchRow && engine) {
        var isExplicit = modifier !== null;
        out.push({
            kind: "search",
            id: "search:" + query,
            name: "Search " + engine.name,
            description: query,
            url: engine.url + encodeURIComponent(query),
            faviconDomain: hostOf(engine.url),
            score: isExplicit ? SCORE.engineSearch : SCORE.fallbackSearch
        });
    }

    // Final ranking: higher score first; ties broken by visit count then title.
    out.sort(function (a, b) {
        if (b.score !== a.score) {
            return b.score - a.score;
        }
        return byVisitsThenTitle(a, b);
    });

    // Subset listings are browsable, so they get a larger cap than a query.
    var limit = subset ? 50 : (opts.maxResults || 20);
    if (out.length > limit) {
        out = out.slice(0, limit);
    }
    return out;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        BUILTIN_ENGINES: BUILTIN_ENGINES,
        SUBSETS: SUBSETS,
        ACTIONS: ACTIONS,
        SCORE: SCORE,
        enginesFromSettings: enginesFromSettings,
        allEngines: allEngines,
        stripCommand: stripCommand,
        parseQuery: parseQuery,
        hostOf: hostOf,
        isUrl: isUrl,
        normalizeUrl: normalizeUrl,
        getResults: getResults
    };
}
