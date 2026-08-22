import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	AuthenticationError,
	LEGACY_DEFAULT_BASE_URL,
	formatBalance,
	loadConfig,
	NewApiClient,
	normalizeBaseUrl,
	quotaToBalance,
	removeConfig,
	saveConfig,
} from "./core.ts";

test("converts quota and formats yuan symbol without exchange conversion", () => {
	assert.equal(quotaToBalance(77_930_416), 155.860832);
	assert.equal(formatBalance(quotaToBalance(77_930_416)), "¥155.86");
});

test("normalizes New API base URLs", () => {
	assert.equal(normalizeBaseUrl(" https://example.test/ "), "https://example.test");
	assert.equal(normalizeBaseUrl("https://example.test/v1"), "https://example.test");
	assert.equal(normalizeBaseUrl("https://example.test/panel/v1/"), "https://example.test/panel");
	assert.throws(() => normalizeBaseUrl("ftp://example.test"), /仅支持/);
	assert.throws(() => normalizeBaseUrl("https://example.test/?token=secret"), /查询参数/);
});

test("persists credentials, base URL, and session", async () => {
	const path = join(await mkdtemp(join(tmpdir(), "newapi-")), "config.json");
	const config = { baseUrl: "https://example.test", username: "user", password: "plain", session: "cookie", userId: 42 };
	await saveConfig(path, config);
	assert.deepEqual(await loadConfig(path), config);
	assert.match(await readFile(path, "utf8"), /"password": "plain"/);
	await removeConfig(path);
	assert.equal(await loadConfig(path), undefined);
});

test("loads legacy config with the default base URL", async () => {
	const path = join(await mkdtemp(join(tmpdir(), "newapi-legacy-")), "config.json");
	await import("node:fs/promises").then(({ writeFile }) =>
		writeFile(path, JSON.stringify({ username: "user", password: "plain" }), "utf8"),
	);
	assert.equal((await loadConfig(path))?.baseUrl, LEGACY_DEFAULT_BASE_URL);
});

test("logs in, captures session cookie, and fetches balance", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(url), init });
		if (String(url).includes("/login")) {
			return new Response(JSON.stringify({ success: true, data: { id: 5590 } }), {
				status: 200,
				headers: { "content-type": "application/json", "set-cookie": "session=abc123; Path=/; HttpOnly" },
			});
		}
		return new Response(JSON.stringify({ success: true, data: { quota: 77_930_416 } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	const client = new NewApiClient(fakeFetch as typeof fetch);
	const config = await client.login({ baseUrl: "https://example.test/v1/", username: "u", password: "p" });
	assert.deepEqual(config, {
		baseUrl: "https://example.test",
		username: "u",
		password: "p",
		session: "abc123",
		userId: 5590,
	});
	const result = await client.getBalance(config);
	assert.equal(requests[0]!.url, "https://example.test/api/user/login?turnstile=");
	assert.equal(requests[1]!.url, "https://example.test/api/user/self");
	assert.equal(result.balance, 155.860832);
	assert.equal((requests[1]!.init!.headers as Record<string, string>).cookie, "session=abc123");
	assert.equal((requests[1]!.init!.headers as Record<string, string>)["new-api-user"], "5590");
});

test("refresh logs in once when the existing session is unauthorized", async () => {
	let selfCalls = 0;
	const fakeFetch = async (url: string | URL | Request) => {
		if (String(url).includes("/login")) {
			return new Response(JSON.stringify({ success: true, data: { id: 7 } }), {
				headers: { "content-type": "application/json", "set-cookie": "session=new-session; Path=/" },
			});
		}
		selfCalls++;
		if (selfCalls === 1) return new Response(JSON.stringify({ success: false }), { status: 401 });
		return new Response(JSON.stringify({ success: true, data: { quota: 500_000 } }), {
			headers: { "content-type": "application/json" },
		});
	};
	const client = new NewApiClient(fakeFetch as typeof fetch);
	const refreshed = await client.refresh({
		baseUrl: "https://example.test",
		username: "u",
		password: "p",
		session: "old",
		userId: 7,
	});
	assert.equal(refreshed.config.session, "new-session");
	assert.equal(refreshed.result.balance, 1);
	assert.equal(selfCalls, 2);
});

test("refresh also reauthenticates for HTTP 200 login-expired envelopes", async () => {
	let selfCalls = 0;
	const fakeFetch = async (url: string | URL | Request) => {
		if (String(url).includes("/login")) {
			return new Response(JSON.stringify({ success: true, data: { id: 7 } }), {
				headers: { "content-type": "application/json", "set-cookie": "session=fresh; Path=/" },
			});
		}
		selfCalls++;
		if (selfCalls === 1) {
			return new Response(JSON.stringify({ success: false, message: "未登录或登录已过期" }), {
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ success: true, data: { quota: 1_000_000 } }), {
			headers: { "content-type": "application/json" },
		});
	};
	const client = new NewApiClient(fakeFetch as typeof fetch);
	const refreshed = await client.refresh({
		baseUrl: "https://example.test",
		username: "u",
		password: "p",
		session: "old",
		userId: 7,
	});
	assert.equal(refreshed.config.session, "fresh");
	assert.equal(refreshed.result.balance, 2);
});

test("rejects unsuccessful login without exposing the password", async () => {
	const client = new NewApiClient(
		(async () => new Response(JSON.stringify({ success: false, message: "账号或密码错误" }), { status: 401 })) as typeof fetch,
	);
	await assert.rejects(
		() => client.login({ baseUrl: "https://example.test", username: "u", password: "secret" }),
		AuthenticationError,
	);
});
