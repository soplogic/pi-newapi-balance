# `pi-newapi-balance` 项目发布 Skill 设计

## 背景

项目同时存在三类可能被 Pi 加载的扩展副本：开发仓库、本地自动发现扩展目录，以及通过 npm 安装的包。`/reload` 只重新加载 Pi 当前配置中的副本，不会同步开发仓库、拉取 GitHub 或更新 npm 包。此前登录提示修复已存在于开发仓库，但 Pi 实际加载的是旧的 `~/.pi/agent/extensions/maolao-balance`，导致 `/reload` 后仍看不到修复。

项目还需要一套稳定的发布顺序，覆盖 Git 提交、语义化升版、GitHub 推送、npm 2FA 发布、隔离安装、Pi Package 加载及 Gallery 验证。未来在本仓库工作的 AI 应在发布相关请求出现时自动掌握这些项目约束。

## 目标

- 将发布知识保存为受版本控制的项目 Skill。
- 当用户询问发布、升版、npm、Pi 市场、安装、更新或 `/reload` 未生效时，使 AI 能加载正确流程。
- 默认仅提供状态检查、解释和命令指南。
- 明确区分开发仓库、本地扩展和 npm 安装副本。
- 避免 npm OTP、恢复码、Token 或真实 New API 凭据进入对话、日志或仓库。

## Skill 位置与发现

Skill 放在：

```text
.agents/skills/pi-newapi-balance-release/SKILL.md
```

选择 `.agents/skills/` 的原因：

- Pi 会在受信任项目中，从当前目录和祖先目录自动发现该位置。
- 仓库现有 `.gitignore` 忽略整个 `.pi/`，使用 `.agents/` 无需修改该规则。
- 该目录遵循 Agent Skills 结构，也便于其他兼容工具复用。

Skill 名称为 `pi-newapi-balance-release`，描述明确列出发布、升版、npm、Pi Gallery、安装、更新和 reload 排障等触发场景。

## 行为边界

Skill 默认为只读顾问：

- 可以检查 Git、npm、Pi 安装状态、文件内容和公开页面。
- 可以运行不改变发布状态的测试、语法检查、打包 dry-run 和隔离安装验证。
- 可以说明并生成命令。
- 不自动修改版本、源码或 README。
- 不自动暂存、提交、打标签、推送或执行 `npm publish`。
- 用户必须在当前对话中另行明确授权具体写操作；仅仅加载 Skill 或询问流程不构成授权。

敏感身份验证边界：

- npm OTP、2FA 恢复码和 access token 只能由用户在自己的交互终端处理。
- AI 不请求用户把这些秘密发到聊天中，也不把它们放进工具参数、环境输出、脚本、文件或 Git 历史。
- 发布因 `EOTP` 停止时，Skill 只提供用户本机交互命令；用户完成后，AI再执行公开注册表验证。

## 流程结构

### 1. 定位实际加载副本

检查：

- 当前 Git 仓库根目录（使用 `git rev-parse --show-toplevel` 动态解析，不硬编码个人绝对路径）
- `pi list` 和 `~/.pi/agent/settings.json`
- npm 安装目录 `~/.pi/agent/npm/node_modules/pi-newapi-balance`
- 旧本地目录 `~/.pi/agent/extensions/maolao-balance`

必须解释：`/reload` 只重载当前已配置或自动发现的文件；它不会复制开发仓库文件、执行 `pi update`、更新 npm 或切换扩展来源。

### 2. 发布前状态检查

检查：

- 当前分支、工作树、暂存区、HEAD 与 `origin/main`
- `package.json` 当前版本
- `npm view pi-newapi-balance version` 和 `dist-tags`
- 是否存在同版本已发布，从而需要先升版
- 预期变更与无关用户修改是否混杂

### 3. 发布门禁

按顺序给出或在用户另行授权后运行：

```text
npm test
npm run check
git diff --check
npm pack --dry-run --json
```

额外检查：

- 高置信凭据和私钥模式
- npm 包清单中没有配置文件、临时文件、评审产物或本地秘密
- 隔离 `PI_CODING_AGENT_DIR` 下的 Pi Package 加载

测试失败、语法错误、diff 错误、敏感信息命中或包清单异常都属于发布 blocker。

### 4. 版本、提交和推送顺序

建议使用 SemVer：

- `patch`：兼容性修复和小型交互修复
- `minor`：向后兼容的新功能
- `major`：破坏性变更

提交优先使用中文 Conventional Commits：

```text
type(scope): description

- 具体改动
```

推荐顺序：先完成并验证源码修改，再升级版本，提交代码与版本变更，推送 `main` 和版本标签，最后发布 npm。每一步仍需用户明确授权。

### 5. npm 2FA 发布

发布命令从仓库根目录执行，必须使用适合当前 Shell 的路径格式。先在当前仓库中获取根目录：

Bash：

```bash
release_repo="$(git rev-parse --show-toplevel)" || exit 1
cd "$release_repo" || exit 1
unset release_repo
```

PowerShell：

```powershell
$releaseRepo = git rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) { throw "当前目录不在 Git 仓库中" }
Set-Location $releaseRepo
Remove-Variable releaseRepo
```

发布需要当前未被 npm 占用的新版本。若账号启用 `auth-and-writes`，用户在自己的交互终端读取并提交当前 TOTP。AI 不接收验证码。

### 6. 发布后验证

公开注册表验证：

- `npm view pi-newapi-balance@latest`
- `latest` 指向预期版本
- tarball 完整性、文件数、仓库和关键词正确

隔离 Pi 验证：

- 创建独立临时 `PI_CODING_AGENT_DIR`
- 执行 `pi install npm:pi-newapi-balance`
- 用 `pi list` 确认安装来源
- 启动 Pi 加载已安装包，确认无扩展错误
- 必要时检查 `/newapi-login`、`/newapi-refresh`、`/newapi-status`、`/newapi-logout` 注册

市场验证：

- 详情页 `https://pi.dev/packages/pi-newapi-balance`
- 搜索页可能受 npm 搜索索引和 Pi 缓存延迟影响
- 详情页可用而列表搜索暂时无结果时，不应重复发布同一版本

## 常见错误诊断

Skill 包含以下固定诊断：

- Bash 中写 `C:\Users\...`：反斜杠被当作转义，`cd` 失败，后续 npm 命令在错误目录运行。
- `Missing script` 或 `Invalid package`：优先检查当前目录，而不是修改包配置。
- `EACCES` 扫描到无关系统文件：通常是 `cd` 失败导致 npm 在过宽目录打包。
- `E403` 要求 2FA 或 granular token：先确认 npm 账号发布安全设置。
- `EOTP`：使用全新的当前 TOTP，在用户自己的交互终端重试；不把 OTP 发给 AI。
- `/reload` 后仍是旧行为：检查实际加载来源和版本，不假设开发仓库已被载入。
- npm 安装后重复命令：检查并停用旧的本地 `maolao-balance` 扩展副本。
- Pi Gallery 搜索暂时找不到：先检查直接详情页和 npm 精确包读取，区分索引延迟与未发布。

## npm 包边界

项目 Skill 属于维护者开发元数据，应提交到 GitHub，但不随插件运行包安装。实现时在 `package.json` 使用明确的 `files` 发布白名单，仅发布：

```text
index.ts
core.ts
lifecycle-operation-owner.ts
refresh-coordinator.ts
README.md
LICENSE
assets/*.png
```

`package.json` 由 npm 自动包含。`.agents/`、`docs/` 和 `*.test.ts` 均不进入 npm tarball。

白名单变更必须通过 `npm pack --dry-run --json` 验证，不能意外漏掉任何运行时模块、README、LICENSE 或市场截图。

## 验收标准

- Pi 能从仓库根目录发现 `pi-newapi-balance-release`。
- `SKILL.md` frontmatter 的名称合法且描述能准确触发发布和 reload 排障。
- Skill 明确默认只提供指南，不把加载 Skill 视为发布授权。
- Skill 包含实际加载来源诊断、发布门禁、SemVer、Git/npm 顺序、2FA 边界、隔离安装和 Gallery 验证。
- Skill 不包含任何真实凭据、Token、OTP、恢复码或账户秘密。
- `npm pack --dry-run --json` 证明 Skill 和维护文档不会误入 npm 包，运行时必需文件仍完整。
- Skill 通过 Pi 的项目级发现与加载验证。
