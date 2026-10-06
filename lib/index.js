import { randomBytes, randomUUID } from "node:crypto";
import Schema from "@deepseek-ai/schemastery";
import { createServer, request } from "node:http";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
//#region src/protocol.ts
/**
* Wire protocol shared by the three participants of the desktop-pet bridge:
*
*   host plugin (Node)  ←→  desktop pet (any local process)  ←→  browser page
*
* This module is the single source of truth for event names, payload shapes,
* and the normalization table. The desktop-pet half (`pet.py`) reimplements the
* receiving end against this same document instead of importing it, so every
* change here is a protocol change and must bump {@link PROTOCOL_VERSION}.
*
* Deliberately dependency-free (no `node:` imports, no harness imports): the
* browser bundle re-exports parts of this file, and the client build must not
* pull Node builtins into the page.
*
* **What counts as a version bump.** Everything the pet parses — events,
* `/hello`, `/ack`, `/state` — is a wire contract with a second implementation
* in `pet.py`, so a change there has to bump {@link PROTOCOL_VERSION}. An
* additive *optional* field on a browser-only route is not that: the pet never
* reads `/pet-bridge/visibility`, and no participant can observe the addition
* except the host. Those stay on v1 (see {@link VisibilityRequest.reader} and
* {@link VisibilityRequest.buildId}). The same holds for a **new** field on
* `/state`: `pet_bridge.snapshot_status()` reads `sessions` and `revision` and
* ignores every other key, so {@link StatePayload.buildId} is additive too.
*
* @module dsh-pet-seen/protocol
*/
/** Protocol revision carried by every event, control response, and handshake. */
const PROTOCOL_VERSION = 1;
/** Event source tag the pet uses to tell this producer apart from its own UI. */
const EVENT_SOURCE = "deepseek-harness";
/** Default loopback port the pet listens on for `POST /event`. */
const DEFAULT_PET_PORT = 17322;
/** Default loopback port this plugin listens on for `/hello`, `/state`, `/ack`. */
const DEFAULT_CONTROL_PORT = 17323;
/** Hard cap on any request body this plugin accepts (bytes). */
const MAX_REQUEST_BODY_BYTES = 65536;
/** Cap on a session title before it reaches the wire; titles echo user input. */
const MAX_TITLE_LENGTH = 160;
/**
* Cap on the reported `sessions.list.byId` size.
*
* A diagnostic bound, not a correctness one: the number is only ever printed, so
* it is clamped to keep an absurd value out of the snapshot instead of out of
* the page.
*/
const MAX_BY_ID_COUNT = 1e4;
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
* `package.json` `version` at the moment this build was made.
*
* The human-readable half of the same fact: {@link BUILD_ID} answers "same
* build or not", this answers "which release is it" without a hash lookup. It is
* the *plugin's* version — deliberately not the DSH version the peer range in
* `package.json` talks about, and not {@link PROTOCOL_VERSION}.
*/
const PLUGIN_VERSION = "0.1.1";
/**
* The normalized events this host actually dispatches, as a runtime list.
*
* Its sibling {@link RESERVED_PET_EVENT_NAMES} is the other half of the same
* union: `session/removed` is named here in the type, accepted by the pet's own
* `EVENT_NAMES` whitelist, and listed in `README.md` §4.1 — but the host
* subscribes to nothing that would ever send it, and `NoticeStore.removeSession`
* has no caller. Publishing it as an implemented event would turn that debt into
* a promise (IS-014, PL-PR-IV-01), so the published schema carries it as
* **reserved** instead.
*
* Runtime arrays rather than types alone because `protocol/bridge-v1.schema.json`
* enumerates both groups and the drift test compares them by value (PL-PR-NW-02).
*/
const PET_EVENT_NAMES = [
	"idle",
	"running",
	"completed",
	"error",
	"notice/seen"
];
/**
* Events named in the union that this host never dispatches.
*
* Ownership is `PL-PR-IV-01`; when the runtime probe settles that item, the name
* moves between the two lists and nothing else about the wire format changes
* (`protocol/bridge-v1.schema.json` states the same rule as a compatibility
* clause).
*/
const RESERVED_PET_EVENT_NAMES = ["session/removed"];
/**
* The event names that may carry a settled run's `noticeId`.
*
* These are the two *result* events. `error` appears in both roles — a
* notice-bearing result and a running-time failure report — so the pet's rule is
* "pop up only when `noticeId` is present", never "when the name is `error`".
* Everything else (`idle`, `running`, `session/removed`) is lifecycle chatter.
*/
const NOTICE_EVENT_NAMES = ["completed", "error"];
/**
* Type guard for a value usable as a {@link SessionReaderIndex}.
*
* Deliberately strict, because the value arrives from a page: `"0"`, `1.5`, `-2`
* and `4` are all dropped rather than coerced, so a malformed report degrades to
* "no diagnostic" instead of inventing one.
*
* @param value - candidate value from a request body.
* @returns true when the value is one of the five valid indices.
*/
function isReaderIndex(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= -1 && value <= 3;
}
/**
* Capability names a pet and this host negotiate at `/hello` (PL-PR-NW-02).
*
* One vocabulary for both directions: the pet declares which of these it
* implements, and the host answers with the set it supports plus the
* intersection it will actually rely on. A capability does not gate the event
* stream — a missing one only removes an *assumption*:
*
* - `events` — accepts `POST /event` at all.
* - `state-sync` — pulls `GET /state` and aligns its popups to that snapshot.
* - `ack-shown` — reports a popup that is really on screen through `/ack`.
* - `ack-dismissed` — reports a popup the user closed by hand.
* - `notice-seen` — treats `notice/seen` as "retire that popup".
*
* A pet that declares no set at all is a **legacy** pet: the handshake and every
* push keep working exactly as before, and the only thing the host may not do is
* read the absent `ack-shown` as "that popup was never displayed".
*
* The drift test compares this list, `protocol/bridge-v1.schema.json`, and the
* second receiver in `tools/mock-pet.mjs` by value.
*/
const BRIDGE_CAPABILITIES = [
	"events",
	"state-sync",
	"ack-shown",
	"ack-dismissed",
	"notice-seen"
];
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
/** Control-endpoint paths served on the loopback control port. */
const CONTROL_ROUTES = {
	hello: "/hello",
	state: "/state",
	ack: "/ack"
};
/** Hostnames accepted by the browser-side same-origin check. */
const LOOPBACK_HOSTNAMES = /* @__PURE__ */ new Set([
	"localhost",
	"127.0.0.1",
	"[::1]",
	"::1"
]);
/**
* Same-origin check for browser calls, mirroring the approach used by the
* installed `dsh-plugin` package: the `Origin` host must equal the request
* `Host` and must itself be a loopback name.
*
* A missing `Origin` is accepted only when `Host` is loopback, because
* same-origin `fetch` from the DSH page always sends one and non-browser
* clients on loopback are already handled by the bearer token path.
*
* @param origin - raw `Origin` header, if any.
* @param host - raw `Host` header, if any.
* @returns true when the request is an accepted same-origin loopback call.
*/
function isSameOriginLoopback(origin, host) {
	if (host === void 0 || host === "") return false;
	const hostName = stripPort(host);
	if (!LOOPBACK_HOSTNAMES.has(hostName)) return false;
	if (origin === void 0 || origin === "") return true;
	let parsed;
	try {
		parsed = new URL(origin);
	} catch {
		return false;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
	if (!isLoopbackName(stripPort(parsed.host))) return false;
	return portOf(parsed.host) === portOf(host);
}
/**
* Port of a `host[:port]` value, or `-1` when absent.
*
* @param host - a `Host`-header-shaped value.
* @returns the numeric port, or -1 for a missing/unparsable one.
*/
function portOf(host) {
	const bare = host.startsWith("[") ? host.slice(host.indexOf("]") + 1) : host;
	const colon = bare.lastIndexOf(":");
	if (colon === -1) return -1;
	const port = Number(bare.slice(colon + 1));
	return Number.isSafeInteger(port) && port > 0 ? port : -1;
}
/** Whether a host name (without port) is one of the accepted loopback names. */
function isLoopbackName(hostName) {
	return LOOPBACK_HOSTNAMES.has(hostName);
}
/**
* Whether a raw `Host` header names a loopback address. Used to reject the
* pet's control calls when the listener is accidentally reachable off-host.
*
* @param host - raw `Host` header, if any.
* @returns true when the host name is loopback.
*/
function isLoopbackHost(host) {
	if (host === void 0 || host === "") return false;
	return LOOPBACK_HOSTNAMES.has(stripPort(host));
}
/** Strip a `:port` suffix, leaving IPv6 brackets intact. */
function stripPort(host) {
	if (host.startsWith("[")) {
		const closing = host.indexOf("]");
		return closing === -1 ? host : host.slice(0, closing + 1);
	}
	const colon = host.lastIndexOf(":");
	return colon === -1 ? host : host.slice(0, colon);
}
/**
* Truncate a string that may echo user input.
*
* Truncation is a display bound, not a privacy boundary: callers must not treat
* a truncated field as safe when the protocol never promised to carry it at all
* (see the field whitelist in the host implementation).
*
* @param value - raw text, or undefined.
* @param limit - maximum length; longer values get an ellipsis.
* @returns the bounded text, or undefined when the input was empty.
*/
function clampText(value, limit) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	if (trimmed === "") return void 0;
	return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 3)}...`;
}
/** Type guard for a value usable as a loopback TCP port. */
function isPort(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 65535;
}
/**
* Clamp a session title, which routinely embeds a slice of the user's prompt.
*
* @param value - raw title, or undefined/null.
* @returns the bounded title, or undefined when there was nothing to send.
*/
function clampTitle(value) {
	return clampText(value, 160);
}
//#endregion
//#region src/state.ts
/**
* Per-session progress and notice store.
*
* Callers advance grace deadlines through {@link consumeTime} rather than the
* store scheduling its own timers.
*/
var NoticeStore = class {
	sessions = /* @__PURE__ */ new Map();
	notices = /* @__PURE__ */ new Map();
	options;
	revision = 0;
	/**
	* @param options - retention and grace bounds.
	*/
	constructor(options) {
		this.options = options;
	}
	/** Monotonic snapshot revision, bumped by every outward-visible change. */
	get snapshotRevision() {
		return this.revision;
	}
	/**
	* Record that a root session started running.
	*
	* A new run mints a fresh run id and drops the previous run's recorded reason,
	* so a stale completion can never be attributed to the new run. A duplicate
	* `running` report for an already-running session is not a new run.
	*
	* @param sessionId - root session id.
	* @param runId - id minted by the caller for this run.
	* @param at - epoch ms of the observation.
	* @param facts - optional session facts known at run start.
	* @returns the effects to apply.
	*/
	startRun(sessionId, runId, at, facts = {}) {
		const bucket = this.bucket(sessionId, at);
		this.applyFacts(bucket, facts);
		const previous = bucket.run;
		if (bucket.running && previous !== null && !previous.settled && previous.lastTurnEnd === null) {
			bucket.updatedAt = at;
			return {
				completions: [],
				changed: false
			};
		}
		bucket.running = true;
		bucket.updatedAt = at;
		bucket.run = freshRun(runId, at);
		this.revision += 1;
		return {
			completions: [],
			changed: true
		};
	}
	/**
	* Record one `turn/end`.
	*
	* Never produces a completion on its own: the run may continue, because a
	* goal round or a queued follow-up opens the next turn immediately. When an
	* idle observation is already pending, the arriving reason settles it at once
	* instead of waiting out the grace window.
	*
	* A `turn/end` with no observed run start (the plugin mounted mid-run, or a
	* resumed session) mints a provisional run so the eventual idle can still
	* settle. A real `turn/start` or `agent/status: running` supersedes it, which
	* is why the provisional run id is namespaced and never reported as a real
	* run id by the caller.
	*
	* @param sessionId - root session id.
	* @param turn - the ended turn's number; used as the page-matchable reference.
	* @param reason - the turn-end kind.
	* @param at - epoch ms of the observation.
	* @returns the effects to apply.
	*/
	recordTurnEnd(sessionId, turn, reason, at) {
		const bucket = this.bucket(sessionId, at);
		let run = bucket.run;
		if (run === null) {
			run = freshRun(`provisional:${sessionId}`, at);
			bucket.run = run;
		}
		run.lastTurnEnd = {
			turn,
			kind: reason,
			at
		};
		bucket.updatedAt = at;
		this.revision += 1;
		if (run.idlePendingSince !== null && !run.settled) return {
			completions: [this.settle(bucket, run, at)],
			changed: true
		};
		return {
			completions: [],
			changed: true
		};
	}
	/**
	* Record that a session reached `idle`.
	*
	* With a recorded reason this settles the run immediately. Without one it
	* opens the grace window, because `turn/end` may still be in flight.
	*
	* @param sessionId - root session id.
	* @param at - epoch ms of the observation.
	* @returns the effects to apply.
	*/
	recordIdle(sessionId, at) {
		const bucket = this.sessions.get(sessionId);
		if (bucket === void 0) return {
			completions: [],
			changed: false
		};
		bucket.running = false;
		bucket.updatedAt = at;
		this.revision += 1;
		const run = bucket.run;
		if (run === null || run.settled) return {
			completions: [],
			changed: true
		};
		if (run.lastTurnEnd !== null) return {
			completions: [this.settle(bucket, run, at)],
			changed: true
		};
		run.idlePendingSince = at;
		return {
			completions: [],
			changed: true
		};
	}
	/**
	* Advance grace deadlines and expire old notices. Call from a timer; the
	* store never schedules anything itself.
	*
	* A pending idle whose grace expires with no recorded reason produces no
	* notice, and the run is retired on the spot. That is the conservative
	* choice: with no reason in hand "completed" would be a guess, and a wrong
	* "your task finished" is worse than a missing one. Retiring the run also
	* means a reason that shows up much later cannot resurrect it — that would be
	* a different, already-reported run.
	*
	* @param at - epoch ms to evaluate against.
	* @returns the effects to apply.
	*/
	consumeTime(at) {
		const completions = [];
		let changed = false;
		for (const bucket of this.sessions.values()) {
			const run = bucket.run;
			if (run === null || run.settled || run.idlePendingSince === null) continue;
			if (at - run.idlePendingSince < this.options.idleGraceMs) continue;
			run.idlePendingSince = null;
			if (run.lastTurnEnd === null) {
				run.settled = true;
				bucket.running = false;
				bucket.updatedAt = at;
				changed = true;
				continue;
			}
			completions.push(this.settle(bucket, run, at));
			changed = true;
		}
		if (this.expireNotices(at)) changed = true;
		return {
			completions,
			changed
		};
	}
	/**
	* Record progress that does not change the run lifecycle.
	*
	* @param sessionId - root session id.
	* @param at - epoch ms of the observation.
	* @param progress - bounded counts and the tool's name only.
	* @returns the effects to apply.
	*/
	recordProgress(sessionId, at, progress) {
		const bucket = this.sessions.get(sessionId);
		if (bucket === void 0) return {
			completions: [],
			changed: false
		};
		const run = bucket.run;
		if (run === null || run.settled) return {
			completions: [],
			changed: false
		};
		if (progress.tool !== void 0) {
			run.toolCalls += 1;
			run.lastTool = clampText(progress.tool, 200) ?? null;
		}
		if (progress.todoCount !== void 0) run.todoCount = Math.max(0, progress.todoCount);
		if (progress.completedTodoCount !== void 0) run.completedTodoCount = Math.max(0, progress.completedTodoCount);
		bucket.updatedAt = at;
		this.revision += 1;
		return {
			completions: [],
			changed: true
		};
	}
	/**
	* Store session facts learned outside the event stream.
	*
	* The page is the source of two of these: the title (which only the client
	* snapshot has) and `reader` (which read named the session), both observed on
	* a `POST /pet-bridge/visibility`.
	*
	* @param sessionId - root session id.
	* @param facts - only the fields whose values are known.
	* @param at - epoch ms of the observation.
	*/
	recordSessionFacts(sessionId, facts, at) {
		const bucket = this.bucket(sessionId, at);
		if (this.applyFacts(bucket, facts)) {
			bucket.updatedAt = at;
			this.revision += 1;
		}
	}
	/**
	* Mark a session removed: it stops running and leaves the pet's view without
	* pretending to be a subagent.
	*
	* @param sessionId - session id to remove.
	* @param at - epoch ms of the observation.
	* @returns whether the session was known.
	*/
	removeSession(sessionId, at) {
		const bucket = this.sessions.get(sessionId);
		if (bucket === void 0) return false;
		bucket.removed = true;
		bucket.running = false;
		bucket.updatedAt = at;
		this.revision += 1;
		return true;
	}
	/**
	* Store a produced notice so later observations and pet acks can find it.
	*
	* @param completion - the settled run.
	* @param noticeId - id the pet keys its popup on.
	* @param at - epoch ms the notice was created.
	* @returns the stored notice snapshot.
	*/
	createNotice(completion, noticeId, at) {
		const record = {
			noticeId,
			sessionId: completion.sessionId,
			runId: completion.runId,
			targetTurnRef: completion.targetTurnRef,
			reason: completion.reason,
			completedAt: completion.completedAt,
			state: "pending",
			seenAt: null,
			delivered: false,
			deliveredSeen: false,
			deliveredAt: null
		};
		this.notices.set(noticeId, record);
		this.expireNotices(at);
		this.revision += 1;
		return toSnapshot(record);
	}
	/**
	* Mark a notice as handed to the pet.
	*
	* @param noticeId - target notice.
	* @param seen - whether the completion event advertised `seen: true`.
	* @param at - epoch ms of the delivery.
	* @returns the updated notice, or null when unknown/expired.
	*/
	markDelivered(noticeId, seen, at) {
		const record = this.notices.get(noticeId);
		if (record === void 0) return null;
		record.delivered = true;
		record.deliveredSeen = seen;
		record.deliveredAt = at;
		if (seen && record.state === "pending") {
			record.state = "seen";
			record.seenAt = at;
		}
		this.revision += 1;
		return toSnapshot(record);
	}
	/**
	* Apply a pet acknowledgement.
	*
	* `dismissed` retires the notice permanently: a notice the user closed is
	* over, so a duplicate or out-of-order `shown` cannot reopen the popup. A
	* `shown` acknowledgement on an already-`seen` notice is likewise ignored,
	* because an observed notice was suppressed rather than displayed.
	*
	* @param noticeId - target notice.
	* @param action - `shown` or `dismissed`.
	* @returns the resulting state, or null when the notice is unknown.
	*/
	applyAck(noticeId, action) {
		const record = this.notices.get(noticeId);
		if (record === void 0) return null;
		if (record.state === "seen" || record.state === "dismissed") return record.state;
		const next = action === "shown" ? "shown" : "dismissed";
		if (record.state === next) return record.state;
		record.state = next;
		this.revision += 1;
		return record.state;
	}
	/**
	* Accept an L3 observation from the browser.
	*
	* All three identifiers must agree with the stored notice and the notice must
	* still be open. This is the only path that moves a notice to `seen`.
	*
	* @param input - the observation's notice/run/session triple.
	* @param at - epoch ms of the observation.
	* @returns whether it was accepted, why not when it was not, and the notice.
	*/
	applyObservation(input, at) {
		const record = this.notices.get(input.noticeId);
		if (record === void 0) return {
			accepted: false,
			reason: "unknown-notice",
			notice: null
		};
		if (record.runId !== input.runId) return {
			accepted: false,
			reason: "run-mismatch",
			notice: toSnapshot(record)
		};
		if (record.sessionId !== input.sessionId) return {
			accepted: false,
			reason: "session-mismatch",
			notice: toSnapshot(record)
		};
		if (record.state === "dismissed") return {
			accepted: false,
			reason: "already-dismissed",
			notice: toSnapshot(record)
		};
		if (record.state === "seen") return {
			accepted: true,
			notice: toSnapshot(record)
		};
		record.state = "seen";
		record.seenAt = at;
		this.revision += 1;
		return {
			accepted: true,
			notice: toSnapshot(record)
		};
	}
	/**
	* Open notices for one session, oldest first.
	*
	* "Open" means every state the user has not settled yet: `pending` **and**
	* `shown`. `shown` must stay visible to the page, because the popup being on
	* screen is exactly the case the automatic cancellation exists for — the user
	* reads the result and the pet retracts a popup it already raised. Only the
	* terminal states are withheld: `seen` is already retired, and `dismissed`
	* was closed by the user.
	*
	* This list does not drive popups, so including `shown` cannot open a second
	* one: the pet's popup comes from the pushed `completed` event, and is
	* suppressed for a notice it has already acknowledged.
	*
	* @param sessionId - session to filter by.
	* @returns snapshots the browser may watch for.
	*/
	pendingFor(sessionId) {
		const rows = [];
		for (const record of this.notices.values()) {
			if (record.sessionId !== sessionId) continue;
			if (record.state === "seen" || record.state === "dismissed") continue;
			rows.push(toSnapshot(record));
		}
		rows.sort((left, right) => left.completedAt - right.completedAt);
		return rows;
	}
	/** All retained notices, oldest first, for the pet's `/state` snapshot. */
	allNotices() {
		const rows = [...this.notices.values()].map(toSnapshot);
		rows.sort((left, right) => left.completedAt - right.completedAt);
		return rows;
	}
	/** One notice by id, or null when unknown. */
	notice(noticeId) {
		const record = this.notices.get(noticeId);
		return record === void 0 ? null : toSnapshot(record);
	}
	/** Visible root-session progress buckets, most recently active first. */
	progressSnapshot() {
		const rows = [];
		for (const bucket of this.sessions.values()) {
			if (bucket.subagent || bucket.removed) continue;
			rows.push({
				sessionId: bucket.sessionId,
				title: bucket.title,
				cwd: bucket.cwd,
				origin: bucket.subagent ? "subagent" : null,
				running: bucket.running,
				runId: bucket.run?.runId ?? null,
				lastTurnEnd: bucket.run?.lastTurnEnd ?? null,
				toolCalls: bucket.run?.toolCalls ?? 0,
				lastTool: bucket.run?.lastTool ?? null,
				todoCount: bucket.run?.todoCount ?? 0,
				completedTodoCount: bucket.run?.completedTodoCount ?? 0,
				percent: percentOf(bucket.run),
				updatedAt: bucket.updatedAt,
				...bucket.reader === null ? {} : { reader: bucket.reader }
			});
		}
		rows.sort((left, right) => right.updatedAt - left.updatedAt);
		return rows;
	}
	/** Whether any retained notice is still open. */
	hasOpenNotices() {
		for (const record of this.notices.values()) if (record.state === "pending" || record.state === "shown") return true;
		return false;
	}
	/** Settle one run into a completion and mark it consumed. */
	settle(bucket, run, at) {
		run.settled = true;
		run.idlePendingSince = null;
		bucket.running = false;
		bucket.updatedAt = at;
		this.revision += 1;
		const last = run.lastTurnEnd;
		return {
			sessionId: bucket.sessionId,
			runId: run.runId,
			reason: last?.kind ?? "unknown",
			targetTurnRef: last === null ? null : String(last.turn),
			completedAt: at
		};
	}
	/** Apply session facts; returns whether anything actually changed. */
	applyFacts(bucket, facts) {
		let changed = false;
		if (facts.title !== void 0) {
			const next = clampTitle(facts.title) ?? null;
			if (next !== bucket.title) {
				bucket.title = next;
				changed = true;
			}
		}
		if (facts.cwd !== void 0) {
			const next = facts.cwd === null ? null : clampText(facts.cwd, 4096) ?? null;
			if (next !== bucket.cwd) {
				bucket.cwd = next;
				changed = true;
			}
		}
		if (facts.subagent !== void 0 && facts.subagent !== bucket.subagent) {
			bucket.subagent = facts.subagent;
			changed = true;
		}
		if (facts.reader !== void 0 && facts.reader !== bucket.reader) {
			bucket.reader = facts.reader;
			changed = true;
		}
		return changed;
	}
	/** Look up or lazily create a session bucket. */
	bucket(sessionId, at) {
		const existing = this.sessions.get(sessionId);
		if (existing !== void 0) return existing;
		const created = {
			sessionId,
			title: null,
			cwd: null,
			subagent: false,
			removed: false,
			running: false,
			run: null,
			updatedAt: at,
			reader: null
		};
		this.sessions.set(sessionId, created);
		return created;
	}
	/**
	* Drop settled notices past the TTL, then trim to the size cap.
	*
	* Open notices are never evicted by age: an unacknowledged completion is
	* exactly the thing the pet exists to surface.
	*
	* @returns whether the notice table changed.
	*/
	expireNotices(at) {
		let changed = false;
		for (const [id, record] of this.notices) {
			if (record.state === "pending" || record.state === "shown") continue;
			if (at - record.completedAt < this.options.noticeTtlMs) continue;
			this.notices.delete(id);
			changed = true;
		}
		if (this.notices.size > this.options.maxNotices) {
			const settled = [...this.notices.values()].filter((record) => record.state !== "pending" && record.state !== "shown").sort((left, right) => left.completedAt - right.completedAt);
			for (const record of settled) {
				if (this.notices.size <= this.options.maxNotices) break;
				this.notices.delete(record.noticeId);
				changed = true;
			}
		}
		if (changed) this.revision += 1;
		return changed;
	}
};
/** Create a fresh, unsettled run record. */
function freshRun(runId, at) {
	return {
		runId,
		startedAt: at,
		lastTurnEnd: null,
		idlePendingSince: null,
		settled: false,
		toolCalls: 0,
		lastTool: null,
		todoCount: 0,
		completedTodoCount: 0
	};
}
/** Project the internal record onto the exported snapshot shape. */
function toSnapshot(record) {
	return {
		noticeId: record.noticeId,
		sessionId: record.sessionId,
		runId: record.runId,
		targetTurnRef: record.targetTurnRef,
		reason: record.reason,
		completedAt: record.completedAt,
		state: record.state,
		seenAt: record.seenAt,
		delivered: record.delivered
	};
}
/** Derived progress percentage, or null when the run has no todo list yet. */
function percentOf(run) {
	if (run === null || run.todoCount <= 0) return null;
	return Math.round(run.completedTodoCount / run.todoCount * 100);
}
/**
* Build a pet-facing event.
*
* Every field is either an identifier, a count, a bounded label, or a bounded
* title. Raw tool arguments, prompts, assistant text, tool results, and
* credentials have no field to travel in, by construction.
*
* @param input - identifiers plus optional bounded fields.
* @returns a protocol-shaped event.
*/
function buildEvent(input) {
	const event = {
		v: 1,
		id: input.id,
		event: input.event,
		source: "deepseek-harness",
		hook: input.hook,
		sessionId: input.sessionId,
		runId: input.runId ?? null,
		targetTurnRef: input.targetTurnRef ?? null,
		timestamp: input.at,
		title: clampTitle(input.title) ?? null
	};
	const message = clampText(input.message, 240);
	const tool = clampText(input.tool, 200);
	return {
		...event,
		...message === void 0 ? {} : { message },
		...tool === void 0 ? {} : { tool },
		...input.reason === void 0 ? {} : { reason: input.reason },
		...input.seen === void 0 ? {} : { seen: input.seen },
		...input.noticeId === void 0 ? {} : { noticeId: input.noticeId }
	};
}
//#endregion
//#region src/pet-client.ts
/**
* Outbound half of the pet link: pushes normalized events to the pet's
* loopback `/event` endpoint.
*
* The design rules this implements:
*
* - **The pet never blocks the harness.** A send is bounded by a timeout and
*   every failure resolves to `false`. Progress events are allowed to be lost,
*   because the `/state` snapshot repairs them; result notifications are not,
*   which is why the caller keeps them in its own pending table and only marks
*   them delivered on a `true` result.
* - **Order matters per notice.** Sends are serialized through one promise
*   chain, so a `completed` can never overtake the `notice/seen` that retires
*   it, or the reverse.
* - **Nothing is buffered while the pet is away.** The queue holds at most the
*   in-flight request; a backlog of stale "running" frames is worse than none.
*
* @module dsh-pet-seen/pet-client
*/
/** Promise-based loopback JSON POST; never throws, always resolves. */
function postJson(options) {
	const { port, path, body, timeoutMs, signal } = options;
	if (signal.aborted) return Promise.resolve({
		delivered: false,
		body: null,
		failure: "aborted"
	});
	const encoded = JSON.stringify(body);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const onAbort = () => {
			request$1.destroy();
			finish({
				delivered: false,
				body: null,
				failure: "aborted"
			});
		};
		const request$1 = request({
			host: "127.0.0.1",
			port,
			path,
			method: "POST",
			timeout: timeoutMs,
			headers: {
				"content-type": "application/json; charset=utf-8",
				"content-length": Buffer.byteLength(encoded)
			}
		}, (response) => {
			let text = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => {
				if (text.length < 65536) text += chunk;
				else request$1.destroy();
			});
			response.on("end", () => {
				const status = response.statusCode ?? 0;
				if (status < 200 || status >= 300) {
					finish({
						delivered: false,
						body: null,
						failure: `http-${status}`
					});
					return;
				}
				if (text === "") {
					finish({
						delivered: true,
						body: null
					});
					return;
				}
				try {
					const parsed = JSON.parse(text);
					finish({
						delivered: true,
						body: typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null
					});
				} catch {
					finish({
						delivered: true,
						body: null,
						failure: "unparsable-response"
					});
				}
			});
		});
		request$1.on("timeout", () => {
			request$1.destroy();
			finish({
				delivered: false,
				body: null,
				failure: "timeout"
			});
		});
		request$1.on("error", (error) => {
			finish({
				delivered: false,
				body: null,
				failure: error.code ?? "network-error"
			});
		});
		signal.addEventListener("abort", onAbort, { once: true });
		request$1.write(encoded);
		request$1.end();
	});
}
/**
* Serialized, bounded, fire-and-forget client for the pet's event endpoint.
*
* Sends are never awaited by the harness's own work: `send` returns a promise,
* but callers do not need to hold it, and failures only surface through the
* returned {@link SendResult}.
*/
var PetClient = class {
	/** Current target port; starts at the default and follows `/hello`. */
	petPort;
	timeoutMs;
	signal;
	log;
	/** Tail of the serialization chain; never rejects. */
	queue = Promise.resolve();
	/** Whether the pet has completed a handshake at least once this session. */
	handshaken = false;
	constructor(options) {
		this.petPort = options.port;
		this.timeoutMs = options.timeoutMs;
		this.signal = options.signal;
		this.log = options.log ?? (() => {});
	}
	/** Port events are currently pushed to. */
	get port() {
		return this.petPort;
	}
	/** Whether a handshake has been seen; events are suppressed until then. */
	get isHandshaken() {
		return this.handshaken;
	}
	/**
	* Adopt the port reported by the pet's `/hello`.
	*
	* @param port - the pet's listening port.
	*/
	setPort(port) {
		this.handshaken = true;
		if (port === this.petPort) return;
		this.log(`pet port ${this.petPort} -> ${port}`);
		this.petPort = port;
	}
	/**
	* Test whether a pet is already listening on {@link PetClient.port}, for the
	* case where the pet started before this plugin mounted. A `false` result
	* leaves the bridge waiting for a `/hello` instead.
	*
	* @returns whether the probe was answered.
	*/
	async probe() {
		const result = await this.send(buildProbeEvent());
		if (result.delivered) this.handshaken = true;
		return result.delivered;
	}
	/**
	* Queue one event for the pet.
	*
	* @param event - the normalized event.
	* @returns delivery result; never rejects.
	*/
	send(event) {
		const run = async () => {
			const result = await postJson({
				port: this.petPort,
				path: "/event",
				body: event,
				timeoutMs: this.timeoutMs,
				signal: this.signal
			});
			if (!result.delivered) this.log(`send ${event.event} failed: ${result.failure ?? "unknown"}`);
			return result;
		};
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => void 0);
		return next;
	}
	/** Resolve once every queued send has settled; used on plugin unload. */
	async drain() {
		await this.queue.catch(() => void 0);
	}
};
/**
* Build a `/hello` acknowledgement for the pet.
*
* The negotiation is deliberately one-sided and tiny (PL-PR-NW-02): the host
* advertises {@link BRIDGE_CAPABILITIES}, and `agreed` is that set filtered by
* what this particular pet declared. All of it is additive on v1, so a pet that
* predates the negotiation receives the same 200 it always did, plus two fields
* it will ignore.
*
* @param revision - current snapshot revision.
* @param hello - the parsed handshake; its `capabilities` decide `agreed`.
* @returns the response body.
*/
function helloResponse(revision, hello) {
	const declared = hello.capabilities;
	return {
		v: 1,
		ok: true,
		revision,
		petPort: hello.port,
		capabilities: BRIDGE_CAPABILITIES,
		agreed: declared === void 0 ? [] : BRIDGE_CAPABILITIES.filter((capability) => declared.includes(capability)),
		...declared === void 0 ? { legacy: true } : {},
		...hello.petVersion === void 0 ? {} : { petVersion: hello.petVersion }
	};
}
/**
* Validate a `/hello` body.
*
* @param body - parsed request body.
* @param isPort - port validator (injected so this module stays free of the
*   protocol's own guards in tests).
* @returns the handshake, or a failure reason.
*/
function parseHello(body, isPort) {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return {
		ok: false,
		reason: "body-not-object"
	};
	const record = body;
	if (record.v !== 1) return {
		ok: false,
		reason: "version-mismatch"
	};
	if (!isPort(record.port)) return {
		ok: false,
		reason: "invalid-port"
	};
	const protocol = parseProtocolRange(record.protocol);
	const capabilities = parseCapabilities(record.capabilities);
	return {
		ok: true,
		hello: {
			v: 1,
			port: record.port,
			...typeof record.petVersion === "string" ? { petVersion: clampPlain(record.petVersion, 64) } : {},
			...typeof record.token === "string" ? { token: record.token } : {},
			...protocol === void 0 ? {} : { protocol },
			...capabilities === void 0 ? {} : { capabilities }
		}
	};
}
/**
* Read the optional protocol range.
*
* A malformed range is dropped rather than treated as fatal: demanding agreement
* here would turn a forward-compatible extension into a handshake failure, which
* is the one outcome `/hello` must never produce (PL-PR-NW-02). The pet's `v`
* check stays the real gate.
*
* @param value - raw field from the request body.
* @returns the range, or undefined when absent or unusable.
*/
function parseProtocolRange(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const { min, max } = value;
	if (!isRevision(min) || !isRevision(max) || min > max) return void 0;
	return {
		min,
		max
	};
}
/** Whether a value could be a protocol revision number. */
function isRevision(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
/**
* Read the optional capability declaration.
*
* Unknown names are dropped instead of rejected, for the same reason the range
* is: a newer pet may name a capability this host has never heard of, and that
* must still be a successful handshake. Absent or non-array yields `undefined`
* (a legacy pet); an empty array stays an empty array, which says "aware of the
* negotiation, implements none of it" — a different fact, and the reason the two
* are not collapsed here.
*
* @param value - raw field from the request body.
* @returns the recognized capabilities in the protocol's own order, or undefined.
*/
function parseCapabilities(value) {
	if (!Array.isArray(value)) return void 0;
	const seen = /* @__PURE__ */ new Set();
	for (const item of value) {
		if (typeof item !== "string") continue;
		const capability = BRIDGE_CAPABILITIES.find((candidate) => candidate === item);
		if (capability !== void 0) seen.add(capability);
	}
	return BRIDGE_CAPABILITIES.filter((capability) => seen.has(capability));
}
/** Bound a plain string field without pulling in the title-oriented helper. */
function clampPlain(value, limit) {
	return value.length <= limit ? value : value.slice(0, limit);
}
/**
* Build the liveness probe sent when the plugin mounts.
*
* It is an ordinary `idle` event with no session attached: a pet that receives
* it learns DSH is up, and its answer is what tells the plugin the pet is
* already listening.
*
* @returns the probe event.
*/
function buildProbeEvent() {
	return {
		v: 1,
		id: randomUUID(),
		event: "idle",
		source: EVENT_SOURCE,
		hook: "plugin/start",
		sessionId: "host",
		runId: null,
		targetTurnRef: null,
		timestamp: Date.now(),
		title: null,
		message: "DSH 在线"
	};
}
//#endregion
//#region src/control-server.ts
/**
* The control plane the pet talks to: a loopback HTTP listener that is *not*
* the DSH WebServer.
*
* Why a second listener instead of reusing the DSH port: the DSH WebServer is
* the browser's carrier — its routes live inside the page's origin and its
* same-origin defence. The pet is a non-browser local process, so making it
* speak the page's namespace would couple it to the harness's HTTP surface for
* no gain. This listener has one job, dies with the plugin, and its liveness
* *is* the pet's "is DSH up" signal.
*
* Security posture:
*
* - Bound to `127.0.0.1` only, never `0.0.0.0`. Loopback-only is not
*   authentication — any local process can connect — which is why a bearer
*   token is required as well.
* - The token is minted per host process, so a token from a previous process is
*   rejected, and it is written 0600 to `~/.dsh/pet-bridge.json` for the pet.
* - Path, method, body size, token, and body shape are all checked before any
*   plugin work happens. A control port that is already taken disables the
*   bridge loudly instead of leaking a token to whoever owns the port.
*
* @module dsh-pet-seen/control-server
*/
/**
* Where the handshake file lives for the pet to read.
*
* @param override - explicit path to use instead of the shared user path.
* @returns the override, or `~/.dsh/pet-bridge.json`.
*/
function tokenFilePath(override) {
	if (override !== void 0 && override !== "") return override;
	return join(homedir(), ".dsh", "pet-bridge.json");
}
/** Read a request body with a hard size cap. */
async function readBody$1(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		total += buffer.byteLength;
		if (total > 65536) return {
			ok: false,
			reason: "body-too-large"
		};
		chunks.push(buffer);
	}
	return {
		ok: true,
		text: Buffer.concat(chunks).toString("utf8")
	};
}
/** Respond with JSON and close the response. */
function sendJson$1(res, status, body) {
	const encoded = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(encoded),
		"cache-control": "no-store"
	});
	res.end(encoded);
}
/** Parse a body into a plain object, or null. */
function parseObject$1(text) {
	if (text === "") return null;
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}
/** Extract the presented token from either a header or a query parameter. */
function presentedToken(req, query) {
	const header = req.headers["x-pet-token"];
	if (typeof header === "string" && header !== "") return header;
	const fromQuery = query.get("token");
	return fromQuery === null || fromQuery === "" ? null : fromQuery;
}
/**
* Write the handshake file with owner-only permissions.
*
* A failure is reported but never fatal: an already-configured pet keeps
* working, and a fresh pet simply sees no token.
*
* @param port - the bound control port.
* @param token - the minted bearer token.
* @param override - explicit destination; defaults to {@link tokenFilePath}.
* @returns an error message when writing failed, else null.
*/
function writeTokenFile(port, token, override) {
	const path = tokenFilePath(override);
	try {
		mkdirSync(dirname(path), { recursive: true });
		const staged = `${path}.tmp`;
		writeFileSync(staged, `${JSON.stringify({
			v: 1,
			controlPort: port,
			token,
			writtenAt: (/* @__PURE__ */ new Date()).toISOString()
		}, null, 2)}\n`, { mode: 384 });
		renameSync(staged, path);
		chmodSync(path, 384);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
/**
* Start the control listener.
*
* Credential-publishing rule: the shared handshake file is written **only** for
* a listener that was asked for a *specific* port. An instance with
* `port: 0` — a test, the offline round-trip script, any throwaway — is not the
* host's bridge, so publishing its random port and token would break whatever
* real bridge is running (this is exactly how `npm run check` once left a live
* DSH unreachable). Such an instance must pass `tokenFile` to opt in.
*
* @param deps - collaborators and bind port.
* @returns the running server, or a failure reason when the port is unusable.
*/
async function startControlServer(deps) {
	const log = deps.log ?? (() => {});
	const token = randomBytes(32).toString("hex");
	const server = createServer((req, res) => {
		handle(req, res, deps, token, log);
	});
	const bound = await new Promise((resolve) => {
		server.once("error", (error) => {
			resolve({
				ok: false,
				reason: error.code ?? "listen-error"
			});
		});
		server.listen(deps.port, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				resolve({
					ok: false,
					reason: "no-address"
				});
				return;
			}
			resolve({
				ok: true,
				port: address.port
			});
		});
	});
	if (!bound.ok) {
		server.close();
		log(`control listener failed: ${bound.reason}`);
		deps.onBound?.({
			ok: false,
			reason: bound.reason
		});
		return bound;
	}
	const writeError = deps.port === 0 && (deps.tokenFile === void 0 || deps.tokenFile === "") ? (log(`ephemeral control port: not publishing credentials to the shared path (${tokenFilePath()}); pass \`tokenFile\` to publish elsewhere`), null) : writeTokenFile(bound.port, token, deps.tokenFile);
	if (writeError !== null) log(`could not write ${tokenFilePath(deps.tokenFile)}: ${writeError}`);
	log(`control listener on 127.0.0.1:${bound.port}`);
	deps.onBound?.({
		ok: true,
		port: bound.port
	});
	return {
		ok: true,
		server: {
			port: bound.port,
			token,
			close: () => new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => {
					resolve();
				});
			})
		}
	};
}
/** Dispatch one control request. */
async function handle(req, res, deps, token, log) {
	if (!isLoopbackHost(req.headers.host)) {
		sendJson$1(res, 403, {
			v: 1,
			ok: false,
			reason: "non-loopback-host"
		});
		return;
	}
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const path = url.pathname;
	if (path === CONTROL_ROUTES.state) {
		if (req.method !== "GET") {
			sendJson$1(res, 405, {
				v: 1,
				ok: false,
				reason: "method-not-allowed"
			});
			return;
		}
		if (presentedToken(req, url.searchParams) !== token) {
			sendJson$1(res, 401, {
				v: 1,
				ok: false,
				reason: "unauthorized"
			});
			return;
		}
		sendJson$1(res, 200, deps.statePayload());
		return;
	}
	if (path !== CONTROL_ROUTES.hello && path !== CONTROL_ROUTES.ack) {
		sendJson$1(res, 404, {
			v: 1,
			ok: false,
			reason: "not-found"
		});
		return;
	}
	if (req.method !== "POST") {
		sendJson$1(res, 405, {
			v: 1,
			ok: false,
			reason: "method-not-allowed"
		});
		return;
	}
	const raw = await readBody$1(req);
	if (!raw.ok) {
		sendJson$1(res, 413, {
			v: 1,
			ok: false,
			reason: raw.reason
		});
		return;
	}
	const body = parseObject$1(raw.text);
	if (body === null) {
		sendJson$1(res, 400, {
			v: 1,
			ok: false,
			reason: "body-not-object"
		});
		return;
	}
	if (body.token !== token) {
		sendJson$1(res, 401, {
			v: 1,
			ok: false,
			reason: "unauthorized"
		});
		return;
	}
	if (path === CONTROL_ROUTES.hello) {
		const parsed = parseHello(body, isPort);
		if (!parsed.ok) {
			sendJson$1(res, 400, {
				v: 1,
				ok: false,
				reason: parsed.reason
			});
			return;
		}
		deps.onHello(parsed.hello.port);
		const revision = deps.statePayload().revision;
		const negotiated = helloResponse(revision, parsed.hello);
		const declared = parsed.hello.capabilities;
		const range = parsed.hello.protocol;
		log(`hello accepted: ${declared === void 0 ? "legacy pet (no capability declaration)" : `declared ${declared.join(",") || "none"}`}${range === void 0 ? "" : `, speaks v${range.min}..v${range.max}`}; host agrees on ${negotiated.agreed.join(",") || "nothing"}`);
		sendJson$1(res, 200, negotiated);
		return;
	}
	const noticeId = typeof body.noticeId === "string" ? body.noticeId : "";
	const action = body.action === "shown" || body.action === "dismissed" ? body.action : null;
	if (noticeId === "" || action === null) {
		sendJson$1(res, 400, {
			v: 1,
			ok: false,
			reason: "invalid-ack"
		});
		return;
	}
	const state = deps.onAck(noticeId, action);
	if (state === null) {
		log(`ack for unknown notice ${noticeId} ignored`);
		sendJson$1(res, 404, {
			v: 1,
			ok: false,
			reason: "unknown-notice"
		});
		return;
	}
	sendJson$1(res, 200, {
		v: 1,
		ok: true,
		state
	});
}
//#endregion
//#region src/routes.ts
/**
* Default lease lifetime.
*
* The page reports on focus, visibility, and session changes — not on a timer —
* so the lifetime is generous: it exists to expire a tab that vanished without
* a `pagehide` report, not to police a heartbeat.
*/
const DEFAULT_LEASE_TTL_MS = 15e3;
/** How often expired leases are swept. */
const LEASE_SWEEP_MS = 2e3;
/** Respond with JSON and close the response. */
function sendJson(res, status, body) {
	const encoded = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(encoded),
		"cache-control": "no-store"
	});
	res.end(encoded);
}
/** Read a request body with a hard size cap. */
async function readBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		total += buffer.byteLength;
		if (total > 65536) return {
			ok: false,
			reason: "body-too-large"
		};
		chunks.push(buffer);
	}
	return {
		ok: true,
		text: Buffer.concat(chunks).toString("utf8")
	};
}
/** Parse a request body into a plain object, or null. */
function parseObject(text) {
	if (text === "") return null;
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}
/**
* Mount the browser routes.
*
* @param deps - collaborators and registration target.
* @returns handles for disposer, leases, and mounted paths.
*/
function mountBrowserRoutes(deps) {
	const log = deps.log ?? (() => {});
	const leases = /* @__PURE__ */ new Map();
	const disposers = [];
	const hasEffectiveLease = (tabId, at) => {
		const lease = leases.get(tabId);
		if (lease === void 0) return false;
		if (at - lease.at > deps.leaseTtlMs) return false;
		return lease.visible && lease.focused;
	};
	/**
	* Session-read diagnostics of every tab whose lease has not gone stale.
	*
	* Freshness uses the same rule as {@link hasEffectiveLease} rather than the
	* sweeper's interval, so a tab stops being reported at exactly the moment it
	* stops being able to observe anything — and a test can assert the bound
	* without waiting for the two-second sweep.
	*/
	const diagnostics = () => {
		const now = Date.now();
		const rows = [];
		for (const [tabId, lease] of leases) {
			if (now - lease.at > deps.leaseTtlMs) continue;
			rows.push({
				tabId,
				sessionId: lease.sessionId,
				reader: lease.reader,
				readerReason: lease.readerReason,
				byIdCount: lease.byIdCount,
				buildId: lease.buildId,
				at: lease.at
			});
		}
		rows.sort((left, right) => right.at - left.at);
		return rows;
	};
	/** Same-origin gate shared by all three routes. */
	const sameOrigin = (req, res) => {
		if (!isSameOriginLoopback(req.headers.origin, req.headers.host)) {
			log(`rejected ${req.method ?? "?"} ${req.url ?? "?"}: not same-origin loopback`);
			sendJson(res, 403, {
				v: 1,
				ok: false,
				reason: "cross-origin"
			});
			return false;
		}
		return true;
	};
	disposers.push(deps.webServer.register({
		kind: "exact",
		path: BROWSER_ROUTES.visibility,
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendJson(res, 405, {
					v: 1,
					ok: false,
					reason: "method-not-allowed"
				});
				return;
			}
			if (!sameOrigin(req, res)) return;
			const raw = await readBody(req);
			if (!raw.ok) {
				sendJson(res, 413, {
					v: 1,
					ok: false,
					reason: raw.reason
				});
				return;
			}
			const body = parseObject(raw.text);
			if (body === null || typeof body.tabId !== "string" || body.tabId === "") {
				sendJson(res, 400, {
					v: 1,
					ok: false,
					reason: "invalid-visibility"
				});
				return;
			}
			const sessionId = typeof body.sessionId === "string" && body.sessionId !== "" ? body.sessionId : null;
			const diagnostics = isReaderIndex(body.reader) ? {
				reader: body.reader,
				readerReason: clampText(typeof body.readerReason === "string" ? body.readerReason : void 0, 240) ?? null,
				byIdCount: typeof body.byIdCount === "number" && Number.isSafeInteger(body.byIdCount) && body.byIdCount >= 0 ? Math.min(body.byIdCount, MAX_BY_ID_COUNT) : null
			} : null;
			const reportedBuild = clampText(typeof body.buildId === "string" ? body.buildId : void 0, 64);
			const previous = leases.get(body.tabId);
			leases.set(body.tabId, {
				sessionId,
				visible: body.visible === true,
				focused: body.focused === true,
				at: Date.now(),
				reader: diagnostics === null ? previous?.reader ?? null : diagnostics.reader,
				readerReason: diagnostics === null ? previous?.readerReason ?? null : diagnostics.readerReason,
				byIdCount: diagnostics === null ? previous?.byIdCount ?? null : diagnostics.byIdCount,
				buildId: reportedBuild ?? previous?.buildId ?? null
			});
			if (sessionId !== null) {
				const facts = {};
				if (typeof body.title === "string" || body.title === null) facts.title = body.title;
				if (diagnostics !== null && diagnostics.reader !== -1) facts.reader = diagnostics.reader;
				deps.store.recordSessionFacts(sessionId, facts, Date.now());
			}
			sendJson(res, 200, {
				v: 1,
				ok: true
			});
		}
	}));
	disposers.push(deps.webServer.register({
		kind: "exact",
		path: BROWSER_ROUTES.notices,
		handler: (req, res) => {
			if (req.method !== "GET") {
				sendJson(res, 405, {
					v: 1,
					ok: false,
					reason: "method-not-allowed"
				});
				return;
			}
			if (!sameOrigin(req, res)) return;
			const sessionId = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("sessionId");
			if (sessionId === null || sessionId === "") {
				sendJson(res, 400, {
					v: 1,
					ok: false,
					reason: "missing-session"
				});
				return;
			}
			const notices = deps.store.pendingFor(sessionId);
			sendJson(res, 200, {
				v: 1,
				revision: deps.store.snapshotRevision,
				sessionId,
				notices: notices.map((notice) => ({
					noticeId: notice.noticeId,
					sessionId: notice.sessionId,
					runId: notice.runId,
					targetTurnRef: notice.targetTurnRef,
					reason: notice.reason,
					completedAt: notice.completedAt,
					state: notice.state
				})),
				seenDwellMs: deps.seenDwellMs
			});
		}
	}));
	disposers.push(deps.webServer.register({
		kind: "exact",
		path: BROWSER_ROUTES.seen,
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendJson(res, 405, {
					v: 1,
					ok: false,
					reason: "method-not-allowed"
				});
				return;
			}
			if (!sameOrigin(req, res)) return;
			const raw = await readBody(req);
			if (!raw.ok) {
				sendJson(res, 413, {
					v: 1,
					ok: false,
					reason: raw.reason
				});
				return;
			}
			const body = parseObject(raw.text);
			if (body === null) {
				sendJson(res, 400, {
					v: 1,
					ok: false,
					reason: "body-not-object"
				});
				return;
			}
			const noticeId = typeof body.noticeId === "string" ? body.noticeId : "";
			const runId = typeof body.runId === "string" ? body.runId : "";
			const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
			const tabId = typeof body.tabId === "string" ? body.tabId : "";
			if (noticeId === "" || runId === "" || sessionId === "" || tabId === "") {
				sendJson(res, 400, {
					v: 1,
					ok: false,
					reason: "incomplete-observation"
				});
				return;
			}
			/** Refuse and explain; the page logs the reason instead of retrying blindly. */
			const refuse = (reason) => {
				sendJson(res, 200, {
					v: 1,
					accepted: false,
					reason
				});
			};
			if (body.observed !== true) {
				refuse("observed-flag-missing");
				return;
			}
			if (!hasEffectiveLease(tabId, Date.now())) {
				refuse("no-effective-lease");
				return;
			}
			const lease = leases.get(tabId);
			if (lease === void 0 || lease.sessionId !== sessionId) {
				refuse("tab-not-on-session");
				return;
			}
			const result = deps.store.applyObservation({
				noticeId,
				runId,
				sessionId
			}, Date.now());
			if (!result.accepted) {
				refuse(result.reason ?? "rejected");
				return;
			}
			log(`notice ${noticeId} marked seen by tab ${tabId}`);
			if (result.notice !== null && result.notice.delivered) deps.onObserved?.(result.notice);
			sendJson(res, 200, {
				v: 1,
				accepted: true
			});
		}
	}));
	const sweeper = setInterval(() => {
		const now = Date.now();
		for (const [tabId, lease] of leases) if (now - lease.at > deps.leaseTtlMs) leases.delete(tabId);
	}, LEASE_SWEEP_MS);
	sweeper.unref?.();
	return {
		dispose: () => {
			clearInterval(sweeper);
			for (const dispose of disposers.splice(0)) dispose();
			leases.clear();
		},
		leases: () => leases,
		hasEffectiveLease,
		diagnostics,
		paths: [
			BROWSER_ROUTES.visibility,
			BROWSER_ROUTES.notices,
			BROWSER_ROUTES.seen
		]
	};
}
//#endregion
//#region src/index.ts
/**
* Host half of `dsh-pet-seen`.
*
* Responsibilities, in the order they are set up in {@link apply}:
*
* 1. Subscribe to the harness event streams that describe *work*
*    (`session/event`) and *run lifecycle* (`agent/status`) and fold them into
*    per-session progress buckets plus one notice per finished run.
* 2. Own the loopback control listener the pet talks to
*    (`/hello`, `/state`, `/ack`).
* 3. Push normalized events to the pet's own listener.
* 4. Optionally mount the browser routes, but only when the DSH WebServer
*    exists. That injection is *optional on purpose*: headless and CLI hosts
*    have no WebServer, and the bridge's core must not fail to start there.
*
* The harness packages are imported for their types only. Their declarations
* are resolved from the live DSH installation during type checking, and the
* bundle carries no runtime dependency on them — see `tsconfig.check.json`.
*
* @module dsh-pet-seen
*/
/** Plugin name as the loader knows it. */
const name = "dsh-pet-seen";
/** Services this plugin waits for. `webServer` is *not* here; see {@link apply}. */
const inject = ["agents", "sessions"];
/** Configuration schema; every default comes from the design document. */
const Config = Schema.object({
	/** Loopback port for `/hello`, `/state`, `/ack`. */
	controlPort: Schema.number().default(DEFAULT_CONTROL_PORT),
	/**
	* Where to publish the handshake file. Empty means the shared
	* `~/.dsh/pet-bridge.json`. A `controlPort: 0` instance (tests, offline
	* tools) must point this at its own file, because otherwise it would
	* overwrite the credentials of the bridge that is actually serving DSH.
	*/
	tokenFile: Schema.string().default(""),
	/** Port the pet listens on before it has handshaken. */
	petPort: Schema.number().default(DEFAULT_PET_PORT),
	/** Wait this long for a browser observation before pushing `completed`. */
	notifyDelayMs: Schema.number().default(2500),
	/** Per-request timeout when pushing to the pet. */
	petEventTimeoutMs: Schema.number().default(800),
	/** Grace for a `turn/end` that arrives after the idle signal. */
	idleGraceMs: Schema.number().default(1500),
	/** Continuous on-screen dwell the page requires before reporting `/seen`. */
	seenDwellMs: Schema.number().default(1500),
	/** Retained notices cap. */
	maxNotices: Schema.number().default(100),
	/** Retained notice age cap, in ms. */
	noticeTtlMs: Schema.number().default(864e5),
	/** Whether session titles may be sent to the pet (titles echo user input). */
	includeTitle: Schema.boolean().default(true)
});
/**
* Narrow an arbitrary `turn/end` reason to the kinds the protocol names.
*
* Anything unrecognized — a malformed reason, an absent one, or a kind a newer
* DSH added — becomes `'unknown'`, which is *not* a completion
* ({@link completionDispatch}). Reporting success is the one outcome we must
* never guess at: a wrong "your task finished" hides a failure, while a missing
* popup is caught up through `/state`. The `_ReasonsCovered` pin makes the
* "newer DSH added a kind" half of this a build failure rather than a runtime
* default, so this branch only ever handles genuinely broken input.
*
* @param reason - raw `turn/end.data.reason`.
* @returns the protocol-facing kind.
*/
function turnEndKind(reason) {
	if (typeof reason !== "object" || reason === null) return "unknown";
	const kind = reason.kind;
	switch (kind) {
		case "completed":
		case "aborted":
		case "blocked":
		case "error":
		case "forked":
		case "max-tokens":
		case "interrupted": return kind;
		default: return "unknown";
	}
}
/**
* Map a failure to a closed category, forwarding nothing but the category.
*
* The raw value is read for `code` **shape** only, never echoed: harness error
* text routinely restates the user's prompt, a tool argument or a remote
* response body, and `README.md` §4.4 promises the pet never receives it. Only
* membership in {@link ErrorCategory} crosses the wire.
*
* @param error - the raw value from `agent/error`.
* @returns the category to report.
*/
function errorCategory(error) {
	const code = typeof error === "object" && error !== null ? error.code : void 0;
	if (typeof code === "string" && code !== "") {
		const normalized = code.toLowerCase();
		if (/econn|etimedout|enotfound|eai_again|socket|network|dns|fetch/.test(normalized)) return "network";
		if (/unauthor|forbidden|401|403|credential|api.?key/.test(normalized)) return "auth";
		if (/rate.?limit|429|quota|too.?many.?requests/.test(normalized)) return "rate-limit";
		if (/abort|cancel/.test(normalized)) return "aborted";
	}
	return "unknown";
}
/** Content-free one-liner for a failure, by category. */
function errorMessage(category) {
	switch (category) {
		case "network": return "运行出错：网络连接失败";
		case "auth": return "运行出错：认证失败";
		case "rate-limit": return "运行出错：请求过于频繁";
		case "aborted": return "运行已中止";
		case "unknown": return "运行出错";
	}
}
/**
* Human-readable one-liner for a settled run, by turn-end kind.
*
* `forked` mints no notice, so nothing here reaches the pet through that path;
* the line exists so the switch stays total over {@link TurnEndKind}.
*/
function completionMessage(kind) {
	switch (kind) {
		case "completed": return "任务完成";
		case "max-tokens": return "达到输出上限后结束";
		case "blocked": return "被阻塞，需要处理";
		case "error": return "运行出错";
		case "aborted": return "已中止";
		case "interrupted": return "中断（会话恢复时补记）";
		case "forked": return "分叉时截断（继承的前缀回合）";
		case "unknown": return "运行结束（结束原因无法识别）";
	}
}
/**
* Map a settled run's reason to its event, per the design's normalization table.
*
* The point of the split is that `reason` alone no longer has to carry the whole
* meaning: a pet can act on the event name and use `reason` only for wording. In
* particular `aborted` / `interrupted` / `forked` are **not** completions — they
* mean the run stopped, so they mint no notice and nothing pops. `error` /
* `blocked` do mint one, and the pet decides whether a failed run deserves a
* popup; that is why a notice-bearing `error` carries `noticeId` while the
* running-time failures (`tool/result`, `agent/error`) do not.
*
* @param kind - the settled run's reason.
* @returns the event name and whether a notice is minted.
*/
function completionDispatch(kind) {
	switch (kind) {
		case "completed": return {
			event: "completed",
			notice: true
		};
		case "max-tokens": return {
			event: "completed",
			notice: true
		};
		case "error":
		case "blocked": return {
			event: "error",
			notice: true
		};
		case "forked":
		case "aborted":
		case "interrupted":
		case "unknown": return {
			event: "idle",
			notice: false
		};
	}
}
/**
* Plugin entry point.
*
* @param ctx - host plugin context.
* @param config - resolved configuration.
* @param testHooks - optional hooks the integration tests use to observe the
*   plugin's own state: the bind outcome of the control listener and a consumed
*   token. Absent in production; nothing here depends on it.
*/
function apply(ctx, config, testHooks) {
	const log = (message) => {
		ctx.logger?.info?.(`dsh-pet-seen: ${message}`);
	};
	const warn = (message) => {
		ctx.logger?.warn?.(`dsh-pet-seen: ${message}`);
	};
	const store = new NoticeStore({
		maxNotices: config.maxNotices,
		noticeTtlMs: config.noticeTtlMs,
		idleGraceMs: config.idleGraceMs
	});
	const lifetime = new AbortController();
	const client = new PetClient({
		port: config.petPort,
		timeoutMs: config.petEventTimeoutMs,
		signal: lifetime.signal,
		log
	});
	/** Pending `completed` deliveries, keyed by notice id. */
	const deliveries = /* @__PURE__ */ new Map();
	let control = null;
	let browserRoutes = null;
	let disposed = false;
	/** Observers handed in through `testHooks`; empty in production. */
	const boundObservers = [];
	/** Build the `/state` payload the pet reads. */
	const statePayload = () => ({
		v: 1,
		revision: store.snapshotRevision,
		sessions: store.progressSnapshot(),
		notices: store.allNotices(),
		petPort: client.isHandshaken ? client.port : null,
		browserRoutes: browserRoutes !== null,
		browserTabs: browserRoutes?.diagnostics() ?? [],
		buildId: BUILD_ID,
		pluginVersion: PLUGIN_VERSION
	});
	/** Push a normalized event; suppressed until the pet has ever handshaken. */
	const push = (event) => {
		if (disposed) return Promise.resolve(false);
		if (!client.isHandshaken) return Promise.resolve(false);
		return client.send(event).then((result) => result.delivered);
	};
	/**
	* Push one settled run's result event.
	*
	* If the browser already confirmed the *exact* notice, the event carries
	* `seen: true` and the pet is expected not to pop anything. Otherwise it is a
	* normal popup, and a later observation becomes a separate `notice/seen` that
	* retires it.
	*
	* @param completion - the settled run.
	* @param noticeId - notice the pet keys its popup on.
	* @param eventName - `completed` or `error`, from {@link completionDispatch}.
	*/
	const deliverCompletion = (completion, noticeId, eventName) => {
		const seen = store.notice(noticeId)?.state === "seen";
		const title = store.progressSnapshot().find((row) => row.sessionId === completion.sessionId)?.title ?? null;
		const event = buildEvent({
			id: randomUUID(),
			event: eventName,
			hook: "run/idle",
			sessionId: completion.sessionId,
			runId: completion.runId,
			targetTurnRef: completion.targetTurnRef,
			at: completion.completedAt,
			title: config.includeTitle ? title : null,
			message: completionMessage(completion.reason),
			reason: completion.reason,
			seen,
			noticeId
		});
		push(event).then((delivered) => {
			if (!delivered) {
				log(`completion ${noticeId} not delivered; kept pending`);
				return;
			}
			store.markDelivered(noticeId, seen, Date.now());
		});
	};
	/** Turn a settled run into a (possibly notice-less) event plus its delivery. */
	const onCompletion = (completion) => {
		const dispatch = completionDispatch(completion.reason);
		if (!dispatch.notice) {
			const row = store.progressSnapshot().find((entry) => entry.sessionId === completion.sessionId);
			log(`run ${completion.runId} settled as ${completion.reason}: reported as ${dispatch.event}, no notice`);
			push(buildEvent({
				id: randomUUID(),
				event: dispatch.event,
				hook: "run/idle",
				sessionId: completion.sessionId,
				runId: completion.runId,
				targetTurnRef: completion.targetTurnRef,
				at: completion.completedAt,
				title: config.includeTitle ? row?.title ?? null : null,
				message: completionMessage(completion.reason),
				reason: completion.reason
			}));
			return;
		}
		const noticeId = randomUUID();
		store.createNotice(completion, noticeId, completion.completedAt);
		if (store.notice(noticeId) === null) return;
		if (completion.targetTurnRef === null || config.notifyDelayMs <= 0) {
			deliverCompletion(completion, noticeId, dispatch.event);
			return;
		}
		const timer = setTimeout(() => {
			deliveries.delete(noticeId);
			deliverCompletion(completion, noticeId, dispatch.event);
		}, config.notifyDelayMs);
		timer.unref?.();
		deliveries.set(noticeId, timer);
	};
	/** Apply the effects a store transition returned. */
	const applyEffects = (effects) => {
		for (const completion of effects.completions) onCompletion(completion);
	};
	ctx.on("session/event", (session, event) => {
		const sessionId = String(session.id);
		const isSubagent = session.header.origin === "subagent";
		const at = typeof event.time === "number" && event.time > 0 ? event.time : Date.now();
		switch (event.type) {
			case "turn/start": {
				if (isSubagent) return;
				const runId = randomUUID();
				store.recordSessionFacts(sessionId, {
					subagent: false,
					...session.header.title === void 0 ? {} : { title: session.header.title },
					...session.header.cwd === void 0 ? {} : { cwd: session.header.cwd }
				}, at);
				applyEffects(store.startRun(sessionId, runId, at));
				const row = store.progressSnapshot().find((entry) => entry.sessionId === sessionId);
				push(buildEvent({
					id: randomUUID(),
					event: "running",
					hook: event.type,
					sessionId,
					runId: row?.runId ?? null,
					at,
					title: config.includeTitle ? row?.title ?? null : null
				}));
				return;
			}
			case "tool/call": {
				if (isSubagent) return;
				const data = event.data;
				const toolName = typeof data?.name === "string" ? data.name : null;
				store.recordProgress(sessionId, at, { tool: toolName });
				const row = store.progressSnapshot().find((entry) => entry.sessionId === sessionId);
				push(buildEvent({
					id: randomUUID(),
					event: "running",
					hook: event.type,
					sessionId,
					runId: row?.runId ?? null,
					at,
					tool: toolName,
					title: config.includeTitle ? row?.title ?? null : null
				}));
				return;
			}
			case "tool/result":
				if (isSubagent) return;
				if (!(event.data?.error !== void 0)) return;
				push(buildEvent({
					id: randomUUID(),
					event: "error",
					hook: event.type,
					sessionId,
					at,
					message: "工具调用失败"
				}));
				return;
			case "todo/write": {
				if (isSubagent) return;
				const data = event.data;
				const todos = Array.isArray(data?.todos) ? data.todos : [];
				const completed = todos.filter((item) => {
					if (typeof item !== "object" || item === null) return false;
					return item.status === "completed";
				}).length;
				store.recordProgress(sessionId, at, {
					todoCount: todos.length,
					completedTodoCount: completed
				});
				return;
			}
			case "turn/end": {
				if (isSubagent) return;
				const data = event.data;
				const turn = typeof data?.turn === "number" ? data.turn : null;
				const kind = turnEndKind(data?.reason);
				if (turn === null) {
					log(`turn/end without a turn number on ${sessionId}`);
					return;
				}
				applyEffects(store.recordTurnEnd(sessionId, turn, kind, at));
				return;
			}
			default: return;
		}
	});
	ctx.on("agent/status", ({ agent, status }) => {
		const sessionId = String(agent.session.id);
		const isSubagent = agent.session.header.origin === "subagent";
		const at = Date.now();
		if (status === "running") {
			if (isSubagent) return;
			store.recordSessionFacts(sessionId, {
				subagent: false,
				...agent.session.header.title === void 0 ? {} : { title: agent.session.header.title },
				...agent.session.header.cwd === void 0 ? {} : { cwd: agent.session.header.cwd }
			}, at);
			applyEffects(store.startRun(sessionId, randomUUID(), at));
			return;
		}
		if (isSubagent) return;
		applyEffects(store.recordIdle(sessionId, at));
	});
	ctx.on("agent/error", ({ agent, error }) => {
		if (agent.session.header.origin === "subagent") return;
		const sessionId = String(agent.session.id);
		const at = Date.now();
		const row = store.progressSnapshot().find((entry) => entry.sessionId === sessionId);
		push(buildEvent({
			id: randomUUID(),
			event: "error",
			hook: "agent/error",
			sessionId,
			runId: row?.runId ?? null,
			at,
			message: errorMessage(errorCategory(error)),
			title: config.includeTitle ? row?.title ?? null : null
		}));
	});
	const tick = setInterval(() => {
		applyEffects(store.consumeTime(Date.now()));
	}, 250);
	tick.unref?.();
	ctx.effect(() => {
		let closed = false;
		/** Publish the bind outcome once, to whoever is observing. */
		const publishBound = (result) => {
			for (const observer of boundObservers.splice(0)) observer(result);
		};
		startControlServer({
			port: config.controlPort,
			...config.tokenFile === "" ? {} : { tokenFile: config.tokenFile },
			statePayload,
			onHello: (port) => {
				const wasHandshaken = client.isHandshaken;
				client.setPort(port);
				if (!wasHandshaken) log(`pet handshake accepted on port ${port}`);
			},
			onAck: (noticeId, action) => store.applyAck(noticeId, action),
			log
		}).then((result) => {
			if (closed) {
				if (result.ok) result.server.close();
				publishBound({
					ok: false,
					reason: "closed-before-bind"
				});
				return;
			}
			if (!result.ok) {
				warn(`control port ${config.controlPort} unavailable (${result.reason}); bridge disabled`);
				publishBound(result);
				return;
			}
			control = result.server;
			publishBound({
				ok: true,
				port: result.server.port,
				token: result.server.token
			});
		});
		return () => {
			closed = true;
			if (control !== null) {
				const server = control;
				control = null;
				server.close();
			}
		};
	});
	ctx.effect(() => {
		client.probe().then((delivered) => {
			if (delivered) log(`pet answered on the configured port ${client.port}`);
		});
		return () => {
			disposed = true;
			clearInterval(tick);
			for (const timer of deliveries.values()) clearTimeout(timer);
			deliveries.clear();
			lifetime.abort();
		};
	});
	ctx.inject(["webServer"], (scoped) => {
		const webServer = scoped.get("webServer");
		if (webServer === void 0 || typeof webServer.register !== "function") return;
		scoped.effect(() => {
			const mounted = mountBrowserRoutes({
				store,
				webServer,
				seenDwellMs: config.seenDwellMs,
				leaseTtlMs: DEFAULT_LEASE_TTL_MS,
				onObserved: (notice) => {
					push(buildEvent({
						id: randomUUID(),
						event: "notice/seen",
						hook: "browser/observed",
						sessionId: notice.sessionId,
						runId: notice.runId,
						targetTurnRef: notice.targetTurnRef,
						at: notice.seenAt ?? Date.now(),
						noticeId: notice.noticeId
					}));
				},
				log
			});
			browserRoutes = mounted;
			log(`browser routes mounted: ${mounted.paths.join(", ")}`);
			return () => {
				browserRoutes = null;
				mounted.dispose();
			};
		});
	});
	/** Keeps the retained-notice table from outliving the plugin instance. */
	ctx.effect(() => () => {
		deliveries.clear();
	});
	log(`started (control :${config.controlPort}, pet :${config.petPort})`);
	testHooks?.onReady?.({
		disposed: () => disposed,
		onControlBound: (callback) => {
			if (control !== null) {
				callback({
					ok: true,
					port: control.port,
					token: control.token
				});
				return;
			}
			boundObservers.push(callback);
		}
	});
}
//#endregion
export { BRIDGE_CAPABILITIES, BROWSER_ROUTES, BUILD_ID, CONTROL_ROUTES, Config, DEFAULT_CONTROL_PORT, DEFAULT_LEASE_TTL_MS, DEFAULT_PET_PORT, EVENT_SOURCE, MAX_REQUEST_BODY_BYTES, MAX_TITLE_LENGTH, NOTICE_EVENT_NAMES, NoticeStore, PET_EVENT_NAMES, PLUGIN_VERSION, PROTOCOL_VERSION, PetClient, RESERVED_PET_EVENT_NAMES, apply, buildEvent, buildProbeEvent, clampText, clampTitle, completionDispatch, helloResponse, inject, isLoopbackHost, isPort, isSameOriginLoopback, mountBrowserRoutes, name, parseHello, startControlServer, tokenFilePath, writeTokenFile };
