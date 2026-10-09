window.__ModuleLoader__.load({
	id: "@fooxe/dsh-memory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/index.ts
		/**
		* dsh-memory client: registers the "Memory" section inside Settings — the P2.1
		* panel: expandable per-workspace tree with per-scope inline add buttons,
		* path (sub-folder) grouping inside each workspace, per-entry delete, and a
		* scrollable list. All writes go through the same save/delete cores as the
		* model tools.
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
			section: { marginBottom: "16px" },
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
				padding: "4px 10px",
				fontFamily: "inherit",
				cursor: "pointer"
			},
			smallButton: {
				padding: "2px 8px",
				fontFamily: "inherit",
				fontSize: "12px",
				cursor: "pointer",
				background: "transparent",
				border: "1px solid var(--border, #e5e5e5)",
				borderRadius: "4px"
			},
			form: {
				display: "flex",
				flexDirection: "column",
				gap: "8px",
				marginBottom: "12px",
				maxWidth: "560px"
			},
			list: {
				listStyle: "none",
				margin: "0",
				padding: "0"
			},
			item: {
				display: "flex",
				alignItems: "baseline",
				justifyContent: "space-between",
				gap: "8px",
				padding: "8px 0",
				borderBottom: "1px solid var(--border, #e5e5e5)"
			},
			itemMain: {
				minWidth: "0",
				flex: "1"
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
			wsHeaderMain: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				flex: "1",
				minWidth: "0"
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
			titleRow: {
				display: "flex",
				alignItems: "baseline",
				gap: "4px",
				flexWrap: "nowrap"
			},
			pathGroup: {
				marginLeft: "18px",
				borderLeft: "1px solid var(--border, #e5e5e5)",
				paddingLeft: "10px",
				marginTop: "4px"
			},
			pathHeader: {
				color: "var(--fg-muted, #888)",
				fontSize: "12px",
				padding: "4px 0"
			},
			scroller: {
				maxHeight: "60vh",
				overflowY: "auto",
				paddingRight: "8px"
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
		function gauge(stats) {
			return `${stats.entries}/${stats.maxEntries} lines · ${(stats.indexBytes / 1024).toFixed(1)}/${(stats.maxBytes / 1024).toFixed(0)} KB · ${stats.memoryFiles}/${stats.maxMemories} files`;
		}
		function MemoryPanel() {
			const [data, setData] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [query, setQuery] = (0, react.useState)("");
			const [expanded, setExpanded] = (0, react.useState)(/* @__PURE__ */ new Set());
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
			})), (0, react.createElement)("div", { style: S.scroller }, (0, react.createElement)(UserSection, {
				info: data.scopes.user,
				query: q,
				onSaved: fetchList
			}), workspaces.length > 0 ? (0, react.createElement)("h3", { style: { margin: "8px 0 4px" } }, "Projects") : null, workspaces.map((ws) => (0, react.createElement)(WorkspaceSection, {
				key: ws.root,
				ws,
				query: q,
				open: searchActive || expanded.has(ws.root),
				onToggle: () => {
					const next = new Set(expanded);
					if (next.has(ws.root)) next.delete(ws.root);
					else next.add(ws.root);
					setExpanded(next);
				},
				onSaved: fetchList
			}))));
		}
		/** Entries grouped by sub-folder path: root-level first, then path groups. */
		function GroupedEntries(props) {
			const { entries, query, target, onSaved } = props;
			const q = query;
			const matched = q === "" ? entries : entries.filter((e) => entryMatches(e, q));
			const root = matched.filter((e) => e.path === "");
			const groups = /* @__PURE__ */ new Map();
			for (const e of matched) {
				if (e.path === "") continue;
				const list = groups.get(e.path) ?? [];
				list.push(e);
				groups.set(e.path, list);
			}
			if (matched.length === 0) return (0, react.createElement)("p", { style: S.muted }, q === "" ? props.emptyText : "No memories match the search.");
			return (0, react.createElement)("div", null, (0, react.createElement)(EntryList, {
				entries: root,
				query: "",
				target,
				onSaved
			}), [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([p, es]) => (0, react.createElement)("div", {
				key: p,
				style: S.pathGroup
			}, (0, react.createElement)("div", { style: S.pathHeader }, "📁 ", p, ` · ${es.length}`), (0, react.createElement)(EntryList, {
				entries: es,
				query: "",
				target,
				onSaved
			}))));
		}
		function EntryList(props) {
			const [deleting, setDeleting] = (0, react.useState)(null);
			const [editing, setEditing] = (0, react.useState)(null);
			const [rowError, setRowError] = (0, react.useState)(null);
			const del = (e) => {
				if (deleting !== null || e.id === void 0) return;
				if (!window.confirm(`Delete "${e.title}"?`)) return;
				setDeleting(e.id);
				setRowError(null);
				fetch("/dsh-memory/api/v1/delete", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						scope: props.target.scope,
						workspace: props.target.workspace,
						id: e.id
					})
				}).then(async (r) => {
					const d = r.json();
					if (!r.ok || (await d).ok !== true) throw new Error((await d).error ?? `HTTP ${r.status}`);
					props.onSaved();
				}).catch((err) => {
					setRowError(`Delete failed: ${String(err)}`);
				}).finally(() => {
					setDeleting(null);
				});
			};
			if (props.entries.length === 0) return (0, react.createElement)("span");
			return (0, react.createElement)("ul", { style: S.list }, rowError !== null ? (0, react.createElement)("li", {
				key: "error",
				style: S.item
			}, (0, react.createElement)("div", { style: S.error }, rowError)) : null, props.entries.map((e, i) => {
				if (e.id !== void 0 && editing === e.id) return (0, react.createElement)("li", {
					key: e.id,
					style: {
						...S.item,
						display: "block"
					}
				}, (0, react.createElement)(MemoryForm, {
					target: props.target,
					initial: e,
					onDone: () => {
						setEditing(null);
						props.onSaved();
					}
				}));
				return (0, react.createElement)("li", {
					key: e.id ?? i,
					style: S.item
				}, (0, react.createElement)("div", { style: S.itemMain }, (0, react.createElement)("div", { style: S.titleRow }, (0, react.createElement)("strong", null, e.title), e.tags.map((t) => (0, react.createElement)("code", {
					key: t,
					style: S.tag
				}, t)), (0, react.createElement)("span", { style: {
					flex: "1",
					minWidth: "8px"
				} }), e.id !== void 0 ? (0, react.createElement)("button", {
					style: S.smallButton,
					title: "Edit this memory",
					onClick: () => {
						setEditing(e.id);
						setRowError(null);
					}
				}, "✎") : null, e.id !== void 0 ? (0, react.createElement)("button", {
					style: S.smallButton,
					title: "Delete this memory",
					disabled: deleting === e.id,
					onClick: () => del(e)
				}, deleting === e.id ? "…" : "×") : null), (0, react.createElement)("div", { style: S.muted }, e.date !== "" ? `${e.date} — ` : "", e.excerpt)));
			}));
		}
		/** Inline edit form: fetches the full text on demand, saves via /update. */
		/** One form, two modes — add (empty, /save) and edit (prefilled via /read, /update). Identical layout and size. */
		function MemoryForm(props) {
			const editing = props.initial !== void 0 && props.initial.id !== void 0;
			const [title, setTitle] = (0, react.useState)(props.initial?.title ?? "");
			const [content, setContent] = (0, react.useState)("");
			const [tags, setTags] = (0, react.useState)(props.initial?.tags.join(", ") ?? "");
			const [loading, setLoading] = (0, react.useState)(editing);
			const [formError, setFormError] = (0, react.useState)(null);
			const [saving, setSaving] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				if (!editing) return;
				fetch("/dsh-memory/api/v1/read", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						scope: props.target.scope,
						workspace: props.target.workspace,
						id: props.initial.id
					})
				}).then(async (r) => {
					const d = r.json();
					if (!r.ok || (await d).ok !== true) throw new Error((await d).error ?? `HTTP ${r.status}`);
					return d;
				}).then((d) => {
					setContent(d.content ?? "");
				}).catch((err) => {
					setFormError(String(err));
				}).finally(() => {
					setLoading(false);
				});
			}, []);
			const submit = (e) => {
				e.preventDefault();
				if (saving) return;
				setSaving(true);
				setFormError(null);
				const tagList = tags.split(",").map((t) => t.trim()).filter((t) => t !== "");
				fetch(editing ? "/dsh-memory/api/v1/update" : "/dsh-memory/api/v1/save", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(editing ? {
						scope: props.target.scope,
						workspace: props.target.workspace,
						id: props.initial.id,
						title,
						content,
						tags: tagList
					} : {
						scope: props.target.scope,
						workspace: props.target.workspace,
						title,
						content,
						tags: tagList
					})
				}).then(async (r) => {
					const d = r.json();
					if (!r.ok || (await d).ok !== true) throw new Error((await d).error ?? `HTTP ${r.status}`);
					props.onDone();
				}).catch((err) => {
					setFormError(String(err));
					setSaving(false);
				});
			};
			if (loading && formError === null) return (0, react.createElement)("div", { style: S.form }, "Loading…");
			return (0, react.createElement)("form", {
				style: S.form,
				onSubmit: submit
			}, (0, react.createElement)("input", {
				style: S.input,
				placeholder: "Title (max 60 chars)",
				value: title,
				maxLength: 60,
				autoFocus: true,
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
			}, saving ? "Saving…" : editing ? "Save changes" : "Save memory"), editing ? (0, react.createElement)("button", {
				style: {
					...S.button,
					marginLeft: "8px"
				},
				type: "button",
				onClick: props.onDone
			}, "Cancel") : null));
		}
		function UserSection(props) {
			const [adding, setAdding] = (0, react.useState)(false);
			const [open, setOpen] = (0, react.useState)(true);
			const { info, query } = props;
			const target = { scope: "user" };
			return (0, react.createElement)("section", { style: S.section }, (0, react.createElement)("div", { style: S.wsHeader }, (0, react.createElement)("div", {
				style: S.wsHeaderMain,
				onClick: () => {
					setOpen(!open);
				}
			}, (0, react.createElement)("span", { style: {
				...S.chevron,
				transform: open ? "rotate(90deg)" : "rotate(0deg)"
			} }, "▸"), (0, react.createElement)("strong", null, "User"), (0, react.createElement)("span", { style: S.muted }, info?.available === true ? gauge(info.stats) : "")), (0, react.createElement)("button", {
				style: S.smallButton,
				title: "Add a user memory",
				onClick: () => {
					setAdding(!adding);
				}
			}, adding ? "×" : "+")), open ? (0, react.createElement)("div", null, adding ? (0, react.createElement)(MemoryForm, {
				target,
				onDone: () => {
					setAdding(false);
					props.onSaved();
				}
			}) : null, info?.available !== true ? (0, react.createElement)("p", { style: S.muted }, "Not available in this workspace") : (0, react.createElement)(GroupedEntries, {
				entries: info.entries ?? [],
				query,
				emptyText: "No memories yet.",
				target,
				onSaved: props.onSaved
			})) : null);
		}
		function WorkspaceSection(props) {
			const [adding, setAdding] = (0, react.useState)(false);
			const { ws, open, onToggle } = props;
			const target = {
				scope: "project",
				workspace: ws.root
			};
			return (0, react.createElement)("section", { style: S.section }, (0, react.createElement)("div", { style: S.wsHeader }, (0, react.createElement)("div", {
				style: S.wsHeaderMain,
				onClick: onToggle
			}, (0, react.createElement)("span", { style: {
				...S.chevron,
				transform: open ? "rotate(90deg)" : "rotate(0deg)"
			} }, "▸"), (0, react.createElement)("strong", null, ws.name), ws.current ? (0, react.createElement)("code", { style: S.current }, "current") : null, ws.nested === true ? (0, react.createElement)("code", { style: S.current }, "sub") : null, (0, react.createElement)("span", { style: S.muted }, `${ws.entries.length} memories · ${gauge(ws.stats)}`)), (0, react.createElement)("button", {
				style: S.smallButton,
				title: `Add a memory in ${ws.name}`,
				onClick: () => setAdding(!adding)
			}, adding ? "×" : "+")), open ? (0, react.createElement)("div", null, adding ? (0, react.createElement)(MemoryForm, {
				target,
				onDone: () => {
					setAdding(false);
					props.onSaved();
				}
			}) : null, (0, react.createElement)(GroupedEntries, {
				entries: ws.entries,
				query: props.query,
				emptyText: "No memories in this workspace.",
				target,
				onSaved: props.onSaved
			})) : null);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
