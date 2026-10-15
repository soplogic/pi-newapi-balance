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
	quotaToBalance,
	removeConfig,
	removeConfigTemporary,
	saveConfig,
	shouldRestorePeriodicRefresh,
} from "./core.ts";
import { LifecycleOperationOwner } from "./lifecycle-operation-owner.ts";
import { RefreshCoordinator } from "./refresh-coordinator.ts";

const STATUS_ID = "newapi-balance";
const FOLLOW_UP_DELAYS_MS = [1_000, 3_000, 6_000] as const;
const DEDUCTION_ANIMATION_MS = 800;
const DEDUCTION_DISPLAY_MS = 3_000;
const DEDUCTION_FRAME_MS = 50;
const LOGIN_PROMPT_TITLES = {
	baseUrl: "New API 登录（1/3）：网站地址",
	userId: "New API 登录（2/3）：用户 ID",
	accessToken: "New API 登录（3/3）：系统访问令牌",
} as const;
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const configPath = join(agentDir, "newapi-balance.json");

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function fileErrorCode(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : "";
}

function configReadError(error: unknown): string {
	return `配置读取失败${fileErrorCode(error)}`;
}

function configWriteError(error: unknown): string {
	return `配置保存失败${fileErrorCode(error)}`;
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

async function promptSecret(ctx: ExtensionContext): Promise<string | undefined> {
	if (ctx.mode !== "tui") return undefined;
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const input = new Input();
		input.focused = true;
		input.onSubmit = (value) => done(value);
		input.onEscape = () => done(undefined);
		return {
			render: (width) => {
				const label = theme.fg("accent", `${LOGIN_PROMPT_TITLES.accessToken}  `);
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
	let balanceYuan: number | undefined;
	let recentUsageYuan: number | undefined;
	let lastSuccessfulRefreshAt: Date | undefined;
	let lastError: string | undefined;
	let periodicRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	let deductionAnimationTimer: ReturnType<typeof setInterval> | undefined;
	let deductionClearTimer: ReturnType<typeof setTimeout> | undefined;
	let deduction: { fromCents: number; toCents: number; amountCents: number; startedAt: number } | undefined;
	let followUpTimers: Array<ReturnType<typeof setTimeout>> = [];
	let sessionActive = false;
	let requestFooterRender: () => void = () => {};
	const accountOperations = new LifecycleOperationOwner();
	let refreshCoordinator: RefreshCoordinator;

	function displayedBalance(): number | undefined {
		if (!deduction) return balanceYuan;
		const progress = Math.min(1, (Date.now() - deduction.startedAt) / DEDUCTION_ANIMATION_MS);
		const cents = Math.round(deduction.fromCents + (deduction.toCents - deduction.fromCents) * progress);
		return cents / 100;
	}

	function balanceStatus(): {
		text: string;
		color: "success" | "warning" | "error" | "dim";
		deductionText?: string;
		usageText?: string;
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
			usageText: config && recentUsageYuan !== undefined ? `24h 已用 ${formatBalance(recentUsageYuan)}` : undefined,
		};
	}

	function renderStatus(): void {
		if (sessionActive) requestFooterRender();
	}

	function installFooter(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		ctx.ui.setStatus(STATUS_ID, undefined);
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestFooterRender = () => {
				if (sessionActive) tui.requestRender();
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
					if (status.usageText) parts.push(theme.fg("dim", status.usageText));
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

	function clearPeriodicRefresh(): void {
		if (periodicRefreshTimer) clearTimeout(periodicRefreshTimer);
		periodicRefreshTimer = undefined;
	}

	function clearDeduction(): void {
		if (deductionAnimationTimer) clearInterval(deductionAnimationTimer);
		if (deductionClearTimer) clearTimeout(deductionClearTimer);
		deductionAnimationTimer = undefined;
		deductionClearTimer = undefined;
		deduction = undefined;
	}

	function clearAccountState(error?: string): void {
		config = undefined;
		balanceYuan = undefined;
		recentUsageYuan = undefined;
		lastSuccessfulRefreshAt = undefined;
		lastError = error;
		clearDeduction();
	}

	function startDeduction(previousBalanceYuan: number, nextBalanceYuan: number): void {
		clearDeduction();
		const fromCents = Math.round(previousBalanceYuan * 100);
		const toCents = Math.round(nextBalanceYuan * 100);
		if (toCents >= fromCents) return;
		deduction = {
			fromCents,
			toCents,
			amountCents: fromCents - toCents,
			startedAt: Date.now(),
		};
		deductionAnimationTimer = setInterval(() => {
			if (!sessionActive || !deduction) return;
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

	function applyBalance(nextBalanceYuan: number): boolean {
		const previousBalanceYuan = balanceYuan;
		balanceYuan = nextBalanceYuan;
		if (previousBalanceYuan === undefined) return false;
		const previousCents = Math.round(previousBalanceYuan * 100);
		const nextCents = Math.round(nextBalanceYuan * 100);
		if (nextCents < previousCents) {
			startDeduction(previousBalanceYuan, nextBalanceYuan);
			return true;
		}
		if (nextCents > previousCents) clearDeduction();
		return false;
	}

	function clearFollowUpTimers(): void {
		for (const followUpTimer of followUpTimers) clearTimeout(followUpTimer);
		followUpTimers = [];
	}

	function cancelSettledFollowUps(): void {
		clearFollowUpTimers();
		refreshCoordinator.cancelTrailing();
	}

	function schedulePeriodicRefresh(): void {
		clearPeriodicRefresh();
		if (!sessionActive || !config) return;
		const scheduledGeneration = refreshCoordinator.currentGeneration();
		periodicRefreshTimer = setTimeout(() => {
			if (!refreshCoordinator.isCurrent(scheduledGeneration)) return;
			void requestRefresh();
		}, DEFAULT_REFRESH_INTERVAL_MS);
	}

	async function performRefresh(refreshGeneration: number, signal: AbortSignal): Promise<boolean> {
		if (!config || !refreshCoordinator.isCurrent(refreshGeneration)) {
			renderStatus();
			return false;
		}
		const currentConfig = config;
		lastError = undefined;
		renderStatus();
		try {
			const refreshed = await client.refresh(currentConfig, signal);
			if (!refreshCoordinator.isCurrent(refreshGeneration) || signal.aborted) return false;
			config = refreshed.config;
			const decreased = applyBalance(refreshed.result.balance);
			recentUsageYuan = refreshed.usage ? quotaToBalance(refreshed.usage.quota) : undefined;
			lastSuccessfulRefreshAt = new Date();
			lastError = undefined;
			return decreased;
		} catch (error) {
			if (!refreshCoordinator.isCurrent(refreshGeneration) || signal.aborted) return false;
			lastError = errorMessage(error);
			return false;
		} finally {
			if (refreshCoordinator.isCurrent(refreshGeneration) && !signal.aborted) renderStatus();
		}
	}

	refreshCoordinator = new RefreshCoordinator(performRefresh, clearFollowUpTimers);

	async function requestRefresh(queueTrailingIfBusy = false): Promise<void> {
		clearPeriodicRefresh();
		const requestedGeneration = refreshCoordinator.currentGeneration();
		await refreshCoordinator.request(queueTrailingIfBusy);
		if (sessionActive && config && refreshCoordinator.isCurrent(requestedGeneration)) schedulePeriodicRefresh();
	}

	async function stopAsyncWork(): Promise<void> {
		clearPeriodicRefresh();
		cancelSettledFollowUps();
		clearDeduction();
		await Promise.all([accountOperations.deactivate(), refreshCoordinator.deactivate()]);
		clearPeriodicRefresh();
	}

	async function restartRefreshLifecycle(): Promise<number> {
		clearPeriodicRefresh();
		cancelSettledFollowUps();
		const generation = await refreshCoordinator.restart();
		clearPeriodicRefresh();
		return generation;
	}

	async function cleanTemporaryCredentials(): Promise<boolean> {
		const results = await Promise.allSettled([
			removeConfigTemporary(configPath),
		]);
		return results.every((result) => result.status === "fulfilled");
	}

	async function startSettledRefreshes(): Promise<void> {
		cancelSettledFollowUps();
		if (!config || !sessionActive) return;
		const settledGeneration = refreshCoordinator.currentGeneration();
		followUpTimers = FOLLOW_UP_DELAYS_MS.map((delay) =>
			setTimeout(() => {
				if (!refreshCoordinator.isCurrent(settledGeneration)) return;
				void requestRefresh(true);
			}, delay),
		);
		await requestRefresh();
	}

	pi.on("session_start", async (_event, ctx) => {
		sessionActive = true;
		clearAccountState();
		installFooter(ctx);
		await stopAsyncWork();
		if (!sessionActive) return;
		const accountGeneration = await accountOperations.activate();
		await refreshCoordinator.activate();
		if (!sessionActive || !accountOperations.isCurrent(accountGeneration)) return;
		type LoadedAccount = { config: NewApiConfig | undefined };
		try {
			const loadedAccount = await accountOperations.run<LoadedAccount>(accountGeneration, async (signal) => {
				if (!(await cleanTemporaryCredentials())) return { config: undefined };
				if (signal.aborted || !accountOperations.isCurrent(accountGeneration)) return { config: undefined };
				const candidate = await loadConfig(configPath);
				if (signal.aborted || !accountOperations.isCurrent(accountGeneration)) return { config: undefined };
				return { config: candidate };
			});
			if (!accountOperations.isCurrent(accountGeneration) || !loadedAccount) return;
			config = loadedAccount.config;
			lastError = undefined;
		} catch (error) {
			if (!accountOperations.isCurrent(accountGeneration)) return;
			clearAccountState(configReadError(error));
		}
		renderStatus();
		if (config && accountOperations.isCurrent(accountGeneration)) await requestRefresh();
	});

	pi.on("before_agent_start", async () => {
		const refreshGeneration = await restartRefreshLifecycle();
		if (shouldRestorePeriodicRefresh(config, sessionActive, refreshCoordinator.isCurrent(refreshGeneration))) {
			schedulePeriodicRefresh();
		}
	});

	pi.on("agent_settled", async () => {
		await startSettledRefreshes();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		sessionActive = false;
		requestFooterRender = () => {};
		ctx.ui.setStatus(STATUS_ID, undefined);
		if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
		clearAccountState();
		await stopAsyncWork();
		await cleanTemporaryCredentials();
	});

	pi.registerCommand("newapi-login", {
		description: "登录 New API 站点并开始显示余额",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("当前模式不支持交互登录", "error");
				return;
			}
			type LoginTransactionResult = { config: NewApiConfig } | { saveError: unknown };
			const commandGeneration = await accountOperations.activate();
			if (!sessionActive || !accountOperations.isCurrent(commandGeneration)) return;
			const currentBaseUrl = config?.baseUrl;
			const baseUrlInput = await ctx.ui.input(
				LOGIN_PROMPT_TITLES.baseUrl,
				currentBaseUrl ? `留空沿用 ${currentBaseUrl}` : "例如 https://newapi.example.com",
			);
			if (!accountOperations.isCurrent(commandGeneration) || baseUrlInput === undefined) return;
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
			const userIdInput = await ctx.ui.input(LOGIN_PROMPT_TITLES.userId);
			if (!accountOperations.isCurrent(commandGeneration) || !userIdInput?.trim()) return;
			const accessToken = await promptSecret(ctx);
			if (!accountOperations.isCurrent(commandGeneration) || accessToken === undefined || accessToken === "") return;
			const candidate: NewApiConfig = { baseUrl, userId: userIdInput.trim(), accessToken };
			clearPeriodicRefresh();
			cancelSettledFollowUps();
			clearDeduction();
			await refreshCoordinator.deactivate();
			clearPeriodicRefresh();
			if (!sessionActive || !accountOperations.isCurrent(commandGeneration)) return;
			const accountGeneration = commandGeneration;
			await refreshCoordinator.activate();
			if (!sessionActive || !accountOperations.isCurrent(accountGeneration)) return;
			try {
				const loginResult = await accountOperations.run<LoginTransactionResult>(accountGeneration, async (signal) => {
					await client.getBalance(candidate, signal);
					if (signal.aborted || !accountOperations.isCurrent(accountGeneration)) return { config: candidate };
					try {
						await saveConfig(configPath, candidate);
					} catch (saveError) {
						return { saveError };
					}
					return { config: candidate };
				});
				if (!loginResult || !sessionActive || !accountOperations.isCurrent(accountGeneration)) return;
				if ("saveError" in loginResult) {
					const message = configWriteError(loginResult.saveError);
					lastError = message;
					renderStatus();
					if (shouldRestorePeriodicRefresh(config, sessionActive, accountOperations.isCurrent(accountGeneration))) {
						schedulePeriodicRefresh();
					}
					ctx.ui.notify(`登录失败: ${message}`, "error");
					return;
				}
				config = loginResult.config;
				balanceYuan = undefined;
				recentUsageYuan = undefined;
				lastSuccessfulRefreshAt = undefined;
				lastError = undefined;
				await requestRefresh();
				if (!accountOperations.isCurrent(accountGeneration)) return;
				if (lastError || balanceYuan === undefined) {
					ctx.ui.notify(`登录成功，但余额刷新失败${lastError ? `: ${lastError}` : ""}`, "warning");
				} else {
					ctx.ui.notify("登录成功，余额已更新", "info");
				}
			} catch (error) {
				if (!accountOperations.isCurrent(accountGeneration)) return;
				const message = errorMessage(error);
				lastError = message;
				renderStatus();
				if (config) schedulePeriodicRefresh();
				ctx.ui.notify(`登录失败: ${message}`, "error");
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
			const manualRefreshGeneration = await restartRefreshLifecycle();
			if (!refreshCoordinator.isCurrent(manualRefreshGeneration) || !config) {
				if (sessionActive) ctx.ui.notify("刷新已取消：当前未登录", "warning");
				return;
			}
			await requestRefresh();
			if (!refreshCoordinator.isCurrent(manualRefreshGeneration)) return;
			ctx.ui.notify(
				lastError || balanceYuan === undefined
					? `刷新失败: ${lastError ?? "未返回有效余额"}`
					: `当前余额 ${formatBalance(balanceYuan)}`,
				lastError || balanceYuan === undefined ? "error" : "info",
			);
		},
	});

	pi.registerCommand("newapi-logout", {
		description: "退出 New API 并清除本地凭据",
		handler: async (_args, ctx) => {
			await stopAsyncWork();
			clearAccountState();
			renderStatus();
			if (!sessionActive) return;
			const cleanupGeneration = await accountOperations.activate();
			const cleanupResult = await accountOperations.run(cleanupGeneration, async () => {
				const results = await Promise.allSettled([removeConfig(configPath)]);
				return results.every((result) => result.status === "fulfilled");
			});
			if (!sessionActive || !accountOperations.isCurrent(cleanupGeneration) || cleanupResult === undefined) return;
			await refreshCoordinator.activate();
			if (!accountOperations.isCurrent(cleanupGeneration)) return;
			if (!cleanupResult) {
				ctx.ui.notify("已退出，但部分本地凭据删除失败", "warning");
			} else {
				ctx.ui.notify("已退出并清除本地凭据", "info");
			}
		},
	});

	pi.registerCommand("newapi-status", {
		description: "查看 New API 余额与刷新状态",
		handler: async (_args, ctx) => {
			const lines = [
				`站点: ${config?.baseUrl ?? "未配置"}`,
				`状态: ${config ? (lastError ? "更新失败" : "已登录") : "未登录"}`,
				`余额: ${balanceYuan === undefined ? "未知" : formatBalance(balanceYuan)}`,
				`24h 已用: ${recentUsageYuan === undefined ? "未知" : formatBalance(recentUsageYuan)}`,
				`最近更新: ${formatTime(lastSuccessfulRefreshAt)}`,
			];
			if (lastError) lines.push(`错误: ${lastError}`);
			ctx.ui.notify(lines.join("\n"), lastError ? "warning" : "info");
		},
	});
}
