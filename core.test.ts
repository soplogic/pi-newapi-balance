import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	AuthenticationError,
	LEGACY_DEFAULT_BASE_URL,
	MAX_API_MESSAGE_LENGTH,
	formatBalance,
	loadConfig,
	loadLegacyConfig,
	NewApiClient,
	normalizeBaseUrl,
	quotaToBalance,
	removeConfig,
	removeConfigTemporary,
	sanitizeApiMessage,
	saveConfig,
	shouldPersistRefreshedConfig,
	shouldRestorePeriodicRefresh,
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

test("persists credentials with restrictive permissions and removes temporary artifacts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "newapi-"));
	const path = join(directory, "config.json");
	const config = { baseUrl: "https://example.test", username: "user", password: "plain", session: "cookie", userId: 42 };
	await saveConfig(path, config);
	assert.deepEqual(await loadConfig(path), config);
	assert.match(await readFile(path, "utf8"), /"password": "plain"/);
	if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
	await writeFile(`${path}.tmp`, "synthetic temporary data", { mode: 0o600 });
	await removeConfig(path);
	assert.equal(await loadConfig(path), undefined);
	await assert.rejects(() => stat(`${path}.tmp`), { code: "ENOENT" });
});

test("cleans the temporary credential file when an atomic rename fails", async () => {
	const directory = await mkdtemp(join(tmpdir(), "newapi-save-failure-"));
	const path = join(directory, "config.json");
	await mkdir(path);
	await assert.rejects(() =>
		saveConfig(path, { baseUrl: "https://example.test", username: "user", password: "synthetic" }),
	);
	await assert.rejects(() => stat(`${path}.tmp`), { code: "ENOENT" });
});

test("removes only a stale temporary credential artifact", async () => {
	const directory = await mkdtemp(join(tmpdir(), "newapi-temp-only-"));
	const path = join(directory, "config.json");
	await writeFile(path, "primary", "utf8");
	await writeFile(`${path}.tmp`, "temporary", "utf8");
	await removeConfigTemporary(path);
	assert.equal(await readFile(path, "utf8"), "primary");
	await assert.rejects(() => stat(`${path}.tmp`), { code: "ENOENT" });
});

test("requires an explicit valid Base URL in current configs", async () => {
	const directory = await mkdtemp(join(tmpdir(), "newapi-current-config-"));
	const path = join(directory, "config.json");
	await writeFile(path, JSON.stringify({ username: "current-user", password: "synthetic-current-password" }), "utf8");
	assert.equal(await loadConfig(path), undefined);

	await writeFile(
		path,
		JSON.stringify({ baseUrl: "not-a-url", username: "current-user", password: "synthetic-current-password" }),
		"utf8",
	);
	await assert.rejects(() => loadConfig(path), /Base URL/);
});

test("loads and persists a resolved Base URL only through legacy migration", async () => {
	const directory = await mkdtemp(join(tmpdir(), "newapi-legacy-"));
	const legacyPath = join(directory, "maolao-balance.json");
	const currentPath = join(directory, "newapi-balance.json");
	await writeFile(
		legacyPath,
		JSON.stringify({ username: "legacy-user", password: "synthetic-legacy-password" }),
		"utf8",
	);
	const legacyConfig = await loadLegacyConfig(legacyPath);
	assert.equal(legacyConfig?.baseUrl, LEGACY_DEFAULT_BASE_URL);
	assert.ok(legacyConfig);
	await saveConfig(currentPath, legacyConfig);
	assert.equal(JSON.parse(await readFile(currentPath, "utf8")).baseUrl, LEGACY_DEFAULT_BASE_URL);
	assert.deepEqual(await loadConfig(currentPath), legacyConfig);
});

function canonicalizeForAssertion(value: string): string {
	return value.replace(/[\p{Cc}\p{Cf}]/gu, "");
}

function assertContainsNoCanonicalSensitiveValue(output: string, sensitiveValues: readonly string[]): void {
	const canonicalOutput = canonicalizeForAssertion(output);
	for (const value of sensitiveValues) {
		const canonicalValue = canonicalizeForAssertion(value);
		if (canonicalValue) assert.equal(canonicalOutput.includes(canonicalValue), false, `exposed ${JSON.stringify(value)}`);
	}
}

test("sanitizes and redacts server messages before exposing errors", async () => {
	const syntheticPassword = "synthetic-password";
	const formattedPassword = "synthetic\u200bsecret";
	const syntheticSession = "synthetic-session";
	const malicious = `  failed\u001b]52;c;clipboard\u0007\r\n\u0085\u202e\u2066\u200b\ufeff ${syntheticPassword} ${formattedPassword} ${syntheticSession} ${"😀".repeat(300)}  `;
	const sanitized = sanitizeApiMessage(malicious, "fallback", [syntheticPassword, formattedPassword, syntheticSession]);
	assert.equal(/[\p{Cc}\p{Cf}]/u.test(sanitized), false);
	assert.equal(sanitized.includes("  "), false);
	assert.equal(sanitized.includes(syntheticPassword), false);
	assert.equal(sanitized.includes("synthetic secret"), false);
	assert.equal(sanitized.includes(syntheticSession), false);
	assert.equal(Array.from(sanitized).length, MAX_API_MESSAGE_LENGTH);
	assert.match(sanitized, /\.\.\.$/);
	assert.equal(sanitizeApiMessage("\u001b\u200b\u0007", "fallback", ["fallback"]), "fallback");
	assert.equal(sanitizeApiMessage(undefined, "login failed", ["i"]), "login failed");

	const canonicalSensitiveValues = [
		"abc123",
		"abc",
		"bc1",
		"[REDACTED]",
		"x",
		"🔐safe",
		"control\u200bsecret",
	];
	const adversarialMessage = [
		"denied",
		"a\u200bb\u202ec\u00001\u20662\u00073",
		"abc123 abc bc1",
		"[REDACTED]",
		"x",
		"🔐\u200bs\u202ea\u0000f\u2066e",
		"control\u0007s\u200be\u202ec\u2066r\u0000e\u2069t",
		"still useful",
	].join(" | ");
	const adversarialSanitized = sanitizeApiMessage(adversarialMessage, "fallback", canonicalSensitiveValues);
	assert.equal(/[\p{Cc}\p{Cf}]/u.test(adversarialSanitized), false);
	assert.match(adversarialSanitized, /denied/);
	assert.match(adversarialSanitized, /still useful/);
	assert.equal(adversarialSanitized.includes("[REDACTED]"), false);
	assertContainsNoCanonicalSensitiveValue(adversarialSanitized, canonicalSensitiveValues);

	const loginClient = new NewApiClient(
		(async () =>
			new Response(JSON.stringify({ success: false, message: `echo ${syntheticPassword}` }), { status: 401 })) as typeof fetch,
	);
	await assert.rejects(
		() => loginClient.login({ baseUrl: "https://example.test", username: "u", password: syntheticPassword }),
		(error: unknown) => error instanceof AuthenticationError && error.message === "echo [REDACTED]",
	);

	const balanceClient = new NewApiClient(
		(async () =>
			new Response(JSON.stringify({ success: false, message: `expired ${syntheticSession}` }), {
				status: 500,
				headers: { "content-type": "application/json" },
			})) as typeof fetch,
	);
	await assert.rejects(
		() =>
			balanceClient.getBalance({
				baseUrl: "https://example.test",
				username: "u",
				password: syntheticPassword,
				session: syntheticSession,
				userId: 7,
			}),
		(error: unknown) => error instanceof Error && error.message === "expired [REDACTED]",
	);
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
	const config = await client.login({ baseUrl: "https://example.test/panel/v1/", username: "u", password: "p" });
	assert.deepEqual(config, {
		baseUrl: "https://example.test/panel",
		username: "u",
		password: "p",
		session: "abc123",
		userId: 5590,
	});
	const result = await client.getBalance(config);
	assert.equal(requests[0]!.url, "https://example.test/panel/api/user/login?turnstile=");
	assert.equal(requests[1]!.url, "https://example.test/panel/api/user/self");
	assert.equal((requests[0]!.init!.headers as Record<string, string>).origin, "https://example.test");
	assert.equal((requests[0]!.init!.headers as Record<string, string>).referer, "https://example.test/panel/login");
	assert.equal(requests[0]!.init!.redirect, "error");
	assert.equal(requests[1]!.init!.redirect, "error");
	assert.equal(result.balance, 155.860832);
	assert.equal((requests[1]!.init!.headers as Record<string, string>).cookie, "session=abc123");
	assert.equal((requests[1]!.init!.headers as Record<string, string>)["new-api-user"], "5590");
});

test("refresh config persistence follows the reauthentication identity contract", async () => {
	const currentConfig: NewApiConfig = {
		baseUrl: "https://example.test",
		username: "user",
		password: "synthetic-password",
		session: "current-session",
		userId: 7,
	};
	const directClient = new NewApiClient(
		(async () =>
			new Response(JSON.stringify({ success: true, data: { quota: 500_000 } }), {
				headers: { "content-type": "application/json" },
			})) as typeof fetch,
	);
	const unchanged = await directClient.refresh(currentConfig);
	assert.strictEqual(unchanged.config, currentConfig);
	assert.equal(shouldPersistRefreshedConfig(currentConfig, unchanged.config), false);

	const reauthenticatedConfig = { ...currentConfig, session: "new-session" };
	assert.equal(shouldPersistRefreshedConfig(currentConfig, reauthenticatedConfig), true);
});

test("restores periodic refresh only for the retained current account", () => {
	const config: NewApiConfig = {
		baseUrl: "https://example.test",
		username: "user",
		password: "synthetic-password",
	};
	assert.equal(shouldRestorePeriodicRefresh(config, true, true), true);
	assert.equal(shouldRestorePeriodicRefresh(undefined, true, true), false);
	assert.equal(shouldRestorePeriodicRefresh(config, false, true), false);
	assert.equal(shouldRestorePeriodicRefresh(config, true, false), false);
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
	const originalConfig: NewApiConfig = {
		baseUrl: "https://example.test",
		username: "u",
		password: "p",
		session: "old",
		userId: 7,
	};
	const refreshed = await client.refresh(originalConfig);
	assert.equal(refreshed.config.session, "new-session");
	assert.notStrictEqual(refreshed.config, originalConfig);
	assert.equal(shouldPersistRefreshedConfig(originalConfig, refreshed.config), true);
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
