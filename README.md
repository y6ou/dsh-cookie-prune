# dsh-cookie-prune

[![Release](https://img.shields.io/github/v/release/y6ou/dsh-cookie-prune?label=release&color=blue)](https://github.com/y6ou/dsh-cookie-prune/releases/latest)
[![License](https://img.shields.io/github/license/y6ou/dsh-cookie-prune?color=green)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-informational)](package.json)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.3%20~%200.2.2-blueviolet)](package.json)
[![Tests](https://img.shields.io/badge/tests-16%20passed-success)](test/run.mjs)

**当前版本 `0.1.2`** ｜ [⬇ 下载安装包](https://github.com/y6ou/dsh-cookie-prune/releases/latest) ｜ [更新日志](https://github.com/y6ou/dsh-cookie-prune/releases)

> 上面这些徽章如果加载不出来（国内访问 shields.io 有时会失败），以本行文字为准：版本 0.1.2，安装包在 Releases。

修复 DeepSeek Harness 的 **`dsh-auth-*` cookie 撑爆请求头**问题：启动若干次之后 Web UI 打不开、服务端返回 **HTTP 431**、Electron 侧报 `Web authentication failed`。

已在 **DSHA 安卓客户端（`web` profile）** 上实测生效；`dsh web` 走同一套认证与 Web 服务，同样适用。**DSH Desktop 未实测**——它也用同一套 `@deepseek-ai/dsh-client-connection`，理论上适用，但请自行验证。

> 这是社区修复，不是官方补丁。真正根治需要上游把 cookie 名改成只按 host 派生（见文末「上游修复建议」）。

## 问题成因

1. `@deepseek-ai/dsh-client-connection` 的会话 cookie 名是 `"dsh-auth-" + base64url(sha256(authority))`，HTTP 下 `authority` 是 **`host:port`**。
2. 浏览器 / WebView 的 cookie 库**只按 host 隔离，不区分端口**。于是每次启动换一个端口，就多出**一条新的** `dsh-auth-*`，而不是覆盖上一条。
3. cookie 默认活 30 天，且没有任何代码清理它。
4. Node 的 `maxHeaderSize` 默认 16 KiB，单条 cookie 在请求头里约 228 B：

   `16384 ÷ 228 ≈ 71.9` → **第 72 次启动**时 `Cookie` 头越界，请求在进入任何路由之前就被拒（431），界面再也打不开。

因为 cookie 名带端口，而端口每次随机（DSHA / Desktop 都是随机端口启动），所以这个问题**只会在反复重启后出现**，且清浏览器数据能立刻恢复——这正好解释了它的「玄学」表现。

## 修复方式

两层，都**不修改认证逻辑**：

| 层 | 做法 | 效果 |
|---|---|---|
| **响应时清理** | 请求里若带超过 `keep` 条 `dsh-auth-*`，保留最新的（当前正在服务的 authority 必留），其余回 `Set-Cookie: <name>=; Max-Age=0` | 稳态 6 条 ≈ 1.4 KB，不再是 72 条。静态资源请求也会触发，等于自动清扫 |
| **抬高解析上限** | 把 `http.Server#maxHeaderSize` 抬到 64 KiB（Node 按连接读取该值） | **已经卡死**的实例也能先解析请求、再被清理掉，从而自愈，不再永久 431 |

清理用的是标准 `Set-Cookie`，所以**历史堆积的 cookie 会被自动删除**，不需要手动清浏览器站点数据。

## 安装

需要 DSH `0.2.1-rc.3` 及以上，Node.js ≥ 22。

> ### ⚠️ 安装时一定要带来源，不要用裸包名
>
> **这个包没有发布到 npm。** 直接执行 `dsh plugin --profile web add dsh-cookie-prune`
> 会失败（npm 上不存在该包）。
>
> 更要注意的是：`dsh-cookie-prune` 这个 npm 名称**目前仍空着**，任何人现在都可以抢注。
> 一旦被抢注，裸名安装就会**静默装到别人的包**。所以请始终使用下面两种带来源的写法之一。
>
> 另外，名字相近的 [`dsh-cookie-guard`](https://www.npmjs.com/package/dsh-cookie-guard) 是**另一位作者**的插件，
> 只针对 DSH Desktop、且只缩短 cookie 寿命**不清理**已有 cookie。别装混了。

### 方式一：用 Release 里的 tgz（推荐，最确定）

```sh
# 1. 下载
curl -L -o dsh-cookie-prune-0.1.2.tgz \
  https://github.com/y6ou/dsh-cookie-prune/releases/download/v0.1.2/dsh-cookie-prune-0.1.2.tgz

# 2. 校验（必须完全一致，否则不要安装）
sha256sum dsh-cookie-prune-0.1.2.tgz
# 期望值：6841427fe43a8e05e7e1016547df7fbd2fa086e3a84843a5b0e7e795682cd2d8

# 3. 安装
dsh plugin --profile web add ./dsh-cookie-prune-0.1.2.tgz
```

### 方式二：直接从 GitHub 安装

```sh
dsh plugin --profile web add github:y6ou/dsh-cookie-prune
```

这种方式依赖你的机器能访问 github.com（git 或 https）。如果你的网络受限，
会报 `Could not read from remote repository` 或端口连接失败，此时请改用方式一。

### 方式三：手动放置

```sh
mkdir -p ~/.dsh/profiles/web/node_modules/dsh-cookie-prune
cp -r lib cordis.patch.yml package.json ~/.dsh/profiles/web/node_modules/dsh-cookie-prune/
```

再编辑 `~/.dsh/profiles/web/package.json`，把插件名加进 bundle 列表：

```jsonc
{
  "dependencies": { "dsh-cookie-prune": "0.1.2" },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-cookie-prune"
      ]
    }
  }
}
```

### 最后一步：重启

**必须重启才生效**，而且请从 DSHA / DSH 客户端里重启——重启会生成新的签名密钥，当前页面的 cookie 立即失效，新地址带一次性 token，只有 App 能把它交给浏览器。

> **为什么是 `--profile web`**：DSHA 实际启动的命令是
> `dsh web --no-open --host 127.0.0.1 --port <随机端口>`，用的就是 `web` profile。
> 你可能还会看到 `dsha-recovery-*` 这类目录，那是兜底/残留，不是常驻目标。

## 验证

重启后，启动日志里应出现：

```
[cookie-prune] active: keep=6, header ceiling 65536 bytes
```

（这行用 `console.log` 输出，所以一定会进日志文件；早先版本用 `ctx.logger` 输出、在部分环境看不到，0.1.2 已修正。）

想再确认它真的在干活，可以对运行中的服务压一个假的 cookie 头：

```sh
# 从日志里取当前端口
PORT=$(grep -oE 'http://127\.0\.0\.1:[0-9]+' ~/dsh-web.log | tail -1 | sed 's/.*://')
COOKIE=$(python3 -c "print('; '.join(f'dsh-auth-t{i}=x' for i in range(10)))")
curl -s -D - -o /dev/null -H "Cookie: $COOKIE" "http://127.0.0.1:$PORT/" | grep -c "Max-Age=0"
```

- 输出 **`5`** → 生效（10 条假 cookie，保留 5 条，删 5 条）
- 输出 **`0`** → 没生效

这个测试只发假 cookie，不会碰你的真实会话。

## 配置

编辑 `cordis.patch.yml`，或在 profile 的 `cordis.patch.yml` 里覆盖同 id 的行：

```yaml
- id: cookie-prune
  config:
    keep: 6                # 稳态保留条数
    maxHeaderSize: 65536   # 解析上限（raiseHeaderLimit 生效时）
    raiseHeaderLimit: auto # auto | always | never
    enabled: true
```

| 键 | 默认 | 说明 |
|---|---|---|
| `keep` | `6` | 清理后保留几条。调小更省，调大可容纳更多并发实例的会话 |
| `maxHeaderSize` | `65536` | 解析上限。浏览器单域名最多约 180 条 cookie（≈41 KB），64 KiB 足够 |
| `raiseHeaderLimit` | `auto` | `auto` = 仅在绑定 loopback 时抬高上限；局域网暴露时保持 Node 默认，避免放大不可信客户端的每连接缓冲区。`always` 强制抬高，`never` 关闭 |
| `enabled` | `true` | 设 `false` 可临时停用而不用卸载 |

### 关于 `maxHeaderSize` 的安全性

把请求头上限从 16 KiB 抬到 64 KiB 意味着每条连接可能多占用约 48 KiB 的内存缓冲。默认只在 loopback 绑定时这么做，而 DSH 的默认绑定就是 `127.0.0.1`。如果你用 `--host` 绑到局域网地址，`auto` 会保持 Node 默认值（此时仍会清理 cookie，只是失去「已卡死时自愈」这一层）。

## 卸载

从 `dsh.profile.bundles` 移除 `dsh-cookie-prune`，重启即可。插件用 `ctx.effect` 注册清理函数，卸载时会移除请求钩子并还原 `maxHeaderSize`。

## 兼容性

| DSH | 状态 |
|---|---|
| 0.2.2-rc.1 | 实测生效（DSHA，`web` profile） |
| 0.2.2-rc.5 | 适用（`connection` 的 cookie 逻辑与 rc.1 完全一致，已比对源码） |
| 0.2.1-rc.3 / rc.5 | 适用（同上） |
| DSH Desktop | **未实测**，理论适用 |

## 已知取舍

- **多实例并存**时只保留最新 `keep` 条，最老的会话会被挤掉，需要重新走一次带 token 的启动链接。`keep` 调大可放宽。
- 清理顺序依据 cookie 载荷里的 `issuedAt`，但**不验签**：伪造时间戳最多让一条本该删除的 cookie 多活一会儿，不带来任何授权影响（鉴权仍由服务端验签）。
- 只处理 `dsh-auth-` 前缀，不碰其他任何 cookie。
- 插件整体包了 try/catch：**插件自身出错最多是不生效，绝不会让 DSH 起不来**。

## 测试

```sh
npm test
```

16 项，涵盖：cookie 解析、时间戳解码、保留策略、loopback 判定与门控、`writeHead` 合并（认证层用 `res.writeHead(status, {"set-cookie": …})` 会覆盖已 staged 的头，必须合并）、100 条 cookie 的 431 自愈、100 次启动的稳态上界、静态资源触发清理、启动顺序竞态下的延迟挂载。

## 上游修复建议

真正根治只需上游改一处：

1. **让 cookie 名只按 host 派生**（例如 `127.0.0.1`），使每次启动**覆盖同一条** cookie 而不是新增一条；或
2. 启动时清掉历史的 `dsh-auth-*` cookie。

改完之后这个插件就不再需要了。

## License

[MIT](LICENSE)
