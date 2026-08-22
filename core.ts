import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const LEGACY_DEFAULT_BASE_URL = "https://api.maolaoapi.cc";
export const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const QUOTA_PER_YUAN = 500_000;
export const MAX_API_MESSAGE_LENGTH = 240;

const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

export interface NewApiConfig {
	baseUrl: string;
	username: string;
	password: string;
	session?: string;
	userId?: number;
}

export interface BalanceResult {
	quota: number;
	balance: number;
}

interface ApiEnvelope<T> {
	success: boolean;
	message?: string;
	data?: T;
}

interface LoginData {
	id: number;
}

interface SelfData {
	quota: number;
}

export class AuthenticationError extends Error {
	constructor(message = "登录已失效") {
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

type ConfigSource = "current" | "legacy";

async function loadConfigFile(path: string, source: ConfigSource): Promise<NewApiConfig | undefined> {
	try {
		const value = JSON.parse(await readFile(path, "utf8")) as Partial<NewApiConfig>;
		if (typeof value.username !== "string" || typeof value.password !== "string") return undefined;
		const baseUrl = typeof value.baseUrl === "string"
			? value.baseUrl
			: source === "legacy"
				? LEGACY_DEFAULT_BASE_URL
				: undefined;
		if (baseUrl === undefined) return undefined;
		return {
			baseUrl: normalizeBaseUrl(baseUrl),
			username: value.username,
			password: value.password,
			session: typeof value.session === "string" ? value.session : undefined,
			userId: typeof value.userId === "number" ? value.userId : undefined,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Load the current config format, which always requires an explicit Base URL. */
export function loadConfig(path: string): Promise<NewApiConfig | undefined> {
	return loadConfigFile(path, "current");
}

/** Load the legacy config format for migration, supplying its historical site URL when absent. */
export function loadLegacyConfig(path: string): Promise<NewApiConfig | undefined> {
	return loadConfigFile(path, "legacy");
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

/** NewApiClient.refresh preserves config identity unless it reauthenticates. */
export function shouldPersistRefreshedConfig(current: NewApiConfig, refreshed: NewApiConfig): boolean {
	return current !== refreshed;
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
	return sanitizeApiMessage(value.message, fallback, [config.username, config.password, config.session]);
}

function isAuthenticationFailure(response: Response, payload: ApiEnvelope<unknown>): boolean {
	if (response.status === 401 || response.status === 403) return true;
	if (payload.success !== false) return false;
	return /未登录|登录失效|请登录|认证|授权|session/i.test(payload.message ?? "");
}

async function withTimeout<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const timeoutSignal = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
	const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	return operation(combinedSignal);
}

function readSessionCookie(response: Response): string | undefined {
	const headers = response.headers as Headers & { getSetCookie?: () => string[] };
	const values = headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
	for (const value of values) {
		const match = value.match(/(?:^|[,;]\s*)session=([^;]+)/i);
		if (match) return match[1];
	}
	return undefined;
}

export class NewApiClient {
	private readonly fetchImpl: typeof fetch;

	constructor(fetchImpl: typeof fetch = fetch) {
		this.fetchImpl = fetchImpl;
	}

	async login(config: NewApiConfig, signal?: AbortSignal): Promise<NewApiConfig> {
		const baseUrl = normalizeBaseUrl(config.baseUrl);
		const origin = new URL(baseUrl).origin;
		const response = await withTimeout(signal, (requestSignal) =>
			this.fetchImpl(`${baseUrl}/api/user/login?turnstile=`, {
				method: "POST",
				headers: {
					accept: "application/json, text/plain, */*",
					"cache-control": "no-store",
					"content-type": "application/json",
					"new-api-user": "-1",
					origin,
					referer: `${baseUrl}/login`,
				},
				body: JSON.stringify({ username: config.username, password: config.password }),
				redirect: "error",
				signal: requestSignal,
			}),
		);
		const payload = (await response.json().catch(() => ({}))) as ApiEnvelope<LoginData>;
		if (!response.ok || !payload.success || typeof payload.data?.id !== "number") {
			throw new AuthenticationError(apiMessage(payload, `登录失败 (HTTP ${response.status})`, config));
		}
		const session = readSessionCookie(response);
		if (!session) throw new AuthenticationError("登录成功，但响应中没有会话 Cookie");
		return { ...config, baseUrl, session, userId: payload.data.id };
	}

	async getBalance(config: NewApiConfig, signal?: AbortSignal): Promise<BalanceResult> {
		if (!config.session || typeof config.userId !== "number") throw new AuthenticationError();
		const baseUrl = normalizeBaseUrl(config.baseUrl);
		const response = await withTimeout(signal, (requestSignal) =>
			this.fetchImpl(`${baseUrl}/api/user/self`, {
				headers: {
					accept: "application/json, text/plain, */*",
					"cache-control": "no-store",
					cookie: `session=${config.session}`,
					"new-api-user": String(config.userId),
					referer: `${baseUrl}/console`,
				},
				redirect: "error",
				signal: requestSignal,
			}),
		);
		const payload = (await response.json().catch(() => ({}))) as ApiEnvelope<SelfData>;
		if (isAuthenticationFailure(response, payload)) {
			throw new AuthenticationError(apiMessage(payload, "登录已失效", config));
		}
		if (!response.ok || !payload.success) {
			throw new Error(apiMessage(payload, `余额请求失败 (HTTP ${response.status})`, config));
		}
		if (typeof payload.data?.quota !== "number" || !Number.isFinite(payload.data.quota)) {
			throw new Error("余额响应缺少有效 quota");
		}
		return { quota: payload.data.quota, balance: quotaToBalance(payload.data.quota) };
	}

	async refresh(config: NewApiConfig, signal?: AbortSignal): Promise<{ config: NewApiConfig; result: BalanceResult }> {
		let activeConfig = config;
		try {
			return { config: activeConfig, result: await this.getBalance(activeConfig, signal) };
		} catch (error) {
			if (!(error instanceof AuthenticationError)) throw error;
		}
		activeConfig = await this.login(config, signal);
		return { config: activeConfig, result: await this.getBalance(activeConfig, signal) };
	}
}
