# Pi New API Balance

Live [New API](https://github.com/Calcium-Ion/new-api) account balance in the [Pi](https://github.com/badlogic/pi-mono) terminal footer, with a roll-down animation the moment a settlement deduction is detected. Works with any New API site.

[中文](README.md)

> Screenshots below come from an isolated local mock service; balances, account states and timestamps are synthetic demo data and do not correspond to any real account.

![Pi New API Balance status](assets/pi-newapi-balance.png)

When a deduction is detected, the balance rolls down and shows the red delta:

![Pi New API Balance deduction animation](assets/deduction-animation.png)

## Features

- Configure the Base URL of any New API site
- Shows the current balance in the Pi footer without taking up extra panels
- Auto-refresh on Pi startup and every 5 minutes
- Instant refresh after each agent turn fully settles, with settlement re-checks at 1s, 3s and 6s for async settlement
- Remaining re-checks are cancelled as soon as a balance drop is detected
- Balance rolls to the new value in ~800ms and shows the red deduction delta for 3 seconds
- Safe cleanup of background tasks on session switch, `/reload`, new conversation, manual refresh and exit
- Automatic re-login for expired sessions
- Config migration from the legacy cat-laoban balance extension

## Install

Requires a Pi version with Pi Package support. Recommended install from npm:

```bash
pi install npm:pi-newapi-balance
```

Or install the development repo directly from GitHub:

```bash
pi install git:github.com/zxbdzh/pi-newapi-balance
```

Restart Pi, or run in an open session:

```text
/reload
```

Update / uninstall the npm-installed extension:

```bash
pi update npm:pi-newapi-balance
pi remove npm:pi-newapi-balance
```

For GitHub installs, replace the source with `git:github.com/zxbdzh/pi-newapi-balance`.

## Usage

First run:

```text
/newapi-login
```

Follow the three on-screen prompts: site URL, username, password (masked). The Base URL can be the site root or a common OpenAI API address — trailing `/v1` and slashes are stripped before calling the New API user endpoint.

| Command | Purpose |
| --- | --- |
| `/newapi-login` | Log in or switch New API site |
| `/newapi-refresh` | Refresh balance immediately |
| `/newapi-status` | Show site, balance, last update time and error state |
| `/newapi-logout` | Log out and clear local credentials |

## License

[MIT](./LICENSE)
