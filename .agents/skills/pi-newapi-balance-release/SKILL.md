---
name: pi-newapi-balance-release
description: Guide releases of pi-newapi-balance, including version bumps, Git commits and tags, npm publishing with 2FA, Pi Package installation, Gallery verification, and troubleshooting when /reload, pi update, or npm installs still load an old copy. Use when the user asks about publishing, releasing, npm, Pi packages/market/Gallery, installation, updating, versioning, or stale extension behavior in this repository.
compatibility: Requires Git, Node.js/npm, and Pi. Public npm and Pi Gallery checks require network access.
---

# pi-newapi-balance Release Guide

Use this Skill only in the `pi-newapi-balance` repository. It is a release guide, not standing permission to publish.

## Authority boundary

By default, perform only read-only inspection, tests, syntax checks, `npm pack --dry-run`, isolated temporary installs, and public registry or Gallery checks.

Do not modify versions or files, stage, commit, tag, push, or run `npm publish` unless the user explicitly authorizes that specific action in the current conversation. A request for instructions, diagnosis, status, or loading this Skill is not authorization.

Never request or expose an npm OTP, 2FA recovery code, granular access token, New API access token, or user ID. The user must enter npm authentication secrets in their own interactive terminal. Do not place them in tool arguments, logs, files, scripts, Git history, or chat.

## Resolve the repository first

Do not hardcode a user-specific path. Resolve and validate the repository root:

```bash
release_repo="$(git rev-parse --show-toplevel)" || exit 1
[ "$(node -p "require('$release_repo/package.json').name")" = "pi-newapi-balance" ] || exit 1
```

Use `$release_repo` for commands and unset it when finished. In PowerShell, use `git rev-parse --show-toplevel`, check `$LASTEXITCODE`, and pass the resulting path to `Set-Location`.

Before any release guidance, inspect:

```bash
git -C "$release_repo" status --short
git -C "$release_repo" branch --show-current
git -C "$release_repo" log -3 --oneline --decorate
git -C "$release_repo" remote -v
node -p "require('$release_repo/package.json').version"
npm view pi-newapi-balance version dist-tags --json --registry=https://registry.npmjs.org/
```

Preserve unrelated user changes. Do not assume a dirty worktree contains only release work.

## Identify which extension Pi actually loads

Keep these sources distinct:

1. Development checkout: the current Git repository.
2. Auto-discovered local extension, historically `~/.pi/agent/extensions/maolao-balance`.
3. npm package configured in Pi settings and installed under `~/.pi/agent/npm/node_modules/pi-newapi-balance`.
4. A temporary extension passed with `pi -e`.

Inspect `pi list`, `~/.pi/agent/settings.json`, and the relevant installed `package.json` and `index.ts` before diagnosing stale behavior.

`/reload` only reloads resources Pi already has configured or auto-discovers. It does not copy files from the development checkout, pull GitHub, run `pi update`, install a new npm version, or switch from a legacy local extension to the npm package.

For an immediate development-checkout test without other extensions:

```bash
pi --no-extensions -e "$release_repo"
```

If both the legacy local extension and npm package are enabled, commands can be registered twice. Explain the conflict and ask for explicit permission before removing or disabling either copy.

## Choose the version

Compare the local `package.json` version with npm `latest`. npm versions are immutable; never attempt to republish an existing version.

Use SemVer:

- `patch` for compatible bug fixes and small interaction fixes.
- `minor` for backward-compatible features.
- `major` for breaking changes.

A version change, generated tag, and any package metadata edits are writes and require explicit authorization.

## Release gates

Run these from the repository root before any commit or publish:

```bash
npm test
npm run check
git diff --check
npm pack --dry-run --json
```

Also verify:

- The current and staged diffs contain only intended changes.
- Nothing unexpected is staged.
- High-confidence API-token and private-key patterns do not occur in the current tree.
- The npm file list contains only `package.json`, runtime TypeScript modules, README, LICENSE, and `assets/*.png`.
- `.agents/`, `docs/`, `*.test.ts`, configuration files, `.tmp` files, review artifacts, and local credentials are absent from the tarball.
- The package manifest still declares `pi.extensions: ["./index.ts"]` and keyword `pi-package`.
- An isolated Pi process can load the development package.

Treat any failing test, syntax error, diff error, secret hit, unexpected tarball file, missing runtime module, or Pi load error as a release blocker.

## Git commit and tag guidance

Prefer Chinese Conventional Commits:

```text
type(scope): description

- 具体改动
- 验证结果
```

Recommended order after explicit authorization:

1. Finish and validate implementation changes.
2. Set the new package version without publishing.
3. Re-run release gates.
4. Commit the implementation and version metadata.
5. Create an annotated `v<version>` tag.
6. Push `main` and the tag.
7. Publish the exact committed tree to npm.

Before pushing, verify the target remote and branch. After pushing, verify local `HEAD`, `origin/main`, and the tag all resolve to the intended commit.

## npm publishing with 2FA

Run `npm publish` only after explicit authorization and only from the validated repository root. Confirm `npm whoami` and account 2FA state without printing credentials.

For `auth-and-writes`, the user must execute the final OTP-bearing command in their own interactive terminal. Provide shell-specific commands that read the OTP without echoing it. Do not ask the user to paste the OTP into chat.

Bash pattern:

```bash
read -rsp "npm OTP: " OTP
echo
npm publish --access public --registry=https://registry.npmjs.org/ --otp="$OTP"
unset OTP
```

PowerShell pattern:

```powershell
$otp = Read-Host "npm OTP"
npm publish --access public --registry=https://registry.npmjs.org/ --otp="$otp"
Remove-Variable otp
```

If npm returns `EOTP`, use a fresh current TOTP and check automatic device time. If npm returns `E403` requiring 2FA or a granular token, inspect account security settings; do not weaken security or store a token in the repository.

## Post-publish verification

First verify the public registry:

```bash
npm view pi-newapi-balance@latest name version keywords repository dist --json --registry=https://registry.npmjs.org/
```

Ensure `latest` equals the intended version and the published integrity/file count match the release candidate.

Then test a clean installation using a newly created temporary directory as `PI_CODING_AGENT_DIR`:

```bash
PI_CODING_AGENT_DIR="$temporary_pi_dir" pi install npm:pi-newapi-balance
PI_CODING_AGENT_DIR="$temporary_pi_dir" pi list
PI_CODING_AGENT_DIR="$temporary_pi_dir" OPENAI_API_KEY="synthetic-package-validation" \
  pi --offline --list-models gpt-4o-mini
```

Use an explicit, validated temporary path; do not target the real Pi directory. Confirm the installed package version and the four commands:

- `/newapi-login`
- `/newapi-refresh`
- `/newapi-status`
- `/newapi-logout`

Verify the Pi package page:

```text
https://pi.dev/packages/pi-newapi-balance
```

The package-list search can lag because npm search indexing and Pi catalog caching are asynchronous. If the direct detail page and exact npm package read succeed but list search returns no result, report indexing delay and do not republish the same version.

## Common failure diagnosis

- Bash `cd C:\Users\...` fails because backslashes are consumed as escapes. Use `/c/Users/...` or a quoted forward-slash path in Bash; use `C:\Users\...` in PowerShell.
- `Missing script: test`, `Missing script: check`, or `Invalid package` usually means `cd` failed and npm is running in the wrong directory.
- `EACCES` on an unrelated system or Docker socket during packing usually means npm is scanning the wrong, overly broad directory after a failed `cd`.
- `/reload` showing old behavior means Pi reloaded the old configured copy. Inspect the source and version actually listed by Pi.
- Duplicate `/newapi-*` commands mean more than one extension copy is loaded.
- `npm publish` cannot overwrite an existing version; bump and validate a new version.
- A Pi Gallery direct page can appear before package-list search catches up.

## Finish the guidance

Report clearly:

- Which copy Pi currently loads.
- Local, npm `latest`, and intended versions.
- Which gates passed or failed.
- Whether any write or publication still requires explicit authorization.
- Exact user-run command needed at an OTP boundary.
- Post-publish npm, clean Pi install, and Gallery outcomes.

Unset temporary shell variables and remove only temporary verification directories created for the task. Never remove the user's real Pi installation or legacy extension without explicit authorization.
