# dsh-math-perf

[![ci](https://github.com/ZhangPotato2022/dsh-math-perf/actions/workflows/ci.yml/badge.svg)](https://github.com/ZhangPotato2022/dsh-math-perf/actions/workflows/ci.yml)

DeepSeek Harness 插件：**只渲染你看得见的公式**。长对话（上千个 LaTeX）打开不再卡死，
滚动时公式按需出现。

## 它解决的是什么

Web 客户端把一条会话的所有 turn 一次性渲染出来。每个数学节点在 React 渲染期间都要跑完整条
链路：

```
katex.renderToString()  →  new DOMParser().parseFromString()  →  逐个节点手搓 React 元素
```

一个公式产出 60～200 个 DOM 节点。所以一个「应用统计复习」那种规模的会话：

| | 数量 |
|---|---|
| turn / assistant 消息 | 93 / 109 |
| 公式（含行内） | **1347** |
| 落盘体积 | 9.2 MB（jsonl） |

打开它 = 1347 次 KaTeX + 十几万个 DOM 节点 + 一次巨型布局，主线程要卡好几秒；
之后每次滚动、每次重排都还在为这些节点买单。

## 改了什么

插件读取安装目录里的客户端 bundle，改写好之后把字节挂到 `/assets/index-*.js` 这条
exact 路由上（**不碰 `app.asar`**）。一共四件事：

1. **公式按视口渲染**：KaTeX 包装器改名 `__dshMathRender()` 并缓存结果；bundle 里所有
   数学节点改走占位组件 `__dshMathLazy`——首次渲染只出一个灰块，进入视口前后 1200px
   才真正渲染，命中缓存则直接出图。
2. **代码块按视口渲染**：Shiki 那个代码块组件改名 `__dshRealCodeBlock`，调用点改走
   `Zb` 包装器 → `__dshDeferMount`。屏幕外的代码块**不跑语法高亮**（高亮每个块
   1～5ms，一屏几十个就是几百毫秒）。
3. **屏幕外的消息行不参与布局**：注入
   `[data-chat-node-key]{content-visibility:auto;contain-intrinsic-size:auto 240px}`，
   浏览器跳过它们的样式计算和布局。
4. **自带探针**：页面加载 12 秒后，把一份很小的 JSON POST 回
   `/__dsh_math_perf/report`，插件把它追加到 `$DSH_HOME/math-perf-reports.jsonl`
   —— 里面是 DOM 节点数、各类占位块数量、KaTeX 调用次数/耗时、以及**每次长任务
   （longtask）的时长**。卡顿排查靠它，数据只落本地，不外发。

5. **滚动更顺**（v0.4.0）：
   - 空闲时（`requestIdleCallback`，每次 ≤6ms，上限 400 个）**从会话尾部往回**预渲染排队中的
     公式，所以你向上翻时大多数已经画好了；滚动停止 220ms 后再补一轮。
   - 占位块变轻：行内是小圆角点，独立公式是**居中的窄块**（不再是整条灰带），透明度 7–9%。
   - 真正渲染时套一层 `dsh-math-live`，160ms 淡入，替换占位时不"啪"地跳一下。
   - 预取距离从 1200px 提到 **2000px**（提前约两屏）。

`beforeprint` 时所有待渲染内容一次性补齐，打印/导出不受影响。

## 探针怎么读

```bash
cat ~/.dsh/math-perf-reports.jsonl | tail -3 | jq -r .body | jq
```

`tasks` 是 longtask 列表 `[开始毫秒, 时长毫秒]`，超过 50ms 的才是卡顿；`nodes` 是 DOM 节点数（几万以上说明树太大），`shiki` 是已高亮的代码块数，`mathPending` 是还没渲染的公式数。

## 副作用（明确写出来）

- **Ctrl+F 找不到还没渲染的公式**——它们还不在 DOM 里；滚到附近就会渲染。
- **复制一大段跨屏文本时**，尚未渲染的公式不能在剪贴板里还原成 LaTeX。
- 占位块高度是估计值，滚动到新区域时会有轻微高度变化（浏览器滚动锚定会抵消大部分）。

## 安装

插件以 **bundle** 形式接入：包内自带 `cordis.patch.yml`（插入 `math-perf` 那一行），
profile 里要做两件事，缺一不可：

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": {
    "dsh-math-perf": "file:./vendor/dsh-math-perf"   // 让它出现在「设置 → 插件」
  },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
    "dsh-go-usage", "dsh-math-perf"                   // 让它真的加载
  ] } }
}
```

```
~/.dsh/profiles/desktop/
├── package.json
├── vendor/dsh-math-perf/            # file: 依赖指向这里（源码）
└── node_modules/dsh-math-perf/      # 运行时从这里解析（安装副本）
```

> 桌面版的 profile 不能用 `dsh plugin --profile desktop ...`（CLI 直接拒绝）。改完
> profile 的 manifest / 插件源码后，**服务端会自己 recompose**，但客户端 bundle 是页面
> 加载时拉的，桌面版没有刷新菜单，所以窗口里要**重启 DSH** 才换上新 bundle。

## 桌面版：必须改 app.asar（关键）

桌面窗口的 origin 是 `dsh-app://app`，主进程 `lib/main.js` 里写着：

```js
if (pathname === "/" || pathname === "/index.html" || pathname.startsWith("/assets/"))
  return serveWebDocument(request, join(resources.dsh, "node_modules/@deepseek-ai/dsh-web-frontend/dist"))
```

也就是说 `/assets/*` **直接从 app.asar 读文件**，根本不经过 Web 服务器——插件注册的
HTTP 路由对桌面窗口是无效的（只对浏览器访问 Web 端口有效）。所以桌面版必须改归档：

```bash
node tools/patch-asar.mjs --dry-run   # 看会改什么
node tools/patch-asar.mjs             # 追加改写后的 bundle + 改一条头记录，备份在 app.asar.bak-mathperf
node tools/patch-asar.mjs --restore   # 还原
```

做法：把改写后的 bundle **追加到归档末尾**，然后把 asar 头里那一条 entry 指向新位置并重算
SHA-256（头长度保持不变，其它 entry 的偏移一个都不动）。先追加、后改头，中途中断归档仍然可用。
Electron 的 `EnableEmbeddedAsarIntegrityValidation` fuse 在本安装里是关的，所以整包哈希不会被拦。

**DSH 升级会覆盖 app.asar**，补丁随之失效——重跑一次 `node tools/patch-asar.mjs` 即可。

## 验证

```bash
cd dsh-math-perf
node test/all.mjs        # 全部检查（自动用 Electron 的 Node 模式，能读 asar）
```

单项：

| 脚本 | 检查什么 |
|---|---|
| `test/verify.mjs` | bundle 可解析；缓存命中；占位→观测→只渲染一次；缓存命中直接出图；打印前补渲染 |
| `test/render-equivalence.mjs` | 延迟渲染产出的元素树与原版**逐字节相同**（含报错公式、中英混排） |
| `test/test-route.mjs` | 真实安装位置读取 + 路由 200/304/HEAD |
| `test/check-profile.mjs` | 确实是 bundle 层、没被兼容性跳过、行能解析 |
| `test/check-inventory.mjs` | 「设置 → 插件」里显示为已安装、已启用 |
| `test/bench.mjs` | 上面那张表的基准（需 katex + linkedom） |

跑着的服务是否已经用上：

```bash
curl -s http://127.0.0.1:<port>/assets/index-*.js | grep -c __dshMathLazy   # 1 = 已生效
```

## 卸载 / 回滚

把 `"dsh-math-perf"` 从 `dsh.profile.bundles` 删掉即可，客户端回到原版。

## 升级 DSH 之后

产物结构一变，`patchBundle()` 匹配失败 → 只打警告、**不注册路由**，客户端退回原版行为。
重跑 `node test/all.mjs` 就知道还兼不兼容

## 装到别的机器（对外发布后）

```bash
# 1) 装包（带 CLI）
npm i -g dsh-math-perf

# 2) 接进 profile：能联网时用 DSH 自己的插件管理
dsh plugin --profile <profile> add dsh-math-perf
# 再把 "dsh-math-perf" 加进该 profile package.json 的 dsh.profile.bundles

# 3) 桌面版：窗口是从 app.asar 读前端的，必须再改写一次归档
dsh-math-perf patch          # 自动找安装位置；找不到时 --asar <path>
# 重启 DeepSeek Harness
```

`dsh-math-perf restore` 回滚归档，`dsh-math-perf extract <file>` 导出原始前端
bundle（调试用）。

## 发布（维护者）

```bash
npm login --registry https://registry.npmjs.org/
npm publish          # package.json 的 publishConfig 已固定 registry 与 access=public
```

发布前建议跑一遍 `node test/all.mjs`；`npm publish --dry-run` 只打包不上传，可以先用它检查
包内容（当前 14 个文件 / ~25 kB）。

。