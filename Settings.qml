import QtQuick
import QtQuick.Layouts
import qs.Commons
import qs.Widgets
import "lib.js" as Lib

ColumnLayout {
    id: root

    property var pluginApi: null
    property var cfg: pluginApi?.pluginSettings || ({})
    property var defaults: pluginApi?.manifest?.metadata?.defaultSettings || ({})

    property string valueSearchEngine: "ddg"
    property bool valueDirectUrl: true
    property bool valueShowSuggestions: true
    property bool valueFavicons: true
    property int valueMaxResults: 8

    property var engines: []
    property var bookmarks: []
    property var shortcuts: []
    property int revision: 0

    property real preferredWidth: 900 * Style.uiScaleRatio
    spacing: Style.marginL

    Component.onCompleted: reload()

    function resolve(key) {
        return cfg[key] ?? defaults[key];
    }

    function copyList(list) {
        var out = [];
        if (Array.isArray(list)) {
            for (var i = 0; i < list.length; i++) {
                out.push(Object.assign({}, list[i]));
            }
        }
        return out;
    }

    function reload() {
        valueSearchEngine = resolve("search_engine") ?? "ddg";
        valueDirectUrl = resolve("direct_url") ?? true;
        valueShowSuggestions = resolve("show_suggestions") ?? true;
        valueFavicons = resolve("favicons") ?? true;
        valueMaxResults = resolve("max_results") ?? 8;
        engines = copyList(resolve("engines"));
        bookmarks = copyList(resolve("bookmarks"));
        shortcuts = copyList(resolve("shortcuts"));
        revision++;
    }

    function engineOptions() {
        void revision;
        var out = [];
        var seen = {};
        for (var k in Lib.BUILTIN_ENGINES) {
            out.push({ "key": k, "name": Lib.BUILTIN_ENGINES[k].name });
            seen[k] = true;
        }
        for (var i = 0; i < engines.length; i++) {
            var e = engines[i];
            if (e.key && !seen[e.key]) {
                out.push({ "key": e.key, "name": e.name || e.key });
                seen[e.key] = true;
            }
        }
        return out;
    }

    // Repeater delegates read list rows through these helpers so that a bump of
    // `revision` re-evaluates every text binding after a reorder.
    function field(which, index, key) {
        void revision;
        var list = root[which];
        return (index >= 0 && index < list.length && list[index]) ? (list[index][key] || "") : "";
    }

    function setField(which, index, key, value) {
        var list = root[which];
        if (index >= 0 && index < list.length && list[index] && list[index][key] !== value) {
            list[index][key] = value;
        }
    }

    function moveItem(which, index, delta) {
        var list = root[which];
        var target = index + delta;
        if (target < 0 || target >= list.length) {
            return;
        }
        var tmp = list[index];
        list[index] = list[target];
        list[target] = tmp;
        revision++;
    }

    function removeItem(which, index) {
        root[which].splice(index, 1);
        revision++;
    }

    function saveSettings() {
        if (!pluginApi) {
            Logger.e("WebSearch", "Cannot save settings: pluginApi is null");
            return;
        }
        var cleanEngines = engines.filter(function (e) { return e.key && e.url; });
        var cleanBookmarks = bookmarks.filter(function (b) { return b.url; });
        var cleanShortcuts = shortcuts.filter(function (s) { return s.alias && s.url; });

        pluginApi.pluginSettings.search_engine = root.valueSearchEngine;
        pluginApi.pluginSettings.direct_url = root.valueDirectUrl;
        pluginApi.pluginSettings.show_suggestions = root.valueShowSuggestions;
        pluginApi.pluginSettings.favicons = root.valueFavicons;
        pluginApi.pluginSettings.max_results = root.valueMaxResults;
        pluginApi.pluginSettings.engines = cleanEngines;
        pluginApi.pluginSettings.bookmarks = cleanBookmarks;
        pluginApi.pluginSettings.shortcuts = cleanShortcuts;
        pluginApi.saveSettings();
        Logger.i("WebSearch", "Settings saved");
    }

    NText {
        text: pluginApi?.tr("settings.title")
        pointSize: Style.fontSizeL
        font.bold: true
    }

    NText {
        text: pluginApi?.tr("settings.description")
        color: Color.mOnSurfaceVariant
        Layout.fillWidth: true
        wrapMode: Text.Wrap
    }

    NDivider {
        Layout.fillWidth: true
    }

    NComboBox {
        Layout.fillWidth: true
        label: pluginApi?.tr("settings.engine.label")
        description: pluginApi?.tr("settings.engine.description")
        model: root.engineOptions()
        currentKey: root.valueSearchEngine
        onSelected: key => root.valueSearchEngine = key
    }

    NToggle {
        label: pluginApi?.tr("settings.directUrl.label")
        description: pluginApi?.tr("settings.directUrl.description")
        checked: root.valueDirectUrl
        onToggled: root.valueDirectUrl = checked
    }

    NToggle {
        label: pluginApi?.tr("settings.suggestions.label")
        description: pluginApi?.tr("settings.suggestions.description")
        checked: root.valueShowSuggestions
        onToggled: root.valueShowSuggestions = checked
    }

    NToggle {
        label: pluginApi?.tr("settings.favicons.label")
        description: pluginApi?.tr("settings.favicons.description")
        checked: root.valueFavicons
        onToggled: root.valueFavicons = checked
    }

    ColumnLayout {
        Layout.fillWidth: true
        spacing: Style.marginS

        RowLayout {
            Layout.fillWidth: true
            NText {
                text: pluginApi?.tr("settings.maxResults.label")
                font.pointSize: Style.fontSizeL
                font.weight: Font.Medium
                color: Color.mOnSurface
                Layout.fillWidth: true
            }
            NText {
                text: root.valueMaxResults.toString()
                font.pointSize: Style.fontSizeM
                font.weight: Font.Medium
                color: Color.mPrimary
            }
        }

        NText {
            text: pluginApi?.tr("settings.maxResults.description")
            font.pointSize: Style.fontSizeS
            color: Color.mOnSurfaceVariant
            wrapMode: Text.WordWrap
            Layout.fillWidth: true
        }

        NSlider {
            Layout.fillWidth: true
            from: 1
            to: 20
            stepSize: 1
            value: root.valueMaxResults
            onMoved: root.valueMaxResults = Math.round(value)
        }
    }

    NDivider {
        Layout.fillWidth: true
    }

    // --- Shortcuts (alias -> URL) ---
    NText {
        text: pluginApi?.tr("settings.shortcuts.label")
        font.pointSize: Style.fontSizeL
        font.bold: true
    }
    NText {
        text: pluginApi?.tr("settings.shortcuts.description")
        font.pointSize: Style.fontSizeS
        color: Color.mOnSurfaceVariant
        wrapMode: Text.WordWrap
        Layout.fillWidth: true
    }

    NScrollView {
        id: shortcutsView
        Layout.fillWidth: true
        Layout.preferredHeight: Math.min(shortcutsColumn.implicitHeight, 280)
        showScrollbarWhenScrollable: true
        gradientColor: "transparent"

        ColumnLayout {
            id: shortcutsColumn
            width: shortcutsView.availableWidth
            spacing: Style.marginS

            Repeater {
                model: {
                    void root.revision;
                    return root.shortcuts.length;
                }

                delegate: RowLayout {
                    required property int index
                    Layout.fillWidth: true
                    spacing: Style.marginM

                    NTextInput {
                        Layout.preferredWidth: 140
                        placeholderText: pluginApi?.tr("settings.shortcuts.alias")
                        text: root.field("shortcuts", index, "alias")
                        onTextChanged: root.setField("shortcuts", index, "alias", text)
                    }
                    NTextInput {
                        Layout.fillWidth: true
                        Layout.preferredWidth: 220
                        placeholderText: pluginApi?.tr("settings.shortcuts.name")
                        text: root.field("shortcuts", index, "name")
                        onTextChanged: root.setField("shortcuts", index, "name", text)
                    }
                    NTextInput {
                        Layout.fillWidth: true
                        Layout.preferredWidth: 360
                        placeholderText: pluginApi?.tr("settings.shortcuts.url")
                        text: root.field("shortcuts", index, "url")
                        onTextChanged: root.setField("shortcuts", index, "url", text)
                    }
                    NIconButton {
                        icon: "arrow-up"
                        enabled: index > 0
                        onClicked: root.moveItem("shortcuts", index, -1)
                    }
                    NIconButton {
                        icon: "arrow-down"
                        enabled: index < root.shortcuts.length - 1
                        onClicked: root.moveItem("shortcuts", index, 1)
                    }
                    NIconButton {
                        icon: "trash"
                        onClicked: root.removeItem("shortcuts", index)
                    }
                }
            }
        }
    }

    NButton {
        text: pluginApi?.tr("settings.shortcuts.add")
        icon: "plus"
        onClicked: {
            root.shortcuts.push({ "alias": "", "name": "", "url": "" });
            root.revision++;
        }
    }

    NDivider {
        Layout.fillWidth: true
    }

    // --- Bookmarks (priority pages) ---
    NText {
        text: pluginApi?.tr("settings.bookmarks.label")
        font.pointSize: Style.fontSizeL
        font.bold: true
    }
    NText {
        text: pluginApi?.tr("settings.bookmarks.description")
        font.pointSize: Style.fontSizeS
        color: Color.mOnSurfaceVariant
        wrapMode: Text.WordWrap
        Layout.fillWidth: true
    }

    NScrollView {
        id: bookmarksView
        Layout.fillWidth: true
        Layout.preferredHeight: Math.min(bookmarksColumn.implicitHeight, 280)
        showScrollbarWhenScrollable: true
        gradientColor: "transparent"

        ColumnLayout {
            id: bookmarksColumn
            width: bookmarksView.availableWidth
            spacing: Style.marginS

            Repeater {
                model: {
                    void root.revision;
                    return root.bookmarks.length;
                }

                delegate: RowLayout {
                    required property int index
                    Layout.fillWidth: true
                    spacing: Style.marginM

                    NTextInput {
                        Layout.fillWidth: true
                        Layout.preferredWidth: 260
                        placeholderText: pluginApi?.tr("settings.bookmarks.title")
                        text: root.field("bookmarks", index, "title")
                        onTextChanged: root.setField("bookmarks", index, "title", text)
                    }
                    NTextInput {
                        Layout.fillWidth: true
                        Layout.preferredWidth: 400
                        placeholderText: pluginApi?.tr("settings.bookmarks.url")
                        text: root.field("bookmarks", index, "url")
                        onTextChanged: root.setField("bookmarks", index, "url", text)
                    }
                    NIconButton {
                        icon: "arrow-up"
                        enabled: index > 0
                        onClicked: root.moveItem("bookmarks", index, -1)
                    }
                    NIconButton {
                        icon: "arrow-down"
                        enabled: index < root.bookmarks.length - 1
                        onClicked: root.moveItem("bookmarks", index, 1)
                    }
                    NIconButton {
                        icon: "trash"
                        onClicked: root.removeItem("bookmarks", index)
                    }
                }
            }
        }
    }

    NButton {
        text: pluginApi?.tr("settings.bookmarks.add")
        icon: "plus"
        onClicked: {
            root.bookmarks.push({ "title": "", "url": "", "visits": 0 });
            root.revision++;
        }
    }

    NDivider {
        Layout.fillWidth: true
    }

    // --- Custom engines (modifier key -> search URL) ---
    NText {
        text: pluginApi?.tr("settings.engines.label")
        font.pointSize: Style.fontSizeL
        font.bold: true
    }
    NText {
        text: pluginApi?.tr("settings.engines.description")
        font.pointSize: Style.fontSizeS
        color: Color.mOnSurfaceVariant
        wrapMode: Text.WordWrap
        Layout.fillWidth: true
    }

    NScrollView {
        id: enginesView
        Layout.fillWidth: true
        Layout.preferredHeight: Math.min(enginesColumn.implicitHeight, 240)
        showScrollbarWhenScrollable: true
        gradientColor: "transparent"

        ColumnLayout {
            id: enginesColumn
            width: enginesView.availableWidth
            spacing: Style.marginS

            Repeater {
                model: {
                    void root.revision;
                    return root.engines.length;
                }

                delegate: RowLayout {
                    required property int index
                    Layout.fillWidth: true
                    spacing: Style.marginM

                    NTextInput {
                        Layout.preferredWidth: 80
                        placeholderText: pluginApi?.tr("settings.engines.key")
                        text: root.field("engines", index, "key")
                        onTextChanged: root.setField("engines", index, "key", text)
                    }
                    NTextInput {
                        Layout.preferredWidth: 160
                        placeholderText: pluginApi?.tr("settings.engines.name")
                        text: root.field("engines", index, "name")
                        onTextChanged: root.setField("engines", index, "name", text)
                    }
                    NTextInput {
                        Layout.fillWidth: true
                        Layout.preferredWidth: 340
                        placeholderText: pluginApi?.tr("settings.engines.url")
                        text: root.field("engines", index, "url")
                        onTextChanged: root.setField("engines", index, "url", text)
                    }
                    NTextInput {
                        Layout.preferredWidth: 120
                        placeholderText: pluginApi?.tr("settings.engines.domain")
                        text: root.field("engines", index, "domain")
                        onTextChanged: root.setField("engines", index, "domain", text)
                    }
                    NTextInput {
                        Layout.fillWidth: true
                        Layout.preferredWidth: 240
                        placeholderText: pluginApi?.tr("settings.engines.suggest")
                        text: root.field("engines", index, "suggest")
                        onTextChanged: root.setField("engines", index, "suggest", text)
                    }
                    NIconButton {
                        icon: "arrow-up"
                        enabled: index > 0
                        onClicked: root.moveItem("engines", index, -1)
                    }
                    NIconButton {
                        icon: "arrow-down"
                        enabled: index < root.engines.length - 1
                        onClicked: root.moveItem("engines", index, 1)
                    }
                    NIconButton {
                        icon: "trash"
                        onClicked: root.removeItem("engines", index)
                    }
                }
            }
        }
    }

    NButton {
        text: pluginApi?.tr("settings.engines.add")
        icon: "plus"
        onClicked: {
            root.engines.push({ "key": "", "name": "", "url": "", "domain": "", "suggest": "" });
            root.revision++;
        }
    }
}
