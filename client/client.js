window.__ModuleLoader__.load({
	id: "@fooxe/dsh-memory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/index.ts
		/**
		* dsh-memory client: registers the "Memory" section inside Settings — the P2
		* panel: expandable per-workspace groups, cross-scope search, and an in-panel
		* add form writing through the same save core as the model tool.
		* Built by tsdown into the __ModuleLoader__ factory bundle at client/client.js;
		* the only externals are the loader module table's react entries.
		*/
		const S = {
			pad: {
				padding: "16px",
				fontFamily: "inherit"
			},
			h2: { margin: "0 0 12px" },
			toolbar: {
				display: "flex",
				gap: "8px",
				marginBottom: "12px",
				alignItems: "center"
			},
			section: { marginBottom: "20px" },
			muted: {
				color: "var(--fg-muted, #888)",
				fontSize: "12px"
			},
			input: {
				padding: "6px 10px",
				boxSizing: "border-box",
				fontFamily: "inherit"
			},
			search: {
				width: "100%",
				maxWidth: "420px",
				padding: "6px 10px",
				boxSizing: "border-box",
				fontFamily: "inherit"
			},
			textarea: {
				width: "100%",
				padding: "6px 10px",
				boxSizing: "border-box",
				fontFamily: "inherit"
			},
			button: {
				padding: "6px 14px",
				fontFamily: "inherit",
				cursor: "pointer"
			},
			form: {
				display: "flex",
				flexDirection: "column",
				gap: "8px",
				marginBottom: "16px",
				maxWidth: "560px"
			},
			list: {
				listStyle: "none",
				margin: "0",
				padding: "0"
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
			},
			wsHeader: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				cursor: "pointer",
				padding: "6px 0",
				userSelect: "none"
			},
			chevron: {
				display: "inline-block",
				width: "1em",
				transition: "transform 120ms"
			},
			current: {
				margin: "0",
				padding: "1px 6px",
				borderRadius: "4px",
				background: "var(--bg-accent, #e0ecff)",
				fontSize: "11px"
			},
			error: {
				color: "var(--fg-danger, #c33)",
				fontSize: "13px"
			}
		};
		const name = "@fooxe/dsh-memory";
		const inject = ["slots"];
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-memory",
				order: 70,
				label: () => "Memory",
				locale: "dsh-memory"
			}, () => (0, react.createElement)(MemoryPanel)));
		}
		function entryMatches(e, q) {
			return e.title.toLowerCase().includes(q) || e.excerpt.toLowerCase().includes(q) || e.path.toLowerCase().includes(q) || e.tags.some((t) => t.toLowerCase().includes(q));
		}
		function MemoryPanel() {
			const [data, setData] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [query, setQuery] = (0, react.useState)("");
			const [expanded, setExpanded] = (0, react.useState)(/* @__PURE__ */ new Set());
			const [adding, setAdding] = (0, react.useState)(false);
			const [defaultExpanded, setDefaultExpanded] = (0, react.useState)(false);
			const fetchList = (0, react.useCallback)(() => {
				fetch("/dsh-memory/api/v1/list").then((r) => {
					if (!r.ok) throw new Error(`HTTP ${r.status}`);
					return r.json();
				}).then((d) => {
					setData(d);
					setError(null);
				}).catch((e) => setError(String(e)));
			}, []);
			(0, react.useEffect)(() => {
				fetchList();
			}, [fetchList]);
			if (error !== null) return (0, react.createElement)("div", { style: S.pad }, `Failed to load memories: ${error}`);
			if (data === null) return (0, react.createElement)("div", { style: S.pad }, "Loading…");
			const workspaces = data.scopes.projects ?? [];
			if (!defaultExpanded) {
				setDefaultExpanded(true);
				setExpanded(new Set(workspaces.filter((w) => w.current).map((w) => w.root)));
			}
			const q = query.trim().toLowerCase();
			const searchActive = q !== "";
			return (0, react.createElement)("div", { style: S.pad }, (0, react.createElement)("h2", { style: S.h2 }, "Memory"), (0, react.createElement)("div", { style: S.toolbar }, (0, react.createElement)("input", {
				style: S.search,
				placeholder: "Search memories…",
				value: query,
				onChange: (e) => setQuery(e.target.value)
			}), (0, react.createElement)("button", {
				style: S.button,
				onClick: () => setAdding(!adding)
			}, adding ? "× Cancel" : "+ Add")), adding ? (0, react.createElement)(AddForm, {
				workspaces,
				onDone: () => {
					setAdding(false);
					fetchList();
				}
			}) : null, (0, react.createElement)(UserSection, {
				info: data.scopes.user,
				query: q
			}), workspaces.length > 0 ? (0, react.createElement)("h3", { style: { margin: "16px 0 4px" } }, "Projects") : null, workspaces.map((ws) => (0, react.createElement)(WorkspaceSection, {
				key: ws.root,
				ws,
				query: q,
				forceOpen: searchActive,
				open: searchActive || expanded.has(ws.root),
				onToggle: () => {
					const next = new Set(expanded);
					if (next.has(ws.root)) next.delete(ws.root);
					else next.add(ws.root);
					setExpanded(next);
				}
			})));
		}
		function gauge(stats) {
			return `${stats.entries}/${stats.maxEntries} lines · ${(stats.indexBytes / 1024).toFixed(1)}/${(stats.maxBytes / 1024).toFixed(0)} KB · ${stats.memoryFiles}/${stats.maxMemories} files`;
		}
		function EntryList(props) {
			const q = props.query;
			const entries = q === "" ? props.entries : props.entries.filter((e) => entryMatches(e, q));
			if (entries.length === 0) return (0, react.createElement)("p", { style: S.muted }, q === "" ? props.emptyText : "No memories match the search.");
			return (0, react.createElement)("ul", { style: S.list }, entries.map((e, i) => (0, react.createElement)("li", {
				key: e.id ?? i,
				style: S.item
			}, (0, react.createElement)("div", null, (0, react.createElement)("strong", null, e.title), e.path !== "" ? (0, react.createElement)("code", {
				key: "path",
				style: S.tag
			}, e.path) : null, ...e.tags.map((t) => (0, react.createElement)("code", {
				key: t,
				style: S.tag
			}, t))), (0, react.createElement)("div", { style: S.muted }, e.date !== "" ? `${e.date} — ` : "", e.excerpt))));
		}
		function UserSection(props) {
			const { info, query } = props;
			if (info?.available !== true) return (0, react.createElement)("section", { style: S.section }, (0, react.createElement)("h3", null, "User"), (0, react.createElement)("p", { style: S.muted }, "Not available in this workspace"));
			return (0, react.createElement)("section", { style: S.section }, (0, react.createElement)("h3", null, "User ", (0, react.createElement)("span", { style: S.muted }, gauge(info.stats))), (0, react.createElement)("p", { style: {
				...S.muted,
				margin: "0 0 4px"
			} }, "Personal, cross-project"), (0, react.createElement)(EntryList, {
				entries: info.entries ?? [],
				query,
				emptyText: "No memories yet."
			}));
		}
		function WorkspaceSection(props) {
			const { ws, open, onToggle } = props;
			return (0, react.createElement)("section", { style: S.section }, (0, react.createElement)("div", {
				style: S.wsHeader,
				onClick: props.forceOpen ? void 0 : onToggle
			}, (0, react.createElement)("span", { style: {
				...S.chevron,
				transform: open ? "rotate(90deg)" : "rotate(0deg)"
			} }, "▸"), (0, react.createElement)("strong", null, ws.name), ws.current ? (0, react.createElement)("code", { style: S.current }, "current") : null, (0, react.createElement)("span", { style: S.muted }, `${ws.entries.length} memories · ${gauge(ws.stats)}`)), open ? (0, react.createElement)(EntryList, {
				entries: ws.entries,
				query: props.query,
				emptyText: "No memories in this workspace."
			}) : null);
		}
		function AddForm(props) {
			const [scope, setScope] = (0, react.useState)(props.workspaces.find((w) => w.current)?.root ?? "user");
			const [title, setTitle] = (0, react.useState)("");
			const [content, setContent] = (0, react.useState)("");
			const [tags, setTags] = (0, react.useState)("");
			const [formError, setFormError] = (0, react.useState)(null);
			const [saving, setSaving] = (0, react.useState)(false);
			const submit = (e) => {
				e.preventDefault();
				if (saving) return;
				setSaving(true);
				setFormError(null);
				const body = {
					scope: scope === "user" ? "user" : "project",
					workspace: scope === "user" ? void 0 : scope,
					title,
					content,
					tags: tags.split(",").map((t) => t.trim()).filter((t) => t !== "")
				};
				fetch("/dsh-memory/api/v1/save", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body)
				}).then(async (r) => {
					const data = r.json();
					if (!r.ok || (await data).ok !== true) throw new Error((await data).error ?? `HTTP ${r.status}`);
					props.onDone();
				}).catch((err) => {
					setFormError(String(err));
					setSaving(false);
				});
			};
			return (0, react.createElement)("form", {
				style: S.form,
				onSubmit: submit
			}, (0, react.createElement)("select", {
				style: S.input,
				value: scope,
				onChange: (e) => setScope(e.target.value)
			}, (0, react.createElement)("option", {
				key: "user",
				value: "user"
			}, "User — personal, cross-project"), ...props.workspaces.map((w) => (0, react.createElement)("option", {
				key: w.root,
				value: w.root
			}, `${w.name}${w.current ? " (current)" : ""} — team-shared`))), (0, react.createElement)("input", {
				style: S.input,
				placeholder: "Title (max 60 chars)",
				value: title,
				maxLength: 60,
				onChange: (e) => setTitle(e.target.value)
			}), (0, react.createElement)("textarea", {
				style: S.textarea,
				placeholder: "The memory itself — self-contained, will matter months later",
				value: content,
				rows: 4,
				onChange: (e) => setContent(e.target.value)
			}), (0, react.createElement)("input", {
				style: S.input,
				placeholder: "Tags, comma-separated (optional)",
				value: tags,
				onChange: (e) => setTags(e.target.value)
			}), formError !== null ? (0, react.createElement)("div", { style: S.error }, formError) : null, (0, react.createElement)("div", null, (0, react.createElement)("button", {
				style: S.button,
				type: "submit",
				disabled: saving || title.trim() === "" || content.trim() === ""
			}, saving ? "Saving…" : "Save memory")));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
