window.__ModuleLoader__.load({
	id: "dsh-ark-quota",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");
		var react_jsx_runtime = require("react/jsx-runtime");
		var jsx = react_jsx_runtime.jsx;
		var jsxs = react_jsx_runtime.jsxs;
		var Fragment = react_jsx_runtime.Fragment;
		//#region widget
		var POLL_MS = 5 * 60 * 1000;
		var LEVEL_LABELS = { session: "会话", weekly: "本周", monthly: "本月" };
		var LEVEL_ORDER = ["session", "weekly", "monthly"];

		function colorOf(percent) {
			if (percent >= 90) return "#e5484d";
			if (percent >= 70) return "#f5a524";
			return "#46a758";
		}

		function fmtReset(ts) {
			if (!ts) return "—";
			var diff = ts * 1000 - Date.now();
			if (diff <= 0) return "已重置";
			var h = Math.floor(diff / 3600000);
			if (h >= 24) return Math.round(h / 24) + " 天后重置";
			if (h >= 1) return h + " 小时后重置";
			return Math.max(1, Math.round(diff / 60000)) + " 分钟后重置";
		}

		function fmtClock(ts) {
			if (!ts) return "";
			var d = new Date(ts * 1000);
			var p = function (n) { return (n < 10 ? "0" : "") + n; };
			return p(d.getHours()) + ":" + p(d.getMinutes());
		}

		function useQuota() {
			var state = React.useState({ loading: true, data: null, error: null });
			var data = state[0], setState = state[1];
			var load = React.useCallback(function (force) {
				setState(function (prev) { return { loading: true, data: prev.data, error: null }; });
				fetch("/ark-quota" + (force ? "?force=1" : ""), { cache: "no-store" })
					.then(function (r) { return r.json(); })
					.then(function (json) {
						if (json && json.ok === true) setState({ loading: false, data: json, error: null });
						else setState({ loading: false, data: null, error: (json && json.message) || "查询失败" });
					})
					.catch(function (e) {
						setState({ loading: false, data: null, error: String((e && e.message) || e) });
					});
			}, []);
			React.useEffect(function () {
				load(false);
				var t = window.setInterval(function () { load(false); }, POLL_MS);
				return function () { window.clearInterval(t); };
			}, [load]);
			return { data: data.data, loading: data.loading, error: data.error, load: load };
		}

		function QuotaRow(_a) {
			var item = _a.item;
			var p = item.percentRemaining;
			var used = item.percentUsed;
			return jsxs("div", {
				style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0 },
				children: [
					jsx("span", {
						style: { flex: "none", width: "28px", fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" },
						children: Object.prototype.hasOwnProperty.call(LEVEL_LABELS, item.level) ? LEVEL_LABELS[item.level] : item.level
					}),
					jsxs("div", {
						style: { flex: "1", minWidth: 0, height: "4px", borderRadius: "2px", background: "var(--dsw-alias-track-bg, rgba(128,128,128,0.25))", overflow: "hidden" },
						children: [
							jsx("div", {
								style: { height: "100%", width: used + "%", borderRadius: "2px", background: colorOf(used), transition: "width .3s" }
							})
						]
					}),
					jsxs("span", {
						style: { flex: "none", minWidth: "34px", textAlign: "right", fontSize: "11px", lineHeight: "16px", fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-primary)" },
						children: [Math.round(p), "%"]
					})
				]
			});
		}

		function Card(_a) {
			var state = _a.state, onRefresh = _a.onRefresh, loading = _a.loading;
			if (state.error) {
				return jsxs("div", {
					style: { padding: "6px 10px", fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-state-error-primary, #e5484d)" },
					children: [
						jsxs("div", {
							style: { display: "flex", alignItems: "center", gap: "6px" },
							children: [
								jsx("span", { style: { flex: "1", fontWeight: "500" }, children: "方舟额度" }),
								jsx("button", {
									type: "button",
									title: "立即重试",
									onClick: onRefresh,
									style: {
										flex: "none", width: "18px", height: "18px", display: "inline-flex",
										alignItems: "center", justifyContent: "center", padding: "0",
										border: "none", borderRadius: "4px", cursor: "pointer",
										background: "transparent", color: "var(--dsw-alias-label-secondary)", fontSize: "12px", lineHeight: "1"
									},
									children: "⟳"
								})
							]
						}),
						jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", wordBreak: "break-all" }, children: state.error }),
						jsx("div", { style: { color: "var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary))", marginTop: "2px" }, children: "重新登录后可运行 node refresh.mjs 自动更新 Cookie" })
					]
				});
			}
			var quota = state.data ? state.data.quota : [];
			var rows = LEVEL_ORDER
				.map(function (level) { return quota.find(function (q) { return q.level === level; }); })
				.filter(Boolean);
			return jsxs("div", {
				style: {
					boxSizing: "border-box",
					width: "100%",
					padding: "8px 10px",
					display: "flex",
					flexDirection: "column",
					gap: "6px",
					borderRadius: "8px",
					border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2))",
					background: "var(--dsw-alias-bg-base, transparent)"
				},
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "6px" },
						children: [
							jsx("span", {
								style: { flex: "1", fontSize: "11px", fontWeight: "500", lineHeight: "16px", color: "var(--dsw-alias-label-primary)" },
								children: "方舟额度"
							}),
							loading && jsx("span", {
								style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary)" },
								children: "刷新中…"
							}),
							jsx("button", {
								type: "button",
								title: "立即刷新",
								onClick: onRefresh,
								style: {
									flex: "none", width: "18px", height: "18px", display: "inline-flex",
									alignItems: "center", justifyContent: "center", padding: "0",
									border: "none", borderRadius: "4px", cursor: "pointer",
									background: "transparent", color: "var(--dsw-alias-label-secondary)", fontSize: "12px", lineHeight: "1"
								},
								children: "⟳"
							})
						]
					}),
					rows.length > 0 ? rows.map(function (item) {
						return jsx(QuotaRow, { item: item, key: item.level });
					}) : jsx("div", {
						style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" },
						children: "暂无额度数据"
					}),
					state.data && state.data.updatedAt ? jsx("div", {
						style: { fontSize: "10px", lineHeight: "14px", color: "var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary))" },
						children: "更新于 " + fmtClock(state.data.updatedAt)
					}) : null
				]
			});
		}

		function RailPill(_a) {
			var state = _a.state;
			var quota = state.data ? state.data.quota : [];
			var monthly = quota.find(function (q) { return q.level === "monthly"; });
			var p = monthly ? monthly.percentRemaining : null;
			return jsx("button", {
				type: "button",
				title: p === null ? "方舟额度（无数据）" : "方舟额度 · 本月剩余 " + Math.round(p) + "%" + (state.error ? " · " + state.error : ""),
				onClick: function () {},
				style: {
					flex: "none", minWidth: "30px", height: "22px", padding: "0 7px",
					display: "inline-flex", alignItems: "center", justifyContent: "center",
					borderRadius: "999px", cursor: "default",
					border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2))",
					background: p === null ? "var(--dsw-alias-bg-base, transparent)" : (colorOf(100 - (p === null ? 0 : p)) + "1a"),
					color: "var(--dsw-alias-label-primary)", fontSize: "11px", fontVariantNumeric: "tabular-nums"
				},
				children: p === null ? (state.error ? "!" : "—") : Math.round(p) + "%"
			});
		}

		function ArkQuotaWidget(_a) {
			var wide = _a.wide;
			var useSettings = _a.useSettings;
			var q = useQuota();
			var revision = typeof useSettings === "function" ? useSettings(function (s) { return s && s.revision; }) : 0;
			React.useEffect(function () {
				// Settings changed (e.g. cookies refreshed) — force a fresh read.
				if (revision !== 0 && revision !== null && revision !== undefined) q.load(true);
			}, [revision, q]);
			if (!wide) return jsx(RailPill, { state: { data: q.data, error: q.error } });
			return jsx(Card, { state: { data: q.data, error: q.error }, loading: q.loading, onRefresh: function () { q.load(true); } });
		}
		//#endregion
		//#region plugin entry
		var NS = "arkQuota";
		var inject = ["slots", "settingsScope"];
		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", function () {
				var scope = ctx.settingsScope.bind({ namespace: "ark-quota" });
				return ctx.slots.register({
					name: "sidebar.footer.action",
					id: "ark-quota",
					order: 100,
					label: "方舟额度",
					inject: function () {
						return {
							hooks: {
								settings: scope
							}
						};
					}
				}, ArkQuotaWidget);
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.NS = NS;
		return module.exports;
	}
});
