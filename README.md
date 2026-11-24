# dsh-cookie-prune

修复 DeepSeek Harness 的 **`dsh-auth-*` cookie 撑爆请求头**问题：启动若干次之后页面打不开、返回 HTTP 431、Electron 侧报 `Web authentication failed`。

适用于 **`dsh web`（含 DSHA 安卓客户端）** 和 **DSH Desktop**，因为它们跑的是同一套 `@deepseek-ai/dsh-client-connection` 认证。

## 问题成因

1. `dsh-client-connection` 的会话 cookie 名是 `"dsh-auth-" + base64url(sha256(authority))`，而 HTTP 下 `authority` 是 **`host:port`**。
2. 浏览器/WebView 的 cookie 库**只按 host 隔离，不区分端口**。于是每次启动换一个端口，就多出**一条新的** `dsh-auth-*` cookie，而不是覆盖上一条。
3. cookie 默认活 30 天，且没有任何代码清理它。
4. Node 的 `maxHeaderSize` 默认 16 KiB，单条 cookie 在请求头里约占 228 B → **第 72 次启动**时 `Cookie` 头越界，请求在进入任何路由之前就被拒（431），界面再也打不开。

## 修复方式

两层，都**不碰认证逻辑本身**：

| 层 | 作用 |
|---|---|
| **响应时清理** | 请求里若带着超过 `keep` 条 `dsh-auth-*`，只保留最新的 `keep` 条（当前正在服务的 authority 始终保留），其余回 `Set-Cookie: <name>=; Max-Age=0`，浏览器随即删除。稳态永远是 6 条（≈1.4 KB），不再是 72 条。静态资源请求也会触发清理。 |
| **抬高解析上限** | `http.Server#maxHeaderSize` 是**按连接**读取的，运行时可改。把上限抬到 64 KiB 后，**已经卡死**的实例也能先解析请求、被第 1 层清理掉，从而自愈，而不是永久 431。 |

因为清理是靠标准 `Set-Cookie` 完成的，所以**已存在的历史垃圾 cookie 会被自动清掉**，不需要手动清浏览器的站点数据。

## 安装

### 1. 本地安装（本仓库已打好包）

```sh
# 把 tgz 放进 profile
cp dsh-cookie-prune-0.1.1.tgz /root/.dsh/profiles/web/
cd /root/.dsh/profiles/web
npm install ./dsh-cookie-prune-0.1.1.tgz --no-save
```

然后编辑该 profile 的 `package.json`，把插件加进依赖和 bundle 列表：

```jsonc
{
  "dependencies": { "dsh-cookie-prune": "0.1.0" },
  "dsh": { "profile": { "bundles": [ /* …原有项… */, "dsh-cookie-prune" ] } }
}
```

重启 DSH / DSHA 生效。

### 2. 从 npm（发布后）

```sh
dsh plugin --profile web add dsh-cookie-prune
```

### DSHA 说明

DSHA 启动的实际命令是——

```
dsh web --no-open --host 127.0.0.1 --port <随机端口>
```

也就是说它用的就是 **`web` profile**，只是端口每次随机（正是本 bug 的触发条件）。所以**装进 `profiles/web` 即可同时覆盖 DSH 与 DSHA**。

> 如果你看到 `dsha-recovery-*` 这类 profile 目录，那是 DSHA 的兜底/残留目录，不是常驻目标；插件装 `profiles/web` 就够了。

## 验证

重启后看启动日志，应出现：

```
cookie-prune: keeping at most 6 dsh-auth cookies, header ceiling 65536 bytes
```

再验证行为：反复重启几次，然后在浏览器里看 `127.0.0.1` 的 cookie 数量，应稳定在 6 条左右，不再单调增长。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖（或直接改本包自带的 `cordis.patch.yml`）：

```yaml
- id: cookie-prune
  config:
    keep: 6              # 稳态保留条数；调小更省，调大可保留更多并发实例的会话
    maxHeaderSize: 65536 # 解析上限；已卡死时靠它自愈。浏览器对单域名最多约 180 条 ≈ 41 KB，64 KiB 足够
    enabled: true        # 设为 false 可临时停用
```

### 可选的第二层：限制 cookie 寿命

清理已经能把 cookie 数量压住，这一层只是兜底（比如别的客户端仍在本插件看不到的地方堆积）。`cordis.patch.yml` 末尾有一段注释掉的示例：

```yaml
- id: connection
  config:
    trustedHosts: !!js ctx.webStartup.trustedHosts   # 必须原样重述
    cookieMaxAgeDays: 1
```

注意：patch 会**整体替换**该行的 `config`，所以 `trustedHosts` 必须照抄原来的表达式，否则浏览器信任检查会失效。

## 兼容性

| DSH | 状态 |
|---|---|
| 0.2.1-rc.3 / rc.5 | 适用 |
| 0.2.2-rc.1（当前） | 适用，已针对该版本源码验证 |
| 0.2.2-rc.5 | 适用（`connection` 的 cookie 逻辑与 rc.1 一致） |

运行环境：Node.js ≥ 22（用到 `Buffer` 的 `base64url` 解码）。

## 卸载

从 `dsh.profile.bundles` 删掉 `dsh-cookie-prune` 并重启即可。插件用 `ctx.effect` 注册清理函数，卸载时会移除请求钩子并还原 `maxHeaderSize`。

## 边界与说明

- 只处理 `dsh-auth-` 前缀，不碰任何其他 cookie。
- 清理用的 `issuedAt` 取自 cookie 载荷但**不验签**：伪造时间戳最多让一条本该被删的 cookie 多活一会儿，不会带来任何授权影响（鉴权仍由服务端验签）。
- 多实例并存（比如同时开两个端口）时，保留最新 6 条，最老的会过期；老实例因此需要重新走一次带 token 的启动链接，属于可接受代价。`keep` 调大可放宽。
- 这是缓解 + 自愈，真正根治仍在上游：让 cookie 名只按 host 派生（`127.0.0.1`），使每次启动覆盖同一条 cookie。

## 测试

```sh
npm test
```

14 项，覆盖：cookie 解析、时间戳解码、保留策略、`writeHead` 合并（认证层用 `res.writeHead(status, {"set-cookie": …})` 写 cookie，会覆盖已 staged 的头，必须合并）、100 条 cookie 的 431 自愈、100 次启动的稳态上界、静态资源请求触发清理、以及启动顺序竞态下的延迟挂载。

## License

MIT
