import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	AuthenticationError,
	MAX_API_MESSAGE_LENGTH,
	formatBalance,
	loadConfig,
	NewApiClient,
	type NewApiConfig,
	normalizeBaseUrl,
	quotaToBalance,
	removeConfig,
	removeConfigTemporary,
	sanitizeApiMessage,
	saveConfig,
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
	const config = { baseUrl: "https://example.test", userId: "56", accessToken: "secret-token" };
	await saveConfig(path, config);
	assert.deepEqual(await loadConfig(path), config);
	assert.match(await readFile(path, "utf8"), /"accessToken": "secret-token"/);
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
		saveConfig(path, { baseUrl: "https://example.test", userId: "56", accessToken: "synthetic" }),
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

test("requires a userId, access token, and valid Base URL in current configs", async () => {
	const directory = await mkdtemp(join(tmpdir(), "newapi-current-config-"));
	const path = join(directory, "config.json");
	await writeFile(path, JSON.stringify({ userId: "56", accessToken: "synthetic-current-token" }), "utf8");
	assert.equal(await loadConfig(path), undefined);

	await writeFile(
		path,
		JSON.stringify({ baseUrl: "not-a-url", userId: "56", accessToken: "synthetic-current-token" }),
		"utf8",
	);
	await assert.rejects(() => loadConfig(path), /Base URL/);
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
	const syntheticToken = "synthetic-token";
	const formattedToken = "synthetic​secret";
	const syntheticUserId = "synthetic-user-id";
	const malicious = `  failed\u001b]52;c;clipboard\u0007\r\n\u0085‮⁦​﻿ ${syntheticToken} ${formattedToken} ${syntheticUserId} ${"😀".repeat(300)}  `;
	const sanitized = sanitizeApiMessage(malicious, "fallback", [syntheticToken, formattedToken, syntheticUserId]);
	assert.equal(/[\p{Cc}\p{Cf}]/u.test(sanitized), false);
	assert.equal(sanitized.includes("  "), false);
	assert.equal(sanitized.includes(syntheticToken), false);
	assert.equal(sanitized.includes("synthetic secret"), false);
	assert.equal(sanitized.includes(syntheticUserId), false);
	assert.equal(Array.from(sanitized).length, MAX_API_MESSAGE_LENGTH);
	assert.match(sanitized, /\.\.\.$/);
	assert.equal(sanitizeApiMessage("\u001b​\u0007", "fallback", ["fallback"]), "fallback");
	assert.equal(sanitizeApiMessage(undefined, "login failed", ["i"]), "login failed");

	const canonicalSensitiveValues = [
		"abc123",
		"abc",
		"bc1",
		"[REDACTED]",
		"x",
		"🔐safe",
		"control​secret",
	];
	const adversarialMessage = [
		"denied",
		"a​b‮c\u00001⁦2\u00073",
		"abc123 abc bc1",
		"[REDACTED]",
		"x",
		"🔐​s‮a\u0000f⁦e",
		"control\u0007s​e‮c⁦r\u0000e⁩t",
		"still useful",
	].join(" | ");
	const adversarialSanitized = sanitizeApiMessage(adversarialMessage, "fallback", canonicalSensitiveValues);
	assert.equal(/[\p{Cc}\p{Cf}]/u.test(adversarialSanitized), false);
	assert.match(adversarialSanitized, /denied/);
	assert.match(adversarialSanitized, /still useful/);
	assert.equal(adversarialSanitized.includes("[REDACTED]"), false);
	assertContainsNoCanonicalSensitiveValue(adversarialSanitized, canonicalSensitiveValues);

	const balanceClient = new NewApiClient(
		(async () =>
			new Response(JSON.stringify({ success: false, message: `expired ${syntheticToken}` }), {
				status: 500,
				headers: { "content-type": "application/json" },
			})) as typeof fetch,
	);
	await assert.rejects(
		() =>
			balanceClient.getBalance({
				baseUrl: "https://example.test",
				userId: "56",
				accessToken: syntheticToken,
			}),
		(error: unknown) => error instanceof Error && error.message === "expired [REDACTED]",
	);
});

test("fetches balance with bearer access token and user id headers", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(url), init });
		return new Response(JSON.stringify({ success: true, data: { quota: 77_930_416 } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	const client = new NewApiClient(fakeFetch as typeof fetch);
	const result = await client.getBalance({ baseUrl: "https://example.test/panel/v1/", userId: "56", accessToken: "tok" });
	assert.equal(requests[0]!.url, "https://example.test/panel/api/user/self");
	const headers = requests[0]!.init!.headers as Record<string, string>;
	assert.equal(headers.authorization, "Bearer tok");
	assert.equal(headers["new-api-user"], "56");
	assert.equal(headers.cookie, undefined);
	assert.equal(requests[0]!.init!.redirect, "error");
	assert.equal(result.balance, 155.860832);
});

test("rejects balance requests when credentials are missing", async () => {
	const client = new NewApiClient(async () => new Response("{}", { status: 200 }));
	await assert.rejects(
		() => client.getBalance({ baseUrl: "https://example.test", userId: "", accessToken: "tok" }),
		AuthenticationError,
	);
	await assert.rejects(
		() => client.getBalance({ baseUrl: "https://example.test", userId: "56", accessToken: "" }),
		AuthenticationError,
	);
});

test("fetches recent usage with a trailing day window", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(url), init });
		return new Response(JSON.stringify({ success: true, data: { quota: 519_873, rpm: 12, tpm: 3400 } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	const client = new NewApiClient(fakeFetch as typeof fetch);
	const usage = await client.getRecentUsage({ baseUrl: "https://example.test", userId: "56", accessToken: "tok" });
	const url = new URL(requests[0]!.url);
	assert.equal(url.origin + url.pathname, "https://example.test/api/log/self/stat");
	assert.equal(url.searchParams.get("default_time"), "1");
	assert.ok(Number(url.searchParams.get("start_timestamp")) > 0);
	assert.ok(Number(url.searchParams.get("end_timestamp")) > Number(url.searchParams.get("start_timestamp")));
	assert.deepEqual(usage, { quota: 519_873, requestCount: 12, tokenCount: 3400 });
});

test("refresh tolerates a failed usage request and still returns balance", async () => {
	let selfCalls = 0;
	const fakeFetch = async (url: string | URL | Request) => {
		if (String(url).includes("/log/self/stat")) {
			return new Response(JSON.stringify({ success: false }), { status: 500 });
		}
		selfCalls++;
		return new Response(JSON.stringify({ success: true, data: { quota: 500_000 } }), {
			headers: { "content-type": "application/json" },
		});
	};
	const client = new NewApiClient(fakeFetch as typeof fetch);
	const config: NewApiConfig = { baseUrl: "https://example.test", userId: "56", accessToken: "tok" };
	const refreshed = await client.refresh(config);
	assert.strictEqual(refreshed.config, config);
	assert.equal(refreshed.result.balance, 1);
	assert.equal(refreshed.usage, undefined);
	assert.equal(selfCalls, 1);
});

test("refresh propagates authentication failures as AuthenticationError", async () => {
	const client = new NewApiClient(
		(async () => new Response(JSON.stringify({ success: false, message: "Unauthorized, invalid access token" }), { status: 401 })) as typeof fetch,
	);
	await assert.rejects(
		() => client.refresh({ baseUrl: "https://example.test", userId: "56", accessToken: "bad" }),
		AuthenticationError,
	);
});

test("restores periodic refresh only for the retained current account", () => {
	const config: NewApiConfig = {
		baseUrl: "https://example.test",
		userId: "56",
		accessToken: "synthetic-token",
	};
	assert.equal(shouldRestorePeriodicRefresh(config, true, true), true);
	assert.equal(shouldRestorePeriodicRefresh(undefined, true, true), false);
	assert.equal(shouldRestorePeriodicRefresh(config, false, true), false);
	assert.equal(shouldRestorePeriodicRefresh(config, true, false), false);
});
