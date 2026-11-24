/**
 * dsh-cookie-prune — stop `dsh-auth-*` browser-session cookies from piling up
 * until the `Cookie` request header overflows and the Web UI answers
 * HTTP 431 (Request Header Fields Too Large) / "Web authentication failed".
 *
 * Background
 * ----------
 * `@deepseek-ai/dsh-client-connection` names its session cookie
 *
 *     "dsh-auth-" + base64url(sha256(authority))
 *
 * where `authority` is `host:port` for plain HTTP. Browser cookie jars are
 * keyed by host only, so every launch that binds a different port appends a
 * *new* cookie under `127.0.0.1` instead of replacing the previous one. The
 * cookie lives 30 days and nothing ever prunes it. Node's `maxHeaderSize`
 * defaults to 16 KiB, one cookie costs ≈228 B in the request header, so the
 * 72nd launch pushes the request over the line and the server rejects it
 * before any route runs — the UI simply cannot open.
 *
 * What this plugin does
 * ---------------------
 * Two independent layers, neither of which touches the authentication code
 * path:
 *
 *   1. Prune on every response. If a request carries more than `keep`
 *      `dsh-auth-*` cookies, the newest `keep` are retained (the cookie of the
 *      authority currently being served is always retained) and the rest get
 *      `Set-Cookie: <name>=; Max-Age=0`, which removes them from the browser
 *      jar. Steady state is therefore `keep` cookies (≈1.4 KB), never 72.
 *
 *   2. Raise the parser ceiling. `http.Server#maxHeaderSize` is read per
 *      connection, so a server that is *already* stuck behind 72+ cookies can
 *      still parse the request, let layer 1 prune it, and recover by itself
 *      instead of answering 431 forever.
 *
 * @module dsh-cookie-prune
 */

import { createHash } from "node:crypto";

/** Cookie-name prefix owned by `@deepseek-ai/dsh-client-connection`. */
const COOKIE_PREFIX = "dsh-auth-";

/** How many `dsh-auth-*` cookies survive a prune. */
const DEFAULT_KEEP = 6;

/** Parser ceiling in bytes; comfortably above the largest jar a browser allows. */
const DEFAULT_MAX_HEADER_BYTES = 65536;

/** Expiry stamp for cookie deletion. */
const EPOCH = "Thu, 01 Jan 1970 00:00:00 GMT";

/** Stable Cordis plugin name. */
export const name = "cookie-prune";

/** Wait for the Web server carrier before wiring request hooks. */
export const inject = ["webServer"];

/** Normalise a header value that may be a single string or an array. */
function toArray(value) {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value.slice() : [value];
}

/** Name part of a `name=value` Set-Cookie / Cookie pair. */
function cookieKey(text) {
	if (typeof text !== "string") return undefined;
	const at = text.indexOf("=");
	return at === -1 ? text : text.slice(0, at);
}

/**
 * Collect the `dsh-auth-*` pairs out of one `Cookie` request header.
 * @param header - raw `req.headers.cookie`, which Node already joined.
 * @returns the matching `{ name, value }` pairs in wire order.
 */
export function parseCookieHeader(header) {
	const out = [];
	if (typeof header !== "string" || header === "") return out;
	for (const segment of header.split(";")) {
		const at = segment.indexOf("=");
		if (at <= 0) continue;
		const cookieName = segment.slice(0, at).trim();
		if (!cookieName.startsWith(COOKIE_PREFIX)) continue;
		out.push({ name: cookieName, value: segment.slice(at + 1).trim() });
	}
	return out;
}

/**
 * Read `issuedAt` out of a signed cookie value without verifying it.
 *
 * The value is `v<version>.<base64url(payload json)>.<signature>`; the payload
 * carries `issuedAt` and `expiresAt`. Only ordering matters here, so the
 * signature is deliberately not checked — a forged stamp can at worst keep a
 * cookie that would otherwise be pruned, never grant access.
 *
 * @param value - cookie value as sent by the browser.
 * @returns milliseconds since epoch, or -1 when the value is not readable.
 */
export function issuedAtOf(value) {
	if (typeof value !== "string") return -1;
	const parts = value.split(".");
	if (parts.length !== 3) return -1;
	if (parts[0] !== "v1" && parts[0] !== "v2") return -1;
	try {
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		const issuedAt = payload?.issuedAt;
		return typeof issuedAt === "number" && Number.isFinite(issuedAt) ? issuedAt : -1;
	} catch {
		return -1;
	}
}

/**
 * The cookie name the current authority would mint — kept regardless of age so
 * a prune can never log out the session that is asking.
 * @param host - `Host` request header, carrying the port.
 * @returns the base64url cookie name, or undefined without a host.
 */
export function cookieNameFor(host) {
	if (typeof host !== "string" || host === "") return undefined;
	return COOKIE_PREFIX + createHash("sha256").update(host).digest("base64url");
}

/**
 * Decide which cookies to drop. Pure: no I/O, so the policy is testable.
 * @param header - raw `Cookie` request header.
 * @param host - `Host` request header of the request being served.
 * @param keep - upper bound on the jar size once the response mints its cookie.
 * @returns total count, the retained names, and the names to expire.
 */
export function planPrune(header, host, keep = DEFAULT_KEEP) {
	const limit = Number.isInteger(keep) && keep > 0 ? keep : DEFAULT_KEEP;
	// The response that follows a prune usually mints one more cookie for the
	// authority being served, so pruning is triggered one short of the cap and
	// retains one fewer. That lands the jar on exactly `keep` after the mint
	// instead of oscillating between `keep` and `keep + 1`.
	const retain = Math.max(1, limit - 1);
	const entries = parseCookieHeader(header).map((entry, index) => ({
		...entry,
		index,
		issuedAt: issuedAtOf(entry.value)
	}));
	if (entries.length < limit) return { total: entries.length, kept: entries.map((entry) => entry.name), expire: [] };

	// Newest first; unreadable stamps sink to the bottom but stay ordered by
	// arrival so the outcome is deterministic.
	const newestFirst = [...entries].sort((left, right) => right.issuedAt - left.issuedAt || right.index - left.index);
	const kept = new Set();
	const current = cookieNameFor(host);
	// Only reserve a slot when that cookie is actually in the jar; otherwise the
	// phantom entry would displace a real cookie from the retain budget.
	if (current !== undefined && entries.some((entry) => entry.name === current)) kept.add(current);
	for (const entry of newestFirst) {
		if (kept.size >= retain) break;
		kept.add(entry.name);
	}

	const expire = [];
	const seen = new Set();
	for (const entry of newestFirst) {
		if (kept.has(entry.name) || seen.has(entry.name)) continue;
		seen.add(entry.name);
		expire.push(entry.name);
	}
	return { total: entries.length, kept: [...kept], expire };
}

/** A deletion directive that matches the attribute set the issuer uses. */
export function deletionCookie(cookieName) {
	return `${cookieName}=; Path=/; Max-Age=0; Expires=${EPOCH}; HttpOnly; SameSite=Strict`;
}

/** Merge cookie lists, keeping the first directive per cookie name. */
function dedupeCookies(groups) {
	const seen = new Set();
	const out = [];
	for (const group of groups) {
		for (const cookie of toArray(group)) {
			if (typeof cookie !== "string" || cookie === "") continue;
			const key = cookieKey(cookie);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(cookie);
		}
	}
	return out;
}

/**
 * Attach the prune directives to one response and keep them there.
 *
 * The authentication layer writes its own session cookie through
 * `res.writeHead(status, { "set-cookie": ... })`, and a `writeHead` header
 * object overwrites anything staged with `setHeader`. So the response is
 * patched once to merge the two sources instead of letting one win.
 *
 * @param res - the live `ServerResponse`.
 * @param pruneCookies - deletion directives to send with this response.
 */
function attachPruneCookies(res, pruneCookies) {
	if (pruneCookies.length === 0) return;

	const readStaged = () => {
		try {
			return res.getHeader("Set-Cookie");
		} catch {
			return undefined;
		}
	};
	const stage = (value) => {
		try {
			res.setHeader("Set-Cookie", value);
		} catch {
			/* headers already flushed: nothing left to add */
		}
	};

	stage(dedupeCookies([readStaged(), pruneCookies]));

	const originalWriteHead = res.writeHead;
	res.writeHead = function writeHeadWithPrune(status, reasonOrHeaders, maybeHeaders) {
		let reason = reasonOrHeaders;
		let headers = maybeHeaders;
		if (typeof reasonOrHeaders === "object" && reasonOrHeaders !== null) {
			headers = reasonOrHeaders;
			reason = undefined;
		}

		const merged = { ...(headers ?? {}) };
		let ownKey;
		for (const key of Object.keys(merged)) {
			if (key.toLowerCase() === "set-cookie") {
				ownKey = key;
				break;
			}
		}
		const own = ownKey === undefined ? [] : merged[ownKey];
		if (ownKey !== undefined) delete merged[ownKey];

		const staged = readStaged();
		const combined = dedupeCookies([staged, own, pruneCookies]);
		if (combined.length > 0) merged["set-cookie"] = combined;

		res.writeHead = originalWriteHead;
		if (typeof reason === "string") return originalWriteHead.call(res, status, reason, merged);
		return originalWriteHead.call(res, status, merged);
	};
}

/** Read a positive integer from plugin config, falling back to a default. */
function positiveInt(value, fallback) {
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Bind addresses that never leave the machine. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0:0:0:0:0:0:0:1"]);

/**
 * Does this bind address stay on the machine?
 * @param host - the configured bind address, as `webServer.host` reports it.
 * @returns true for loopback spellings of both address families.
 */
export function isLoopbackHost(host) {
	if (typeof host !== "string" || host === "") return false;
	if (LOOPBACK_HOSTS.has(host.toLowerCase())) return true;
	return /^127\./u.test(host) || /^::ffff:127\./iu.test(host);
}

/**
 * Resolve whether to raise the parser ceiling.
 *
 * `auto` — the default — raises it only for a loopback bind. A larger header
 * buffer exists so an over-full jar can be re-parsed and pruned; an externally
 * reachable bind does not need that and keeping Node's default there avoids
 * enlarging the per-connection buffer for untrusted clients. The pruning layer
 * works either way.
 *
 * @param value - `true`/`"always"`, `false`/`"never"`, or `"auto"`/undefined.
 * @param host - the configured bind address.
 * @returns true when the ceiling should be raised.
 */
export function shouldRaiseHeaderLimit(value, host) {
	if (value === false || value === "never") return false;
	if (value === true || value === "always") return true;
	return isLoopbackHost(host);
}

/** Report a line on every available sink, so the plugin is visible in logs. */
function announce(ctx, message, level = "info") {
	const line = `[cookie-prune] ${message}`;
	try {
		if (level === "warn") console.warn(line);
		else console.log(line);
	} catch {
		/* stdout may be closed during shutdown */
	}
	try {
		if (level === "warn") ctx.logger?.warn?.(line);
		else ctx.logger?.info?.(line);
	} catch {
		/* a logger failure must not matter */
	}
}

/**
 * Wire the plugin into the running Web server.
 *
 * `webServer` is published from its constructor but assigns `server` only when
 * its own init runs, so this defers briefly instead of assuming the listener is
 * already there — plugin ordering must not decide whether the fix applies.
 *
 * @param ctx - Cordis context carrying `webServer`.
 * @param config - optional `{ keep, maxHeaderSize, enabled, raiseHeaderLimit }`.
 */
export function apply(ctx, config) {
	// A housekeeping plugin must never be able to block startup: any unexpected
	// failure degrades to "fix inactive", never to "DSH does not boot".
	try {
		wire(ctx, config);
	} catch (error) {
		announce(ctx, `inactive after an unexpected error: ${error instanceof Error ? error.message : String(error)}`, "warn");
	}
}

/**
 * The real body of {@link apply}.
 * @param ctx - Cordis context carrying `webServer`.
 * @param config - optional `{ keep, maxHeaderSize, enabled, raiseHeaderLimit }`.
 */
function wire(ctx, config) {
	const settings = config ?? {};
	if (settings.enabled === false) {
		announce(ctx, "disabled by config; no cookie is pruned", "warn");
		return;
	}

	const keep = positiveInt(settings.keep, DEFAULT_KEEP);
	const maxHeaderSize = positiveInt(settings.maxHeaderSize, DEFAULT_MAX_HEADER_BYTES);
	let timer;
	let attached = false;

	const attach = () => {
		const server = ctx.webServer?.server;
		if (server === undefined || typeof server.prependListener !== "function") return false;
		attached = true;

		const raise = shouldRaiseHeaderLimit(settings.raiseHeaderLimit, ctx.webServer?.host);

		// Layer 2: a stuck jar must still reach layer 1 to be pruned. Node reads
		// this value when it builds each connection's parser.
		const previousMaxHeaderSize = server.maxHeaderSize;
		if (raise) {
			try {
				server.maxHeaderSize = Math.max(maxHeaderSize, Number(server.maxHeaderSize) || 0);
			} catch {
				announce(ctx, "could not raise maxHeaderSize; only pruning is active", "warn");
			}
		}

		// Layer 1: prune on every response, so asset hits clean the jar too.
		const onRequest = (req, res) => {
			try {
				const plan = planPrune(req.headers.cookie, req.headers.host, keep);
				if (plan.expire.length === 0) return;
				attachPruneCookies(res, plan.expire.map(deletionCookie));
			} catch (error) {
				// Never break a request because housekeeping failed.
				announce(ctx, `prune skipped for one request: ${error instanceof Error ? error.message : String(error)}`, "warn");
			}
		};
		server.prependListener("request", onRequest);

		ctx.effect(() => () => {
			server.removeListener("request", onRequest);
			try {
				if (previousMaxHeaderSize === undefined) delete server.maxHeaderSize;
				else server.maxHeaderSize = previousMaxHeaderSize;
			} catch {
				/* server already closed */
			}
		}, "cookie-prune: request hook and parser ceiling");

		announce(ctx, `active: keep=${String(keep)}, ${raise ? `header ceiling ${String(maxHeaderSize)} bytes` : "parser ceiling unchanged (non-loopback bind)"}`);
		return true;
	};

	if (!attach()) {
		let attempt = 0;
		const retry = () => {
			if (attached) return;
			attempt += 1;
			if (attach()) return;
			if (attempt >= 40) {
				announce(ctx, "webServer never exposed an HTTP listener; the plugin is inactive", "warn");
				return;
			}
			timer = setTimeout(retry, 25);
			timer.unref?.();
		};
		timer = setTimeout(retry, 25);
		timer.unref?.();
		ctx.effect(() => () => {
			if (timer !== undefined) clearTimeout(timer);
		}, "cookie-prune: pending attach timer");
	}
}
