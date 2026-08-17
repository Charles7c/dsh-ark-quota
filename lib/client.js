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

		// Module-scope refresh fan-out: the DSH settings scope is read-only for
		// third-party namespaces, so credentials are saved through the plugin's
		// own /ark-quota/credentials route. This signal tells every mounted
		// widget to re-read the quota right after a save (and on manual refresh).
		var refreshSignal = {
			listeners: new Set(),
			subscribe: function (fn) {
				refreshSignal.listeners.add(fn);
				return function () { refreshSignal.listeners.delete(fn); };
			},
			notify: function () {
				for (var fn of Array.from(refreshSignal.listeners)) {
					try { fn(); } catch (_e) { /* keep other listeners alive */ }
				}
			}
		};

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

		// Inline 火山方舟 (Volcano Ark) brand mark — the official ark.volcengine.com
		// console icon, flattened (masks/clipPaths removed) so mounting it twice in
		// the DOM never collides on shared <mask>/<clipPath> ids. Colors kept as-is.
		function ArkLogo(_a) {
			var size = _a.size === undefined ? 16 : _a.size;
			return jsxs("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				shapeRendering: "geometricPrecision",
				"aria-hidden": true,
				style: { flex: "none", display: "block" },
				children: [
					jsx("path", { d: "M0.347656 22.254H6.6917L3.81945 13.22C3.76717 13.05 3.58591 12.958 3.41859 13.0111C3.32099 13.043 3.2443 13.1208 3.21293 13.22L0.347656 22.254Z", fill: "#00DCFF" }),
					jsx("path", { d: "M15.7734 22.2655H23.1353L19.7576 11.6243C19.7053 11.4543 19.5241 11.3623 19.3568 11.4154C19.2592 11.4473 19.1825 11.5251 19.1511 11.6243L15.7734 22.2655Z", fill: "#00DCFF" }),
					jsx("path", { d: "M7.01172 22.2654H20.5922L14.1052 1.9564C14.0494 1.78648 13.8717 1.69444 13.7043 1.75108C13.6067 1.78294 13.5301 1.86082 13.4987 1.9564L7.01172 22.2654Z", fill: "#006AFF" }),
					jsx("path", { d: "M2.8863 22.2674H13.1657L8.32754 7.11265C8.27176 6.94273 8.09399 6.85069 7.92668 6.90733C7.82908 6.93919 7.75239 7.01707 7.72102 7.11265L2.88281 22.2674H2.8863Z", fill: "#006AFF" }),
					jsx("path", { d: "M5.73438 22.2673H14.4278L10.3844 9.67906C10.3286 9.50914 10.1508 9.4171 9.98349 9.47374C9.88589 9.5056 9.81269 9.58348 9.78132 9.67906L5.73786 22.2673H5.73438Z", fill: "#00DCFF" })
				]
			});
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
						jsx("div", { style: { color: "var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary))", marginTop: "2px" }, children: "请在设置中检查访问密钥 AK/SK" })
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
							jsx(ArkLogo, { size: 14 }),
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
			var q = useQuota();
			React.useEffect(function () {
				// Re-read immediately after a credentials save (see refreshSignal).
				return refreshSignal.subscribe(function () { q.load(true); });
			}, [q]);
			if (!wide) return jsx(RailPill, { state: { data: q.data, error: q.error } });
			return jsx(Card, { state: { data: q.data, error: q.error }, loading: q.loading, onRefresh: function () { q.load(true); } });
		}

		function ArkQuotaSettingsCard() {
			var d = React.useState({ ak: "", sk: "" });
			var draft = d[0], setDraft = d[1];
			var s = React.useState({ loading: true, configured: false, saving: false, msg: null });
			var state = s[0], setState = s[1];
			var loadStatus = React.useCallback(function () {
				fetch("/ark-quota/status", { cache: "no-store" })
					.then(function (r) { return r.json(); })
					.then(function (json) {
						setState(function (prev) { return { ...prev, loading: false, configured: !!(json && json.ok === true && json.configured) }; });
					})
					.catch(function () {
						setState(function (prev) { return { ...prev, loading: false }; });
					});
			}, []);
			React.useEffect(function () { loadStatus(); }, [loadStatus]);
			var onSave = function () {
				if (!draft.ak && !draft.sk) {
					setState(function (prev) { return { ...prev, msg: "未填写任何值" }; });
					return;
				}
				setState(function (prev) { return { ...prev, saving: true, msg: null }; });
				fetch("/ark-quota/credentials", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						accessKeyId: draft.ak || undefined,
						secretAccessKey: draft.sk || undefined
					})
				})
					.then(function (r) { return r.json(); })
					.then(function (json) {
						if (json && json.ok === true) {
							setDraft({ ak: "", sk: "" });
							setState({ loading: false, saving: false, configured: !!json.configured, msg: "已保存并热生效（无需重启）" });
							refreshSignal.notify();
						} else {
							setState(function (prev) { return { ...prev, saving: false, msg: (json && json.message) || "保存失败" }; });
						}
					})
					.catch(function (e) {
						setState(function (prev) { return { ...prev, saving: false, msg: "保存失败：" + String((e && e.message) || e) }; });
					});
			};
			var inputStyle = {
				boxSizing: "border-box", width: "100%", padding: "6px 8px", fontSize: "12px", lineHeight: "16px",
				color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-input, var(--dsw-alias-bg-base))",
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))", borderRadius: "6px"
			};
			var configured = state.configured;
			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "8px", maxWidth: "520px" },
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "8px" },
						children: [
							jsx(ArkLogo, { size: 16 }),
							jsx("span", { style: { fontWeight: "600", fontSize: "13px", lineHeight: "20px", color: "var(--dsw-alias-label-primary)" }, children: "方舟额度 · 访问密钥" }),
							jsx("span", { style: { fontSize: "11px", lineHeight: "16px", color: configured ? "var(--dsw-alias-state-success-primary, #46a758)" : "var(--dsw-alias-label-tertiary)" }, children: configured ? "已配置" : "未配置" })
						]
					}),
					jsx("div", {
						style: { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)" },
						children: "在火山控制台 → 访问控制 → API 访问密钥 创建。密钥仅存于本地 settings.yaml，保存后立即生效（无需重启 DSH）。留空则不修改对应项。"
					}),
					jsx("label", {
						style: { display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" },
						children: [
							jsx("span", { children: "AccessKey ID" }, "ak-label"),
							jsx("input", {
								type: "text", autoComplete: "off", spellCheck: false,
								placeholder: configured ? "（已配置，留空不变）" : "输入 AccessKey ID",
								value: draft.ak,
								onChange: function (e) { setDraft({ ak: e.target.value, sk: draft.sk }); },
								style: inputStyle
							}, "ak-input")
						]
					}),
					jsx("label", {
						style: { display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" },
						children: [
							jsx("span", { children: "Secret Access Key" }, "sk-label"),
							jsx("input", {
								type: "password", autoComplete: "off", spellCheck: false,
								placeholder: configured ? "（已配置，留空不变）" : "输入 Secret Access Key",
								value: draft.sk,
								onChange: function (e) { setDraft({ ak: draft.ak, sk: e.target.value }); },
								style: inputStyle
							}, "sk-input")
						]
					}),
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "8px", marginTop: "2px" },
						children: [
							jsx("button", {
								type: "button",
								onClick: onSave,
								disabled: state.saving,
								style: {
									padding: "5px 12px", fontSize: "12px", lineHeight: "16px", borderRadius: "6px", cursor: "pointer",
									border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))",
									background: "var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base))",
									color: "var(--dsw-alias-label-primary)"
								},
								children: state.saving ? "保存中…" : "保存访问密钥"
							}),
							state.msg ? jsx("span", { style: { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)" }, children: state.msg }) : null
						]
					})
				]
			});
		}
		//#endregion
		//#region plugin entry
		var NS = "arkQuota";
		var inject = ["slots"];
		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", function () {
				return ctx.slots.register({
					name: "sidebar.footer.action",
					id: "ark-quota",
					order: 100,
					label: "方舟额度"
				}, ArkQuotaWidget);
			});
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register({
					name: "settings.section",
					id: "ark-quota",
					order: 200,
					label: "方舟额度"
				}, function (props) { return jsx(ArkQuotaSettingsCard, {}); });
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.NS = NS;
		return module.exports;
	}
});
