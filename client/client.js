window.__ModuleLoader__.load({
	id: "@fooxe/dsh-memory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/index.ts
		/**
		* dsh-memory client: registers a "Memory" tab inside the Plugins settings
		* section — the P1 read-only panel (two-scope list, search, guard gauges).
		* Built by tsdown into the __ModuleLoader__ factory bundle at client/client.js;
		* the only externals are the loader module table's react entries.
		*/
		const SCOPE_LABELS = {
			project: "Project (team-shared, committed to the repo)",
			user: "User (personal, cross-project)"
		};
		const S = {
			pad: {
				padding: "16px",
				fontFamily: "inherit"
			},
			h2: { margin: "0 0 12px" },
			section: { marginBottom: "20px" },
			muted: {
				color: "var(--fg-muted, #888)",
				fontSize: "12px"
			},
			input: {
				width: "100%",
				maxWidth: "420px",
				padding: "6px 10px",
				marginBottom: "12px",
				boxSizing: "border-box"
			},
			list: {
				listStyle: "none",
				margin: 0,
				padding: 0
			},
			item: {
				padding: "8px 0",
				borderBottom: "1px solid var(--border, #e5e5e5)"
			},
			tag: {
				margin: "0 4px",
				padding: "1px 6px",
				borderRadius: "4px",
				background: "var(--bg-muted, #f2f2f2)",
				fontSize: "11px"
			}
		};
		const name = "@fooxe/dsh-memory";
		const inject = ["slots"];
		function apply(ctx) {
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "dsh-memory",
				order: 70,
				label: () => "Memory",
				locale: "dsh-memory"
			}, () => (0, react.createElement)(MemoryPanel)));
		}
		function MemoryPanel() {
			const [data, setData] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [query, setQuery] = (0, react.useState)("");
			(0, react.useEffect)(() => {
				fetch("/dsh-memory/api/v1/list").then((r) => {
					if (!r.ok) throw new Error(`HTTP ${r.status}`);
					return r.json();
				}).then(setData).catch((e) => setError(String(e)));
			}, []);
			if (error !== null) return (0, react.createElement)("div", { style: S.pad }, `Failed to load memories: ${error}`);
			if (data === null) return (0, react.createElement)("div", { style: S.pad }, "Loading…");
			return (0, react.createElement)("div", { style: S.pad }, (0, react.createElement)("h2", { style: S.h2 }, "Memory"), (0, react.createElement)("input", {
				style: S.input,
				placeholder: "Search memories…",
				value: query,
				onChange: (e) => setQuery(e.target.value)
			}), ["project", "user"].map((scope) => (0, react.createElement)(ScopeSection, {
				key: scope,
				scope,
				info: data.scopes[scope],
				query
			})));
		}
		function ScopeSection(props) {
			const { scope, info, query } = props;
			const label = SCOPE_LABELS[scope] ?? scope;
			if (info?.available !== true) return (0, react.createElement)("section", { style: S.section }, (0, react.createElement)("h3", null, label), (0, react.createElement)("p", { style: S.muted }, "Not available in this workspace"));
			const q = query.trim().toLowerCase();
			const entries = (info.entries ?? []).filter((e) => q === "" || e.title.toLowerCase().includes(q) || e.excerpt.toLowerCase().includes(q) || e.path.toLowerCase().includes(q) || e.tags.some((t) => t.toLowerCase().includes(q)));
			const stats = info.stats;
			const gauge = `${stats.entries}/${stats.maxEntries} lines · ${(stats.indexBytes / 1024).toFixed(1)}/${(stats.maxBytes / 1024).toFixed(0)} KB · ${stats.memoryFiles}/${stats.maxMemories} files`;
			return (0, react.createElement)("section", { style: S.section }, (0, react.createElement)("h3", null, label, " ", (0, react.createElement)("span", { style: S.muted }, gauge)), entries.length === 0 ? (0, react.createElement)("p", { style: S.muted }, q === "" ? "No memories yet." : "No memories match the search.") : (0, react.createElement)("ul", { style: S.list }, entries.map((e, i) => (0, react.createElement)("li", {
				key: e.id ?? i,
				style: S.item
			}, (0, react.createElement)("div", null, (0, react.createElement)("strong", null, e.title), e.path !== "" ? (0, react.createElement)("code", {
				key: "path",
				style: S.tag
			}, e.path) : null, ...e.tags.map((t) => (0, react.createElement)("code", {
				key: t,
				style: S.tag
			}, t))), (0, react.createElement)("div", { style: S.muted }, e.date !== "" ? `${e.date} — ` : "", e.excerpt)))));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
