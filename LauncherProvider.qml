import QtQuick
import Quickshell.Io
import qs.Commons
import "lib.js" as Lib

Item {
    id: root

    property var pluginApi: null
    property var launcher: null
    property string name: "Web Search"

    // Participate in the global launcher search (no ">" required).
    property bool handleSearch: true
    property string supportedLayouts: "list"
    property bool trackUsage: true

    // Lazily loaded user data
    property var engines: ({})
    property var bookmarks: []
    property var shortcuts: []
    property var history: []
    property string defaultEngineKey: "ddg"
    property bool directUrl: true
    property bool showSuggestions: true
    property bool favicons: true
    property int maxResults: 8

    property var suggestions: []
    property string lastQuery: ""

    // Favicons are downloaded to disk (cache/favicons) with curl and loaded
    // from there. A bundled, theme-independent magnifier is shown until the
    // icon is available, and kept forever if the download fails.
    property var faviconCache: ({})
    property var faviconFailed: ({})
    property var faviconPending: ({})
    property bool faviconSeeded: false
    property int imageRevision: 0

    function cfgValue(key, fallback) {
        var settings = pluginApi?.pluginSettings || ({});
        var defaults = pluginApi?.manifest?.metadata?.defaultSettings || ({});
        return settings[key] ?? defaults[key] ?? fallback;
    }

    function init() {
        loadData();
    }

    function onOpened() {
        loadData();
    }

    function loadData() {
        engines = Lib.allEngines(cfgValue("engines", []));
        bookmarks = cfgValue("bookmarks", []);
        shortcuts = cfgValue("shortcuts", []);
        history = cfgValue("history", []);
        defaultEngineKey = cfgValue("search_engine", "ddg");
        directUrl = cfgValue("direct_url", true);
        showSuggestions = cfgValue("show_suggestions", true);
        favicons = cfgValue("favicons", true);
        maxResults = cfgValue("max_results", 8);
        lastQuery = "";
        suggestions = [];
        if (favicons && !faviconSeeded && cacheDir() !== "") {
            faviconSeeded = true;
            faviconList.running = true;
        }
    }

    function handleCommand(searchText) {
        return searchText.startsWith(">web");
    }

    function commands() {
        return [{
            "name": pluginApi?.tr("launcher.command.name"),
            "description": pluginApi?.tr("launcher.command.description"),
            "icon": "world",
            "isTablerIcon": true,
            "isImage": false,
            "onActivate": function () {
                launcher.setSearchText(">web ");
            }
        }];
    }

    // Active engine + effective query for the current input.
    function contextFor(searchText) {
        var parsed = Lib.parseQuery(Lib.stripCommand(searchText), engines);
        var engine = parsed.modifier && parsed.modifier.type === "engine"
            ? parsed.modifier.engine
            : (engines[defaultEngineKey] || Lib.BUILTIN_ENGINES.g);
        return { engine: engine, query: parsed.query };
    }

    function iconFor(kind) {
        if (kind === "url") return "link";
        if (kind === "bookmark") return "bookmark";
        if (kind === "shortcut") return "bolt";
        if (kind === "history") return "history";
        if (kind === "suggestion") return "search";
        return "world";
    }

    function cacheDir() {
        return pluginApi ? pluginApi.pluginDir + "/cache/favicons" : "";
    }

    function faviconFile(domain) {
        return cacheDir() + "/" + domain.replace(/[^a-z0-9.-]/g, "_") + ".png";
    }

    function faviconUrl(domain) {
        return "https://www.google.com/s2/favicons?sz=64&domain=" + encodeURIComponent(domain);
    }

    function magnifierUrl() {
        return pluginApi ? "file://" + pluginApi.pluginDir + "/assets/search.png" : "";
    }

    function imageUrlFor(domain) {
        if (!favicons || !domain) {
            return "";
        }
        var cached = faviconCache[domain];
        return cached !== undefined ? cached : magnifierUrl();
    }

    // Download once per domain into the on-disk cache (or reuse the existing
    // file); the local magnifier stays until the file is ready.
    function ensureFavicon(domain) {
        if (!domain || faviconCache[domain] !== undefined || faviconFailed[domain] || faviconPending[domain]) {
            return;
        }
        faviconPending[domain] = true;
        Qt.callLater(function () {
            var proc = faviconDownloader.createObject(root, {
                "domain": domain,
                "destPath": faviconFile(domain)
            });
            if (proc) {
                proc.running = true;
            }
        });
    }

    function seedFaviconCache(listing) {
        var dir = cacheDir();
        var lines = (listing || "").split("\n");
        for (var i = 0; i < lines.length; i++) {
            var name = lines[i].replace(/^\s+|\s+$/g, "");
            if (name.length > 4 && name.slice(-4) === ".png") {
                faviconCache[name.slice(0, -4)] = dir + "/" + name;
            }
        }
        imageRevision++;
    }

    // The launcher renders images through isImage and overlays a small format
    // badge built from description.split(" • ")[0]. Prefixing "WEB • " keeps
    // that badge short and the subtitle informative (same idea as clipboard).
    function subtitle(description) {
        return favicons && description ? "WEB • " + description : description;
    }

    function toEntry(item) {
        var domain = item.faviconDomain || "";
        var withIcon = domain !== "" && favicons;
        return {
            "name": item.name,
            "description": subtitle(item.description),
            // Icon shown when the image cannot be loaded at all (and while it
            // loads, if imagePath is empty). With favicons on, keep a neutral
            // magnifier; with favicons off, keep the per-kind icon.
            "icon": withIcon ? "search" : iconFor(item.kind),
            "isTablerIcon": true,
            "isImage": withIcon,
            "faviconDomain": domain,
            "_score": item.score,
            "usageKey": item.url,
            "provider": root,
            "onActivate": function () {
                openUrl(item.url, item.name, item.kind);
            }
        };
    }

    // Called by the launcher delegate when a result becomes visible.
    function prepareItem(item) {
        if (favicons && item && item.faviconDomain) {
            ensureFavicon(item.faviconDomain);
        }
    }

    function getImageUrl(item) {
        if (!item || !favicons) {
            return "";
        }
        var domain = item.faviconDomain || "";
        return domain ? imageUrlFor(domain) : magnifierUrl();
    }

    function getResults(searchText) {
        var ctx = contextFor(searchText);
        var items = Lib.getResults({
            text: searchText,
            engines: engines,
            defaultEngineKey: defaultEngineKey,
            bookmarks: bookmarks,
            shortcuts: shortcuts,
            history: history,
            directUrl: directUrl,
            maxResults: maxResults
        });

        maybeFetchSuggestions(ctx, searchText);

        var results = items.map(toEntry);
        for (var i = 0; i < suggestions.length; i++) {
            results.push(suggestionEntry(suggestions[i], ctx));
        }
        return results;
    }

    function suggestionEntry(text, ctx) {
        var domain = Lib.hostOf(ctx.engine.url);
        return {
            "name": text,
            "description": subtitle(pluginApi?.tr("launcher.suggestion", { engine: ctx.engine.name })),
            "icon": "search",
            "isTablerIcon": true,
            "isImage": favicons && domain !== "",
            "faviconDomain": domain,
            "_score": Lib.SCORE.suggestion - suggestions.indexOf(text) * 0.01,
            "provider": root,
            "onActivate": function () {
                openUrl(ctx.engine.url + encodeURIComponent(text), text, "search");
            }
        };
    }

    function maybeFetchSuggestions(ctx, searchText) {
        var query = ctx.query;
        if (!showSuggestions || query === lastQuery || query.length < 2 || !ctx.engine.suggest) {
            return;
        }
        lastQuery = query;
        suggestions = [];
        fetchSuggestions(query, ctx.engine.suggest);
    }

    function fetchSuggestions(query, suggestUrl) {
        var xhr = new XMLHttpRequest();
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== XMLHttpRequest.DONE || xhr.status !== 200) {
                return;
            }
            if (query !== lastQuery) {
                return;
            }
            try {
                var data = JSON.parse(xhr.responseText);
                if (Array.isArray(data) && data.length > 0) {
                    if (typeof data[0] === "object" && data[0].phrase !== undefined) {
                        // DuckDuckGo: [{"phrase": "..."}, ...]
                        suggestions = data.map(function (item) { return item.phrase; }).slice(0, maxResults);
                    } else if (data.length > 1 && Array.isArray(data[1])) {
                        // Google / Bing / Yandex: ["query", ["s1", "s2"]]
                        suggestions = data[1].slice(0, maxResults);
                    }
                    if (launcher) {
                        launcher.updateResults();
                    }
                }
            } catch (e) {
                Logger.e("WebSearch", "Suggestion parse error: " + e);
            }
        };
        xhr.open("GET", suggestUrl + encodeURIComponent(query));
        xhr.send();
    }

    function openUrl(url, title, kind) {
        if (!url) {
            return;
        }
        if (kind !== "search" && kind !== "suggestion") {
            recordHistory(url, title);
        }
        Qt.openUrlExternally(url);
        if (launcher) {
            launcher.close();
        }
    }

    // Launcher-local history (no browser DB): pages opened through the plugin.
    function recordHistory(url, title) {
        if (!pluginApi || !url) {
            return;
        }
        var list = (pluginApi.pluginSettings.history || []).filter(function (h) {
            return h.url !== url;
        });
        list.unshift({ "title": title || url, "url": url, "ts": Date.now() });
        // Keep in sync with TOTAL_LIMIT in tools/import-history.js.
        if (list.length > 5000) {
            list = list.slice(0, 5000);
        }
        pluginApi.pluginSettings.history = list;
        pluginApi.saveSettings();
        history = list;
    }

    // Populates the in-memory cache from the on-disk favicon cache.
    Process {
        id: faviconList
        command: ["sh", "-c", "ls -1 '" + root.cacheDir() + "' 2>/dev/null"]
        stdout: StdioCollector {
            id: faviconListStdout
        }
        onExited: root.seedFaviconCache(String(faviconListStdout.text || ""))
    }

    // One-shot downloader: reuses the cached file if present, otherwise curls
    // the favicon into the cache. On success the result switches from the
    // magnifier to the site icon.
    Component {
        id: faviconDownloader

        Process {
            property string domain
            property string destPath
            command: ["sh", "-c", "mkdir -p '" + root.cacheDir() + "' && { [ -f '" + destPath + "' ] || curl -fsSL --max-time 8 -o '" + destPath + "' '" + root.faviconUrl(domain) + "'; }"]

            onExited: (code) => {
                if (code === 0) {
                    root.faviconCache[domain] = destPath;
                    root.imageRevision++;
                } else {
                    root.faviconFailed[domain] = true;
                }
                root.faviconPending[domain] = false;
                destroy();
            }
        }
    }
}
