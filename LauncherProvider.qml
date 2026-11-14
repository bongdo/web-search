import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Services.UI
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
    // `bookmarks` is the merged search pool: launcher bookmarks (selfBookmarks,
    // in settings.json) plus any imported from the tool-owned history.json.
    property var bookmarks: []
    property var selfBookmarks: []
    property var importedBookmarks: []
    // `shortcuts` is the merged view: plugin settings plus the live
    // ~/.config/ww/shortcuts.json and ~/.bookmarks sources.
    property var shortcuts: []
    property var selfShortcuts: []
    property var externalShortcuts: []
    // `history` is the merged view used by search: pages the launcher recorded
    // (selfHistory, in settings.json) plus the Zen import (importedHistory,
    // from the tool-owned history.json).
    property var selfHistory: []
    property var importedHistory: []
    property var history: []
    property bool syncingHistory: false
    // Live Zen bookmarks, read straight from places.sqlite. Kept separate
    // from the tool-owned history.json import so a broken/absent Node sync
    // never hides a bookmark the user just added.
    property var browserBookmarks: []
    property bool browserSyncing: false
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
        selfBookmarks = cfgValue("bookmarks", []);
        rebuildBookmarks();
        selfShortcuts = cfgValue("shortcuts", []);
        rebuildShortcuts();
        selfHistory = cfgValue("history", []);
        rebuildHistory();
        defaultEngineKey = cfgValue("search_engine", "ddg");
        directUrl = cfgValue("direct_url", true);
        showSuggestions = cfgValue("show_suggestions", true);
        favicons = cfgValue("favicons", true);
        var configuredResults = Math.round(Number(cfgValue("max_results", 8)));
        maxResults = isFinite(configuredResults) ? Math.min(20, Math.max(1, configuredResults)) : 8;
        lastQuery = "";
        suggestions = [];
        if (favicons && !faviconSeeded && cacheDir() !== "") {
            faviconSeeded = true;
            faviconList.running = true;
        }
        // Show the last import immediately, then top it up with a fresh diff.
        refreshImportedHistory();
        refreshBrowserBookmarks();
        refreshExternalShortcuts();
        startHistorySync();
        externalRefresh.restart();
    }

    function historyFile() {
        return pluginApi ? pluginApi.pluginDir + "/history.json" : "";
    }

    function historyScript() {
        return pluginApi ? pluginApi.pluginDir + "/tools/import-history.js" : "";
    }

    // Live shortcut sources override the copy migrated into plugin settings,
    // so adding/editing a shortcut in ww or ~/.bookmarks needs no migration.
    function rebuildShortcuts() {
        shortcuts = Lib.mergeShortcuts([selfShortcuts, externalShortcuts]);
    }

    function refreshExternalShortcuts() {
        externalShortcutsReader.running = true;
    }

    // Merge self-recorded and imported history into one newest-first list.
    function rebuildHistory() {
        var byUrl = ({});
        var lists = [selfHistory, importedHistory];
        for (var i = 0; i < lists.length; i++) {
            for (var j = 0; j < lists[i].length; j++) {
                var e = lists[i][j];
                if (!e || !e.url) {
                    continue;
                }
                var ts = e.ts || 0;
                var prev = byUrl[e.url];
                if (!prev || ts > (prev.ts || 0)) {
                    byUrl[e.url] = { "title": e.title || e.url, "url": e.url, "ts": ts };
                }
            }
        }
        var out = [];
        for (var url in byUrl) {
            out.push(byUrl[url]);
        }
        out.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
        history = out;
    }

    // Merge local and imported bookmarks by URL; local titles win and visits
    // are the max from either source.
    function rebuildBookmarks() {
        var byUrl = ({});
        var lists = [importedBookmarks, selfBookmarks, browserBookmarks];
        for (var i = 0; i < lists.length; i++) {
            for (var j = 0; j < lists[i].length; j++) {
                var e = lists[i][j];
                if (!e || !e.url) {
                    continue;
                }
                var visits = Number(e.visits) || 0;
                var prev = byUrl[e.url];
                if (!prev) {
                    byUrl[e.url] = { "title": e.title || e.url, "url": e.url, "visits": visits };
                    continue;
                }
                if (e.title) {
                    prev.title = e.title;
                }
                prev.visits = Math.max(prev.visits || 0, visits);
            }
        }
        var out = [];
        for (var url in byUrl) {
            out.push(byUrl[url]);
        }
        out.sort(function (a, b) {
            if ((a.visits || 0) !== (b.visits || 0)) {
                return (b.visits || 0) - (a.visits || 0);
            }
            return (a.title || "").localeCompare(b.title || "");
        });
        bookmarks = out;
    }

    function applyImportedData(raw) {
        var data = null;
        try {
            data = JSON.parse(raw || "");
        } catch (e) {
            Logger.w("WebSearch", "history.json parse error: " + e);
            return;
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            Logger.w("WebSearch", "history.json has an unexpected shape; keeping the previous import");
            return;
        }
        var hasItems = Array.isArray(data.items);
        var hasBookmarks = Array.isArray(data.bookmarks);
        if ((data.items !== undefined && !hasItems) || (data.bookmarks !== undefined && !hasBookmarks) || (!hasItems && !hasBookmarks)) {
            Logger.w("WebSearch", "history.json has no valid items/bookmarks; keeping the previous import");
            return;
        }
        if (hasItems) {
            importedHistory = data.items;
        }
        if (hasBookmarks) {
            importedBookmarks = data.bookmarks;
        }
        rebuildHistory();
        rebuildBookmarks();
        Logger.i("WebSearch", "Imported " + importedHistory.length + " history entries and " + importedBookmarks.length + " bookmarks");
        if (launcher) {
            launcher.updateResults();
        }
    }

    function refreshImportedHistory() {
        // Read with a Process instead of FileView: the import tool writes
        // history.json with tmp+rename, and FileView keeps watching the old
        // inode after that. A fresh cat always sees the current file.
        if (!pluginApi || historyFile() === "") {
            return;
        }
        importedReader.command = ["cat", historyFile()];
        importedReader.running = true;
    }

    function shellQuote(s) {
        return "'" + String(s).replace(/'/g, "'\\''") + "'";
    }

    // The tool is incremental, so a diff is cheap enough to run on every open.
    // node is not on the shell's PATH; probe the usual spots, then PATH.
    function refreshBrowserBookmarks() {
        if (!pluginApi || browserSyncing) {
            return;
        }
        browserSyncing = true;
        browserBookmarksProcess.running = true;
    }

    // Newest Zen/Firefox places.sqlite, then one row per bookmarked URL. The
    // same DB is used by the Node history importer, but bookmarks must not
    // depend on node being present in the shell's PATH.
    function browserBookmarkCommand() {
        var sql = "SELECT (SELECT b.title FROM moz_bookmarks b "
            + "WHERE b.fk = p.id AND b.type = 1 AND b.title IS NOT NULL AND trim(b.title) <> '' "
            + "ORDER BY b.dateAdded DESC LIMIT 1) AS title, "
            + "p.url AS url, p.visit_count AS visits "
            + "FROM moz_places p "
            + "WHERE p.url LIKE 'http%' "
            + "AND EXISTS (SELECT 1 FROM moz_bookmarks b WHERE b.fk = p.id AND b.type = 1) "
            + "ORDER BY p.visit_count DESC";
        return "db=$(find \"$HOME/.zen\" \"$HOME/.mozilla/firefox\" -maxdepth 2 -name places.sqlite -printf '%T@ %p\\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-); "
            + "[ -n \"$db\" ] || exit 3; "
            + "sqlite3 -json -readonly \"file:$db?immutable=1\" " + shellQuote(sql);
    }

    function startHistorySync() {
        if (!pluginApi) {
            return;
        }
        // A Process that never emits exited (for example an empty command at
        // init time) would otherwise leave the flag set forever.
        if (syncingHistory && !historySync.running) {
            syncingHistory = false;
        }
        if (syncingHistory) {
            return;
        }
        syncingHistory = true;
        historySync.running = true;
        syncWatchdog.restart();
    }

    function syncCommand() {
        return "n=\"$HOME/.local/bin/node\"; "
            + "[ -x \"$n\" ] || n=\"$HOME/.hermes/node/bin/node\"; "
            + "[ -x \"$n\" ] || n=\"$HOME/.nix-profile/bin/node\"; "
            + "[ -x \"$n\" ] || n=\"/etc/profiles/per-user/$USER/bin/node\"; "
            + "[ -x \"$n\" ] || n=\"/run/current-system/sw/bin/node\"; "
            + "[ -x \"$n\" ] || n=\"$(command -v node 2>/dev/null)\"; "
            + "if [ ! -x \"$n\" ]; then "
            + "echo 'web-search: node not found; checked $HOME/.local/bin, $HOME/.hermes/node/bin, $HOME/.nix-profile/bin, /etc/profiles/per-user/$USER/bin, /run/current-system/sw/bin and PATH' >&2; "
            + "exit 127; fi; "
            + "exec \"$n\" " + shellQuote(historyScript()) + " --data-dir " + shellQuote(pluginApi ? pluginApi.pluginDir : "");
    }

    function handleCommand(searchText) {
        return /^>web(?:\s|$)/.test(searchText);
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
            : (engines[defaultEngineKey] || engines.ddg || Lib.BUILTIN_ENGINES.g);
        var action = parsed.modifier && parsed.modifier.type === "action" ? parsed.modifier.action : null;
        var subset = parsed.modifier && parsed.modifier.type === "subset" ? parsed.modifier.subset : null;
        return { engine: engine, query: parsed.query, action: action, subset: subset };
    }

    function iconFor(kind) {
        if (kind === "url") return "link";
        if (kind === "bookmark-add") return "bookmark";
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
            "name": item.kind === "bookmark-add"
                ? pluginApi?.tr("launcher.bookmarkAdd", { "url": item.url })
                : item.name,
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
                if (item.kind === "bookmark-add") {
                    addBookmark(item.url);
                } else {
                    openUrl(item.url, item.name, item.kind);
                }
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
        void root.imageRevision;
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

        if (ctx.action || ctx.subset) {
            suggestions = [];
        } else {
            maybeFetchSuggestions(ctx, searchText);
        }

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
        xhr.timeout = 8000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== XMLHttpRequest.DONE) {
                return;
            }
            if (query !== lastQuery) {
                return;
            }
            if (xhr.status !== 200) {
                Logger.w("WebSearch", "Suggestion request failed: HTTP " + xhr.status);
                return;
            }
            try {
                var parsed = Lib.parseSuggestions(JSON.parse(xhr.responseText));
                suggestions = (parsed || []).slice(0, maxResults);
                if (launcher) {
                    launcher.updateResults();
                }
            } catch (e) {
                Logger.w("WebSearch", "Suggestion parse error: " + e);
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
        selfHistory = list;
        rebuildHistory();
    }

    // `bookmark <url>`: title comes from history/bookmarks if the page is
    // already known, otherwise from the page's <title> (network), else the URL.
    function toast(summary, body) {
        if (typeof ToastService !== "undefined") {
            ToastService.showNotice(summary, body, "bookmark");
        }
    }

    function knownTitle(url) {
        var lists = [bookmarks, history];
        for (var i = 0; i < lists.length; i++) {
            for (var j = 0; j < lists[i].length; j++) {
                if (lists[i][j].url === url && lists[i][j].title) {
                    return lists[i][j].title;
                }
            }
        }
        return "";
    }

    function addBookmark(url) {
        if (!pluginApi || !url) {
            return;
        }
        // Only the plugin's own list is checked here: a Zen bookmark is imported
        // automatically, but an explicit `bookmark <url>` should persist locally.
        var own = pluginApi.pluginSettings.bookmarks || [];
        for (var i = 0; i < own.length; i++) {
            if (own[i].url === url) {
                if (launcher) {
                    launcher.close();
                }
                toast(pluginApi.tr("launcher.bookmarkExists"), url);
                return;
            }
        }
        var title = knownTitle(url) || url;
        var fresh = own.slice();
        fresh.unshift({ "title": title, "url": url, "visits": 0 });
        pluginApi.pluginSettings.bookmarks = fresh;
        selfBookmarks = fresh;
        rebuildBookmarks();
        pluginApi.saveSettings();
        if (launcher) {
            launcher.close();
        }
        toast(pluginApi.tr("launcher.bookmarkAdded"), title);
        if (title === url) {
            fetchTitle(url, function (fetched) {
                updateBookmarkTitle(url, fetched);
            });
        }
    }

    function updateBookmarkTitle(url, title) {
        if (!title || !pluginApi) {
            return;
        }
        var list = pluginApi.pluginSettings.bookmarks || [];
        var changed = false;
        for (var i = 0; i < list.length; i++) {
            if (list[i].url === url && list[i].title === url) {
                list[i].title = title;
                changed = true;
            }
        }
        if (changed) {
            selfBookmarks = list;
            rebuildBookmarks();
            pluginApi.saveSettings();
        }
    }

    function parseTitle(html) {
        var m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || "");
        if (!m) {
            return "";
        }
        return m[1]
            .replace(/\s+/g, " ")
            .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
            .replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
            .replace(/^\s+|\s+$/g, "")
            .slice(0, 300);
    }

    function fetchTitle(url, callback) {
        var proc = titleFetcher.createObject(root, { "url": url, "callback": callback });
        if (proc) {
            proc.running = true;
        }
    }

    // Populates the in-memory cache from the on-disk favicon cache.
    Process {
        id: faviconList
        command: ["sh", "-c", "ls -1 " + root.shellQuote(root.cacheDir()) + " 2>/dev/null"]
        stdout: StdioCollector {
            id: faviconListStdout
        }
        onExited: root.seedFaviconCache(String(faviconListStdout.text || ""))
    }

    // Reads the tool-owned Zen import (history.json) and merges it in.
    // This is a Process, not FileView: the importer replaces the file with an
    // atomic rename, so a watcher on the old inode would go stale.
    Process {
        id: importedReader
        command: ["cat", root.historyFile()]
        stdout: StdioCollector {
            id: importedReaderStdout
        }
        onExited: (code) => {
            if (code !== 0) {
                Logger.w("WebSearch", "Could not read " + root.historyFile() + " (cat exit " + code + ")");
                return;
            }
            root.applyImportedData(String(importedReaderStdout.text || ""));
        }
    }

    // Reads the two live shortcut sources on every open. They are the same
    // files the zsh web helper and clilauncher use, so a shortcut added there
    // shows up here without running tools/migrate.js.
    Process {
        id: externalShortcutsReader
        command: ["sh", "-c", "echo '@@BOOKMARKS@@'; cat \"$HOME/.bookmarks\" 2>/dev/null; echo '@@WW@@'; cat \"${XDG_CONFIG_HOME:-$HOME/.config}/ww/shortcuts.json\" 2>/dev/null; true"]
        stdout: StdioCollector {
            id: externalShortcutsStdout
        }
        onExited: (code) => {
            if (code !== 0) {
                Logger.w("WebSearch", "Shortcut sync failed (exit " + code + ")");
                return;
            }
            var text = String(externalShortcutsStdout.text || "");
            var bookmarksAt = text.indexOf("@@BOOKMARKS@@");
            var wwAt = text.indexOf("@@WW@@");
            var bookmarksText = bookmarksAt >= 0 ? text.slice(bookmarksAt + 13, wwAt >= 0 ? wwAt : text.length) : "";
            var wwText = wwAt >= 0 ? text.slice(wwAt + 6) : "";
            var wwItems = [];
            if (wwText.replace(/^\s+|\s+$/g, "") !== "") {
                try {
                    var parsed = JSON.parse(wwText);
                    if (Array.isArray(parsed)) {
                        wwItems = parsed;
                    }
                } catch (e) {
                    Logger.w("WebSearch", "ww shortcuts JSON parse error: " + e);
                }
            }
            // ~/.bookmarks wins over ww on the same alias, matching clilauncher.
            root.externalShortcuts = Lib.mergeShortcuts([wwItems, Lib.parseBookmarksFile(bookmarksText)]);
            root.rebuildShortcuts();
            Logger.d("WebSearch", "External shortcuts: " + root.externalShortcuts.length);
            if (root.launcher) {
                root.launcher.updateResults();
            }
        }
    }

    // Reads browser bookmarks directly. One sqlite3 query per launcher open;
    // the result is merged ahead of the stale history.json/self lists.
    Process {
        id: browserBookmarksProcess
        command: ["sh", "-c", root.browserBookmarkCommand()]
        stdout: StdioCollector {
            id: browserBookmarksStdout
        }
        stderr: StdioCollector {
            id: browserBookmarksStderr
        }
        onExited: (code) => {
            root.browserSyncing = false;
            if (code !== 0) {
                Logger.w("WebSearch", "Browser bookmark import failed (exit " + code + "): " + String(browserBookmarksStderr.text || ""));
                return;
            }
            var rows = [];
            var text = String(browserBookmarksStdout.text || "").replace(/^\s+|\s+$/g, "");
            if (text !== "") {
                try {
                    rows = JSON.parse(text);
                } catch (e) {
                    Logger.w("WebSearch", "Browser bookmark JSON parse error: " + e);
                    return;
                }
            }
            if (!Array.isArray(rows)) {
                return;
            }
            var byUrl = ({});
            for (var i = 0; i < rows.length; i++) {
                var row = rows[i];
                if (!row || typeof row.url !== "string") {
                    continue;
                }
                var url = row.url.replace(/^\s+|\s+$/g, "");
                if (!/^https?:\/\//i.test(url)) {
                    continue;
                }
                var title = typeof row.title === "string" ? row.title.replace(/^\s+|\s+$/g, "") : "";
                var visits = Number(row.visits) || 0;
                var prev = byUrl[url];
                if (!prev) {
                    byUrl[url] = { "title": title, "url": url, "visits": visits };
                    continue;
                }
                var prevVisits = prev.visits || 0;
                if (title && (prev.title === url || visits > prevVisits)) {
                    prev.title = title;
                }
                prev.visits = Math.max(prevVisits, visits);
            }
            var out = [];
            for (var key in byUrl) {
                out.push(byUrl[key]);
            }
            root.browserBookmarks = out;
            root.rebuildBookmarks();
            if (root.launcher) {
                root.launcher.updateResults();
            }
        }
    }

    // Runs the incremental import tool; on exit the fresh history.json is read.
    Process {
        id: historySync
        command: ["sh", "-c", root.syncCommand()]
        stdout: StdioCollector {
            id: syncStdout
        }
        stderr: StdioCollector {
            id: syncStderr
        }
        onExited: (code) => {
            root.syncingHistory = false;
            syncWatchdog.stop();
            var out = String(syncStdout.text || "").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
            var err = String(syncStderr.text || "").replace(/\s+$/, "");
            if (code !== 0) {
                Logger.e("WebSearch", "History sync failed (exit " + code + "): " + err);
            } else {
                if (err !== "") {
                    Logger.w("WebSearch", "History sync stderr: " + err);
                }
                Logger.i("WebSearch", "History sync: " + (out !== "" ? out : "finished"));
            }
            root.refreshImportedHistory();
        }
    }

    // A hung sqlite3/node must not disable sync forever by leaving the flag set.
    Timer {
        id: syncWatchdog
        interval: 60000
        repeat: false
        onTriggered: {
            if (root.syncingHistory) {
                Logger.w("WebSearch", "History sync timed out after 60s; stopping it");
                root.syncingHistory = false;
                historySync.running = false;
            }
        }
    }

    // The importer is incremental, so a periodic run is cheap. This keeps the
    // visited-pages list fresh even when the launcher stays open all day.
    Timer {
        id: externalRefresh
        interval: 300000
        repeat: true
        onTriggered: {
            root.refreshExternalShortcuts();
            root.startHistorySync();
        }
    }

    // One-shot downloader: reuses the cached file if present, otherwise curls
    // the favicon into the cache. On success the result switches from the
    // magnifier to the site icon.
    Component {
        id: faviconDownloader

        Process {
            property string domain
            property string destPath
            command: ["sh", "-c", "mkdir -p " + root.shellQuote(root.cacheDir()) + " && { [ -f " + root.shellQuote(destPath) + " ] || curl -fsSL --max-time 8 -o " + root.shellQuote(destPath) + " " + root.shellQuote(root.faviconUrl(domain)) + "; }"]

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

    // One-shot page-title fetcher used when adding a bookmark for an unknown
    // URL. Raw HTML is parsed in JS so the URL never touches a shell.
    Component {
        id: titleFetcher

        Process {
            property string url
            property var callback
            command: ["curl", "-fsSL", "--max-time", "8", "-A", "Mozilla/5.0", url]
            stdout: StdioCollector {
                id: titleStdout
            }
            onExited: (code) => {
                if (callback) {
                    callback(code === 0 ? root.parseTitle(String(titleStdout.text || "")) : "");
                }
                destroy();
            }
        }
    }
}
