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
		//#region widget
		var DEFAULT_POLL_MS = 5 * 60 * 1000;
		// "session" is actually a 5-hour sliding window (AFPFiveHour / coding session),
		// "weekly"/"monthly" are rolling 7/30-day windows — use precise near-window labels.
		var LEVEL_LABELS = { session: "5小时", weekly: "近1周", monthly: "近1月" };
		var LEVEL_ORDER = ["session", "weekly", "monthly"];

		// UI preference: which percentage the big number shows.
		// "used" (default) shows consumption — industry convention for quota/usage widgets;
		// "remaining" shows budget left. The progress bar always fills by used %.
		var DISPLAY_KEY = "dsh-ark-quota:displayMode";
		var displayMode = "used";
		try {
			var dms = typeof window !== "undefined" && window.localStorage
				? window.localStorage.getItem(DISPLAY_KEY)
				: null;
			if (dms === "remaining" || dms === "used") displayMode = dms;
		} catch (_e) { /* localStorage may be unavailable; keep default */ }

		var displaySignal = {
			listeners: new Set(),
			subscribe: function (fn) {
				displaySignal.listeners.add(fn);
				return function () { displaySignal.listeners.delete(fn); };
			},
			notify: function () {
				for (var fn of Array.from(displaySignal.listeners)) {
					try { fn(displayMode); } catch (_e) { /* keep other listeners alive */ }
				}
			}
		};

		function applyDisplayMode(next) {
			// 非法值回落到默认的 "used"（已用），与 displayMode 初始值保持一致。
			var v = next === "remaining" ? "remaining" : "used";
			if (v === displayMode) return;
			displayMode = v;
			displaySignal.notify();
		}

		function setDisplayMode(next) {
			applyDisplayMode(next);
			try { window.localStorage.setItem(DISPLAY_KEY, displayMode); } catch (_e) { /* ignore */ }
		}

		function useDisplayMode() {
			var dmState = React.useState(displayMode);
			var dm = dmState[0], setDm = dmState[1];
			React.useEffect(function () {
				return displaySignal.subscribe(function (v) { setDm(v); });
			}, []);
			React.useEffect(function () {
				var onStorage = function (e) {
					if (e && e.key === DISPLAY_KEY) applyDisplayMode(e.newValue);
				};
				window.addEventListener("storage", onStorage);
				return function () { window.removeEventListener("storage", onStorage); };
			}, []);
			return dm;
		}

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
			var p = clampPct(percent);
			if (p >= 80) return "#e5484d";
			if (p >= 50) return "#f5a524";
			return "#46a758";
		}

		// 进度条填充色：与 colorOf 同一套阈值（<50% 绿、50~80% 橙、≥80% 红），
		// 每档在自身色系内做「浅 → 主色」渐变，只为让填充块有立体层次，
		// 换色仍是按阈值跳变，不跨色系。
		// colorOf 保持纯色返回（rail 药丸背景靠它拼 alpha，不能给渐变）。
		function fillOf(percent) {
			var p = clampPct(percent);
			if (p >= 80) return "linear-gradient(90deg, #f16a6d, #e5484d)";
			if (p >= 50) return "linear-gradient(90deg, #ffc95c, #f5a524)";
			return "linear-gradient(90deg, #63c07c, #46a758)";
		}

		// 进度条轨道底色：与填充同色系，但很淡（~15% 不透明度）。
		// 颜色也按阈值切换，让整个条的"色系温度"随用量变化，而不是永远灰底。
		function trackOf(percent) {
			var p = clampPct(percent);
			if (p >= 80) return "rgba(229, 72, 77, 0.18)";
			if (p >= 50) return "rgba(245, 165, 36, 0.18)";
			return "rgba(70, 167, 88, 0.18)";
		}

		function pad2(n) { return (n < 10 ? "0" : "") + n; }

		// Precise countdown for the card itself: "3 小时 15 分钟后重置",
		// "2 天 3 小时后重置", etc. Only the two most significant units are shown
		// (days+hours, or hours+minutes) so it stays readable at a glance.
		function fmtReset(ts, now) {
			if (!ts) return "";
			var diff = ts * 1000 - now;
			if (diff <= 0) return "已重置";
			var totalMinutes = Math.floor(diff / 60000);
			if (totalMinutes < 60) {
				return Math.max(1, totalMinutes) + " 分钟后重置";
			}
			var hours = Math.floor(totalMinutes / 60);
			var mins = totalMinutes % 60;
			if (hours < 24) {
				return mins > 0 ? hours + " 小时 " + mins + " 分钟后重置" : hours + " 小时后重置";
			}
			var days = Math.floor(hours / 24);
			var remHours = hours % 24;
			return remHours > 0 ? days + " 天 " + remHours + " 小时后重置" : days + " 天后重置";
		}

		// 紧凑倒计时，用于卡片行内的重置时间：5d16h / 4h12m / 12m。
		// 只保留最高两位单位，宽度固定，便于与百分比并排显示。
		function fmtResetShort(ts, now) {
			if (!ts) return "";
			var diff = ts * 1000 - now;
			if (diff <= 0) return "已重置";
			var totalMinutes = Math.floor(diff / 60000);
			if (totalMinutes < 60) return Math.max(1, totalMinutes) + "m";
			var hours = Math.floor(totalMinutes / 60);
			var mins = totalMinutes % 60;
			if (hours < 24) return mins > 0 ? hours + "h" + mins + "m" : hours + "h";
			var days = Math.floor(hours / 24);
			var remHours = hours % 24;
			return remHours > 0 ? days + "d" + remHours + "h" : days + "d";
		}

		// Absolute wall-clock time for tooltips: "今天 17:45 重置" /
		// "明天 00:00 重置" / "08-23 14:30 重置".
		function fmtResetAt(ts, now) {
			if (!ts) return "";
			var target = new Date(ts * 1000);
			var ref = new Date(now);
			var hhmm = pad2(target.getHours()) + ":" + pad2(target.getMinutes());
			if (target.getFullYear() === ref.getFullYear()
				&& target.getMonth() === ref.getMonth()
				&& target.getDate() === ref.getDate()) {
				return "今天 " + hhmm + " 重置";
			}
			var tomorrow = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + 1);
			if (target.getFullYear() === tomorrow.getFullYear()
				&& target.getMonth() === tomorrow.getMonth()
				&& target.getDate() === tomorrow.getDate()) {
				return "明天 " + hhmm + " 重置";
			}
			return pad2(target.getMonth() + 1) + "-" + pad2(target.getDate()) + " " + hhmm + " 重置";
		}

		function fmtClockMs(ms) {
			if (!ms) return "";
			var d = new Date(ms);
			return pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
		}

		function clampPct(n) {
			if (typeof n !== "number" || !Number.isFinite(n)) return 0;
			if (n < 0) return 0;
			if (n > 100) return 100;
			return n;
		}

		// Host cachedAt is Date.now() (ms). Unix seconds (~1.7e9) would schedule
		// in the past and Math.max(500, …) would hammer every 500ms — treat
		// values below 1e12 as seconds.
		function normalizeCachedAtMs(v) {
			if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return Date.now();
			return v < 1e12 ? v * 1000 : v;
		}

		function fetchedAtMs(data) {
			if (!data) return 0;
			if (typeof data.cachedAt === "number" && data.cachedAt > 0) return normalizeCachedAtMs(data.cachedAt);
			if (typeof data.updatedAt === "number" && data.updatedAt > 0) return data.updatedAt * 1000;
			return 0;
		}

		// "x 分钟前更新" / "刚刚更新". Driven by useNow so it ticks every minute
		// without a network refetch. `atMs` is milliseconds since epoch.
		function fmtRelativeMs(atMs, now) {
			if (!atMs) return "";
			var diff = Math.max(0, now - atMs);
			var m = Math.floor(diff / 60000);
			if (m < 1) return "刚刚更新";
			if (m < 60) return m + " 分钟前更新";
			var h = Math.floor(m / 60);
			if (h < 24) return h + " 小时前更新";
			return Math.floor(h / 24) + " 天前更新";
		}

		// Compact absolute counts for the tooltip (e.g. 12345 -> "12,345").
		function fmtCount(n) {
			if (typeof n !== "number" || !Number.isFinite(n)) return "";
			return Math.round(n).toLocaleString("en-US");
		}

		var PLAN_LABELS = { "coding-plan": "Coding Plan", "agent-plan": "Agent Plan" };

		// A 1-minute tick used purely for display-local countdowns (reset countdown,
		// relative time). It does NOT trigger any network request — the adaptive
		// setTimeout poll in useQuota owns that.
		function useNow() {
			var now = React.useState(function () { return Date.now(); });
			var setNow = now[1];
			React.useEffect(function () {
				var t = window.setInterval(function () { setNow(Date.now()); }, 60000);
				return function () { window.clearInterval(t); };
			}, [setNow]);
			return now[0];
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

		// Schedule the next poll to land just AFTER the host cache expires, not
		// on a fixed blind interval. Equal-interval polling races the host TTL
		// (both 5 min) and can hit a not-yet-expired cache, leaving the widget
		// showing "6 min ago · refreshes every 5 min". Using the server-provided
		// cachedAt + refreshMs plus a small buffer guarantees the next request
		// gets a fresh upstream fetch.
		var POLL_BUFFER_MS = 1500;
		function scheduleNext(timerRef, json, load) {
			if (timerRef.current) window.clearTimeout(timerRef.current);
			var refreshMs = (typeof json.refreshMs === "number" && json.refreshMs > 0) ? json.refreshMs : DEFAULT_POLL_MS;
			var cachedAt = normalizeCachedAtMs(json.cachedAt);
			var nextAt = cachedAt + refreshMs + POLL_BUFFER_MS;
			var delay = Math.max(1000, nextAt - Date.now());
			timerRef.current = window.setTimeout(function () { load(false); }, delay);
		}

		function useQuota() {
			var state = React.useState({ loading: true, data: null, error: null });
			var data = state[0], setState = state[1];
			var timerRef = React.useRef(null);
			var abortRef = React.useRef(null);
			var seqRef = React.useRef(0);
			var refreshMsRef = React.useRef(DEFAULT_POLL_MS);
			var load = React.useCallback(function (force) {
				var seq = ++seqRef.current;
				if (abortRef.current) abortRef.current.abort();
				var ac = typeof AbortController === "function" ? new AbortController() : null;
				abortRef.current = ac;
				setState(function (prev) {
					var initial = !prev.data && !prev.error;
					return {
						loading: !!(force || initial),
						data: prev.data,
						error: force || initial ? null : prev.error
					};
				});
				var opts = { cache: "no-store" };
				if (ac) opts.signal = ac.signal;
				fetch("/ark-quota" + (force ? "?force=1" : ""), opts)
					.then(function (r) { return r.json(); })
					.then(function (json) {
						if (seq !== seqRef.current) return;
						if (json && json.ok === true) {
							if (typeof json.refreshMs === "number" && json.refreshMs > 0) refreshMsRef.current = json.refreshMs;
							setState({ loading: false, data: json, error: null });
							scheduleNext(timerRef, json, load);
						} else {
							var auth = json && (json.code === "unauthorized" || json.code === "missing-auth");
							setState({ loading: false, data: null, error: (json && json.message) || "查询失败" });
							if (timerRef.current) window.clearTimeout(timerRef.current);
							// Auth failures: don't inherit a 1-minute cadence (would hammer
							// Volcengine with a bad key). Transient errors follow last cadence.
							var retryMs = auth ? DEFAULT_POLL_MS : refreshMsRef.current;
							timerRef.current = window.setTimeout(function () { load(false); }, retryMs);
						}
					})
					.catch(function (e) {
						if (e && e.name === "AbortError") return;
						if (seq !== seqRef.current) return;
						setState({ loading: false, data: null, error: String((e && e.message) || e) });
						if (timerRef.current) window.clearTimeout(timerRef.current);
						timerRef.current = window.setTimeout(function () { load(false); }, refreshMsRef.current);
					});
			}, []);
			React.useEffect(function () {
				load(false);
				return function () {
					seqRef.current += 1;
					if (timerRef.current) window.clearTimeout(timerRef.current);
					if (abortRef.current) abortRef.current.abort();
				};
			}, [load]);
			return { data: data.data, loading: data.loading, error: data.error, load: load };
		}

		// 请求统计的取数节奏：自适应。宿主是实时记账的（请求一开始就计数），
		// 延迟只来自这里的轮询间隔，所以有动静时压到 2 秒、连续没动静再降速，
		// 页面切到后台时干脆停掉。/ark-quota/stats 是纯内存折叠的本机路由，
		// 2 秒一次的成本可以忽略（不碰上游、不碰磁盘）。
		var STATS_FAST_MS = 2000;
		var STATS_IDLE_MS = 30000;
		// 连续这么多次拉取都没有新请求，才降到空闲节奏（2s × 5 = 10 秒静默）。
		var STATS_IDLE_AFTER = 5;

		function statsDelay(quiet) {
			return quiet >= STATS_IDLE_AFTER ? STATS_IDLE_MS : STATS_FAST_MS;
		}

		// 「有没有新动静」的指纹：总数 + 成败数。只比总数会漏掉
		// 「请求已开始→随后结束」这一步（total 不变但成功率变了）。
		function statsFingerprint(json) {
			return [json.total, json.succeeded, json.failed].join(":");
		}

		// 请求统计的客户端取数。宿主没装新版时路由 404，此时 stats 为 null，
		// UI 自动隐藏，并且不再重试（避免每 2 秒一次无用的 404）。
		function useStats() {
			var s = React.useState({ data: null, loading: true, error: null });
			var state = s[0], setState = s[1];
			var timerRef = React.useRef(null);
			var printRef = React.useRef("");
			var quietRef = React.useRef(0);
			var loadRef = React.useRef(null);
			var stoppedRef = React.useRef(false);
			var load = React.useCallback(function () {
				if (timerRef.current) {
					window.clearTimeout(timerRef.current);
					timerRef.current = null;
				}
				// 后台标签页不轮询：切回前台时 visibilitychange 会立刻补一次。
				if (typeof document !== "undefined" && document.hidden) {
					timerRef.current = window.setTimeout(function () {
						if (loadRef.current) loadRef.current();
					}, STATS_IDLE_MS);
					return;
				}
				var arm = function () {
					if (stoppedRef.current) return;
					if (timerRef.current) window.clearTimeout(timerRef.current);
					timerRef.current = window.setTimeout(function () {
						if (loadRef.current) loadRef.current();
					}, statsDelay(quietRef.current));
				};
				fetch("/ark-quota/stats", { cache: "no-store" })
					.then(function (r) {
						if (r.status === 404) throw new Error("stats-route-missing");
						return r.json();
					})
					.then(function (json) {
						if (json && json.ok === true) {
							var print = statsFingerprint(json);
							if (print !== printRef.current) {
								printRef.current = print;
								quietRef.current = 0; // 有新动静 → 回到 2 秒快档
							} else {
								quietRef.current += 1; // 静默累积 → 逐步降到 30 秒
							}
							setState({ data: json, loading: false, error: null });
						} else {
							setState({ data: null, loading: false, error: (json && json.message) || "统计不可用" });
							quietRef.current = STATS_IDLE_AFTER;
						}
						arm();
					})
					.catch(function (e) {
						var msg = String((e && e.message) || e);
						if (msg === "stats-route-missing") {
							// 旧宿主：整段隐藏并停止轮询，等 refreshSignal 再试。
							stoppedRef.current = true;
							setState({ data: null, loading: false, error: null });
							return;
						}
						setState({ data: null, loading: false, error: msg });
						quietRef.current = STATS_IDLE_AFTER;
						arm();
					});
			}, []);
			loadRef.current = load;
			React.useEffect(function () {
				load();
				return function () {
					if (timerRef.current) window.clearTimeout(timerRef.current);
				};
			}, [load]);
			// 切回前台立刻补一次，别让用户盯着过期数字。
			React.useEffect(function () {
				var onVisible = function () {
					if (typeof document !== "undefined" && !document.hidden) {
						quietRef.current = 0;
						load();
					}
				};
				document.addEventListener("visibilitychange", onVisible);
				return function () { document.removeEventListener("visibilitychange", onVisible); };
			}, [load]);
			// 凭证保存后刷新一次（宿主刚升级时这是第一次拿到数据的机会）。
			React.useEffect(function () {
				return refreshSignal.subscribe(function () {
					stoppedRef.current = false;
					quietRef.current = 0;
					load();
				});
			}, [load]);
			return state;
		}

		// 时间跨度的简短标签：33 分钟 / 3.3 小时 / 4 天。
		function fmtSpan(ms) {
			if (!ms || ms <= 0) return "0 分钟";
			var mins = Math.floor(ms / 60000);
			if (mins < 60) return mins + " 分钟";
			var hours = mins / 60;
			if (hours < 48) return (Math.round(hours * 10) / 10) + " 小时";
			return Math.floor(hours / 24) + " 天";
		}

		// 成功率的简短标签：99.8% / 100%；没有完成过请求时显示 —。
		function fmtRate(rate) {
			if (rate === null || rate === undefined || Number.isNaN(rate)) return "—";
			if (rate >= 0.9995) return "100%";
			return (Math.round(rate * 1000) / 10) + "%";
		}

		// 健康分档 → 颜色。分档由宿主给出（按成功率算），客户端只取色。
		// 沿用业界 status strip 的三档语义：正常 / 降级 / 故障，外加"无数据"。
		var STATUS_COLORS = {
			ok: "#46a758",
			degraded: "#f5a524",
			outage: "#e5484d",
			empty: "var(--dsw-alias-track-bg, rgba(128,128,128,0.14))"
		};
		var STATUS_LABELS = {
			ok: "正常",
			degraded: "降级",
			outage: "故障",
			empty: "无请求"
		};

		function statusColor(status) {
			return Object.prototype.hasOwnProperty.call(STATUS_COLORS, status)
				? STATUS_COLORS[status]
				: STATUS_COLORS.empty;
		}

		function statusLabel(status) {
			return Object.prototype.hasOwnProperty.call(STATUS_LABELS, status)
				? STATUS_LABELS[status]
				: STATUS_LABELS.empty;
		}

		// 成功率对应的颜色：与单点分档同一套阈值，保证条与汇总数字口径一致。
		function rateColor(rate) {
			if (rate === null || rate === undefined || Number.isNaN(rate)) return "var(--dsw-alias-label-tertiary)";
			if (rate >= 0.99) return STATUS_COLORS.ok;
			if (rate >= 0.95) return STATUS_COLORS.degraded;
			return STATUS_COLORS.outage;
		}

		// 单个健康点的颜色：读宿主给的分档，不再自己按 fail>0 判定。
		function dotColor(dot) {
			return statusColor(dot.status);
		}

		// 每个健康点的 tooltip：起止时间 + 分档 + 成功率 + 计数。
		// 成功率是这里的主角——只给计数会让"100 次挂 1 次"和"1 次挂 1 次"看起来一样。
		function dotTooltip(dot) {
			var from = fmtClockMs(dot.startMs);
			var to = fmtClockMs(dot.startMs + dot.spanMs);
			var total = dot.ok + dot.fail;
			var head = from + " → " + to;
			if (total === 0) return head + "\n无请求";
			return head
				+ "\n" + statusLabel(dot.status) + " · 成功率 " + fmtRate(dot.rate)
				+ "\n成功 " + dot.ok + " · 失败 " + dot.fail + " · 共 " + total;
		}

		// 顶部三列统计：请求总数 / 成功率 / 近 30 分钟。
		function StatsSummary(_a) {
			var stats = _a.stats;
			if (!stats) return null;
			var total = stats.total || 0;
			var rate = stats.rate;
			var recent = stats.recent || 0;
			// 在途请求：总数在请求"开始"时就 +1，而成败要等流结束才知道。
			// 近 30 分钟把在途的一起算进来，两个数字口径才一致——这里顺手
			// 在悬浮提示里交代清楚，免得再有人以为数字对不上。
			var inflight = stats.inflight || 0;
			var recentTip = "近 30 分钟发起的请求数"
				+ (inflight > 0 ? "\n其中 " + inflight + " 个仍在进行中（已计入总数）" : "");
			return jsxs("div", {
				style: { display: "flex", alignItems: "flex-end", gap: "12px", minWidth: 0 },
				children: [
					jsxs("div", {
						style: { flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" },
						title: "自 DSH 启动以来发起的模型请求总数（请求发出即计数）",
						children: [
							jsx("span", {
								style: { fontSize: "18px", lineHeight: "22px", fontWeight: "500", color: "var(--dsw-alias-label-primary)", fontVariantNumeric: "tabular-nums" },
								children: fmtCount(total)
							}),
							jsx("span", {
								style: { fontSize: "10px", lineHeight: "14px", color: "var(--dsw-alias-label-tertiary)" },
								children: "请求总数"
							})
						]
					}),
					jsxs("div", {
						style: { flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: "2px", alignItems: "center" },
						title: "成功率 = 成功数 / 已结束的请求数（在进行中的请求不参与）",
						children: [
							jsx("span", {
								style: { fontSize: "18px", lineHeight: "22px", fontWeight: "500", color: rateColor(rate), fontVariantNumeric: "tabular-nums" },
								children: fmtRate(rate)
							}),
							jsx("span", {
								style: { fontSize: "10px", lineHeight: "14px", color: "var(--dsw-alias-label-tertiary)" },
								children: "成功率"
							})
						]
					}),
					jsxs("div", {
						style: { flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: "2px", alignItems: "flex-end" },
						title: recentTip,
						children: [
							jsx("span", {
								style: { fontSize: "18px", lineHeight: "22px", fontWeight: "500", color: "var(--dsw-alias-label-primary)", fontVariantNumeric: "tabular-nums" },
								children: fmtCount(recent)
							}),
							jsx("span", {
								style: { fontSize: "10px", lineHeight: "14px", color: "var(--dsw-alias-label-tertiary)" },
								children: "近 30 分钟"
							})
						]
					})
				]
			});
		}

		// 健康条 + 右侧「最近 X 分钟 / 窗口成功率」。
		// 布局照业界 status strip：标题在左，观测窗口与总体状态在右，条在下。
		function HealthStrip(_a) {
			var stats = _a.stats;
			if (!stats) return null;
			var dots = stats.dots || [];
			var rate = stats.windowRate;
			var span = stats.windowMs;
			var sampled = stats.windowSampledDots || 0;
			// 整条都没样本时不摆一个空的 "—%"：直接说明这段时间没有请求。
			var summary = sampled === 0
				? jsx("span", {
					style: { fontSize: "10px", lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)" },
					children: "暂无请求"
				})
				: jsx("span", {
					style: { fontSize: "12px", lineHeight: "16px", fontWeight: "500", color: rateColor(rate), fontVariantNumeric: "tabular-nums" },
					children: fmtRate(rate)
				});
			return jsxs("div", {
				// 整条的 tooltip 说明口径，避免用户把"灰点"误读成故障。
				title: "每格 " + fmtSpan(stats.dotSpanMs) + "，按该格成功率上色："
					+ "≥99% 正常、≥95% 降级、<95% 故障；灰色为无请求。"
					+ "\n窗口成功率只统计有请求的格子（" + sampled + "/" + dots.length + "）。",
				style: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 },
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "baseline", gap: "6px", minWidth: 0 },
						children: [
							jsx("span", {
								style: { fontSize: "11px", lineHeight: "16px", fontWeight: "500", color: "var(--dsw-alias-label-secondary)" },
								children: "健康"
							}),
							jsx("span", { style: { flex: "1", minWidth: 0 } }),
							jsx("span", {
								style: { fontSize: "10px", lineHeight: "14px", color: "var(--dsw-alias-label-tertiary)", fontVariantNumeric: "tabular-nums" },
								children: "最近 " + fmtSpan(span)
							}),
							summary
						]
					}),
					jsx("div", {
						style: { display: "flex", gap: "2px", minWidth: 0 },
						children: dots.map(function (dot, i) {
							return jsx("span", {
								title: dotTooltip(dot),
								style: {
									flex: "1 1 0", minWidth: 0, height: "8px",
									borderRadius: "2px", background: dotColor(dot),
									transition: "background .3s"
								}
							}, "dot-" + i);
						})
					})
				]
			});
		}

		function rowTooltip(item, now) {
			var usedPct = clampPct(item.percentUsed);
			var remPct = clampPct(item.percentRemaining);
			var parts = ["已用 " + usedPct.toFixed(1) + "% · 剩余 " + remPct.toFixed(1) + "%"];
			if (typeof item.used === "number" && typeof item.total === "number" && item.total > 0) {
				parts.push(fmtCount(item.used) + " / " + fmtCount(item.total));
			}
			if (item.resetAt) {
				// 卡片内只显示紧凑倒计时（5d16h），提示里补全精确倒计时与绝对时间。
				parts.push(fmtReset(item.resetAt, now));
				parts.push(fmtResetAt(item.resetAt, now));
			}
			return parts.join("\n");
		}

		function QuotaRow(_a) {
			var item = _a.item, now = _a.now, displayMode = _a.displayMode;
			var usedPct = clampPct(item.percentUsed);
			var remPct = clampPct(item.percentRemaining);
			var showPct = displayMode === "used" ? usedPct : remPct;
			var label = Object.prototype.hasOwnProperty.call(LEVEL_LABELS, item.level) ? LEVEL_LABELS[item.level] : item.level;
			var reset = fmtResetShort(item.resetAt, now);
			// Single tooltip on the whole row: hovering the label, bar, percentage,
			// or reset sub-line all shows the same detail (used/remaining %,
			// absolute counts if available, exact wall-clock reset time).
			var tip = rowTooltip(item, now);
			// 两行布局：上行「分类 …… 百分比 · 重置倒计时」，下行为整宽进度条。
			return jsxs("div", {
				title: tip,
				style: { display: "flex", flexDirection: "column", gap: "3px", minWidth: 0, cursor: "default" },
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "baseline", gap: "6px", minWidth: 0 },
						children: [
							jsx("span", {
								style: { flex: "1 1 auto", minWidth: 0, fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
								children: label
							}),
							jsx("span", {
								style: { flex: "none", fontSize: "11px", lineHeight: "16px", fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-primary)" },
								children: Math.round(showPct) + "%"
							}),
							reset ? jsx("span", {
								style: { flex: "none", fontSize: "10px", lineHeight: "16px", fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-tertiary)" },
								children: reset
							}) : null
						]
					}),
					jsx("div", {
						style: { width: "100%", minWidth: 0, height: "6px", borderRadius: "3px", background: trackOf(usedPct), overflow: "hidden", transition: "background .3s" },
						children: jsx("div", {
							// 常规填充：宽度 = 已用百分比，颜色按阈值切换（绿/橙/红）。
							style: { height: "100%", width: usedPct + "%", borderRadius: "3px", background: fillOf(usedPct), transition: "width .3s, background .3s" }
						})
					})
				]
			});
		}

		function PlanBadge(_a) {
			var plan = _a.plan;
			var label = Object.prototype.hasOwnProperty.call(PLAN_LABELS, plan) ? PLAN_LABELS[plan] : plan;
			return jsx("span", {
				title: "当前套餐：" + label,
				style: {
					flex: "none", padding: "0 5px", fontSize: "10px", lineHeight: "14px",
					borderRadius: "3px", color: "var(--dsw-alias-label-secondary)",
					background: "var(--dsw-alias-track-bg, rgba(128,128,128,0.18))",
					fontVariantNumeric: "tabular-nums"
				},
				children: label
			});
		}

		// 显示模式胶囊：点一下在「已用 / 剩余」之间切换，同时充当"当前看的是哪个值"
		// 的常驻提示——头部有它，卡片里的百分比就不会有歧义。
		function DisplayModePill(_a) {
			var dm = _a.displayMode;
			var used = dm === "used";
			return jsx("button", {
				type: "button",
				title: used ? "当前显示已用百分比，点击切换为剩余" : "当前显示剩余百分比，点击切换为已用",
				onClick: function () { setDisplayMode(used ? "remaining" : "used"); },
				style: {
					flex: "none", padding: "0 5px", height: "16px",
					display: "inline-flex", alignItems: "center",
					border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2))",
					borderRadius: "3px", cursor: "pointer",
					background: "transparent", color: "var(--dsw-alias-label-secondary)",
					fontSize: "10px", lineHeight: "14px"
				},
				children: used ? "已用" : "剩余"
			});
		}

		function RefreshButton(_a) {
			var onClick = _a.onClick, title = _a.title, spinning = _a.spinning, disabled = _a.disabled;
			// 懒注入一次 keyframes：刷新按钮全局只需要这一段，且不能塞到 style 属性里。
			// 用 id 幂等——重复注入只替换内容，不会堆。
			if (typeof document !== "undefined" && !document.getElementById("dsh-ark-quota-keyframes")) {
				var style = document.createElement("style");
				style.id = "dsh-ark-quota-keyframes";
				style.textContent =
					"@keyframes dsh-ark-quota-spin {" +
						"from { transform: rotate(0deg); }" +
						"to { transform: rotate(360deg); }" +
					"}";
				document.head.appendChild(style);
			}
			var iconStyle = {
				display: "inline-block",
				lineHeight: "1",
				transform: "translateY(-1px)"
			};
			if (spinning) {
				iconStyle.animation = "dsh-ark-quota-spin 0.8s linear infinite";
			}
			var btnStyle = {
				flex: "none", width: "18px", height: "18px", display: "inline-flex",
				alignItems: "center", justifyContent: "center", padding: "0",
				border: "none", borderRadius: "4px",
				cursor: disabled ? "not-allowed" : "pointer",
				background: "transparent",
				color: disabled ? "var(--dsw-alias-label-tertiary)" : "var(--dsw-alias-label-secondary)",
				fontSize: "12px", lineHeight: "1",
				opacity: disabled ? 0.6 : 1,
				transition: "opacity .2s"
			};
			return jsx("button", {
				type: "button",
				title: title,
				disabled: disabled,
				onClick: onClick,
				style: btnStyle,
				"aria-busy": spinning ? "true" : "false",
				children: jsx("span", { style: iconStyle, children: "⟳" })
			});
		}

		// Human-readable cadence label (e.g. "每 1 分钟自动刷新" / "每 30 分钟自动刷新").
		// 只在刷新按钮的 title 里使用，不占卡片版面。
		function refreshCadence(refreshMs) {
			var ms = (typeof refreshMs === "number" && refreshMs > 0) ? refreshMs : DEFAULT_POLL_MS;
			if (ms < 60000) return "每 " + Math.round(ms / 1000) + " 秒自动刷新";
			var mins = Math.round(ms / 60000);
			if (mins >= 60 && mins % 60 === 0) return "每 " + (mins / 60) + " 小时自动刷新";
			return "每 " + mins + " 分钟自动刷新";
		}

		function Card(_a) {
			var state = _a.state, onRefresh = _a.onRefresh, loading = _a.loading, dm = _a.displayMode, stats = _a.stats;
			var now = useNow();
			var data = state.data;
			var cardOuter = {
				boxSizing: "border-box", width: "100%", minWidth: 0,
				padding: "10px 12px", display: "flex", flexDirection: "column", gap: "8px",
				borderRadius: "10px", overflow: "hidden",
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2))",
				background: "var(--dsw-alias-bg-base, transparent)",
				// Subpixel antialiasing for crisp text on Windows.
				WebkitFontSmoothing: "antialiased",
				MozOsxFontSmoothing: "grayscale"
			};
			if (state.error) {
				return jsxs("div", {
					style: Object.assign({}, cardOuter, { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-state-error-primary, #e5484d)" }),
					children: [
						jsxs("div", {
							style: { display: "flex", alignItems: "center", gap: "6px" },
							children: [
								jsx(ArkLogo, { size: 14 }),
								jsx("span", { style: { flex: "1", fontWeight: "500" }, children: "方舟额度" }),
								jsx(RefreshButton, { onClick: onRefresh, title: "立即重试" })
							]
						}),
						jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", wordBreak: "break-all", minWidth: 0 }, children: state.error }),
						jsx("div", { style: { color: "var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary))" }, children: "请在 设置 → 方舟额度 中检查访问密钥 AK/SK" })
					]
				});
			}
			var quota = data ? data.quota : [];
			var rows = LEVEL_ORDER
				.map(function (level) { return quota.find(function (q) { return q.level === level; }); })
				.filter(Boolean);
			var fetched = fetchedAtMs(data);
			return jsxs("div", {
				style: cardOuter,
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0, marginBottom: "2px" },
						children: [
							jsx(ArkLogo, { size: 15 }),
							jsx("span", {
								style: { flex: "none", fontSize: "12px", fontWeight: "500", lineHeight: "18px", color: "var(--dsw-alias-label-primary)" },
								children: "方舟额度"
							}),
							data && data.plan ? jsx(PlanBadge, { plan: data.plan }) : null,
							jsx("span", { style: { flex: "1", minWidth: 0 } }),
							// 头部右侧 = 操作区：显示模式胶囊 + 刷新按钮。
							// 刷新节奏不占版面，合并到刷新按钮的 title 里。
							jsx(DisplayModePill, { displayMode: dm }),
							// 刷新状态只靠图标转圈 + 禁用表达，不再占一行「刷新中…」文字。
							jsx(RefreshButton, {
								onClick: onRefresh,
								spinning: loading,
								disabled: loading,
								title: loading
									? "刷新中…"
									: (data ? "立即刷新 · " + refreshCadence(data.refreshMs) : "立即刷新")
							})
						]
					}),
					// 统计区：上排三列数字（总数 / 成功率 / 近 30 分钟），下排健康点状图。
					// 宿主未提供 /ark-quota/stats 时 stats 为 null，整段隐藏。
					stats ? jsx(StatsSummary, { stats: stats }) : null,
					stats ? jsx(HealthStrip, { stats: stats }) : null,
					stats ? jsx("div", {
						style: { height: "1px", background: "var(--dsw-alias-border-l2, rgba(128,128,128,0.15))", margin: "1px 0" }
					}) : null,
					jsx("div", {
						style: { display: "flex", flexDirection: "column", gap: "8px", minWidth: 0 },
						children: rows.length > 0 ? rows.map(function (item) {
							return jsx(QuotaRow, { item: item, now: now, displayMode: dm }, item.level);
						}) : jsx("div", {
							style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" },
							children: "暂无额度数据"
						})
					}),
					data && fetched ? jsxs("div", {
						// 底部 = 信息区：奖励徽章靠左，更新时间靠右下角。
						style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "10px", lineHeight: "14px", color: "var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary))", marginTop: "2px" },
						children: [
							data.hasReward ? jsxs("span", {
								title: "该套餐含额外奖励额度",
								style: { flex: "none", display: "inline-flex", alignItems: "center", gap: "3px", color: "var(--dsw-alias-state-info-primary, #0ea5e9)" },
								children: [
									jsx("span", { style: { width: "6px", height: "6px", borderRadius: "50%", background: "#0ea5e9" } }),
									"含奖励额度"
								]
							}) : null,
							jsx("span", { style: { flex: "1", minWidth: 0 } }),
							jsx("span", {
								title: "上次更新：" + fmtClockMs(fetched),
								style: { flex: "none", fontVariantNumeric: "tabular-nums" },
								children: fmtRelativeMs(fetched, now)
							})
						]
					}) : null
				]
			});
		}

		function RailPill(_a) {
			var state = _a.state, dm = _a.displayMode;
			var quota = state.data ? state.data.quota : [];
			var monthly = quota.find(function (q) { return q.level === "monthly"; });
			var showUsed = dm === "used";
			var pct = monthly ? clampPct(showUsed ? monthly.percentUsed : monthly.percentRemaining) : null;
			var label = showUsed ? "近1月已用 " : "近1月剩余 ";
			return jsx("button", {
				type: "button",
				title: pct === null ? "方舟额度（无数据）" : "方舟额度 · " + label + Math.round(pct) + "%" + (state.error ? " · " + state.error : ""),
				onClick: function () {},
				style: {
					flex: "none", minWidth: "30px", height: "22px", padding: "0 7px",
					display: "inline-flex", alignItems: "center", justifyContent: "center",
					borderRadius: "999px", cursor: "default",
					border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2))",
					background: monthly ? colorOf(monthly.percentUsed) + "1a" : "var(--dsw-alias-bg-base, transparent)",
					color: "var(--dsw-alias-label-primary)", fontSize: "11px", fontVariantNumeric: "tabular-nums"
				},
				children: pct === null ? (state.error ? "!" : "—") : Math.round(pct) + "%"
			});
		}

		function ArkQuotaWidget(_a) {
			var wide = _a.wide;
			var q = useQuota();
			var dm = useDisplayMode();
			// 统计只在宽卡片里渲染；rail 药丸空间不够，保持只显示额度百分比。
			var st = useStats();
			var reload = q.load;
			React.useEffect(function () {
				// Re-read immediately after a credentials/settings save (see refreshSignal).
				return refreshSignal.subscribe(function () { reload(true); });
			}, [reload]);
			if (!wide) return jsx(RailPill, { state: { data: q.data, error: q.error }, displayMode: dm });
			return jsx(Card, {
				state: { data: q.data, error: q.error },
				loading: q.loading,
				displayMode: dm,
				stats: st.data,
				onRefresh: function () { reload(true); }
			});
		}

		// Fixed refresh cadence choices the host's /ark-quota/settings route accepts.
		var REFRESH_CHOICES = [
			{ ms: 60000, label: "每 1 分钟" },
			{ ms: 300000, label: "每 5 分钟（默认）" },
			{ ms: 600000, label: "每 10 分钟" },
			{ ms: 1800000, label: "每 30 分钟" },
			{ ms: 3600000, label: "每 1 小时" }
		];

		function SelectField(_a) {
			var label = _a.label, value = _a.value, onChange = _a.onChange, options = _a.options, hint = _a.hint, disabled = _a.disabled;
			var selectStyle = {
				boxSizing: "border-box", padding: "4px 8px", fontSize: "12px", lineHeight: "16px",
				color: "var(--dsw-alias-label-primary)",
				background: "var(--dsw-alias-bg-input, var(--dsw-alias-bg-base))",
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))",
				borderRadius: "6px", cursor: disabled ? "wait" : "pointer", opacity: disabled ? 0.6 : 1
			};
			return jsxs("div", {
				style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" },
				children: [
					jsx("span", { style: { flex: "none", minWidth: "64px" }, children: label }),
					jsxs("select", { value: value, onChange: onChange, style: selectStyle, disabled: disabled, children:
						options.map(function (o) { return jsx("option", { value: String(o.value), children: o.label }, String(o.value)); })
					}),
					hint ? jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)" }, children: hint }) : null
				]
			});
		}

		function ArkQuotaSettingsCard() {
			var d = React.useState({ ak: "", sk: "" });
			var draft = d[0], setDraft = d[1];
			var s = React.useState({ loading: true, configured: false, saving: false, msg: null, refreshMs: DEFAULT_POLL_MS, savingRefresh: false });
			var state = s[0], setState = s[1];
			var dm = useDisplayMode();
			var loadStatus = React.useCallback(function () {
				fetch("/ark-quota/status", { cache: "no-store" })
					.then(function (r) { return r.json(); })
					.then(function (json) {
						setState(function (prev) {
							return {
								...prev, loading: false,
								configured: !!(json && json.ok === true && json.configured),
								refreshMs: (json && typeof json.refreshMs === "number" && json.refreshMs > 0) ? json.refreshMs : DEFAULT_POLL_MS
							};
						});
					})
					.catch(function () {
						setState(function (prev) { return { ...prev, loading: false }; });
					});
			}, []);
			React.useEffect(function () { loadStatus(); }, [loadStatus]);
			var onDisplayChange = function (e) {
				setDisplayMode(e.target.value);
			};
			var onRefreshChange = function (e) {
				var ms = Number(e.target.value);
				if (!(ms > 0)) return;
				setState(function (prev) { return { ...prev, savingRefresh: true }; });
				fetch("/ark-quota/settings", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ refreshMs: ms })
				})
					.then(function (r) { return r.json(); })
					.then(function (json) {
						if (json && json.ok === true) {
							setState(function (prev) { return { ...prev, savingRefresh: false, refreshMs: ms, configured: !!json.configured }; });
							refreshSignal.notify(); // cards re-read immediately and re-arm their poll timer
						} else {
							setState(function (prev) { return { ...prev, savingRefresh: false, msg: (json && json.message) || "保存失败" }; });
						}
					})
					.catch(function (err) {
						setState(function (prev) { return { ...prev, savingRefresh: false, msg: "保存失败：" + String((err && err.message) || err) }; });
					});
			};
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
							setState(function (prev) {
								return {
									...prev,
									loading: false,
									saving: false,
									savingRefresh: false,
									configured: !!json.configured,
									refreshMs: (json && typeof json.refreshMs === "number" && json.refreshMs > 0)
										? json.refreshMs
										: prev.refreshMs,
									msg: "已保存并热生效（无需重启）"
								};
							});
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
							jsx("span", { style: { fontWeight: "500", fontSize: "13px", lineHeight: "20px", color: "var(--dsw-alias-label-primary)" }, children: "方舟额度 · 访问密钥" }),
							jsx("span", { style: { fontSize: "11px", lineHeight: "16px", color: configured ? "var(--dsw-alias-state-success-primary, #46a758)" : "var(--dsw-alias-label-tertiary)" }, children: configured ? "已配置" : "未配置" })
						]
					}),
					jsx("div", {
						style: { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)" },
						children: "在火山控制台 → 访问控制 → API 访问密钥 创建。密钥仅存于本地 settings.yaml，保存后立即生效（无需重启 DSH）。留空则不修改对应项。"
					}),
					jsx("div", {
						style: { height: "1px", background: "var(--dsw-alias-border-l2, rgba(128,128,128,0.15))", margin: "2px 0" }
					}),
					jsx(SelectField, {
						label: "显示方式",
						value: dm,
						onChange: onDisplayChange,
						hint: "进度条始终按已用比例填充",
						options: [
							{ value: "used", label: "已用百分比（如 55%，默认）" },
							{ value: "remaining", label: "剩余百分比（如 45%）" }
						]
					}),
					jsx(SelectField, {
						label: "刷新频率",
						value: String(state.refreshMs),
						onChange: onRefreshChange,
						disabled: state.savingRefresh,
						hint: state.savingRefresh ? "保存中…" : "保存后所有已打开卡片立即生效",
						options: REFRESH_CHOICES.map(function (c) { return { value: c.ms, label: c.label }; })
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
