# Changelog

## 1.1.1

- **修复**：长对话底部偶发一大片空白。屏幕外行隔离用的
  `contain-intrinsic-size: auto 240px` 会被零高度的空行永久占住（空行没有面积，永远不会被判定为"进入视口"，
  于是预留高度一直留着）。现在空行与每个 flow 末尾三行都不参与隔离，预留高度也降到 120px。


## 1.1.0

- **升级自愈**：插件每次启动都会检查 `app.asar`，发现被 DSH 升级覆盖就自动重新打补丁
  （后台子进程，不阻塞启动），不再需要手动执行 `dsh-math-perf patch`
- 补丁带版本标记 `/* dsh-math-perf x.y.z */`：版本一致时跳过，不会每次启动都往归档追加
- `DSH_MATH_PERF_NO_ASAR=1` 关闭自愈
- 显式指定 `--asar` / `DSH_DESKTOP_APP_ASAR` 但路径不存在时直接报错，不再退回自动探测（避免误改别的安装）
- 新增 `test/heal.mjs`：用合成归档覆盖自愈路径，无需安装 DSH
- 观测距离常量与实际值统一为 2000px


## 1.0.0

首个稳定版本。功能面与 0.4.x 相同，作为可依赖的起点发布。

- 公式按视口渲染：KaTeX 结果缓存 + 占位组件，进入视口前后 2000px 才真正渲染
- 代码块按视口高亮：Shiki 只处理屏幕附近的块
- 屏幕外消息行 `content-visibility: auto`，不参与布局与绘制
- 空闲预取（`requestIdleCallback`，每次 ≤6ms，上限 400 个）+ 160ms 淡入
- `beforeprint` 兜底，打印与导出不受影响
- `dsh-math-perf` CLI：`patch` / `restore` / `extract`，归档位置自动探测
- 就地改写 `app.asar`：追加 + 改一条头记录，头长度不变，失败只告警
- 可选性能探针，数据只落本地 `$DSH_HOME/math-perf-reports.jsonl`


## 0.4.1

- README 重写：去掉针对单台机器的描述与维护者章节，安装路径改为 CLI 为主
- 新增英文版 README.en.md，两份文档互相链接
- 包内容加入 README.en.md

## 0.4.0

- 空闲时从会话尾部往回预渲染排队中的公式（每次 ≤6ms，上限 400 个；滚动停止 220ms 后再补一轮）
- 公式渲染完成时 160ms 淡入，替换占位块不再硬切
- 占位块改轻：行内是小圆点，独立公式是居中窄块（透明度 7–9%，不再是满宽灰带）
- 预取距离 1200px → 2000px
- 新增 `dsh-math-perf` CLI：`patch` / `restore` / `extract`
- 归档路径自动探测（Windows / macOS / Linux），并支持 `--asar`、`DSH_DESKTOP_APP_ASAR`
- 归档内的前端 bundle 按内容定位，不再依赖带 hash 的文件名

## 0.3.0

- 代码块（Shiki）按视口延迟渲染
- 屏幕外消息行 `content-visibility: auto`
- 每次页面加载上报一份性能数据到 `$DSH_HOME/math-perf-reports.jsonl`
- **修复**：桌面窗口从 `app.asar` 读 `/assets/*`，Web 路由对它无效 —— 改由
  `tools/patch-asar.mjs` 就地改写归档

## 0.2.0

- 公式改走视口感知的占位组件，KaTeX 只渲染视口附近的公式
- `beforeprint` 时一次性补齐待渲染公式

## 0.1.0

- 首个可用版本：KaTeX 包装器结果缓存（同一公式只渲染一次）