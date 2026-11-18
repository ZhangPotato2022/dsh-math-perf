# dsh-math-perf

[![ci](https://github.com/ZhangPotato2022/dsh-math-perf/actions/workflows/ci.yml/badge.svg)](https://github.com/ZhangPotato2022/dsh-math-perf/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/dsh-math-perf.svg)](https://www.npmjs.com/package/dsh-math-perf)

[English](README.en.md) | 简体中文

DeepSeek Harness 插件：**只渲染你看得见的公式和代码块**。长会话不再卡在打开和滚动上。

## 问题

客户端把一条会话的 Markdown 一次性铺开，每个数学节点在 React 渲染期间都要走完整条链路：

```
katex.renderToString()  →  new DOMParser().parseFromString()  →  逐个节点构造 React 元素
```

一个公式产出 60–200 个 DOM 节点。一条 90 多轮、1300 多个公式的会话意味着：

| 项目 | 数量 |
|---|---|
| 公式（含行内） | 1300+ |
| 代码块 | 250+ |
| 首次打开 | 主线程被 KaTeX 占满数秒，期间滚动完全无响应 |

滚动到别处时，这些节点还要反复参与布局和绘制。

## 做法

插件读取安装目录里的客户端 bundle，改写后把字节挂到 `/assets/index-*.js` 这条 exact
路由上（Web 端口生效）。产物结构认不出时它**只告警、不注册路由**，客户端保持原版行为。四件事：

1. **公式按视口渲染**：KaTeX 包装器改名 `__dshMathRender()` 并按（公式，行内/独立）缓存；
   所有数学节点改走占位组件 `__dshMathLazy`，进入视口前后才真正渲染，命中缓存直接出图。
2. **代码块按视口高亮**：Shiki 组件改名为 `__dshRealCodeBlock`，调用点走
   `__dshDeferMount`。屏幕外的代码块不跑语法高亮。
3. **屏幕外的消息行不参与布局**：注入
   `[data-chat-node-key]{content-visibility:auto;contain-intrinsic-size:auto 240px}`。
4. **滚动平滑**：空闲时用 `requestIdleCallback` 从会话尾部往回预渲染排队中的公式
   （每次 ≤6ms，上限 400 个，滚动停止 220ms 后再补一轮）；占位块是轻量灰块而不是满宽灰带；
   真正渲染时 160ms 淡入。预取距离两屏。

`beforeprint` 时一次性补齐所有待渲染内容，打印与导出不受影响。

## 安装

```bash
npm i -g dsh-math-perf

# 接进 profile（写进 dependencies 与 dsh.profile.bundles）
dsh plugin --profile <profile> add dsh-math-perf
```

确认 profile 的 `package.json` 里两处都在：

```jsonc
{
  "dependencies": { "dsh-math-perf": "^0.4.0" },
  "dsh": { "profile": { "bundles": [ "...", "dsh-math-perf" ] } }
}
```

桌面版还要改写一次前端归档（原因见下），然后**重启** DeepSeek Harness：

```bash
dsh-math-perf patch
```

## 为什么桌面版要改 app.asar

桌面窗口的 origin 是 `dsh-app://app`，主进程 `lib/main.js` 里：

```js
if (pathname === "/" || pathname === "/index.html" || pathname.startsWith("/assets/"))
  return serveWebDocument(request, join(resources.dsh, "node_modules/@deepseek-ai/dsh-web-frontend/dist"))
```

`/assets/*` **直接从 app.asar 读文件**，不经过 Web 服务器。所以插件注册的 HTTP 路由
只对浏览器访问 Web 端口有效，桌面窗口必须改归档。

`patch` 的做法：把改写后的 bundle 追加到归档末尾，再改头部那一条 entry 指向它并重算
SHA-256。头长度保持不变，其它 entry 的偏移一个都不动；先追加、后改头，中途中断归档仍然可用。
原包备份在同目录的 `app.asar.bak-mathperf`。

## 命令行

| 命令 | 作用 |
|---|---|
| `dsh-math-perf patch [--asar <path>] [--dry-run]` | 改写安装里的 app.asar，自动探测安装位置 |
| `dsh-math-perf restore [--asar <path>]` | 从备份还原归档 |
| `dsh-math-perf extract <file>` | 导出未改写的 bundle（调试用） |

安装位置探测不到时用 `--asar` 或环境变量 `DSH_DESKTOP_APP_ASAR` 指定。

## 探针

页面加载 12 秒后会把一份小 JSON POST 回插件路由，追加到 `$DSH_HOME/math-perf-reports.jsonl`：

```bash
cat ~/.dsh/math-perf-reports.jsonl | tail -3 | jq -r .body | jq
```

`tasks` 是 longtask 列表 `[开始毫秒, 时长毫秒]`，超过 50ms 才算卡顿；
`nodes` 是 DOM 节点数，`shiki` 是已高亮的代码块数，`mathPending` 是尚未渲染的公式数。
数据只落本地，不外发。

## 副作用

- **Ctrl+F 找不到尚未渲染的公式**：它们还不在 DOM 里，滚到附近就会渲染。
- **跨屏复制**时，尚未渲染的公式无法还原成 LaTeX。
- 占位块高度是估计值，滚到新区域会有轻微高度变化（浏览器滚动锚定会抵消大部分）。

## 卸载与回滚

把 `"dsh-math-perf"` 从 `dsh.profile.bundles` 删掉即回到原版；桌面版再执行
`dsh-math-perf restore`。

## DSH 升级之后

升级会覆盖 `app.asar`，补丁随之失效，客户端回到原版行为。重跑一次
`dsh-math-perf patch` 即可。服务端产物结构若有变化，`patchBundle()` 匹配失败时只告警，
不会写出半个补丁。

## 开发

包本身没有运行时依赖。测试分两类：

```bash
node test/all.mjs                                                     # 需要本机装有 DSH
node --experimental-vm-modules test/verify.mjs test/fixture-bundle.js # 不需要 DSH，CI 跑这个
```

| 脚本 | 检查什么 |
|---|---|
| `test/verify.mjs` | bundle 可解析；缓存命中；占位 → 观测 → 只渲染一次；打印前补渲染；空闲预取 |
| `test/render-equivalence.mjs` | 延迟渲染产出的元素树与原版逐字节相同 |
| `test/test-route.mjs` | 真实安装位置读取 + 路由 200/304/HEAD + 上报写入 |
| `test/check-profile.mjs` | 确实是 bundle 层、没被兼容性跳过 |
| `test/check-inventory.mjs` | 「设置 → 插件」里显示为已安装、已启用 |
| `test/bench.mjs` | KaTeX 工作量基准（需 katex + linkedom） |

产物结构或命名一变，`test/fixture-bundle.js` 也要跟着改，它是 CI 用的最小替身。

## License

MIT