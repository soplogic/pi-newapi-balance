import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const QUOTA_PER_YUAN = 500_000;
export const MAX_API_MESSAGE_LENGTH = 240;
export const RECENT_USAGE_DAYS = 1;

const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

export interface NewApiConfig {
	baseUrl: string;
	userId: string;
	accessToken: string;
}

export interface BalanceResult {
	quota: number;
	balance: number;
}

export interface RecentUsageResult {
	quota: number;
	requestCount: number;
	tokenCount: number;
}

interface ApiEnvelope<T> {
	success: boolean;
	message?: string;
	data?: T;
}

interface SelfData {
	quota: number;
}

interface UsageStatData {
	quota?: number;
	request_count?: number;
	rpm?: number;
	token_count?: number;
	tpm?: number;
}

export class AuthenticationError extends Error {
	constructor(message = "访问令牌无效") {
		super(message);
		this.name = "AuthenticationError";
	}
}

export function quotaToBalance(quota: number): number {
	return quota / QUOTA_PER_YUAN;
}

export function formatBalance(balance: number): string {
	return `¥${balance.toFixed(2)}`;
}

export function normalizeBaseUrl(value: string): string {
	const input = value.trim();
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new Error("Base URL 格式无效");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Base URL 仅支持 http:// 或 https://");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error("Base URL 不能包含账号、查询参数或片段");
	}
	const normalizedPath = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
	url.pathname = normalizedPath || "/";
	return url.toString().replace(/\/$/, "");
}

/** Load the current config format, which requires a userId and access token. */
export async function loadConfig(path: string): Promise<NewApiConfig | undefined> {
	try {
		const value = JSON.parse(await readFile(path, "utf8")) as Partial<NewApiConfig>;
		if (typeof value.userId !== "string" || !value.userId.trim()) return undefined;
		if (typeof value.accessToken !== "string" || !value.accessToken.trim()) return undefined;
		if (typeof value.baseUrl !== "string") return undefined;
		return {
			baseUrl: normalizeBaseUrl(value.baseUrl),
			userId: value.userId.trim(),
			accessToken: value.accessToken,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function canonicalizeSensitiveValue(value: string): string {
	return value.replace(CONTROL_CHARACTERS, "");
}

function escapeRegularExpression(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function chooseRedactionMarker(sensitiveValues: readonly string[]): string {
	const sensitiveCodePoints = new Set(sensitiveValues.flatMap((value) => Array.from(value)));
	const candidates = ["[REDACTED]", "●", "■", "◆", "※"];
	for (const candidate of candidates) {
		if (Array.from(candidate).every((codePoint) => !sensitiveCodePoints.has(codePoint))) return candidate;
	}
	for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint++) {
		const candidate = String.fromCodePoint(codePoint);
		if (!sensitiveCodePoints.has(candidate)) return candidate;
	}
	return "";
}

export function sanitizeApiMessage(
	value: unknown,
	fallback: string,
	sensitiveValues: ReadonlyArray<string | undefined> = [],
): string {
	if (typeof value !== "string") return fallback;
	const values = [...new Set(
		sensitiveValues
			.filter((item): item is string => typeof item === "string")
			.map(canonicalizeSensitiveValue)
			.filter((item) => item.length > 0),
	)].sort((a, b) => Array.from(b).length - Array.from(a).length || a.localeCompare(b));
	let sanitized = value;
	if (values.length > 0) {
		const controlsBetweenCodePoints = String.raw`[\p{Cc}\p{Cf}]*`;
		const alternatives = values.map((sensitiveValue) =>
			Array.from(sensitiveValue).map(escapeRegularExpression).join(controlsBetweenCodePoints),
		);
		const sensitivePattern = new RegExp(alternatives.join("|"), "gu");
		const marker = chooseRedactionMarker(values);
		sanitized = sanitized.replace(sensitivePattern, () => marker);
	}
	sanitized = sanitized.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
	if (!sanitized) return fallback;
	const codePoints = Array.from(sanitized);
	return codePoints.length > MAX_API_MESSAGE_LENGTH
		? `${codePoints.slice(0, MAX_API_MESSAGE_LENGTH - 3).join("")}...`
		: sanitized;
}

export function shouldRestorePeriodicRefresh(
	currentConfig: NewApiConfig | undefined,
	sessionActive: boolean,
	operationIsCurrent: boolean,
): boolean {
	return currentConfig !== undefined && sessionActive && operationIsCurrent;
}

export async function saveConfig(path: string, config: NewApiConfig): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.tmp`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryPath, path);
		await chmod(path, 0o600).catch(() => undefined);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

export async function removeConfigTemporary(path: string): Promise<void> {
	await rm(`${path}.tmp`, { force: true });
}

export async function removeConfig(path: string): Promise<void> {
	const results = await Promise.allSettled([rm(path, { force: true }), removeConfigTemporary(path)]);
	const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
	if (rejected) throw rejected.reason;
}

function apiMessage(value: ApiEnvelope<unknown>, fallback: string, config: NewApiConfig): string {
	return sanitizeApiMessage(value.message, fallback, [config.userId, config.accessToken]);
}

function isAuthenticationFailure(response: Response, payload: ApiEnvelope<unknown>): boolean {
	if (response.status === 401 || response.status === 403) return true;
	if (payload.success !== false) return false;
	return /未登录|登录失效|请登录|认证|授权|session|token/i.test(payload.message ?? "");
}

async function withTimeout<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const timeoutSignal = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
	const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	return operation(combinedSignal);
}

export class NewApiClient {
	private readonly fetchImpl: typeof fetch;

	constructor(fetchImpl: typeof fetch = fetch) {
		this.fetchImpl = fetchImpl;
	}

	async getBalance(config: NewApiConfig, signal?: AbortSignal): Promise<BalanceResult> {
		if (!config.userId || !config.accessToken) throw new AuthenticationError();
		const baseUrl = normalizeBaseUrl(config.baseUrl);
		const response = await withTimeout(signal, (requestSignal) =>
			this.fetchImpl(`${baseUrl}/api/user/self`, {
				headers: {
					accept: "application/json, text/plain, */*",
					"cache-control": "no-store",
					authorization: `Bearer ${config.accessToken}`,
					"new-api-user": config.userId,
					referer: `${baseUrl}/console`,
				},
				redirect: "error",
				signal: requestSignal,
			}),
		);
		const payload = (await response.json().catch(() => ({}))) as ApiEnvelope<SelfData>;
		if (isAuthenticationFailure(response, payload)) {
			throw new AuthenticationError(apiMessage(payload, "访问令牌无效", config));
		}
		if (!response.ok || !payload.success) {
			throw new Error(apiMessage(payload, `余额请求失败 (HTTP ${response.status})`, config));
		}
		if (typeof payload.data?.quota !== "number" || !Number.isFinite(payload.data.quota)) {
			throw new Error("余额响应缺少有效 quota");
		}
		return { quota: payload.data.quota, balance: quotaToBalance(payload.data.quota) };
	}

	async getRecentUsage(config: NewApiConfig, signal?: AbortSignal): Promise<RecentUsageResult> {
		if (!config.userId || !config.accessToken) throw new AuthenticationError();
		const baseUrl = normalizeBaseUrl(config.baseUrl);
		const endTimestamp = Math.floor(Date.now() / 1000);
		const startTimestamp = endTimestamp - RECENT_USAGE_DAYS * 24 * 60 * 60;
		const url = new URL(`${baseUrl}/api/log/self/stat`);
		url.searchParams.set("start_timestamp", String(startTimestamp));
		url.searchParams.set("end_timestamp", String(endTimestamp));
		url.searchParams.set("default_time", String(RECENT_USAGE_DAYS));
		const response = await withTimeout(signal, (requestSignal) =>
			this.fetchImpl(url.toString(), {
				headers: {
					accept: "application/json, text/plain, */*",
					"cache-control": "no-store",
					authorization: `Bearer ${config.accessToken}`,
					"new-api-user": config.userId,
					referer: `${baseUrl}/console`,
				},
				redirect: "error",
				signal: requestSignal,
			}),
		);
		const payload = (await response.json().catch(() => ({}))) as ApiEnvelope<UsageStatData>;
		if (isAuthenticationFailure(response, payload)) {
			throw new AuthenticationError(apiMessage(payload, "访问令牌无效", config));
		}
		if (!response.ok || !payload.success) {
			throw new Error(apiMessage(payload, `用量请求失败 (HTTP ${response.status})`, config));
		}
		const data = payload.data ?? {};
		const quota = typeof data.quota === "number" && Number.isFinite(data.quota) ? data.quota : 0;
		const requestCount = typeof data.request_count === "number" ? data.request_count : typeof data.rpm === "number" ? data.rpm : 0;
		const tokenCount = typeof data.token_count === "number" ? data.token_count : typeof data.tpm === "number" ? data.tpm : 0;
		return { quota, requestCount, tokenCount };
	}

	async refresh(
		config: NewApiConfig,
		signal?: AbortSignal,
	): Promise<{ config: NewApiConfig; result: BalanceResult; usage?: RecentUsageResult }> {
		const result = await this.getBalance(config, signal);
		let usage: RecentUsageResult | undefined;
		try {
			usage = await this.getRecentUsage(config, signal);
		} catch {
			usage = undefined;
		}
		return { config, result, usage };
	}
}
