# Changelog

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