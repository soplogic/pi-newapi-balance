# Pi New API Balance

在 [Pi](https://github.com/badlogic/pi-mono) 的终端底部持续显示 New API 账户余额，并在检测到结算扣款时播放余额滚动动画。

![Pi New API Balance 状态](assets/pi-newapi-balance.png)

检测到扣款时，余额会滚动下降，并显示红色差额：

![Pi New API Balance 扣款动画](assets/deduction-animation.png)

## 功能

- 支持用户配置任意 New API 站点的 Base URL
- 在 Pi 页脚显示当前余额，不占用额外面板
- Pi 启动时及每隔 5 分钟自动刷新
- 每轮 Agent 完全结束后立即刷新，并在 1 秒、3 秒和 6 秒时补查异步结算
- 检测到余额下降后立即取消剩余补查
- 余额在约 800 毫秒内滚动至新值，并以红色显示扣款差额 3 秒
- Session 切换、`/reload`、新对话、手动刷新和退出时安全清理后台任务
- 自动重新登录失效的 Session
- 兼容旧版猫佬余额扩展配置迁移

## 安装

要求已安装支持 Pi Package 的新版 Pi：

```bash
pi install git:github.com/zxbdzh/pi-newapi-balance
```

重启 Pi，或者在已打开的 Pi 中运行：

```text
/reload
```

更新插件：

```bash
pi update --extensions
```

卸载插件：

```bash
pi remove git:github.com/zxbdzh/pi-newapi-balance
```

## 使用

首次运行：

```text
/newapi-login
```

按提示依次输入 Base URL、账号和密码。Base URL 可以是站点根地址，也可以是常见的 OpenAI API 地址：

```text
https://newapi.example.com
https://newapi.example.com/v1
```

插件会去除末尾的 `/v1` 和斜杠，再调用 New API 用户接口。

| 命令 | 作用 |
| --- | --- |
| `/newapi-login` | 登录或切换 New API 站点 |
| `/newapi-refresh` | 立即刷新余额 |
| `/newapi-status` | 查看站点、余额、更新时间及错误状态 |
| `/newapi-logout` | 退出并清除本地凭据 |

## 刷新与扣款动画

插件监听 Pi 的 `agent_settled` 事件。每轮 Agent 不会再自动重试、压缩或继续运行后，按以下时间点查询余额：

```text
agent_settled  ── 立即 ── 1s ── 3s ── 6s
                              └─ 检测到扣款后停止剩余补查
```

当余额从 `¥155.86` 降至 `¥153.86` 时，页脚余额会在约 800 毫秒内滚动下降，并显示红色 `-¥2.00`。首次加载、余额增加或刷新失败不会触发动画。

## 兼容性

插件使用标准 New API 管理端接口：

- `POST /api/user/login?turnstile=`
- `GET /api/user/self`

站点需要允许账号密码登录，并在登录响应中返回 `session` Cookie。强制 Turnstile、SSO、二次验证或修改过用户接口的站点可能无法直接使用。OpenAI `/v1` 接口兼容本身不代表管理端接口一定兼容。

余额按 New API 默认规则 `quota / 500000` 显示为 `¥`。这里只改变显示单位，不进行汇率换算。

## 配置与安全

配置默认保存在：

```text
~/.pi/agent/newapi-balance.json
```

设置 `PI_CODING_AGENT_DIR` 时，配置写入该目录。插件会尝试将文件权限限制为仅当前用户可读写，但账号、密码和 Session 仍以明文保存；请只在可信设备上使用，不要提交该配置文件。

旧版 `~/.pi/agent/maolao-balance.json` 会在首次加载时迁移到新配置文件，原站点地址仅用于迁移旧配置。`/newapi-logout` 会同时删除新旧配置。

## 本地开发

```bash
npm test
npm run check
pi -e ./index.ts
```

扩展使用 Pi 内置依赖，不需要运行 `npm install` 即可执行测试和语法检查。

## License

[MIT](LICENSE)
