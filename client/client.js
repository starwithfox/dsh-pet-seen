window.__ModuleLoader__.load({
	id: "dsh-pet-seen",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region src/protocol.ts
		/**
		* Identity of the build these bytes came from.
		*
		* Derived from the package version and the contents of every file under `src/`,
		* so two halves that were not built together cannot share it. The host publishes
		* its own copy in `GET /state`, each page reports its own on
		* `POST /pet-bridge/visibility`, and `tools/probe-http.mjs` fails when either is
		* missing or when the two disagree — which is how a half-refreshed install
		* ("host new, page old", or the reverse) stops being silent. See the build
		* handshake (PL-EN-NW-02).
		*/
		const BUILD_ID = "f3a162e9d115c434";
		/**
		* Browser-facing route paths. Each is registered as its own `exact` route so a
		* method mismatch is answered per path instead of falling through to a shared
		* dispatcher.
		*/
		const BROWSER_ROUTES = {
			visibility: "/pet-bridge/visibility",
			notices: "/pet-bridge/notices",
			seen: "/pet-bridge/seen"
		};
		//#endregion
		//#region src/client/decide.ts
		/**
		* Refusal reasons after which retrying is pointless.
		*
		* These are terminal because the host has already reached a final answer about
		* the notice: it was closed by the user, or it never matched this run/session.
		* The request-shape reasons cannot improve either — the page would send the
		* same bytes again. Everything else (`no-effective-lease`, `tab-not-on-session`,
		* and a response that never arrived at all) is a race the page can win later.
		*/
		const TERMINAL_SEEN_REASONS = /* @__PURE__ */ new Set([
			"already-dismissed",
			"unknown-notice",
			"run-mismatch",
			"session-mismatch",
			"observed-flag-missing",
			"incomplete-observation"
		]);
		/**
		* Classify a `/seen` response.
		*
		* @param accepted - the host's `accepted` flag, or undefined when the request
		*   never produced a parsable response.
		* @param reason - the host's machine-readable refusal reason, if any.
		* @returns `verified` for an accepted observation, `stop` for a terminal
		*   refusal, and `retry` for anything that may still succeed.
		*/
		function classifySeenOutcome(accepted, reason) {
			if (accepted) return "verified";
			if (reason === void 0 || reason === "") return "retry";
			return TERMINAL_SEEN_REASONS.has(reason) ? "stop" : "retry";
		}
		/** Parsed numeric turn of a notice, or null when unusable. */
		function turnOf(notice) {
			if (notice.targetTurnRef === null) return null;
			const turn = Number(notice.targetTurnRef);
			return Number.isSafeInteger(turn) && turn >= 0 ? turn : null;
		}
		/**
		* Notices the page is still allowed to report, in the order the host sent them
		* (oldest completion first).
		*
		* @param notices - the host's answer to `/pet-bridge/notices`.
		* @param blocked - notice ids already settled, or terminally refused.
		* @returns watchable candidates.
		*/
		function watchableCandidates(notices, blocked) {
			const rows = [];
			for (const notice of notices) {
				if (blocked.has(notice.noticeId)) continue;
				const turn = turnOf(notice);
				if (turn === null) continue;
				rows.push({
					notice,
					turn
				});
			}
			return rows;
		}
		/**
		* Choose which notice to watch.
		*
		* A notice whose result is scrolled out of view cannot be confirmed by the
		* user, so it must not hold the watch slot: a newer notice that *is* on screen
		* is chosen instead (D3). When nothing is on screen there is nothing better to
		* wait for, so the oldest candidate is watched and its dwell simply starts when
		* the user scrolls to it.
		*
		* @param candidates - watchable candidates, oldest first.
		* @param sessionId - session the page is currently showing.
		* @param isVisible - predicate saying whether a turn's result is on screen.
		* @returns the target to watch, whether it is currently visible, and how many
		*   candidates were considered.
		*/
		function selectWatchTarget(candidates, sessionId, isVisible) {
			let fallback = null;
			for (const candidate of candidates) {
				if (fallback === null) fallback = candidate;
				if (isVisible(candidate.turn)) return {
					target: {
						sessionId,
						noticeId: candidate.notice.noticeId,
						turn: candidate.turn
					},
					visible: true,
					considered: candidates.length
				};
			}
			if (fallback === null) return {
				target: null,
				visible: false,
				considered: 0
			};
			return {
				target: {
					sessionId,
					noticeId: fallback.notice.noticeId,
					turn: fallback.turn
				},
				visible: false,
				considered: candidates.length
			};
		}
		/**
		* Build a retry gate.
		*
		* The gate is a rate limit, not a blacklist: the dwell clock has to re-accumulate
		* before a notice is reported again, and this stops the extra attempt that a
		* 300 ms tick could otherwise fire while the clock is still satisfied.
		*
		* @param cooldownMs - minimum spacing between two attempts for one notice.
		* @returns the gate.
		*/
		function createAttemptGate(cooldownMs) {
			const lastAttemptAt = /* @__PURE__ */ new Map();
			return {
				canAttempt: (noticeId, at) => {
					const last = lastAttemptAt.get(noticeId);
					return last === void 0 || at - last >= cooldownMs;
				},
				remember: (noticeId, at) => {
					lastAttemptAt.set(noticeId, at);
				},
				forget: (noticeId) => {
					lastAttemptAt.delete(noticeId);
				},
				clear: () => {
					lastAttemptAt.clear();
				}
			};
		}
		/**
		* Validate the dwell threshold the host advertises.
		*
		* A bad value must never disable confirmation altogether, so anything that is
		* not a finite, non-negative number falls back to the caller's default.
		*
		* @param value - raw `seenDwellMs` from the notices payload.
		* @param fallbackMs - value to use when the advertised one is unusable.
		* @returns a usable threshold in ms.
		*/
		function resolveDwellMs(value, fallbackMs) {
			return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallbackMs;
		}
		/** A non-empty string, or null. */
		function nonEmptyString(value) {
			return typeof value === "string" && value !== "" ? value : null;
		}
		/**
		* Read the session id out of an observable binding.
		*
		* @param read - thunk returning the observable. It is called inside the guard
		*   because reaching the observable is itself a read that may throw (the
		*   services are proxies and a torn-down fiber can leave a getter behind).
		* @returns the binding's `key`, or null when the source is missing, malformed,
		*   or throws.
		*/
		function bindingKey(read) {
			try {
				const view = read();
				if (typeof view !== "object" || view === null) return null;
				const snapshot = view.getSnapshot();
				if (typeof snapshot !== "object" || snapshot === null) return null;
				return nonEmptyString(snapshot.key);
			} catch {
				return null;
			}
		}
		/** Take the `sessions.list` snapshot once, or null when it cannot be read. */
		function sessionList(sessions) {
			try {
				const snapshot = sessions?.list.getSnapshot();
				return typeof snapshot === "object" && snapshot !== null ? snapshot : null;
			} catch {
				return null;
			}
		}
		/**
		* The id of the first row the main view retains.
		*
		* This is the read the product itself uses (`ui-session` and `ui-layout`), so
		* the order is the host's own `byId` key order rather than one we invent.
		*
		* @param list - the `sessions.list` snapshot, if it could be read.
		* @returns that row's id, or null.
		*/
		function retainedSessionId(list) {
			try {
				for (const [id, row] of Object.entries(list?.byId ?? {})) if ((row?.retainedBy?.mainView ?? 0) > 0) return nonEmptyString(id);
				return null;
			} catch {
				return null;
			}
		}
		/** The title of a resolved session, taken from the same snapshot as its id. */
		function sessionTitle(list, sessionId) {
			try {
				const title = list?.byId[sessionId]?.title;
				return typeof title === "string" ? title : null;
			} catch {
				return null;
			}
		}
		/**
		* Find the session the user is looking at.
		*
		* Reads are tried in order and the first non-empty id wins, so a runtime that
		* loses one source degrades to the next instead of going blind:
		*
		* | `reader` | read | 0.1.5 | 0.2.0 |
		* | --- | --- | --- | --- |
		* | 0 | `uiSession.adapter.current.getSnapshot().key` | yes | yes |
		* | 1 | `uiSession.current.getSnapshot().key` | — | yes |
		* | 2 | `sessions.list.getSnapshot().current` | yes | — |
		* | 3 | the `byId` row with `retainedBy.mainView > 0` | — | yes |
		*
		* Every read is guarded on its own, so a throwing source costs one step rather
		* than the whole chain. Nothing here throws, and nothing here subscribes: this
		* function only answers "which session", the caller owns observation.
		*
		* @param source - the `uiSession` value and the `sessions` service.
		* @returns the session id, its title, and which read found it (`-1` if none).
		*/
		function resolveCurrentSession(source) {
			const ui = source.uiSession;
			const list = sessionList(source.sessions);
			const readers = [
				[0, () => bindingKey(() => ui?.adapter?.current)],
				[1, () => bindingKey(() => ui?.current)],
				[2, () => nonEmptyString(list?.current)],
				[3, () => retainedSessionId(list)]
			];
			for (const [reader, read] of readers) {
				const sessionId = read();
				if (sessionId !== null) return {
					sessionId,
					title: sessionTitle(list, sessionId),
					reader
				};
			}
			return {
				sessionId: null,
				title: null,
				reader: -1
			};
		}
		/**
		* How many session rows the `sessions.list` snapshot is currently holding.
		*
		* Evidence, not behaviour: a page that can see 152 sessions and still cannot
		* name the current one is drifting, while an empty list only means no session
		* exists yet. Those two readings are indistinguishable from `reader` alone,
		* which is why the count travels with it. Reads nothing else, and never throws.
		*
		* @param source - the same source `resolveCurrentSession()` was given.
		* @returns the number of `byId` entries, or 0 when there is no readable list.
		*/
		function byIdCount(source) {
			try {
				const byId = sessionList(source.sessions)?.byId;
				if (typeof byId !== "object" || byId === null) return 0;
				return Object.keys(byId).length;
			} catch {
				return 0;
			}
		}
		/**
		* Human-readable name of the read that answered.
		*
		* The index is the machine signal; this is what makes a `/state` snapshot or a
		* probe line readable on its own. `-1` names the failure
		* itself rather than a source, because "all four reads missed" is a fact about
		* the chain and not about any one read.
		*
		* @param reader - a hit index from `resolveCurrentSession()`.
		* @returns a fixed label; never throws and never varies between runs.
		*/
		function readerReason(reader) {
			switch (reader) {
				case 0: return "uiSession.adapter.current";
				case 1: return "uiSession.current";
				case 2: return "sessions.list.current";
				case 3: return "sessions.list.byId.retainedBy";
				default: return "no-read-answered";
			}
		}
		/** Narrow an unknown value to a readable observable, or null. */
		function observableOf(value) {
			if (typeof value !== "object" || value === null) return null;
			return typeof value.getSnapshot === "function" ? value : null;
		}
		/**
		* Which observable to follow so a session change is noticed without polling.
		*
		* `resolveCurrentSession()` answers *which* session is current and reports the
		* hit index; this answers the separate question of *what to subscribe to* for
		* that hit. Reads 2 and 3 share one source (`sessions.list`) and therefore one
		* subscription; reads 0 and 1 each name their own observable (the read-chain
		* split, PL-EN-NW-06). Nothing here subscribes — observation is the caller's, the same split
		* as everywhere else in this module — and nothing throws: an unreachable source,
		* or a `-1` hit, means "no observable to follow". A missing subscription is
		* never a correctness problem, only a slower notice of the switch.
		*
		* @param source - the same source `resolveCurrentSession()` was given.
		* @param reader - the hit index that function returned.
		* @returns the observable the hit index came from, or null when there is none.
		*/
		function currentSessionObservable(source, reader) {
			try {
				if (reader === 0 || reader === 1) {
					const ui = source.uiSession;
					return observableOf(reader === 0 ? ui?.adapter?.current : ui?.current);
				}
				if (reader === 2 || reader === 3) return observableOf(source.sessions?.list);
				return null;
			} catch {
				return null;
			}
		}
		//#endregion
		//#region src/client/visibility.ts
		/**
		* Default DOM selectors.
		*
		* `data-chat-flow` is emitted on the conversation flow container in every
		* loading and content state, and `data-chat-turn` is the turn number carried by
		* every rendered flow item — the harness's own scroll anchoring and
		* jump-to-turn code resolves rows through it, which is what makes it a
		* contract rather than a guess. It is still an internal attribute, so
		* {@link isTurnVisible} treats a missing row as "not observed" instead of
		* throwing.
		*/
		const FLOW_SELECTOR = "[data-chat-flow]";
		/** Attribute carrying the turn number of a conversation-flow item. */
		const TURN_ATTRIBUTE = "data-chat-turn";
		/** Attribute carrying the kind of a conversation-flow item. */
		const KIND_ATTRIBUTE = "data-chat-flow-kind";
		/**
		* Flow-item kinds that hold a turn's primary result, most authoritative first.
		*
		* `assistant-step` is the answer the user came to read — with the turn-process
		* disclosure open, a long turn renders one item per step, and they are measured
		* together. The two failure kinds are the result of a turn that produced no
		* answer, and are the only thing left to see. Every other kind belongs to the
		* turn's process disclosure (`reasoning`, `tool-call`, …) or to the prompt
		* (`user`, `steering`, `context`, `system-prompt`), which are not what
		* completion is about.
		*/
		const RESULT_KINDS = [
			"assistant-step",
			"turn-error",
			"turn-max-tokens"
		];
		/** Selector matching every flow item, used when no result kind rendered. */
		const ANY_TURN_ITEM = `[${TURN_ATTRIBUTE}]`;
		/**
		* One attribute on one element, or null.
		*
		* Kept local and defensive because every selector below is an upstream internal
		* contract: a harness that stops emitting one of these must degrade to "not
		* observed", never break the page.
		*
		* @param element - candidate element.
		* @param name - attribute name.
		* @returns the attribute value, or null when absent or unreadable.
		*/
		function attributeOf(element, name) {
			if (element === null || typeof element !== "object") return null;
			const reader = element.getAttribute;
			if (typeof reader !== "function") return null;
			try {
				const value = reader.call(element, name);
				return typeof value === "string" ? value : null;
			} catch {
				return null;
			}
		}
		/** Narrow an unknown node to something this module can measure. */
		function asElementLike(node) {
			if (node === null || typeof node !== "object") return null;
			const candidate = node;
			if (typeof candidate.getBoundingClientRect !== "function") return null;
			if (typeof candidate.getAttribute !== "function") return null;
			return node;
		}
		/**
		* Turn number of one flow item, or null when it carries no usable one.
		*
		* @param element - a matched flow item.
		* @returns the turn number, or null.
		*/
		function turnNumberOf(element) {
			const raw = attributeOf(element, TURN_ATTRIBUTE);
			if (raw === null || raw === "") return null;
			const turn = Number(raw);
			return Number.isSafeInteger(turn) && turn >= 0 ? turn : null;
		}
		/** Flow-item kind of one item, or null. */
		function kindOf(element) {
			const raw = attributeOf(element, KIND_ATTRIBUTE);
			return raw === null || raw === "" ? null : raw;
		}
		/**
		* Every conversation-flow item the page can see, in document order.
		*
		* One query for the whole conversation rather than one per turn: the caller
		* asks about single turns, and re-querying per turn would re-scan the flow and
		* re-encode the turn number into a selector string.
		*
		* The flow element is tried first, then the document: the harness virtualizes
		* old history, so a turn that has scrolled out of the rendered window has no
		* item at all, and the caller must read that as "not observed" rather than as
		* an error.
		*
		* @param deps - DOM face to inspect.
		* @returns the matched items.
		*/
		function flowItems(deps) {
			for (const scope of [deps.flowElement, deps.document]) {
				if (scope === null) continue;
				let matched;
				try {
					matched = scope.querySelectorAll(ANY_TURN_ITEM);
				} catch {
					continue;
				}
				const items = [];
				for (let index = 0; index < matched.length; index += 1) {
					const item = asElementLike(matched[index]);
					if (item !== null) items.push(item);
				}
				if (items.length > 0) return items;
			}
			return [];
		}
		/**
		* All items of one turn, in document order.
		*
		* @param deps - DOM face to inspect.
		* @param turn - the turn number to collect.
		* @returns the turn's items; empty when the turn is not rendered.
		*/
		function turnItems(deps, turn) {
			return flowItems(deps).filter((item) => turnNumberOf(item) === turn);
		}
		/**
		* Build the DOM face from the real document.
		*
		* `flowElement` / `scrollElement` are **resolved on every read**, never captured
		* once. The harness remounts the conversation slot whenever the session
		* changes, and a face frozen at construction goes stale at the first switch:
		* `querySelectorAll` on the detached flow still returns the children it was
		* holding, so {@link flowItems} never reaches its `document` fallback, and every
		* rectangle measured on the dead nodes is 0 — which leaves {@link isTurnVisible}
		* permanently false and stops `/seen` for the life of the page, with nothing
		* logged (found in the field on 2026-10-02; the trap it leaves behind is
		* IS-009).
		*
		* Re-reading the two nodes per evaluation costs two `querySelector` calls and
		* keeps {@link VisibilityDeps} a plain value shape, so no consumer changes.
		*
		* @param root - document to read; defaults to the page's own.
		* @returns a {@link VisibilityDeps} bound to that root.
		*/
		function createVisibilityDeps(root) {
			const doc = root ?? (typeof document === "undefined" ? void 0 : document);
			const asScope = (value) => value;
			const query = (selector) => {
				if (doc === void 0) return null;
				return (doc.querySelector("[data-phase='active']") ?? doc).querySelector(selector) ?? doc.querySelector(selector);
			};
			return {
				document: doc ?? null,
				get flowElement() {
					return asScope(doc === void 0 ? null : query(FLOW_SELECTOR));
				},
				get scrollElement() {
					return asScope(doc === void 0 ? null : query("[data-conversation-scroll]") ?? query("[data-chat-flow]"));
				},
				viewportHeight: () => typeof window === "undefined" ? 0 : window.innerHeight,
				rectOf: (element) => element.getBoundingClientRect()
			};
		}
		/**
		* L1 + L2 only. Deliberately says nothing about whether the user is looking at
		* the *right* conversation.
		*
		* @param doc - document to inspect.
		* @returns `'hidden'`, `'visible'`, or `'focused'`.
		*/
		function basicLevel(doc) {
			if (doc.visibilityState !== "visible") return "hidden";
			return doc.hasFocus() ? "focused" : "visible";
		}
		/**
		* The band a turn must intersect to count as on screen: the scroll container's
		* box clipped to the viewport, so an element scrolled under the composer or
		* above the window top is not credited.
		*
		* @param deps - DOM face to inspect.
		* @returns viewport-relative `top`/`bottom`.
		*/
		function visibleBand(deps) {
			const viewportHeight = deps.viewportHeight();
			const scroll = deps.scrollElement;
			const bounds = scroll === null ? null : deps.rectOf(scroll);
			const viewportTop = typeof window === "undefined" || typeof window.scrollY !== "number" ? 0 : window.scrollY;
			const viewportBottom = viewportTop + viewportHeight;
			if (bounds === null) return {
				top: viewportTop,
				bottom: viewportBottom
			};
			return {
				top: Math.max(bounds.top, viewportTop),
				bottom: Math.min(bounds.bottom, viewportBottom)
			};
		}
		/**
		* Union box of the rendered items among `items`, or null when none is rendered.
		*
		* Zero-width and zero-height items are skipped: the harness keeps a zero-height
		* flow item per unloaded turn, and counting those would make an off-screen turn
		* look as if it spanned the whole conversation.
		*
		* @param deps - DOM face to inspect.
		* @param items - candidate items of one group.
		* @returns the union rectangle, or null.
		*/
		function unionBox(deps, items) {
			let top = Number.POSITIVE_INFINITY;
			let bottom = Number.NEGATIVE_INFINITY;
			let width = 0;
			for (const item of items) {
				const rect = deps.rectOf(item);
				if (rect.width <= 0 || rect.height <= 0) continue;
				if (rect.top < top) top = rect.top;
				if (rect.bottom > bottom) bottom = rect.bottom;
				if (rect.width > width) width = rect.width;
			}
			if (bottom <= top) return null;
			return {
				top,
				bottom,
				width,
				height: bottom - top
			};
		}
		/**
		* The box that stands for a turn's *result*, or null when no reliable result of
		* it is rendered.
		*
		* This is the whole of D1. Measuring "the turn" as `[data-chat-turn="N"]`'s
		* first match measured a header-sized row a few dozen pixels tall, while the
		* answer it belonged to was thousands of pixels tall; scrolling far enough to
		* read the answer therefore always pushed that row off screen, so L3 never
		* held and no popup was ever retracted. The result is instead the turn's
		* primary content:
		*
		* 1. the answer items (`assistant-step`) — every step when the process
		*    disclosure is open, measured together;
		* 2. failing that, the turn's failure item (`turn-error`, `turn-max-tokens`),
		*    which *is* the result of a turn that produced no answer;
		* 3. failing both, nothing. A turn whose every rendered row is prompt or
		*    process material (`user`, `steering`, `system-prompt`, `context`,
		*    `reasoning`, `tool-call`, `turn-process`, `turn-tail`, …) has no result on
		*    screen to read, and "the user had a real opportunity to see this result"
		*    is simply false about it.
		*
		* Taking the *union* of a result group, rather than its tallest single item,
		* means the answer counts as on screen while the user is anywhere inside it,
		* which is exactly the reading the dwell rule needs. A group with no rendered
		* member is not used at all, so a collapsed or zero-height answer does not
		* report an off-screen turn as seen.
		*
		* Rule 3 used to fall back to the union of *every* item of the turn. That was a
		* defect: with the answer not rendered — a virtualized or collapsed turn, or a
		* turn that only ever produced process rows — the user's own message or a tool
		* row stood in for the result, and the notice was retired while nobody had seen
		* anything. It is the same "silently swallowed notice" failure this module
		* exists to prevent, so the fallback is gone and the caller reads null as "not
		* observed".
		*
		* @param deps - DOM face to inspect.
		* @param turn - the turn number to measure.
		* @returns the result rectangle, or null when the turn shows no result.
		*/
		function turnResultBox(deps, turn) {
			const items = turnItems(deps, turn);
			if (items.length === 0) return null;
			for (const kind of RESULT_KINDS) {
				const box = unionBox(deps, items.filter((item) => kindOf(item) === kind));
				if (box !== null) return box;
			}
			return null;
		}
		/**
		* Whether the finished `turn`'s result occupies any part of the visible band.
		*
		* A turn whose header is on screen but whose answer is not is deliberately
		* *not* visible: the header is not what the user is being asked to read.
		*
		* Occlusion is not modelled: an element covered by another one still counts.
		* That is a deliberate limit — `elementFromPoint` makes the check flaky around
		* sticky headers and the composer overlay, and a stricter check that misfires
		* would resurrect exactly the "silently swallowed notice" problem this module
		* exists to prevent.
		*
		* @param deps - DOM face to inspect.
		* @param turn - the turn number to look for.
		* @returns whether the turn's result is inside the visible band.
		*/
		function isTurnVisible(deps, turn) {
			const box = turnResultBox(deps, turn);
			if (box === null) return false;
			const band = visibleBand(deps);
			const top = Math.max(box.top, band.top);
			return Math.min(box.bottom, band.bottom) - top > 0;
		}
		/**
		* Edge-triggered visibility tracker.
		*
		* Update it from browser events (`focus`, `blur`, `visibilitychange`, scroll,
		* `pagehide`) and from DOM mutations; it runs the L1→L3 ladder itself and calls
		* {@link VisibilityTracker.update} at most once per target transition.
		*
		* A target whose dwell is interrupted — tab hidden, window blurred, rows
		* re-rendered, or the awaited turn changing — restarts from zero. Nothing is
		* carried over from a previous observation, which is what stops a stale "the
		* user was looking earlier" from retiring a brand-new notice.
		*/
		var VisibilityTracker = class {
			target = null;
			/** Epoch ms the current target first satisfied every L3 condition. */
			dwellStartedAt = null;
			reported = false;
			dwellMs;
			now;
			deps;
			canReport;
			constructor(options) {
				this.deps = options.deps;
				this.dwellMs = options.dwellMs;
				this.now = options.now ?? (() => Date.now());
				this.canReport = options.canReport;
			}
			/**
			* Swap the DOM face. Used when the page itself is replaced, and by tests.
			*
			* @param deps - the new DOM face.
			*/
			setDeps(deps) {
				this.deps = deps;
			}
			/** Continuous-visibility threshold currently in force, in ms. */
			currentDwellMs() {
				return this.dwellMs;
			}
			/**
			* Whether a turn's result is on screen right now.
			*
			* Exposed so the page can pick a watch target it is actually able to confirm,
			* instead of queueing behind a notice that is scrolled out of view.
			*
			* @param turn - the turn number to check.
			* @returns whether the turn occupies part of the visible band.
			*/
			isTurnOnScreen(turn) {
				return isTurnVisible(this.deps, turn);
			}
			/**
			* Adopt a new dwell threshold, restarting the clock.
			*
			* A threshold change is a policy change, so the time already accumulated
			* under the old one must not count towards the new one: shortening the
			* threshold may then report sooner, but lengthening it can never be
			* defeated by time banked under the old value.
			*
			* @param dwellMs - the new threshold; non-finite or negative values are ignored.
			* @returns whether the threshold actually changed.
			*/
			setDwellMs(dwellMs) {
				if (!Number.isFinite(dwellMs) || dwellMs < 0) return false;
				if (dwellMs === this.dwellMs) return false;
				this.dwellMs = dwellMs;
				this.dwellStartedAt = null;
				this.reported = false;
				return true;
			}
			/**
			* Declare which result should be watched.
			*
			* @param target - the notice's identifiers plus its turn number, or null to
			*   clear the watch (session switch, run change, tab losing focus).
			*/
			setTarget(target) {
				if (target === null) {
					this.target = null;
					this.dwellStartedAt = null;
					this.reported = false;
					return;
				}
				if (this.target !== null && this.target.sessionId === target.sessionId && this.target.noticeId === target.noticeId && this.target.turn === target.turn) return;
				this.target = target;
				this.dwellStartedAt = null;
				this.reported = false;
			}
			/** The target currently being watched, if any. */
			currentTarget() {
				return this.target === null ? null : { ...this.target };
			}
			/**
			* Re-arm the current target so L3 can fire again.
			*
			* Used when a report was refused for a reason that may not repeat — a focus
			* lease the host had not yet refreshed, say. Without this the target counts
			* as reported forever and a single refusal would blacklist the notice for the
			* life of the page, which is the defect this round fixes. The dwell clock
			* restarts, so a second report still requires the user to have kept looking.
			*
			* @returns whether there is a target to re-arm.
			*/
			rearm() {
				if (this.target === null) return false;
				this.dwellStartedAt = null;
				this.reported = false;
				return true;
			}
			/**
			* Evaluate the ladder and report once per target.
			*
			* @param doc - the page document.
			* @returns the level reached, the reported notice id when a report just
			*   fired, and dwell bookkeeping for diagnostics.
			*/
			update(doc) {
				const base = basicLevel(doc);
				const now = this.now();
				if (base !== "focused") {
					this.dwellStartedAt = null;
					this.reported = false;
					return {
						level: base,
						report: null,
						dwellMs: 0
					};
				}
				const target = this.target;
				if (target === null) return {
					level: "focused",
					report: null,
					dwellMs: 0
				};
				if (!isTurnVisible(this.deps, target.turn)) {
					this.dwellStartedAt = null;
					this.reported = false;
					return {
						level: "focused",
						report: null,
						dwellMs: 0
					};
				}
				if (this.dwellStartedAt === null) this.dwellStartedAt = now;
				const dwellMs = now - this.dwellStartedAt;
				if (dwellMs < this.dwellMs) return {
					level: "focused",
					report: null,
					dwellMs
				};
				if (this.reported) return {
					level: "observed",
					report: null,
					dwellMs
				};
				if (this.canReport !== void 0 && !this.canReport(target)) return {
					level: "observed",
					report: null,
					dwellMs
				};
				this.reported = true;
				return {
					level: "observed",
					report: {
						noticeId: target.noticeId,
						sessionId: target.sessionId
					},
					dwellMs
				};
			}
		};
		//#endregion
		//#region src/client/index.ts
		/**
		* Browser half of `dsh-pet-seen`.
		*
		* This half is intentionally tiny and **dependency-free**: it renders no UI, so
		* it never touches `react` or the frozen module table, and its bundle is
		* provably free of runtime imports.
		*
		* What it does:
		*
		* 1. Learns the session the user is actually looking at — `uiSession` when the
		*    runtime has it, the `sessions` service as the fallback — and keeps the
		*    host's per-tab focus lease fresh. Every actual switch bumps a generation,
		*    so a `notices` or `seen` result that lands after the user has moved on is
		*    dropped rather than applied to the session they left; following the source
		*    with `subscribe` only makes the switch noticed sooner.
		* 2. Asks the host which notices are still unconfirmed for that session.
		* 3. Watches the finished turn through the L1→L3 ladder in `visibility.ts`, and
		*    reports `/seen` only when L3 holds — refreshing the focus lease first, so a
		*    report cannot be refused for a lease that the page simply had not renewed
		*    yet.
		* 4. Reports *which* read named that session on every one of those reports,
		*    including the `-1` reading where none did. That is the drift self-check
		*    (PL-EN-NW-06): the same condition that silently broke notice retraction
		*    on 0.2.0-rc.2 now leaves a trace in `GET /state` within seconds.
		* 5. Reports its **own build identity** on the same reports (PL-EN-NW-02), so the
		*    host can publish "what I am" next to "what the page says it is" and a
		*    half-refreshed install — a new host with an old page, or the reverse — is
		*    visible instead of silent.
		*
		* Every decision it makes is in `decide.ts`; this file is only the wiring.
		*
		* @module dsh-pet-seen/client
		*/
		/** Services this half needs. These are runtime package names, not values. */
		const inject = ["sessions", "connection"];
		/** How often the ladder is evaluated while the page is focused, in ms. */
		const DWELL_TICK_MS = 300;
		/**
		* How often pending notices are re-queried while the page is focused.
		*
		* Exported so a test can recognise this timer and hold it out of the way: the
		* poll is the one path that can look up the current session entirely on its own,
		* so a case that is about a switch the page has not noticed has to be able to
		* prove the query it asserts on did not come from here.
		*/
		const NOTICES_POLL_MS = 1e3;
		/**
		* Floor between two `/notices` requests, in ms.
		*
		* Mutations during streaming used to schedule one query per 120 ms burst on top
		* of the 1 s poll, which measured at roughly two requests per second on a real
		* page. The floor keeps scroll, session switches and a new result appearing
		* responsive without letting a re-rendering conversation set the pace.
		*/
		const NOTICES_MIN_INTERVAL_MS = 500;
		/** How often the focus lease is refreshed while the page stays focused. */
		const LEASE_REFRESH_MS = 5e3;
		/** Fallback dwell threshold, used until the host advertises its own. */
		const DEFAULT_SEEN_DWELL_MS = 1500;
		/**
		* Minimum spacing between two `/seen` attempts for the same notice, in ms.
		*
		* The dwell clock is the real rate limiter — a retry has to earn L3 again — so
		* this only stops the extra attempt a 300 ms tick could fire while the clock is
		* still satisfied, and bounds what a persistently failing host can be asked.
		* Kept short so a refusal costs the user a couple of seconds of cancellation,
		* not a minute.
		*/
		const SEEN_RETRY_COOLDOWN_MS = 2e3;
		/** Per-tab-instance id key; survives reloads of the same tab. */
		const TAB_ID_KEY = "dsh-pet-seen:tab-id";
		/**
		* Ask a timer not to hold the process open.
		*
		* In the page these are plain numbers; under Node's test harness the same code
		* path may receive a `Timeout` object. Both are fine — this only silences the
		* "unref if it exists" difference without a cast at every call site.
		*
		* @param timer - value returned by `setTimeout`/`setInterval`.
		*/
		function unref(timer) {
			if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref?.();
		}
		/** Read or mint this tab's opaque id. */
		function tabId() {
			try {
				const existing = sessionStorage.getItem(TAB_ID_KEY);
				if (existing !== null && existing !== "") return existing;
				const minted = globalThis.crypto?.randomUUID?.() ?? `tab-${Math.random().toString(36).slice(2)}`;
				sessionStorage.setItem(TAB_ID_KEY, minted);
				return minted;
			} catch {
				return `tab-${Math.random().toString(36).slice(2)}`;
			}
		}
		/**
		* Delay before the next `/notices` query, honouring a floor between requests.
		*
		* @param now - current epoch ms.
		* @param lastAt - epoch ms of the last query, or null when there never was one.
		* @param minIntervalMs - floor between two queries.
		* @param baseDelayMs - coalescing delay for the triggering burst.
		* @returns milliseconds to wait before querying.
		*/
		function nextRefreshDelay(now, lastAt, minIntervalMs, baseDelayMs) {
			if (lastAt === null) return baseDelayMs;
			const elapsed = now - lastAt;
			return elapsed >= minIntervalMs ? baseDelayMs : minIntervalMs - elapsed;
		}
		/** POST JSON, ignoring every failure: the page must never break because of this plugin. */
		async function postJson(path, body) {
			try {
				const response = await fetch(path, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
					credentials: "same-origin"
				});
				if (!response.ok) return null;
				const parsed = await response.json();
				return typeof parsed === "object" && parsed !== null ? parsed : null;
			} catch {
				return null;
			}
		}
		/**
		* Client plugin entry point.
		*
		* @param ctx - browser plugin context.
		*/
		function apply(ctx) {
			const log = (message) => {
				ctx.logger?.info?.(`dsh-pet-seen: ${message}`);
			};
			const id = tabId();
			/**
			* Notice ids this page has settled or been terminally refused for.
			*
			* Cleared on a session switch, because the host list is the authority again
			* at that point. A merely *transient* refusal never lands here — that is D4:
			* a race must not blacklist a notice for the life of the page.
			*/
			const blocked = /* @__PURE__ */ new Set();
			const attempts = createAttemptGate(SEEN_RETRY_COOLDOWN_MS);
			const tracker = new VisibilityTracker({
				deps: createVisibilityDeps(),
				dwellMs: DEFAULT_SEEN_DWELL_MS,
				canReport: (target) => attempts.canAttempt(target.noticeId, Date.now())
			});
			/** Continuous-visibility threshold currently in force, in ms. */
			let dwellMs = DEFAULT_SEEN_DWELL_MS;
			/** Notices the host reported as unconfirmed for the current session. */
			let pending = [];
			let currentSessionId = null;
			let disposed = false;
			/**
			* Bumped whenever the current session actually changes.
			*
			* This is the generation invariant (PL-EN-NW-06): a switch invalidates every
			* previous observation immediately. An async result that was launched for the
			* old session must therefore not be allowed to write state when it lands, and
			* comparing this counter is what makes that true. Following the source below
			* only narrows the window in which a switch is *noticed* — the counter is what
			* keeps a late response harmless even with no subscription at all.
			*/
			let generation = 0;
			/** The source currently followed, and how to stop following it. */
			let subscribedTo = null;
			let unsubscribeSource = null;
			/**
			* Read `uiSession` reflectively, on every call.
			*
			* Not captured at `apply()` time and not in `inject`, because the service may
			* arrive late, be replaced by a reload, or never exist — and all three have to
			* mean "no current session", not "this half failed to start".
			*/
			const readUiSession = () => {
				try {
					return ctx.get?.("uiSession");
				} catch {
					return;
				}
			};
			/** The values the read chain is allowed to look at, re-read on every call. */
			const sessionSource = () => ({
				uiSession: readUiSession(),
				sessions: ctx.sessions
			});
			/**
			* The session the user is looking at, its title, and which read found it.
			*
			* `reader` names which read answered, and is consumed twice: to pick the
			* source worth following (below) and as the drift signal reported upstream
			* through {@link readDiagnostics}. A failure here is an ordinary "no current
			* session" (invariant: the page never breaks because of this plugin).
			*/
			const snapshot = () => {
				try {
					return resolveCurrentSession(sessionSource());
				} catch {
					return {
						sessionId: null,
						title: null,
						reader: -1
					};
				}
			};
			/**
			* The drift self-check fields (PL-EN-NW-06) that ride with every report.
			*
			* `reader` is already known from the snapshot the caller took; the other two
			* cost one extra `sessions.list` read, which is a rounding error next to the
			* HTTP round trip the body is about to make. Diagnostics only: the host stores
			* them and nothing here can mark a notice seen.
			*
			* @param resolved - the snapshot whose `reader` is being reported.
			* @returns the optional fields to spread into the visibility body.
			*/
			const readDiagnostics = (resolved) => ({
				reader: resolved.reader,
				readerReason: readerReason(resolved.reader),
				byIdCount: byIdCount(sessionSource())
			});
			let refreshTimer = null;
			let lastRefreshAt = null;
			/** Coalesce bursts, and keep a floor between two actual queries. */
			const scheduleRefresh = () => {
				if (refreshTimer !== null || disposed) return;
				const delay = nextRefreshDelay(Date.now(), lastRefreshAt, NOTICES_MIN_INTERVAL_MS, 120);
				refreshTimer = setTimeout(() => {
					refreshTimer = null;
					if (!disposed) refreshNotices();
				}, delay);
				unref(refreshTimer);
			};
			/**
			* React to the followed source changing.
			*
			* Only an *actual* change clears anything. These observables also emit for
			* row-level edits — a title, a `running` flag — and treating every emission as
			* a switch would throw away the pending notices the user is still looking at.
			* `syncSession` is idempotent, so an emission that did not move the session
			* costs one snapshot read and one coalesced re-query.
			*/
			const onSessionSourceChange = () => {
				syncSession();
				scheduleRefresh();
			};
			/**
			* Follow the source the winning read came from, so a switch is noticed in
			* milliseconds instead of at the next poll.
			*
			* Re-binding is identity-based: when the service is replaced (a reload hands
			* us a new `uiSession`, or the winning read moves to another source) the old
			* subscription is dropped and the new object is followed. A source without
			* `subscribe`, or none at all, is not a problem — the generation check in
			* `refreshNotices()` / `reportSeen()` has to hold either way.
			*
			* @param resolved - the session image whose `reader` won the chain.
			*/
			const bindSessionSubscription = (resolved) => {
				if (resolved.reader === -1) return;
				const observable = currentSessionObservable(sessionSource(), resolved.reader);
				if (observable === null || observable === subscribedTo) return;
				if (typeof observable.subscribe !== "function") return;
				unsubscribeSource?.();
				subscribedTo = observable;
				try {
					unsubscribeSource = observable.subscribe(() => {
						onSessionSourceChange();
					}) ?? null;
				} catch {
					subscribedTo = null;
					unsubscribeSource = null;
				}
			};
			/**
			* Bring the page's idea of the current session up to date, bumping the
			* generation when it actually moved.
			*
			* One place owns both, because the previous code wrote `currentSessionId` from
			* two directions — `reportVisibility()` unconditionally, `refreshNotices()` in
			* its switch guard — and a switch could therefore be missed: the visibility
			* path set the id first, and the guard that was supposed to clear the watch
			* state then saw no change at all.
			*
			* @param resolved - a snapshot the caller already took, to avoid reading twice.
			* @returns the session image now in force.
			*/
			const syncSession = (resolved = snapshot()) => {
				if (resolved.sessionId !== currentSessionId) {
					generation += 1;
					currentSessionId = resolved.sessionId;
					pending = [];
					blocked.clear();
					attempts.clear();
					tracker.setTarget(null);
					log(`current session is now ${resolved.sessionId ?? "none"}`);
				}
				bindSessionSubscription(resolved);
				return resolved;
			};
			/** Send the current L1/L2 state so the host can maintain this tab's lease. */
			const reportVisibility = async () => {
				const resolved = syncSession();
				await postJson(BROWSER_ROUTES.visibility, {
					v: 1,
					tabId: id,
					sessionId: resolved.sessionId,
					visible: document.visibilityState === "visible",
					focused: document.hasFocus(),
					title: resolved.title,
					...readDiagnostics(resolved),
					buildId: BUILD_ID
				});
			};
			/** Point the tracker at whichever unconfirmed notice is worth watching. */
			const retarget = (sessionId) => {
				const selection = selectWatchTarget(watchableCandidates(pending, blocked), sessionId, (turn) => tracker.isTurnOnScreen(turn));
				tracker.setTarget(selection.target);
			};
			/** Pull the unconfirmed notices for the current session. */
			const refreshNotices = async () => {
				const { sessionId } = syncSession();
				const gen = generation;
				if (sessionId === null) {
					pending = [];
					tracker.setTarget(null);
					return;
				}
				lastRefreshAt = Date.now();
				try {
					const response = await fetch(`${BROWSER_ROUTES.notices}?sessionId=${encodeURIComponent(sessionId)}`, { credentials: "same-origin" });
					if (!response.ok) return;
					const payload = await response.json();
					const current = snapshot();
					if (disposed || gen !== generation || current.sessionId !== sessionId) {
						if (!disposed && current.sessionId !== sessionId) {
							syncSession(current);
							scheduleRefresh();
						}
						return;
					}
					pending = Array.isArray(payload.notices) ? payload.notices : [];
					const advertised = resolveDwellMs(payload.seenDwellMs, dwellMs);
					if (tracker.setDwellMs(advertised)) {
						dwellMs = advertised;
						log(`dwell threshold now ${advertised} ms`);
					}
				} catch {
					return;
				}
				retarget(sessionId);
			};
			/**
			* Report an L3 observation; the host independently re-validates it.
			*
			* The focus lease is refreshed first: coming back from another window, the
			* host may still be holding the `focused: false` report the page sent on the
			* way out, and reporting against it is refused for a lease that is merely old.
			* That refresh is also the one await in which the user can leave the session,
			* so the generation is captured before it and re-checked after — and, because
			* a switch can happen without this page noticing it yet, the source is
			* re-read as well. `refreshNotices()` answers the same question the same way;
			* the cached half alone only covers a switch that something already observed.
			*/
			const reportSeen = async (noticeId, sessionId) => {
				const notice = pending.find((candidate) => candidate.noticeId === noticeId);
				if (notice === void 0) return;
				attempts.remember(noticeId, Date.now());
				const gen = generation;
				await reportVisibility();
				const stillCurrent = snapshot();
				if (disposed || stillCurrent.sessionId !== sessionId) {
					if (!disposed) {
						syncSession(stillCurrent);
						scheduleRefresh();
					}
					return;
				}
				const response = await postJson(BROWSER_ROUTES.seen, {
					v: 1,
					noticeId,
					runId: notice.runId,
					sessionId,
					tabId: id,
					observed: true
				});
				if (disposed || gen !== generation || currentSessionId !== sessionId) return;
				const afterPost = snapshot();
				if (disposed || afterPost.sessionId !== sessionId) {
					if (!disposed) {
						syncSession(afterPost);
						scheduleRefresh();
					}
					return;
				}
				const outcome = classifySeenOutcome(response?.accepted === true, response?.reason);
				if (outcome === "retry") {
					log(`observation for ${noticeId} not accepted: ${String(response?.reason ?? "no-response")}`);
					tracker.rearm();
					return;
				}
				if (outcome === "stop") {
					log(`observation for ${noticeId} refused: ${String(response?.reason ?? "unknown")}`);
					blocked.add(noticeId);
				}
				pending = pending.filter((candidate) => candidate.noticeId !== noticeId);
				retarget(sessionId);
			};
			const onAnyStateChange = () => {
				reportVisibility();
				refreshNotices();
			};
			const onUnload = () => {
				const current = snapshot();
				const body = JSON.stringify({
					v: 1,
					tabId: id,
					sessionId: current.sessionId,
					visible: false,
					focused: false,
					title: current.title,
					...readDiagnostics(current),
					buildId: BUILD_ID
				});
				try {
					if (typeof navigator.sendBeacon === "function") {
						navigator.sendBeacon(BROWSER_ROUTES.visibility, new Blob([body], { type: "application/json" }));
						return;
					}
				} catch {}
				fetch(BROWSER_ROUTES.visibility, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
					credentials: "same-origin",
					keepalive: true
				}).catch(() => void 0);
			};
			ctx.effect(() => {
				const listeners = [
					{
						event: "focus",
						listener: onAnyStateChange
					},
					{
						event: "blur",
						listener: onAnyStateChange
					},
					{
						event: "visibilitychange",
						listener: onAnyStateChange
					},
					{
						event: "scroll",
						listener: scheduleRefresh
					},
					{
						event: "pagehide",
						listener: onUnload
					}
				];
				for (const { event, listener } of listeners) window.addEventListener(event, listener, event === "scroll" ? {
					capture: true,
					passive: true
				} : void 0);
				const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
					scheduleRefresh();
				});
				observer?.observe(document.documentElement, {
					childList: true,
					subtree: true
				});
				const leaseTimer = setInterval(() => {
					if (document.visibilityState === "visible" && document.hasFocus()) reportVisibility();
				}, LEASE_REFRESH_MS);
				unref(leaseTimer);
				const noticeTimer = setInterval(() => {
					if (document.visibilityState === "visible" && document.hasFocus()) refreshNotices();
				}, NOTICES_POLL_MS);
				unref(noticeTimer);
				const dwellTimer = setInterval(() => {
					if (disposed) return;
					const result = tracker.update(document);
					if (result.report === null) return;
					reportSeen(result.report.noticeId, result.report.sessionId);
				}, DWELL_TICK_MS);
				unref(dwellTimer);
				reportVisibility();
				refreshNotices();
				log("client runtime started");
				return () => {
					disposed = true;
					unsubscribeSource?.();
					unsubscribeSource = null;
					subscribedTo = null;
					clearInterval(leaseTimer);
					clearInterval(noticeTimer);
					clearInterval(dwellTimer);
					if (refreshTimer !== null) {
						clearTimeout(refreshTimer);
						refreshTimer = null;
					}
					observer?.disconnect();
					for (const { event, listener } of listeners) window.removeEventListener(event, listener, event === "scroll" ? { capture: true } : void 0);
					tracker.setTarget(null);
				};
			});
		}
		//#endregion
		exports.NOTICES_POLL_MS = NOTICES_POLL_MS;
		exports.SEEN_RETRY_COOLDOWN_MS = SEEN_RETRY_COOLDOWN_MS;
		exports.apply = apply;
		exports.inject = inject;
		exports.nextRefreshDelay = nextRefreshDelay;
		return module.exports;
	}
});
