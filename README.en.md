<div align="center">

# Pi New API Balance

[中文](README.md)

**Live New API subscription usage in the Pi terminal footer, with a roll-up animation the moment a settlement deduction is detected.**

<sub>// Works with any New API site · No extra panel · Never interrupts the agent</sub>

<br />

![Pi](https://img.shields.io/badge/Pi-extension-00f5ff)
![npm](https://img.shields.io/badge/npm-pi--newapi--balance-cb3837?logo=npm&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)
![Tests](https://img.shields.io/badge/tests-node--test-f2a1c1)

</div>

---

> Screenshots below come from an isolated local mock service; subscription usage, account states and timestamps are synthetic demo data and do not correspond to any real account.

## Screenshots

<table>
  <tr>
    <td width="50%" align="center">
      <img src="assets/pi-newapi-balance.png" alt="Footer subscription status" />
      <sub><b>Footer status</b> — subscription usage lives in the footer, no extra panels</sub>
    </td>
    <td width="50%" align="center">
      <img src="assets/deduction-animation.png" alt="Deduction animation" />
      <sub><b>Deduction animation</b> — used amount rolls up, red delta shown for 3s</sub>
    </td>
  </tr>
</table>

## Features

- ⚙️ **Any site** — configure the Base URL of any New API site (trailing `/v1` stripped automatically)
- 👀 **Footer display** — the subscription usage (`sub ¥used/¥total`) and 24h usage live in the Pi footer, no extra panels
- 🔄 **Smart refresh** — on startup + every 5 minutes; instant refresh after each agent turn fully settles, with settlement re-checks at 1/3/6s for async settlement
- 🎬 **Deduction animation** — remaining re-checks cancelled on used-amount increase; rolls to the new value in ~800ms, red delta shown for 3s
- 🧹 **Safe cleanup** — background tasks cleaned up on session switch, `/reload`, new conversation, manual refresh and exit
- 🔑 **Token auth** — stateless authentication via user ID + system access token, no username or password

## Install

Requires a Pi version with Pi Package support. Recommended install from npm:

```bash
pi install npm:pi-newapi-balance
```

Or install the development repo directly from GitHub:

```bash
pi install git:github.com/zxbdzh/pi-newapi-balance
```

Restart Pi, or run `/reload` in an open session.

| Update | Uninstall |
| --- | --- |
| `pi update npm:pi-newapi-balance` | `pi remove npm:pi-newapi-balance` |

## Usage

First run:

```text
/newapi-login
```

Follow the three on-screen prompts: site URL, user ID, and system access token (masked).

| Command | Purpose |
| --- | --- |
| `/newapi-login` | Log in or switch New API site |
| `/newapi-refresh` | Refresh subscription usage immediately |
| `/newapi-status` | Show site, subscription usage, 24h usage, last update time and error state |
| `/newapi-logout` | Log out and clear local credentials |

## How refresh works

The extension listens to Pi's `agent_settled` event: it only refreshes when the agent turn will no longer auto-retry, compress context or produce follow-up actions — avoiding mid-turn readings.

## Development

```bash
npm test     # node --test unit tests
npm run check
```

## License

[MIT](./LICENSE)
