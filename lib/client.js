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

		function useQuota(accountId) {
			var state = React.useState({ loading: true, data: null, error: null });
			var data = state[0], setState = state[1];
			var timerRef = React.useRef(null);
			var abortRef = React.useRef(null);
			var seqRef = React.useRef(0);
			var refreshMsRef = React.useRef(DEFAULT_POLL_MS);
			// 当前账号放进 ref：load 的依赖数组保持为空（不重建回调），
			// 但每次取数都能读到最新的账号。
			var accountRef = React.useRef(accountId);
			accountRef.current = accountId;
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
						error: force || initial ? null : prev.error,
						payload: prev.payload || null
					};
				});
				var opts = { cache: "no-store" };
				if (ac) opts.signal = ac.signal;
				var qs = [];
				if (force) qs.push("force=1");
				if (accountRef.current) qs.push("account=" + encodeURIComponent(accountRef.current));
				fetch("/ark-quota" + (qs.length > 0 ? "?" + qs.join("&") : ""), opts)
					.then(function (r) { return r.json(); })
					.then(function (json) {
						if (seq !== seqRef.current) return;
						if (json && json.ok === true) {
							if (typeof json.refreshMs === "number" && json.refreshMs > 0) refreshMsRef.current = json.refreshMs;
							setState({ loading: false, data: json, error: null, payload: json });
							scheduleNext(timerRef, json, load);
						} else {
							var auth = json && (json.code === "unauthorized" || json.code === "missing-auth");
							// 失败响应也带 accounts / code：保留整个 body，否则密钥失效时
							// 账号切换器会消失（用户就没法切到另一个可用账号了）。
							setState({ loading: false, data: null, error: (json && json.message) || "查询失败", payload: json || null });
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
						// 网络层失败拿不到 body：保留上一次的 payload，切换器不至于闪没。
						setState(function (prev) {
							return {
								loading: false,
								data: null,
								error: String((e && e.message) || e),
								payload: prev.payload || null
							};
						});
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
			// 切换账号 → 立刻重新取数（accountId 变化后 accountRef 已是新值）。
			var firstRef = React.useRef(true);
			React.useEffect(function () {
				if (firstRef.current) {
					firstRef.current = false;
					return;
				}
				load(false);
			}, [accountId, load]);
			return { data: data.data, loading: data.loading, error: data.error, payload: data.payload || null, load: load };
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

		// 消耗速度：把「每天多少个百分点」写成人能读的样子。
		// 速度很慢时（<0.1%/天）改用每周，免得一屏都是 0.0%/天。
		function fmtBurn(perDay) {
			if (typeof perDay !== "number" || !isFinite(perDay) || perDay < 0) return "—";
			if (perDay === 0) return "0%/天";
			if (perDay < 0.1) return (Math.round(perDay * 70) / 10) + "%/周";
			if (perDay < 10) return (Math.round(perDay * 10) / 10) + "%/天";
			return Math.round(perDay) + "%/天";
		}

		// 燃烧倍率的取色：与健康条共用一套语义色，避免用户学两套配色。
		var BURN_COLORS = { ok: "#46a758", warn: "#f5a524", over: "#e5484d" };
		var BURN_LABELS = { ok: "按这个速度用到重置刚好够", warn: "偏快，可能提前用完", over: "明显超速，会提前用完" };
		function burnColor(status) {
			return Object.prototype.hasOwnProperty.call(BURN_COLORS, status)
				? BURN_COLORS[status]
				: "var(--dsw-alias-label-tertiary)";
		}
		function burnLabel(status) {
			return Object.prototype.hasOwnProperty.call(BURN_LABELS, status) ? BURN_LABELS[status] : "";
		}

		// 一条额度行的消耗速度提示（悬浮时给全量口径，行内只放一个短标签）。
		function burnTooltip(b) {
			if (!b) return "";
			var lines = [
				"消耗速度 " + fmtBurn(b.perDay),
				"预算速度 " + fmtBurn(b.budgetPerDay) + "（匀速用完刚好到重置）"
			];
			if (typeof b.ratio === "number" && isFinite(b.ratio)) {
				lines.push("倍率 " + (Math.round(b.ratio * 100) / 100) + "× · " + burnLabel(b.status));
			}
			// 重置对齐投影：订阅额度到点就重置，「重置时预计用到多少」才是能
			// 直接拍板的答案；时间进度 vs 额度进度告诉用户是超前还是落后。
			if (typeof b.projectedAtReset === "number" && isFinite(b.projectedAtReset)) {
				var tp = typeof b.timeProgress === "number" ? Math.round(b.timeProgress * 100) : null;
				var qp = typeof b.quotaProgress === "number" ? Math.round(b.quotaProgress * 100) : null;
				if (tp !== null && qp !== null) {
					var pace = qp - tp;
					lines.push("时间进度 " + tp + "% · 额度进度 " + qp + "%"
						+ (pace >= 5 ? "（消耗超前于时间）" : pace <= -5 ? "（消耗落后于时间）" : ""));
				}
				if (b.projectedAtReset >= 100) {
					lines.push("按当前速度预计撑不到重置就会用完（重置时将达 " + Math.round(b.projectedAtReset) + "%）");
				} else {
					lines.push("按当前速度，重置时预计用到 " + Math.round(b.projectedAtReset) + "%");
				}
			} else if (typeof b.exhaustAt === "number") {
				lines.push("按当前速度预计 " + fmtClockMs(b.exhaustAt) + " 用完");
			}
			if (typeof b.sampleMs === "number") {
				lines.push("观测窗口 " + fmtSpan(b.sampleMs));
			}
			return lines.join("\n");
		}

		// 百分比格式化：99.9% 绝不能四舍五入成 100%——额度没满就是没满，
		// 显示 100% 会让用户以为已经撞线。<99.5 取整；99.5 以上保留一位小数
		// （封顶 99.9）；真正 100 才显示 100。
		function fmtPct(p) {
			var n = clampPct(p);
			if (n >= 100) return "100";
			if (n >= 99.5) return String(Math.min(99.9, Math.floor(n * 10) / 10));
			return String(Math.round(n));
		}

		// 耗尽预测的一句话结论（面板主角信息）。三档语义：
		//   over：按当前速度撑不到重置 → 给出预计用完时刻，以及比重置早多久；
		//   warn：重置时预计用到 85%~100% → 余量紧张；
		//   ok：重置时预计用到 <85% → 够用。
		// 样本不足（burn 为 null）或连投影都算不出来时返回 null，调用方不渲染。
		function burnHeadline(burn, item, now) {
			if (!burn) return null;
			var projected = burn.projectedAtReset;
			if (typeof projected === "number" && isFinite(projected)) {
				if (projected >= 100 - 0.5) {
					// 撞线：预计用完时刻（exhaustAt）才是用户要的答案。
					var text = "按当前速度预计撑不到重置";
					if (typeof burn.exhaustAt === "number" && isFinite(burn.exhaustAt) && burn.exhaustAt > now) {
						text = "预计 " + fmtClockMs(burn.exhaustAt) + " 用完";
						if (item && item.resetAt) {
							var earlyMs = item.resetAt * 1000 - burn.exhaustAt;
							if (earlyMs > 60 * 60 * 1000) text += "，比重置早 " + fmtSpan(earlyMs);
						}
					}
					return { text: text, status: "over" };
				}
				var tense = projected >= 85 ? "warn" : "ok";
				return {
					text: "重置时预计用到 " + Math.round(projected) + "%，" + (tense === "warn" ? "余量紧张" : "够用"),
					status: tense
				};
			}
			// 没有重置投影（上游未给 resetAt）：退回线性耗尽时刻。
			if (typeof burn.exhaustAt === "number" && isFinite(burn.exhaustAt) && burn.exhaustAt > now) {
				return {
					text: "预计 " + fmtClockMs(burn.exhaustAt) + " 用完",
					status: burn.status === "over" ? "over" : "warn"
				};
			}
			return null;
		}

		function QuotaRow(_a) {
			var item = _a.item, now = _a.now, burn = _a.burn;
			var usedPct = clampPct(item.percentUsed);
			// 固定显示已用百分比：剩余 = 100 - 已用，心算零成本，不再提供切换。
			var showPct = usedPct;
			var label = Object.prototype.hasOwnProperty.call(LEVEL_LABELS, item.level) ? LEVEL_LABELS[item.level] : item.level;
			var reset = fmtResetShort(item.resetAt, now);
			// Single tooltip on the whole row: hovering the label, bar, percentage,
			// or reset sub-line all shows the same detail (used/remaining %,
			// absolute counts if available, exact wall-clock reset time).
			var tip = rowTooltip(item, now);
			// 预测结论行（主角信息）：危险（warn/over）时任何一档都醒目显示；
			// 安全时只在月度行给一句"够用"，5 小时/周档安全时不啰嗦。
			var headline = burnHeadline(burn, item, now);
			var showHeadline = headline !== null
				&& (headline.status !== "ok" || item.level === "monthly");
			// 样本不足（还没有两次以上快照）时，月度行给一句积累中提示，
			// 而不是整行空白——否则用户会以为预测功能不存在。
			// 快照随额度刷新积累（约 10 分钟一条），够两条后自动换成预测结论。
			var showAccumulating = headline === null && !burn && item.level === "monthly";
			// 三行布局：
			//   上行「分类 · 消耗速度 …… 百分比 · 重置倒计时」
			//   中行整宽进度条（含预测刻度）
			//   下行耗尽预测结论（危险时醒目，月度安全时也给一句）
			return jsxs("div", {
				title: tip,
				style: { display: "flex", flexDirection: "column", gap: "3px", minWidth: 0, cursor: "default" },
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "baseline", gap: "6px", minWidth: 0 },
						children: [
							jsx("span", {
								style: { flex: "none", fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)", whiteSpace: "nowrap" },
								children: label
							}),
							burn ? jsx("span", {
								title: burnTooltip(burn),
								style: {
									flex: "none", fontSize: "10px", lineHeight: "16px",
									fontVariantNumeric: "tabular-nums", color: burnColor(burn.status),
									whiteSpace: "nowrap"
								},
								children: fmtBurn(burn.perDay)
							}) : null,
							jsx("span", { style: { flex: "1 1 auto", minWidth: 0 } }),
							jsx("span", {
								style: { flex: "none", fontSize: "11px", lineHeight: "16px", fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-primary)" },
								children: fmtPct(showPct) + "%"
							}),
							reset ? jsx("span", {
								style: { flex: "none", fontSize: "10px", lineHeight: "16px", fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-tertiary)" },
								children: reset
							}) : null
						]
					}),
					// 进度条：填充为已用百分比；竖线刻度为「按当前速度外推到
					// 重置时」的预测位置（超过 100% 贴右端）。
					jsxs("div", {
						style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
						children: [
							jsxs("div", {
								style: { position: "relative", width: "100%", minWidth: 0, height: "6px", borderRadius: "3px", background: trackOf(usedPct), overflow: "hidden", transition: "background .3s" },
								children: [
									jsx("div", {
										// 常规填充：宽度 = 已用百分比，颜色按阈值切换（绿/橙/红）。
										style: { height: "100%", width: usedPct + "%", borderRadius: "3px", background: fillOf(usedPct), transition: "width .3s, background .3s" }
									}),
									// 预测刻度：只在投影确实高于当前水位时画，否则与填充末端重合没有信息量。
									burn && typeof burn.projectedAtReset === "number" && isFinite(burn.projectedAtReset)
										&& burn.projectedAtReset > usedPct + 0.5
										? jsx("div", {
											title: "按当前速度，重置时预计用到 " + Math.round(burn.projectedAtReset) + "%",
											style: {
												position: "absolute", top: 0, bottom: 0, width: "2px",
												left: Math.min(100, burn.projectedAtReset) + "%", marginLeft: "-1px",
												borderRadius: "1px", background: burnColor(burn.status), opacity: 0.95
											}
										}) : null
								]
							})
						]
					}),
					// 耗尽预测结论：warn/over 档醒目着色，月度安全档用弱化色。
					showHeadline ? jsx("div", {
						title: burn ? burnTooltip(burn) : undefined,
						style: {
							fontSize: "10px", lineHeight: "15px", minWidth: 0,
							color: headline.status === "ok"
								? "var(--dsw-alias-label-tertiary)"
								: burnColor(headline.status),
							whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
						},
						children: headline.text
					}) : showAccumulating ? jsx("div", {
						title: "预测需要对比两次以上的额度快照算消耗速度。插件随每次额度刷新记录一条（约 10 分钟），数据够了会自动在这里显示预计可用时间。",
						style: {
							fontSize: "10px", lineHeight: "15px", minWidth: 0,
							color: "var(--dsw-alias-label-tertiary)",
							whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", opacity: 0.7
						},
						children: "预计可用时间积累中…"
					}) : null
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

		// 账号切换器：头部右侧的紧凑小下拉，和刷新按钮待在同一个角落。
		//
		// 自绘胶囊 + 透明原生 select：账号名自己画，胶囊宽度随名字自适应
		// （短名字胶囊就短，不再固定撑宽）；一个 opacity:0 的原生
		// select 盖在最上层接收点击，展开的仍是系统原生下拉（无障碍、长名字
		// 在选项里完整显示）。单账号时不渲染。
		function AccountSwitcher(_a) {
			var accounts = _a.accounts, activeId = _a.activeId, onSelect = _a.onSelect;
			if (!Array.isArray(accounts) || accounts.length < 2) return null;
			var current = accounts.find(function (a) { return a.id === activeId; }) || accounts[0];
			return jsxs("span", {
				title: "当前账号：" + current.label + "（点击切换）",
				style: {
					position: "relative", display: "inline-flex", flex: "none",
					alignItems: "center", height: "20px", maxWidth: "170px",
					borderRadius: "5px", cursor: "pointer",
					background: "var(--dsw-alias-track-bg, rgba(128,128,128,0.14))"
				},
				children: [
					// 账号名：宽度随文字走，过长在胶囊内截断。
					jsx("span", {
						style: {
							padding: "0 10px", fontSize: "11px", lineHeight: "20px",
							color: "var(--dsw-alias-label-secondary)",
							whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
						},
						children: current.label
					}),
					// 透明原生 select 盖满整个胶囊：只负责接收点击和弹出系统下拉。
					// 左 padding 不能为 0：它决定展开菜单里选项文本的左缩进，否则文字贴边。
					jsx("select", {
						value: activeId || "",
						"aria-label": "切换账号",
						onChange: function (e) { onSelect(e.target.value); },
						style: {
							position: "absolute", inset: "0", width: "100%", height: "100%",
							margin: "0", padding: "0 14px 0 8px", border: "none", cursor: "pointer", opacity: "0",
							appearance: "none", WebkitAppearance: "none", MozAppearance: "none", fontSize: "11px"
						},
						children: accounts.map(function (a) {
							return jsx("option", {
								value: a.id,
								// 弹出菜单选项的左右缩进：select 的 padding 之外再加一层，
								// 兼容不把 select padding 传导到下拉列表的浏览器。
								style: { paddingLeft: "8px", paddingRight: "12px" },
								children: a.configured === false ? a.label + "（未配密钥）" : a.label
							}, a.id);
						})
					})
				]
			});
		}

		function Card(_a) {
			var state = _a.state, onRefresh = _a.onRefresh, loading = _a.loading;
			var accounts = _a.accounts, activeId = _a.activeAccountId, onSelectAccount = _a.onSelectAccount;
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
								jsx(AccountSwitcher, { accounts: accounts, activeId: activeId, onSelect: onSelectAccount }),
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
			var burn = (data && data.burn) || {};
			var fetched = fetchedAtMs(data);
			// 卡片自上而下两段，每段职责单一、都铺满整宽：
			//   1 头部    标题 + 套餐徽章 …… 账号下拉（多账号时）+ 刷新
			//   2 额度    每档一行（分类 + 消耗速度 …… 百分比 + 重置），底部时间
			return jsxs("div", {
				style: cardOuter,
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0 },
						children: [
							jsx(ArkLogo, { size: 15 }),
							jsx("span", {
								style: { flex: "none", fontSize: "12px", fontWeight: "500", lineHeight: "18px", color: "var(--dsw-alias-label-primary)" },
								children: "方舟额度"
							}),
							jsx("span", { style: { flex: "1", minWidth: 0 } }),
							// 头部右侧 = 操作区：账号下拉（多账号时）+ 刷新按钮。
							// 刷新状态只靠图标转圈 + 禁用表达，不占一行「刷新中…」文字。
							jsx(AccountSwitcher, { accounts: accounts, activeId: activeId, onSelect: onSelectAccount }),
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
					jsx("div", {
						style: { display: "flex", flexDirection: "column", gap: "8px", minWidth: 0 },
						children: rows.length > 0 ? rows.map(function (item) {
							return jsx(QuotaRow, {
								item: item,
								now: now,
								burn: Object.prototype.hasOwnProperty.call(burn, item.level) ? burn[item.level] : null
							}, item.level);
						}) : jsx("div", {
							style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" },
							children: "暂无额度数据"
						})
					}),
					data && fetched ? jsxs("div", {
						// 底部 = 信息区：套餐徽章、奖励徽章靠左（静态信息），更新时间靠右。
						// 套餐类型放这里而不是头部：右上角只留「账号下拉 + 刷新」两个操作，不挤。
						style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "10px", lineHeight: "14px", color: "var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary))", marginTop: "2px" },
						children: [
							// 套餐徽章（Coding Plan / Agent Plan）
							data.plan ? jsx(PlanBadge, { plan: data.plan }) : null,
							// 奖励徽章
							data.hasReward ? jsxs("span", {
								title: "该套餐含额外奖励额度",
								style: { flex: "none", display: "inline-flex", alignItems: "center", gap: "4px", color: "var(--dsw-alias-state-info-primary, #0ea5e9)" },
								children: [
									jsx("span", { style: { width: "6px", height: "6px", borderRadius: "50%", background: "#0ea5e9", display: "inline-block" } }),
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
			var state = _a.state;
			var quota = state.data ? state.data.quota : [];
			var monthly = quota.find(function (q) { return q.level === "monthly"; });
			var pct = monthly ? clampPct(monthly.percentUsed) : null;
			var label = "近1月已用 ";
			return jsx("button", {
				type: "button",
				title: pct === null ? "方舟额度（无数据）" : "方舟额度 · " + label + fmtPct(pct) + "%" + (state.error ? " · " + state.error : ""),
				onClick: function () {},
				style: {
					flex: "none", minWidth: "30px", height: "22px", padding: "0 7px",
					display: "inline-flex", alignItems: "center", justifyContent: "center",
					borderRadius: "999px", cursor: "default",
					border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2))",
					background: monthly ? colorOf(monthly.percentUsed) + "1a" : "var(--dsw-alias-bg-base, transparent)",
					color: "var(--dsw-alias-label-primary)", fontSize: "11px", fontVariantNumeric: "tabular-nums"
				},
				children: pct === null ? (state.error ? "!" : "—") : fmtPct(pct) + "%"
			});
		}

		function ArkQuotaWidget(_a) {
			var wide = _a.wide;
			// 当前查看的账号。null = 跟随宿主的 activeAccountId（首次加载时还不知道）。
			// 切换会写回宿主（下次打开还是上次看的那个），同时立即更新本地态，
			// 不必等写回往返完成——写回失败时宿主的 activeAccountId 会在下次
			// 取数时把它纠回去。
			var sel = React.useState(null);
			var picked = sel[0], setPicked = sel[1];
			var q = useQuota(picked);
			var reload = q.load;
			React.useEffect(function () {
				// Re-read immediately after a credentials/settings save (see refreshSignal).
				return refreshSignal.subscribe(function () { reload(true); });
			}, [reload]);
			// 账号清单与当前账号都来自 /ark-quota 的响应（成功或失败都会带）。
			var payload = q.data || q.payload || null;
			var accounts = (payload && Array.isArray(payload.accounts)) ? payload.accounts : [];
			var activeId = picked || (payload ? (payload.accountId || payload.activeAccountId) : null) || null;
			var onSelectAccount = React.useCallback(function (id) {
				setPicked(id);
				// 写回宿主作为默认账号；失败也不影响本次查看（本地态已切）。
				fetch("/ark-quota/accounts", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ action: "activate", id: id })
				}).catch(function () {});
			}, []);
			if (!wide) return jsx(RailPill, { state: { data: q.data, error: q.error } });
			return jsx(Card, {
				state: { data: q.data, error: q.error },
				loading: q.loading,
				accounts: accounts,
				activeAccountId: activeId,
				onSelectAccount: onSelectAccount,
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

		// provider 多选：一行一个复选框，标注"已属某账号"避免两个账号抢同一路由。
		// 用受控复选框而不是 <select multiple>：后者在小面板里高度难看，且
		// Ctrl+点击的交互对不熟悉的用户不友好。
		function ProviderPicker(_a) {
			var providers = _a.providers, claimed = _a.claimed, selected = _a.selected;
			var accountId = _a.accountId, onToggle = _a.onToggle, disabled = _a.disabled;
			var filtered = _a.filtered, onShowAll = _a.onShowAll, showingAll = _a.showingAll;
			var foreign = _a.foreignClaimed;
			var foreignList = Array.isArray(foreign) ? foreign : [];
			if (!Array.isArray(providers) || providers.length === 0) {
				return jsx("div", {
					style: { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)" },
					children: "宿主未报告任何火山方舟提供方（可能尚未配置 llm 插件，或路由的 baseURL 不指向火山方舟）。"
				});
			}
			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "3px" },
				children: [
					jsx("div", {
						style: { display: "flex", flexDirection: "column", gap: "3px" },
						children: providers.map(function (p) {
							var on = selected.indexOf(p.id) >= 0;
							// 原型链安全：claimed 是路由返回的普通对象，用 hasOwnProperty 查。
							var owner = Object.prototype.hasOwnProperty.call(claimed || {}, p.id) ? claimed[p.id] : null;
							var takenByOther = owner !== null && owner !== accountId;
							return jsxs("label", {
								title: takenByOther ? "已关联到账号 " + owner : "勾选后标记该路由属于本火山账号",
								style: {
									display: "flex", alignItems: "center", gap: "6px",
									fontSize: "11px", lineHeight: "18px",
									color: takenByOther ? "var(--dsw-alias-label-tertiary)" : "var(--dsw-alias-label-secondary)",
									cursor: disabled ? "wait" : "pointer"
								},
								children: [
									jsx("input", {
										type: "checkbox",
										checked: on,
										disabled: disabled || takenByOther,
										onChange: function () { onToggle(p.id); },
										style: { margin: 0 }
									}, "cb"),
									jsx("span", { style: { fontFamily: "var(--dsw-font-mono, monospace)" }, children: p.id }, "id"),
									p.name && p.name !== p.id
										? jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)" }, children: p.name }, "name")
										: null,
									takenByOther
										? jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)" }, children: "· 已属 " + owner }, "owner")
										: null
								]
							}, p.id);
						})
					}),
					// 默认只列火山方舟的路由。被隐藏的数量要说出来，否则用户会以为
					// 自己的路由丢了；同时给一个"仍然显示全部"的出口，应对路由名
					// 和 baseURL 都不常规的情况。
					filtered > 0 && !showingAll ? jsxs("div", {
						style: { fontSize: "10px", lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)" },
						children: [
							"已隐藏 " + filtered + " 个非火山方舟提供方 ",
							jsx("button", {
								type: "button",
								onClick: onShowAll,
								style: {
									padding: "0", border: "none", background: "transparent",
									color: "var(--dsw-alias-label-secondary)", cursor: "pointer",
									fontSize: "10px", textDecoration: "underline"
								},
								children: "仍然显示"
							})
						]
					}) : null,
					// 已关联但判定不是火山方舟的路由（典型：误勾了 deepseek-official）：
					// 默认列表里不显示，但必须明确点名，否则误配永远发现不了。
					foreignList.length > 0 && !showingAll ? jsxs("div", {
						style: { fontSize: "10px", lineHeight: "16px", color: "var(--dsw-alias-state-warning-primary, #f5a524)" },
						children: [
							"已关联的 " + foreignList.length + " 个路由不是火山方舟（"
								+ foreignList.map(function (f) { return f.id; }).join("、")
								+ "），与方舟额度无关。如属误配，请",
							jsx("button", {
								type: "button",
								onClick: onShowAll,
								style: {
									padding: "0", border: "none", background: "transparent",
									color: "inherit", cursor: "pointer",
									fontSize: "10px", textDecoration: "underline"
								},
								children: "显示全部"
							}),
							"后取消勾选。"
						]
					}) : null,
					showingAll ? jsx("div", {
						style: { fontSize: "10px", lineHeight: "16px", color: "var(--dsw-alias-state-warning-primary, #f5a524)" },
						children: "正在显示全部提供方。只勾选真正属于本火山账号的路由（baseURL 指向 volces.com / volcengine.com），其他路由请勿勾选。"
					}) : null
				]
			});
		}

		function ArkQuotaSettingsCard() {
			var d = React.useState({ ak: "", sk: "" });
			var draft = d[0], setDraft = d[1];
			var s = React.useState({
				loading: true, configured: false, saving: false, msg: null,
				refreshMs: DEFAULT_POLL_MS, savingRefresh: false,
				accounts: [], activeAccountId: "", editing: "",
				providers: [], claimed: {}, foreignClaimed: [], busy: false,
				// 默认只列火山方舟的路由；showAllProviders 打开后列全部。
				providersFiltered: 0, showAllProviders: false
			});
			var state = s[0], setState = s[1];
			// 显示名保存状态：""（已同步）/ "dirty"（有未保存改动）/ "saved"（刚保存）。
			// 自动保存（失焦/回车）本身没声音，用一行小字让用户明确知道存没存上。
			var ls2 = React.useState("");
			var labelStatus = ls2[0], setLabelStatus = ls2[1];
			// 当前正在编辑的账号：默认跟随宿主的 activeAccountId。
			var editingId = state.editing || state.activeAccountId || "";
			// 切换编辑的账号时，上一个账号的保存状态提示一并清掉。
			React.useEffect(function () { setLabelStatus(""); }, [editingId]);
			var accountOf = function (id) {
				for (var i = 0; i < state.accounts.length; i += 1) {
					if (state.accounts[i].id === id) return state.accounts[i];
				}
				return null;
			};
			var current = accountOf(editingId);
			var applyStatus = function (json, extra) {
				setState(function (prev) {
					var accounts = (json && Array.isArray(json.accounts)) ? json.accounts : prev.accounts;
					return {
						...prev,
						loading: false,
						configured: !!(json && json.ok === true && json.configured),
						refreshMs: (json && typeof json.refreshMs === "number" && json.refreshMs > 0) ? json.refreshMs : prev.refreshMs,
						accounts: accounts,
						activeAccountId: (json && typeof json.activeAccountId === "string") ? json.activeAccountId : prev.activeAccountId,
						...(extra || {})
					};
				});
			};
			// 取 provider 清单。all=true 时连非火山方舟的路由一起列出来。
			// 必须在 loadStatus 之前声明（被它调用）。
			var loadProviders = React.useCallback(function (all) {
				fetch("/ark-quota/providers" + (all ? "?all=1" : ""), { cache: "no-store" })
					.then(function (r) { return r.json(); })
					.then(function (json) {
						if (json && json.ok === true) {
							setState(function (prev) {
								return {
									...prev,
									providers: Array.isArray(json.providers) ? json.providers : [],
									claimed: json.claimed || {},
									foreignClaimed: Array.isArray(json.foreignClaimed) ? json.foreignClaimed : [],
									providersFiltered: Number(json.filtered) || 0,
									showAllProviders: !!all
								};
							});
						}
					})
					.catch(function () {});
			}, []);
			var loadStatus = React.useCallback(function () {
				fetch("/ark-quota/status", { cache: "no-store" })
					.then(function (r) { return r.json(); })
					.then(function (json) { applyStatus(json); })
					.catch(function () {
						setState(function (prev) { return { ...prev, loading: false }; });
					});
				loadProviders(false);
			}, [loadProviders]);
			React.useEffect(function () { loadStatus(); }, [loadStatus]);

			// 账号增删改的统一入口：POST /ark-quota/accounts。
			var postAccount = function (body, okMsg) {
				setState(function (prev) { return { ...prev, busy: true, msg: null }; });
				return fetch("/ark-quota/accounts", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body)
				})
					.then(function (r) { return r.json(); })
					.then(function (json) {
						if (json && json.ok === true) {
							applyStatus(json, { busy: false, msg: okMsg });
							// provider 归属可能变了，重新取一次 claimed 与误关联清单。
							// 保持当前的 all/过滤视图（all=1 时带 all 参数）。
							fetch("/ark-quota/providers" + (state.showAllProviders ? "?all=1" : ""), { cache: "no-store" })
								.then(function (r) { return r.json(); })
								.then(function (p) {
									if (p && p.ok === true) {
										setState(function (prev) {
											return {
												...prev,
												claimed: p.claimed || {},
												foreignClaimed: Array.isArray(p.foreignClaimed) ? p.foreignClaimed : [],
												providersFiltered: Number(p.filtered) || 0
											};
										});
									}
								})
								.catch(function () {});
							refreshSignal.notify();
						} else {
							setState(function (prev) { return { ...prev, busy: false, msg: (json && json.message) || "操作失败" }; });
							return json;
						}
					})
					.catch(function (e) {
						setState(function (prev) { return { ...prev, busy: false, msg: "操作失败：" + String((e && e.message) || e) }; });
						return null;
					});
			};
			var onAddAccount = function () {
				if (typeof window === "undefined" || typeof window.prompt !== "function") return;
				// 第一步：内部 id。它是落盘存储的键，只能小写英文/数字/下划线，
				// 不能用中文——这一步的文案要讲清楚，免得用户误以为账号名不能中文。
				var raw = window.prompt(
					"第一步：新账号的内部 id\n"
					+ "（小写字母开头，只含小写字母/数字/下划线，例如 personal、company_2）\n"
					+ "id 只是内部标识；显示名称（可中文）下一步再设。"
				);
				if (raw === null) return;
				var id = String(raw).trim();
				if (id.length === 0) return;
				if (!/^[a-z][a-z0-9_]*$/.test(id)) {
					setState(function (prev) {
						return { ...prev, msg: "内部 id 只能用小写字母开头的英文/数字/下划线；显示名称可以用中文，下一步设置。" };
					});
					return;
				}
				// 第二步：显示名称，可中文。留空（直接确定）则回落到 id。
				var labelRaw = window.prompt(
					"第二步：显示名称（可中文，例如 个人号 / 公司 Pro）\n直接确定则用 id 作为名称。",
					id
				);
				var label = (labelRaw === null ? "" : String(labelRaw).trim()) || id;
				postAccount({ action: "add", id: id, label: label }, "已添加账号 " + label);
				setState(function (prev) { return { ...prev, editing: id }; });
			};
			var onRemoveAccount = function () {
				if (!current) return;
				var okToDelete = typeof window === "undefined" || typeof window.confirm !== "function"
					|| window.confirm("删除账号「" + current.label + "」？该账号的密钥与请求统计都会一并移除。");
				if (!okToDelete) return;
				postAccount({ action: "remove", id: current.id }, "已删除账号 " + current.id);
				setState(function (prev) { return { ...prev, editing: "" }; });
			};
				var onRenameAccount = function (e) {
					if (!current) return;
					var label = e.target.value;
					setState(function (prev) {
						return {
							...prev,
							accounts: prev.accounts.map(function (a) { return a.id === current.id ? { ...a, label: label } : a; })
						};
					});
					setLabelStatus("dirty");
				};
				var onCommitLabel = function () {
					if (!current) return;
					// 失焦/回车都会走到这里；值真的变了才发请求，保存成功给「✓ 已保存」。
					if (labelStatus !== "dirty") return;
					postAccount({ action: "update", id: current.id, label: current.label }, "标签已保存")
						.then(function (json) { if (json && json.ok === true) setLabelStatus("saved"); });
				};
			var onToggleProvider = function (providerId) {
				if (!current) return;
				// providers 来自路由响应，理论上总是数组；这里仍然兜一层，
				// 免得某个字段缺失让整个勾选动作静默失败（Promise 会吞掉异常）。
				var next = Array.isArray(current.providers) ? current.providers.slice() : [];
				var at = next.indexOf(providerId);
				if (at >= 0) next.splice(at, 1); else next.push(providerId);
				postAccount({ action: "update", id: current.id, providers: next }, "关联已保存");
			};
			var onActivate = function () {
				if (!current) return;
				postAccount({ action: "activate", id: current.id }, "已设为面板默认账号");
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
							applyStatus(json, { savingRefresh: false, refreshMs: ms });
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
						// 密钥写进当前编辑的账号；空配置时宿主会自动建 default。
						account: editingId || undefined,
						accessKeyId: draft.ak || undefined,
						secretAccessKey: draft.sk || undefined
					})
				})
					.then(function (r) { return r.json(); })
					.then(function (json) {
						if (json && json.ok === true) {
							setDraft({ ak: "", sk: "" });
							applyStatus(json, { saving: false, savingRefresh: false, msg: "已保存并热生效（无需重启）" });
							refreshSignal.notify();
							return json;
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
			var btnStyle = {
				padding: "4px 10px", fontSize: "11px", lineHeight: "16px", borderRadius: "6px", cursor: "pointer",
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))",
				background: "var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base))",
				color: "var(--dsw-alias-label-primary)"
			};
			// 当前编辑的账号是否已配密钥（顶层 configured 说的是"面板默认账号"）。
			var configured = current ? current.configured === true : state.configured;
			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "8px", maxWidth: "520px" },
				children: [
					// 防浏览器/密码管理器自动填充：两个移出屏幕的诱饵框吸收 autofill，
					// 真正的 AK/SK 框在下方（SK 用 new-password），不会被填进保存的网站账号密码。
					jsx("input", { type: "text", name: "ark-decoy-username", autoComplete: "username", tabIndex: -1, "aria-hidden": true, readOnly: true, value: "", style: { position: "absolute", left: "-9999px", top: "auto", width: "1px", height: "1px", opacity: 0, pointerEvents: "none" } }, "decoy-u"),
					jsx("input", { type: "password", name: "ark-decoy-password", autoComplete: "current-password", tabIndex: -1, "aria-hidden": true, readOnly: true, value: "", style: { position: "absolute", left: "-9999px", top: "auto", width: "1px", height: "1px", opacity: 0, pointerEvents: "none" } }, "decoy-p"),
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "8px" },
						children: [
							jsx(ArkLogo, { size: 16 }),
							jsx("span", { style: { fontWeight: "500", fontSize: "13px", lineHeight: "20px", color: "var(--dsw-alias-label-primary)" }, children: "方舟额度 · 账号" }),
							jsx("span", { style: { fontSize: "11px", lineHeight: "16px", color: configured ? "var(--dsw-alias-state-success-primary, #46a758)" : "var(--dsw-alias-label-tertiary)" }, children: configured ? "已配置" : "未配置" })
						]
					}),
					jsx("div", {
						style: { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)" },
						children: "一组 AK/SK 对应一个火山账号。下方可勾选属于该账号的模型提供方路由——列表只显示指向火山方舟端点（volces.com / volcengine.com）的路由，deepseek 官方直连等不会出现；如发现误勾的非火山路由，按提示显示全部后取消即可。密钥仅存于本地 settings.yaml，保存后立即生效。"
					}),
					jsx("div", {
						style: { height: "1px", background: "var(--dsw-alias-border-l2, rgba(128,128,128,0.15))", margin: "2px 0" }
					}),
					// 账号选择 + 增删
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" },
						children: [
							jsx("span", { style: { flex: "none", minWidth: "64px" }, children: "账号" }),
							state.accounts.length > 0 ? jsx("select", {
								value: editingId,
								onChange: function (e) { setState(function (prev) { return { ...prev, editing: e.target.value, msg: null }; }); },
								disabled: state.busy,
								style: {
									boxSizing: "border-box", padding: "4px 8px", fontSize: "12px", lineHeight: "16px",
									color: "var(--dsw-alias-label-primary)",
									background: "var(--dsw-alias-bg-input, var(--dsw-alias-bg-base))",
									border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))",
									borderRadius: "6px", cursor: state.busy ? "wait" : "pointer"
								},
								children: state.accounts.map(function (a) {
									return jsx("option", {
										value: a.id,
										children: a.label + (a.id === state.activeAccountId ? "（面板默认）" : "")
									}, a.id);
								})
							}) : jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)" }, children: "还没有账号，先添加一个" }),
							jsx("button", { type: "button", onClick: onAddAccount, disabled: state.busy, style: btnStyle, children: "添加" }),
							current ? jsx("button", { type: "button", onClick: onRemoveAccount, disabled: state.busy, style: btnStyle, children: "删除" }) : null,
							current && current.id !== state.activeAccountId
								? jsx("button", { type: "button", onClick: onActivate, disabled: state.busy, style: btnStyle, children: "设为默认" })
								: null
						]
					}),
					// 标签
					current ? jsx("label", {
						style: { display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" },
						children: [
							jsx("span", { children: "显示名称（可中文，回车或点别处保存）" }, "label-label"),
							jsx("input", {
								type: "text", autoComplete: "off", spellCheck: false,
								placeholder: "例如 个人号 / 公司 Agent Plan",
								value: current.label,
								onChange: onRenameAccount,
								onBlur: onCommitLabel,
								// 回车 = 失焦 = 保存：否则改完按回车看不到反应，会以为名字改不了。
								onKeyDown: function (e) { if (e.key === "Enter") e.target.blur(); },
								style: inputStyle
							}, "label-input"),
							// 保存状态反馈：自动保存没声音，用这行小字交代清楚。
							labelStatus === "dirty"
								? jsx("span", { style: { fontSize: "10px", lineHeight: "14px", color: "var(--dsw-alias-state-warning-primary, #f5a524)" }, children: "未保存 · 回车或点别处自动保存" })
								: labelStatus === "saved"
									? jsx("span", { style: { fontSize: "10px", lineHeight: "14px", color: "var(--dsw-alias-state-success-primary, #46a758)" }, children: "✓ 已保存" })
									: null
						]
					}) : null,
					// provider 关联
					current ? jsxs("div", {
						style: { display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" },
						children: [
							jsxs("span", {
								children: [
									"属于本账号的模型提供方",
									current.providers.length === 0
										? jsx("span", { style: { color: "var(--dsw-alias-state-warning-primary, #f5a524)" }, children: " · 尚未勾选任何路由" }, "warn")
										: null
								]
							}),
							jsx(ProviderPicker, {
								providers: state.providers,
								claimed: state.claimed,
								foreignClaimed: state.foreignClaimed,
								selected: current.providers,
								accountId: current.id,
								onToggle: onToggleProvider,
								disabled: state.busy,
								filtered: state.providersFiltered,
								showingAll: state.showAllProviders,
								onShowAll: function () { loadProviders(true); }
							})
						]
					}) : null,
					jsx("div", {
						style: { height: "1px", background: "var(--dsw-alias-border-l2, rgba(128,128,128,0.15))", margin: "2px 0" }
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
							jsx("span", {
								children: current ? "AccessKey ID · " + current.label : "AccessKey ID"
							}, "ak-label"),
							jsx("input", {
								type: "text", name: "ark-access-key-id", autoComplete: "off", spellCheck: false,
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
							jsx("span", {
								children: current ? "Secret Access Key · " + current.label : "Secret Access Key"
							}, "sk-label"),
							jsx("input", {
								type: "password", name: "ark-secret-access-key", autoComplete: "new-password", spellCheck: false,
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
								children: state.saving ? "保存中…" : (current ? "保存到「" + current.label + "」" : "保存访问密钥")
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
