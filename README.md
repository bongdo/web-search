# Web Search

A launcher provider plugin that lets you search the internet directly from the Noctalia launcher, with live autocomplete suggestions, engine modifiers, and your own history, bookmarks and shortcuts.

## Features

- **Quick Web Searching**: Search the web instantly without opening a browser first
- **Live Autocomplete**: Get search suggestions from your preferred engine as you type
- **Multiple Search Engines**: Google, DuckDuckGo (default), Bing, Brave, Yandex and YouTube, plus custom engines
- **Engine Modifiers**: Prefix a query with an engine key to search that engine for one query (`g`, `ddg`, `bing`, `brave`, `ya`, `y`, or a custom key)
- **Smart URL Detection**: Automatically detects URLs, IP addresses, and localhost and opens them directly in the browser
- **History, Bookmarks and Shortcuts**: Filter them in the launcher with `h `, `b ` and `sh `, and add bookmarks with `bookmark <url>`
- **Zen Sync**: Zen browsing history and bookmarks are imported automatically and merged with launcher data
- **Smart Priorities**: Web search acts as a fallback when searching for apps, or takes absolute priority when using the explicit `>web` command

## Usage

1. Open the Noctalia launcher
2. Type `>web` followed by your query to enter web search mode exclusively
3. Or just type your query directly. Web search results appear as fallbacks below matched applications
4. Live suggestions populate underneath the main result as you type (after two characters)
5. Press Enter on any result to open it in your default browser

### Examples

**Search with the `>web` command:**
```
>web chocolate cake recipe
```
This bypasses all local apps/files and shows only web search results. The top result will open a search for "chocolate cake recipe" in your configured engine, with autocomplete suggestions listed below.

**Fallback search:**
```
discord
```
Type a query normally. If it matches an installed app, the app appears first. Web search results appear at the bottom as fallbacks, so you can still search for "discord" on the web if the app isn't what you wanted.

**Search one engine:**
```
>web g noctalia plugins
```
The first word is an engine key (`g` for Google here). It applies to that query only and does not change the default engine.

**Direct URL navigation:**
```
>web github.com/noctalia-dev
```
When Direct URL Opening is enabled, the plugin detects that `github.com/noctalia-dev` is a URL and offers to open it directly in your browser, alongside the regular search result.

**Open localhost or IP addresses:**
```
>web localhost:3000
>web 192.168.1.1
```
Local addresses and IPs are detected as URLs and offered for direct opening. Localhost and IP addresses default to `http://`, while domain names default to `https://`.

### History, bookmarks and shortcuts

These modifiers only look at your own data; they never add a web-search row.

| Modifier | Effect |
|---|---|
| `h <query>` | Search launcher-recorded and imported Zen history |
| `b <query>` | Search bookmarks from the plugin settings and the Zen import |
| `sh <query>` | Search shortcuts by alias, name or URL |

With an empty query, `h `, `b ` and `sh ` list up to 50 entries: history newest first, bookmarks by visit count, shortcuts by name. An engine modifier also restricts your history, bookmarks and shortcuts to that engine's domains, so `y cats` only matches your YouTube entries.

**Add a bookmark:**
```
>web bookmark https://example.com
```
`bookmark <url>` turns the input into a "Bookmark …" action. Pressing Enter adds the URL to the plugin's own bookmark list, closes the launcher and shows a toast. Quotes around the URL are ignored, and a bare domain gets `https://` (localhost and IP addresses get `http://`). If the URL is already in that own list, nothing changes; a page that only exists in the Zen import is added locally, so it survives a later Zen removal. The title comes from history or an existing bookmark; otherwise the page title is fetched, falling back to the URL. If the argument is not a URL, the `bookmark` modifier is ignored and the rest is treated as a normal query.

### Zen history and bookmarks

The plugin imports Zen data automatically. On each launcher open, `tools/import-history.js` incrementally imports new page visits from Zen's `places.sqlite`, refreshes the Zen bookmark list, and converts search terms from `formhistory.sqlite` into search URLs for your configured engine, so selecting one re-runs the search. The result is written to `history.json` in the plugin directory.

Imported entries are merged with the history the launcher records itself and with the bookmarks stored in the plugin settings. History is deduplicated by URL keeping the newest visit; bookmarks keep the settings title and the higher visit count. The two writers never touch the same file: the import tool owns `history.json`, and only the plugin writes `settings.json`.

The sync needs `node` and `sqlite3`. `node` is auto-probed in common local and NixOS locations, then `PATH`; `sqlite3` must be on `PATH`. Errors are reported in the Noctalia/quickshell log.

## IPC Commands

You can control the web search plugin via the command line using the Noctalia IPC interface.

### Available Commands

| Command | Description | Example |
|---|---|---|
| `toggle` | Opens or closes the launcher on the current screen | `qs -c noctalia-shell ipc call plugin:web-search toggle` |

## Configuration

You can configure the plugin directly via Noctalia's Plugin Settings:

| Setting | Description | Default |
|---|---|---|
| **Search Engine** | Default engine for plain queries and the fallback search row | DuckDuckGo |
| **Direct URL Opening** | Automatically detect URLs and open them directly in the browser instead of searching | Enabled |
| **Show Search Suggestions** | Fetch real-time autocomplete suggestions while typing | Enabled |
| **Website Icons** | Download site favicons (via Google's favicon service) and show a small `WEB` badge in results | Enabled |
| **Maximum Results** | Cap on query results and autocomplete suggestions (1–20) | 8 |

The settings page also manages:

- **Shortcuts**: alias, name and URL. Typing the alias in the launcher opens the page.
- **Bookmarks**: title and URL. Matching bookmarks are promoted above web search results.
- **Custom Search Engines**: key, name, search URL prefix, optional domain filter, and optional suggestion URL. Use the key as a modifier, for example `gh noctalia`.

## Requirements

- Noctalia 3.9.0 or later
- Internet connection (for search suggestions and favicons)
- For Zen sync: `node` and `sqlite3` (see above)

## Changelog

### 2.3.0
- Added `h `, `b ` and `sh ` modifiers for history, bookmarks and shortcuts
- Added the `bookmark <url>` action
- Added automatic Zen history and bookmark sync, merged with launcher-recorded history and settings bookmarks
- Default engine is DuckDuckGo; maximum results is 1–20 with a default of 8
- Documentation updated for engine modifiers, favicons and Zen sync requirements

### 1.1.1
- Fix protocols other than http/https not recognized as URL
- Support for middle domain with only one character (e.g., www.a.com)
- Support for hostname without dot with port (e.g., hostname:8080)
    - If you want to enter hostname without port and dot, you have to type the protocol manually

### 1.1.0
- Added Direct URL Opening. Automatically detects URLs, IP addresses, and localhost and opens them directly in the browser
- Added configurable toggle for the Direct URL feature
- Smart protocol handling

### 1.0.2
- Added French translation

### 1.0.1
- Added German translation

### 1.0.0
- Initial release
- Live autocomplete suggestions from the selected search engine
- Support for Google, DuckDuckGo, Bing, Brave, and Yandex
- Configurable suggestion count and toggle
- Fallback results when typing normally in the launcher
- English translation
