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
		* section. Built by tsdown into the __ModuleLoader__ factory bundle at
		* client/client.js; the only externals are the loader module table's react
		* entries.
		*/
		const name = "@fooxe/dsh-memory";
		const inject = ["slots"];
		function apply(ctx) {
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "dsh-memory",
				order: 70,
				label: () => "Memory",
				locale: "dsh-memory"
			}, () => (0, react.createElement)("div", { style: { padding: "16px" } }, (0, react.createElement)("h2", null, "Memory"), (0, react.createElement)("p", null, "dsh-memory panel — hello from the client bundle. (MVP list lands here.)"))));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
