/**
 * Tests for dsh-cookie-prune.
 *
 * Unit tests cover the pure policy; the integration block mounts the plugin on
 * a real `node:http` server that mints cookies exactly the way
 * `@deepseek-ai/dsh-client-connection` does — including the `res.writeHead`
 * header object that would otherwise clobber a staged `Set-Cookie`.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { randomBytes, createHmac } from "node:crypto";

import {
	apply,
	cookieNameFor,
	isLoopbackHost,
	shouldRaiseHeaderLimit,
	deletionCookie,
	issuedAtOf,
	parseCookieHeader,
	planPrune
} from "../lib/index.js";

const results = [];
function test(label, body) {
	return Promise.resolve()
		.then(body)
		.then(
			() => results.push([true, label]),
			(error) => results.push([false, label, error])
		);
}

/* ------------------------------------------------------------------ helpers */

const SECRET = randomBytes(32);
const b64 = (input) => Buffer.from(input).toString("base64url");

/** A cookie value shaped like the issuer's: v1.<payload>.<hmac>. */
function mintValue(authority, issuedAt) {
	const payload = { version: 1, authority, issuedAt, expiresAt: issuedAt + 30 * 86400_000 };
	const body = b64(JSON.stringify(payload));
	const signature = b64(createHmac("sha256", SECRET).update(body).digest());
	return `v1.${body}.${signature}`;
}

/** A browser jar keyed by name, honouring Max-Age=0 like a real UA. */
function createJar() {
	const jar = new Map();
	return {
		jar,
		header() {
			return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
		},
		absorb(setCookieHeaders) {
			const list = setCookieHeaders === undefined ? [] : Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
			for (const header of list) {
				const at = header.indexOf("=");
				const name = header.slice(0, at);
				const rest = header.slice(at + 1);
				const value = rest.split(";")[0];
				if (/max-age=0\b/i.test(header)) jar.delete(name);
				else jar.set(name, value);
			}
		}
	};
}

/** Raw HTTP round-trip so a 431 is observable rather than thrown. */
function roundTrip(port, hostHeader, cookieHeader, path = "/") {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1", () => {
			const lines = [
				`GET ${path} HTTP/1.1`,
				`Host: ${hostHeader}`,
				...(cookieHeader ? [`Cookie: ${cookieHeader}`] : []),
				"Connection: close",
				"",
				""
			];
			socket.write(lines.join("\r\n"));
		});
		let raw = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			raw += chunk;
		});
		socket.on("end", () => {
			const status = Number(raw.split(" ")[1]);
			const headers = {};
			const head = raw.split("\r\n\r\n")[0];
			for (const line of head.split("\r\n").slice(1)) {
				const at = line.indexOf(":");
				if (at === -1) continue;
				const key = line.slice(0, at).toLowerCase().trim();
				const value = line.slice(at + 1).trim();
				if (key === "set-cookie") (headers[key] ??= []).push(value);
				else headers[key] = value;
			}
			resolve({ status, headers, body: raw.slice(raw.indexOf("\r\n\r\n") + 4) });
		});
		socket.on("error", reject);
	});
}

/** Mount the plugin on an http server that behaves like the DSH host. */
function startHost() {
	const server = createServer((req, res) => {
		if (req.url.startsWith("/assets/")) {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("asset");
			return;
		}
		// Mirrors dsh-client-connection's authorizeIndex: new session cookie
		// per authority, written through a writeHead header object.
		const issuedAt = Date.now();
		res.writeHead(303, {
			"cache-control": "no-store",
			location: "./",
			"set-cookie": `${cookieNameFor(req.headers.host)}=${mintValue(req.headers.host, issuedAt)}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`
		});
		res.end();
	});

	const ctx = {
		webServer: { server, host: "127.0.0.1" },
		logger: { info() {}, warn() {} },
		effect(register) {
			register();
		}
	};
	apply(ctx, { keep: 6, maxHeaderSize: 65536 });

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
	});
}

/* -------------------------------------------------------------- unit tests */

await test("parseCookieHeader keeps only dsh-auth-* pairs", () => {
	const parsed = parseCookieHeader("theme=dark; dsh-auth-abc=1; dsh-auth-def=2; other=x");
	assert.deepEqual(parsed.map((entry) => entry.name), ["dsh-auth-abc", "dsh-auth-def"]);
});

await test("parseCookieHeader tolerates empty and malformed input", () => {
	assert.deepEqual(parseCookieHeader(undefined), []);
	assert.deepEqual(parseCookieHeader(""), []);
	assert.deepEqual(parseCookieHeader(";;=;noequals"), []);
});

await test("issuedAtOf reads the stamp and rejects foreign values", () => {
	const value = mintValue("127.0.0.1:3080", 1795531869995);
	assert.equal(issuedAtOf(value), 1795531869995);
	assert.equal(issuedAtOf("garbage"), -1);
	assert.equal(issuedAtOf("v1.notbase64!.sig"), -1);
});

await test("cookieNameFor is host:port specific", () => {
	const a = cookieNameFor("127.0.0.1:42939");
	const b = cookieNameFor("127.0.0.1:3080");
	assert.match(a, /^dsh-auth-[A-Za-z0-9_-]{43}$/);
	assert.notEqual(a, b);
});

await test("planPrune leaves a small jar alone", () => {
	const header = ["127.0.0.1:1", "127.0.0.1:2"].map((host, index) => `${cookieNameFor(host)}=${mintValue(host, 1000 + index)}`).join("; ");
	const plan = planPrune(header, "127.0.0.1:1", 6);
	assert.equal(plan.total, 2);
	assert.deepEqual(plan.expire, []);
});

await test("planPrune keeps the newest N and the current authority", () => {
	const hosts = Array.from({ length: 20 }, (_, index) => `127.0.0.1:${10000 + index}`);
	// The oldest one is the authority being served and must survive.
	const header = hosts.map((host, index) => `${cookieNameFor(host)}=${mintValue(host, 1000 + index)}`).join("; ");
	const plan = planPrune(header, hosts[0], 6);
	assert.equal(plan.total, 20);
	assert.equal(plan.kept.length, 5, "retain one short of the cap, leaving room for the next mint");
	assert.equal(plan.expire.length, 15);
	assert.ok(plan.kept.includes(cookieNameFor(hosts[0])), "current authority must be kept");
	assert.ok(plan.kept.includes(cookieNameFor(hosts[19])), "newest must be kept");
	assert.ok(!plan.expire.includes(cookieNameFor(hosts[19])));
});

await test("isLoopbackHost recognises loopback spellings only", () => {
	for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]"]) {
		assert.equal(isLoopbackHost(host), true, `${host} should be loopback`);
	}
	for (const host of ["0.0.0.0", "10.0.0.7", "192.168.1.5", "", undefined, "dsh.example"]) {
		assert.equal(isLoopbackHost(host), false, `${String(host)} should not be loopback`);
	}
});

await test("shouldRaiseHeaderLimit defaults to loopback only", () => {
	assert.equal(shouldRaiseHeaderLimit(undefined, "127.0.0.1"), true);
	assert.equal(shouldRaiseHeaderLimit("auto", "127.0.0.1"), true);
	assert.equal(shouldRaiseHeaderLimit(undefined, "10.0.0.7"), false, "LAN bind must keep Node's ceiling");
	assert.equal(shouldRaiseHeaderLimit("always", "10.0.0.7"), true);
	assert.equal(shouldRaiseHeaderLimit(true, "10.0.0.7"), true);
	assert.equal(shouldRaiseHeaderLimit("never", "127.0.0.1"), false);
	assert.equal(shouldRaiseHeaderLimit(false, "127.0.0.1"), false);
});

await test("deletionCookie clears with matching path attributes", () => {
	const directive = deletionCookie("dsh-auth-x");
	assert.match(directive, /^dsh-auth-x=;/);
	assert.match(directive, /Max-Age=0/);
	assert.match(directive, /Path=\//);
	assert.match(directive, /Expires=Thu, 01 Jan 1970/);
});

/* ------------------------------------------------------- integration tests */

const host = await startHost();

await test("apply raises the parser ceiling on the live server", () => {
	assert.equal(host.server.maxHeaderSize, 65536);
});

await test("a 100-cookie jar is parsed, served and pruned (no 431)", async () => {
	const jar = createJar();
	const stale = [];
	for (let index = 0; index < 100; index += 1) {
		const authority = `127.0.0.1:${20000 + index}`;
		const cookieName = cookieNameFor(authority);
		jar.jar.set(cookieName, mintValue(authority, 1700000000000 + index));
		stale.push(cookieName);
	}
	// Guard the premise: without the raise this header would exceed Node's
	// 16 KiB default.
	assert.ok(jar.header().length > 16384);

	const response = await roundTrip(host.port, "127.0.0.1:42939", jar.header());
	assert.notEqual(response.status, 431);
	assert.equal(response.status, 303);

	const directives = response.headers["set-cookie"] ?? [];
	const deletions = directives.filter((entry) => /max-age=0\b/i.test(entry));
	assert.equal(deletions.length, 95, "stale cookies should be expired down to the cap");

	jar.absorb(directives);
	assert.equal(jar.jar.size, 6, `jar should settle at the cap, got ${jar.jar.size}`);
});

await test("the handler's own session cookie survives the prune merge", async () => {
	const authority = "127.0.0.1:42939";
	const jar = createJar();
	for (let index = 0; index < 10; index += 1) {
		const old = `127.0.0.1:${30000 + index}`;
		jar.jar.set(cookieNameFor(old), mintValue(old, 1700000000000 + index));
	}

	const response = await roundTrip(host.port, authority, jar.header());
	const directives = response.headers["set-cookie"] ?? [];
	const minted = directives.filter((entry) => entry.startsWith(`${cookieNameFor(authority)}=`) && !/max-age=0\b/i.test(entry));
	assert.equal(minted.length, 1, "the freshly minted session cookie must be present");
	assert.ok(directives.some((entry) => /max-age=0\b/i.test(entry)), "prune directives must be present too");

	jar.absorb(directives);
	assert.equal(jar.jar.size, 6, "jar settles at the cap: newest stale cookies plus the live session");
	assert.ok(jar.jar.has(cookieNameFor(authority)));
});

await test("100 launches keep the jar at the steady-state bound", async () => {
	const jar = createJar();
	for (let launch = 0; launch < 100; launch += 1) {
		const authority = `127.0.0.1:${40000 + launch}`;
		const response = await roundTrip(host.port, authority, jar.header());
		assert.equal(response.status, 303, `launch ${launch} should still open`);
		jar.absorb(response.headers["set-cookie"]);
		assert.ok(jar.jar.size <= 6, `launch ${launch}: jar grew to ${jar.jar.size}`);
	}
});

await test("asset requests prune too", async () => {
	const jar = createJar();
	for (let index = 0; index < 12; index += 1) {
		const old = `127.0.0.1:${50000 + index}`;
		jar.jar.set(cookieNameFor(old), mintValue(old, 1700000000000 + index));
	}
	const response = await roundTrip(host.port, "127.0.0.1:42939", jar.header(), "/assets/app.js");
	assert.equal(response.status, 200);
	assert.ok((response.headers["set-cookie"] ?? []).some((entry) => /max-age=0\b/i.test(entry)));
});

await test("no prune headers when the jar is already small", async () => {
	const jar = createJar();
	jar.jar.set(cookieNameFor("127.0.0.1:42939"), mintValue("127.0.0.1:42939", 1700000000000));
	const response = await roundTrip(host.port, "127.0.0.1:42939", jar.header(), "/assets/app.js");
	assert.equal(response.headers["set-cookie"], undefined);
});

await test("defers until the listener exists (plugin ordering race)", async () => {
	const lateServer = createServer((req, res) => {
		res.writeHead(200);
		res.end();
	});
	const service = { server: undefined, host: "127.0.0.1" };
	const ctx = {
		webServer: service,
		logger: { info() {}, warn() {} },
		effect(register) {
			register();
		}
	};
	apply(ctx, { keep: 6 });
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(lateServer.maxHeaderSize, undefined, "not attached yet");
	service.server = lateServer;
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(lateServer.maxHeaderSize, 65536, "attached once the listener appeared");
	lateServer.close();
});

host.server.close();

/* ---------------------------------------------------------------- reporting */

const failed = results.filter(([ok]) => !ok);
for (const [ok, label, error] of results) {
	if (ok) console.log(`  ok   ${label}`);
	else console.log(`  FAIL ${label}\n       ${error?.message ?? error}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
