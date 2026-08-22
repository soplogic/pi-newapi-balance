import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	DEFAULT_REFRESH_INTERVAL_MS,
	formatBalance,
	loadConfig,
	NewApiClient,
	type NewApiConfig,
	normalizeBaseUrl,
	removeConfig,
	saveConfig,
} from "./core.ts";

const STATUS_ID = "newapi-balance";
const FOLLOW_UP_DELAYS_MS = [1_000, 3_000, 6_000] as const;
const DEDUCTION_ANIMATION_MS = 800;
const DEDUCTION_DISPLAY_MS = 3_000;
const DEDUCTION_FRAME_MS = 50;
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const configPath = join(agentDir, "newapi-balance.json");
const legacyConfigPath = join(agentDir, "maolao-balance.json");

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatTime(value: Date | undefined): string {
	return value ? value.toLocaleString("zh-CN", { hour12: false }) : "尚未成功刷新";
}

function formatTokens(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatFooterCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const insideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	return insideHome ? (relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`) : cwd;
}

function sanitizeStatus(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

async function promptPassword(ctx: ExtensionContext): Promise<string | undefined> {
	if (ctx.mode !== "tui") return undefined;
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const input = new Input();
		input.focused = true;
		input.onSubmit = (value) => done(value);
		input.onEscape = () => done(undefined);
		return {
			render: (width) => {
				const label = theme.fg("accent", "密码: ");
				const masked = "*".repeat(input.getValue().length);
				return [truncateToWidth(label + masked, width)];
			},
			handleInput: (data) => {
				input.handleInput(data);
				tui.requestRender();
			},
			invalidate: () => input.invalidate(),
		};
	});
}

export default function (pi: ExtensionAPI) {
	const client = new NewApiClient();
	let config: NewApiConfig | undefined;
	let balance: number | undefined;
	let lastUpdated: Date | undefined;
	let lastError: string | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let deductionAnimationTimer: ReturnType<typeof setInterval> | undefined;
	let deductionClearTimer: ReturnType<typeof setTimeout> | undefined;
	let deduction: { fromCents: number; toCents: number; amountCents: number; startedAt: number } | undefined;
	let refreshInFlight: Promise<boolean> | undefined;
	let refreshController: AbortController | undefined;
	let followUpTimers: Array<ReturnType<typeof setTimeout>> = [];
	let generation = 0;
	let active = false;
	let requestFooterRender: () => void = () => {};

	function displayedBalance(): number | undefined {
		if (!deduction) return balance;
		const progress = Math.min(1, (Date.now() - deduction.startedAt) / DEDUCTION_ANIMATION_MS);
		const cents = Math.round(deduction.fromCents + (deduction.toCents - deduction.fromCents) * progress);
		return cents / 100;
	}

	function balanceStatus(): {
		text: string;
		color: "success" | "warning" | "error" | "dim";
		deductionText?: string;
	} {
		const visibleBalance = displayedBalance();
		let text: string;
		let color: "success" | "warning" | "error" | "dim";
		if (!config) {
			text = "余额: 未登录";
			color = "dim";
		} else if (visibleBalance !== undefined && lastError) {
			text = `余额: ${formatBalance(visibleBalance)} (更新失败)`;
			color = "warning";
		} else if (visibleBalance !== undefined) {
			text = `余额: ${formatBalance(visibleBalance)}`;
			color = "success";
		} else if (lastError) {
			text = `余额: ${lastError}`;
			color = "error";
		} else {
			text = "余额: 更新中...";
			color = "dim";
		}
		return {
			text,
			color,
			deductionText: deduction ? `  -${formatBalance(deduction.amountCents / 100)}` : undefined,
		};
	}

	function renderStatus(): void {
		if (active) requestFooterRender();
	}

	function installFooter(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		ctx.ui.setStatus(STATUS_ID, undefined);
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestFooterRender = () => {
				if (active) tui.requestRender();
			};
			const unsubscribe = footerData.onBranchChange(requestFooterRender);
			return {
				dispose: () => {
					unsubscribe();
					requestFooterRender = () => {};
				},
				invalidate() {},
				render(width: number): string[] {
					let input = 0;
					let output = 0;
					let cacheRead = 0;
					let cacheWrite = 0;
					let cost = 0;
					let latestCacheHitRate: number | undefined;
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type !== "message" || entry.message.role !== "assistant") continue;
						const usage = (entry.message as AssistantMessage).usage;
						input += usage.input;
						output += usage.output;
						cacheRead += usage.cacheRead;
						cacheWrite += usage.cacheWrite;
						cost += usage.cost.total;
						const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
						latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
					}

					let pwd = formatFooterCwd(ctx.sessionManager.getCwd());
					const branch = footerData.getGitBranch();
					if (branch) pwd += ` (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd += ` • ${sessionName}`;

					const parts: string[] = [];
					if (input) parts.push(`↑${formatTokens(input)}`);
					if (output) parts.push(`↓${formatTokens(output)}`);
					if (cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
					if (cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);
					if ((cacheRead || cacheWrite) && latestCacheHitRate !== undefined) parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
					if (cost) parts.push(`$${cost.toFixed(3)}`);

					const context = ctx.getContextUsage();
					const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextValue = context?.percent ?? 0;
					const contextDisplay = context?.percent === null
						? `?/${formatTokens(contextWindow)} (auto)`
						: `${contextValue.toFixed(1)}%/${formatTokens(contextWindow)} (auto)`;
					parts.push(
						contextValue > 90
							? theme.fg("error", contextDisplay)
							: contextValue > 70
								? theme.fg("warning", contextDisplay)
								: contextDisplay,
					);
					const status = balanceStatus();
					parts.push(theme.fg(status.color, status.text));
					if (status.deductionText) parts.push(theme.fg("error", status.deductionText.trimStart()));
					let left = parts.join(" ");
					if (visibleWidth(left) > width) left = truncateToWidth(left, width, "...");

					const modelName = ctx.model?.id || "no-model";
					const right = ctx.model?.reasoning
						? `${modelName} • ${ctx.thinkingLevel === "off" ? "thinking off" : ctx.thinkingLevel || "off"}`
						: modelName;
					const available = width - visibleWidth(left) - 2;
					const visibleRight = available > 0 ? truncateToWidth(right, available, "") : "";
					const padding = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(visibleRight)));
					const lines = [
						truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
						theme.fg("dim", left) + theme.fg("dim", padding + visibleRight),
					];

					const otherStatuses = Array.from(footerData.getExtensionStatuses().entries())
						.filter(([key]) => key !== STATUS_ID)
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => sanitizeStatus(text));
					if (otherStatuses.length) lines.push(truncateToWidth(otherStatuses.join(" "), width, theme.fg("dim", "...")));
					return lines;
				},
			};
		});
	}

	function clearTimer(): void {
		if (timer) clearTimeout(timer);
		timer = undefined;
	}

	function clearDeduction(): void {
		if (deductionAnimationTimer) clearInterval(deductionAnimationTimer);
		if (deductionClearTimer) clearTimeout(deductionClearTimer);
		deductionAnimationTimer = undefined;
		deductionClearTimer = undefined;
		deduction = undefined;
	}

	function startDeduction(previousBalance: number, nextBalance: number): void {
		clearDeduction();
		const fromCents = Math.round(previousBalance * 100);
		const toCents = Math.round(nextBalance * 100);
		if (toCents >= fromCents) return;
		deduction = {
			fromCents,
			toCents,
			amountCents: fromCents - toCents,
			startedAt: Date.now(),
		};
		deductionAnimationTimer = setInterval(() => {
			if (!active || !deduction) return;
			renderStatus();
			if (Date.now() - deduction.startedAt >= DEDUCTION_ANIMATION_MS) {
				clearInterval(deductionAnimationTimer);
				deductionAnimationTimer = undefined;
			}
		}, DEDUCTION_FRAME_MS);
		deductionClearTimer = setTimeout(() => {
			clearDeduction();
			renderStatus();
		}, DEDUCTION_DISPLAY_MS);
	}

	function applyBalance(nextBalance: number): boolean {
		const previousBalance = balance;
		balance = nextBalance;
		if (previousBalance === undefined) return false;
		const previousCents = Math.round(previousBalance * 100);
		const nextCents = Math.round(nextBalance * 100);
		if (nextCents < previousCents) {
			startDeduction(previousBalance, nextBalance);
			return true;
		}
		if (nextCents > previousCents) clearDeduction();
		return false;
	}

	function clearFollowUps(): void {
		for (const followUpTimer of followUpTimers) clearTimeout(followUpTimer);
		followUpTimers = [];
	}

	function scheduleRefresh(): void {
		clearTimer();
		if (!active || !config) return;
		const currentGeneration = generation;
		timer = setTimeout(() => {
			if (!active || currentGeneration !== generation) return;
			void requestRefresh();
		}, DEFAULT_REFRESH_INTERVAL_MS);
	}

	async function performRefresh(currentGeneration: number, signal: AbortSignal): Promise<boolean> {
		if (!config || !active) {
			renderStatus();
			return false;
		}
		const currentConfig = config;
		lastError = undefined;
		renderStatus();
		try {
			const refreshed = await client.refresh(currentConfig, signal);
			if (!active || currentGeneration !== generation || signal.aborted) return false;
			await saveConfig(configPath, refreshed.config);
			if (!active || currentGeneration !== generation || signal.aborted) return false;
			config = refreshed.config;
			const decreased = applyBalance(refreshed.result.balance);
			lastUpdated = new Date();
			lastError = undefined;
			return decreased;
		} catch (error) {
			if (!active || currentGeneration !== generation || signal.aborted) return false;
			lastError = errorMessage(error);
			return false;
		} finally {
			if (active && currentGeneration === generation && !signal.aborted) renderStatus();
		}
	}

	async function requestRefresh(): Promise<boolean> {
		clearTimer();
		if (!active) return false;
		if (!refreshInFlight) {
			const currentGeneration = generation;
			refreshController = new AbortController();
			refreshInFlight = performRefresh(currentGeneration, refreshController.signal).finally(() => {
				refreshInFlight = undefined;
				refreshController = undefined;
			});
		}
		const decreased = await refreshInFlight;
		if (active && config) scheduleRefresh();
		return decreased;
	}

	async function startSettledRefreshes(): Promise<void> {
		clearFollowUps();
		if (!config || !active) return;
		const currentGeneration = generation;
		followUpTimers = FOLLOW_UP_DELAYS_MS.map((delay) =>
			setTimeout(() => {
				if (!active || currentGeneration !== generation) return;
				void requestRefresh().then((decreased) => {
					if (decreased) clearFollowUps();
				});
			}, delay),
		);
		if (await requestRefresh()) clearFollowUps();
	}

	pi.on("session_start", async (_event, ctx) => {
		active = true;
		installFooter(ctx);
		try {
			config = await loadConfig(configPath);
			if (!config) {
				config = await loadConfig(legacyConfigPath);
				if (config) await saveConfig(configPath, config);
			}
			lastError = undefined;
		} catch (error) {
			lastError = `配置读取失败: ${errorMessage(error)}`;
		}
		renderStatus();
		if (config) await requestRefresh();
	});

	pi.on("before_agent_start", async () => {
		clearFollowUps();
	});

	pi.on("agent_settled", async () => {
		await startSettledRefreshes();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		active = false;
		generation++;
		clearTimer();
		clearFollowUps();
		clearDeduction();
		refreshController?.abort();
		requestFooterRender = () => {};
		ctx.ui.setStatus(STATUS_ID, undefined);
		if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
	});

	pi.registerCommand("newapi-login", {
		description: "登录 New API 站点并开始显示余额",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("当前模式不支持交互登录", "error");
				return;
			}
			const currentBaseUrl = config?.baseUrl;
			const baseUrlInput = await ctx.ui.input(
				"New API 登录",
				currentBaseUrl ? `Base URL（留空沿用 ${currentBaseUrl}）` : "Base URL（例如 https://newapi.example.com）",
			);
			if (baseUrlInput === undefined) return;
			if (!baseUrlInput.trim() && !currentBaseUrl) {
				ctx.ui.notify("请输入 New API 站点的 Base URL", "warning");
				return;
			}
			let baseUrl: string;
			try {
				baseUrl = normalizeBaseUrl(baseUrlInput.trim() || currentBaseUrl!);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}
			const username = await ctx.ui.input("New API 登录", "账号");
			if (!username?.trim()) return;
			const password = await promptPassword(ctx);
			if (password === undefined || password === "") return;
			const candidate: NewApiConfig = { baseUrl, username: username.trim(), password };
			try {
				generation++;
				clearTimer();
				clearFollowUps();
				clearDeduction();
				refreshController?.abort();
				await refreshInFlight;
				const loggedIn = await client.login(candidate);
				await saveConfig(configPath, loggedIn);
				config = loggedIn;
				balance = undefined;
				lastUpdated = undefined;
				lastError = undefined;
				await requestRefresh();
				ctx.ui.notify("登录成功，余额已更新", "info");
			} catch (error) {
				lastError = errorMessage(error);
				renderStatus();
				if (config) scheduleRefresh();
				ctx.ui.notify(`登录失败: ${lastError}`, "error");
			}
		},
	});

	pi.registerCommand("newapi-refresh", {
		description: "立即刷新 New API 余额",
		handler: async (_args, ctx) => {
			if (!config) {
				ctx.ui.notify("尚未登录，请先运行 /newapi-login", "warning");
				return;
			}
			clearFollowUps();
			await requestRefresh();
			ctx.ui.notify(lastError ? `刷新失败: ${lastError}` : `当前余额 ${formatBalance(balance!)}`, lastError ? "error" : "info");
		},
	});

	pi.registerCommand("newapi-logout", {
		description: "退出 New API 并清除本地凭据",
		handler: async (_args, ctx) => {
			generation++;
			clearTimer();
			clearFollowUps();
			clearDeduction();
			refreshController?.abort();
			await refreshInFlight;
			await removeConfig(configPath);
			await removeConfig(legacyConfigPath);
			config = undefined;
			balance = undefined;
			lastUpdated = undefined;
			lastError = undefined;
			renderStatus();
			ctx.ui.notify("已退出并清除本地凭据", "info");
		},
	});

	pi.registerCommand("newapi-status", {
		description: "查看 New API 余额与刷新状态",
		handler: async (_args, ctx) => {
			const lines = [
				`站点: ${config?.baseUrl ?? "未配置"}`,
				`状态: ${config ? (lastError ? "更新失败" : "已登录") : "未登录"}`,
				`余额: ${balance === undefined ? "未知" : formatBalance(balance)}`,
				`最近更新: ${formatTime(lastUpdated)}`,
			];
			if (lastError) lines.push(`错误: ${lastError}`);
			ctx.ui.notify(lines.join("\n"), lastError ? "warning" : "info");
		},
	});
}
