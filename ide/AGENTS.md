# 玄铁铸造厂 —— 作用域纪律(对任何 AI / 贡献者永久生效)

## UI 永久纪律

- **禁止 Emoji 图标**:界面图标一律 `@vscode/codicons`(MIT);`.xt` 文件图标用 VSIX 同款玄铁
  `.ico`(`src/assets/xuantie.ico`)。新增图标先用 `grep "codicon-名字" node_modules/@vscode/codicons/dist/codicon.css`
  核实存在,禁止凭记忆写类名。
- **禁止"——"拼接式标题**:主标题 + 小字副标题两行呈现(见设置弹窗 m-subtitle 模式)。

## v0.2 范围(只许有这些,一个不多)

- 文件树(眼睛三态显示:完全/半显示/不显示,build 目录豁免,右键复制路径与空白区新建)
- Monaco 编辑器(玄铁高亮 + LSP 全家桶:补全 / 悬停 / 跳定义 / 大纲(含静态兜底) / 诊断)+ 全面中文 UI
- 一键运行(探测 pao,旧编译器自动回退 tie+运行)
- 编译菜单(当前文件 Ctrl+Shift+B / 整个项目,产物入 工程build 目录,位置可设置)
- 菜单栏(文件/编辑/查看/编译/终端/帮助)+ 自绘一体化标题栏(窗口控制内嵌)
- 内嵌终端(ConPTY + xterm.js,新建/清空/关闭会话)
- 铁铺入口(`tiepm az/ss/lc/ql`)
- 新建工程模板 + 关于弹窗(版本/版权/仓库/XTC 版本)
- 账号(顶栏「账号」按钮):对接**玄铁社区账号体系**(统一账号中枢,决策记录见 NOTES.md 第 8 节);
  未登录显示"账号",登录后显示用户名;服务端改动须先经用户批准
- 智器对话(右侧 dock):官方通道 = 社区代理(简单对话 /api/ai/chat,Agent 模式 /api/ai/agent/chat,
  ailm_* 配置族在社区后台);自定义通道 = 用户自配 OpenAI 兼容提供商。
  v0.2 仅简单对话;**v0.3(2026-10-01 用户批准开工):内嵌 DeepSeek Harness(DSH,MIT)agent 内核**,
  走方案 A 子B——手裁 DSH core 组(Cordis + agent/agent-loop/session/system-prompt/tools/llm)vendor 进
  WebView TS 层,自写 OpenAI 兼容 LlmAdapter,工具调用经社区代理透传端点;体积硬闸门 ≤5MB。
  解剖报告与 spike 在 temp/(deepseek-harness 源码快照在 temp/deepseek-harness,只读)。
  **Phase-2 已落地(2026-10-01)**:内核 vendor 在 `vendor/dsh/`(18 包 src + 7 个 node shim,
  重建 `node vendor/dsh/build.mjs`,决策见 `vendor/dsh/README.md`);TS 层在 `src/ai/dsh/`
  (OpenAI 适配器 adapter-openai.ts / 传输抽象 transport.ts / WebView 桥 transport-tauri.ts /
  运行时工厂 runtime.ts / 手写窄面类型 dsh-core.d.ts);Rust `http_stream` 新增 `sse-raw` 透传格式;
  懒加载入口 `window.__xtDshLoadRuntime()`(独立 chunk 615KB/gzip 162KB,不进主 chunk)。
  **Phase-3 已落地(2026-10-01)**:面板 Agent 开关(工具栏 hubot 按钮,关闭时走原简单对话);
  工具桥 `src/ai/dsh/tools.ts`(read_file/list_files 只读免批,write_file/run_command 逐次弹窗审批,
  审批 seam = DSH `tools/pre-execute` ask + `ctx.provide('approval')`,弹窗在 approval.ts);
  run_command 后端 = Rust `exec_capture`(非交互捕获,超时 kill,不用 PTY);
  面板控制器 agent-mode.ts 只经动态 import 加载;Phase-3 验证记录见 temp/dsh-smoke/(mock3.py + smoke3.ts)。
  **Phase-4 已落地(2026-10-01)**:审批三模式(变更前确认/自动编辑/完全控制,设置 ai.agentMode,
  工具栏下拉);run_command 白名单(命令首 token 匹配,设置 ai.cmdWhitelist,审批卡有
  「批准并加入白名单」,管理界面在提供商弹窗);审批从全局模态改为输入区上方内嵌卡片队列
  (approval.ts ApprovalLane,fail-closed 不变);工具卡片终态自动折叠;exec_capture 加
  CREATE_NO_WINDOW(跑命令不再弹黑窗);思考块/工具结果内滚容器跟随到底。
  验证:temp/dsh-smoke/(mock4.py + smoke4.ts,5 场景 gate 矩阵)。

## AI 面板(智器对话/Agent)工程事实(免去每次考古)

- 数据模型:`ChatMsg{content, thinking?, parts?}`;`parts: TurnPart[]`(text/think/tool 按真实发生顺序交错,
  见 `src/ai/turn-parts.ts`,纯逻辑可单测)是直播、定稿、历史恢复的**单一数据源**;
  老会话无 parts 时按 content 单块渲染。会话持久化在工程根 `.foundry/ai-sessions.json`。
- **段次序硬性**:同一 step 内思考段在正文段之前;`toolCall()` 会先关思考段再落卡片——
  改 `turn-parts.ts` 的关闭次序前先想清楚"重启后渲染顺序会不会反"。
- 状态行/耗时唯一来源 `src/ai/activity.ts`(`fmtDur`: <10s 一位小数,≥10s 取整)。
- 流式渲染:纯文本增量追加(吐字器 `src/ai/smooth-typer.ts`,先 flush 再 md 替换,顺序不能反);
  滚动跟随:用户上滚脱离(`userDetached`),回底重新挂上。
- 工具卡片:折叠只折输出(`.ai-tool-card.collapsed .ai-tool-result{display:none}`),
  参数摘要行(命令/路径)折叠态仍可见;标题语义化走 `formatToolArgs`;write_file 行级 diff 用 `lineDiff`(空串=0 行、末尾换行不额外计行)。
- 多轮 Node 冒烟与单测在仓库 `temp/dsh-smoke/`(esbuild 打包 ide 源码为 node bundle,
  backend.ts 经插件替换为 stub;mock 是 python http.server 假 OpenAI SSE 流)。

## 智器对话交互工程事实(二轮补充)

- **工具视觉**:`AiChatPanel.toolVisual(name)` 统一决定图标/色族;CSS 在 `[data-tool-kind]`
  上色(buildToolCard 存 data-toolName/kind;updateToolCard 的 className 重写不影响 dataset)。
- **用量统计**:面板 `usage` 对象;agent 路径有真实 usage(from adapter,含缓存字段);
  简单对话服务端只回总量——只入账总量/轮数,TTFT/生成时长/输出细分不混口径、不估算。
- **文档库**:Rust `docs.rs`(fetch docs 切分落盘/INDEX/`.version`);前端 `src/ai/docs.ts`
  (启动比对+拉取);agent-mode 经 deps.loadDocsIndex 注入(`<玄铁语言文档>` 块);
  面板 chip 与 ChatMsg.docsCount 持久化同 instrNames 模式。all.txt 分篇标记:
  `============ <相对路径> ============`。
- **模型的 read_file 双根白名单**:resolveInside(roots):[workspace, docsDir];写操作固定仅 workspace。
- **教训**:批量文本替换一律用 Edit 工具(涉及 `
` 等转义序列时 python heredoc 会被
  JSON/bash 两层吃掉转义);python 批量写入的 assert 失败会静默跳过全量写入,复核必须看完整输出。
- **开发环境快照**:agent-mode `deps.getEnvSnapshot` ← 面板 `buildEnvSnapshot()`
  (xtc/tiepm 路径与版本、官方库目录[标记 `数组\数组.xt`,候选序:xtc 目录/上 1-2 级/工程根]、
  工程顶层 .xt、产物目录);随系统提示词注入。改候选顺序先看这里。
- **上下文自动压缩**(面板层实现;DSH 的 compaction 包未 vendor):阈值
  `COMPRESS_AT_TOKENS=90K`(实测 lastInputTokens 优先,字符估算兜底);摘要经当前通道
  httpStream 收集 text chunk;Agent 模式走 `AgentMode.applyCompression`(摘要→
  compressionNote[摘要+最近 6 条回放——会话历史不可注入,回放是重建后唯一连续通道],
  清 instructions 缓存,dropSession → 下次发送重建会话重携全部块)。
  引用 chip 的"仅首发"逻辑在 runAgentTurn 的 `firstCarry` 判定(历史中已有携带记录则不渲染)。

## 智器对话交互工程事实

- **默认值**:联网搜索与 Agent 模式默认开启;修改时同步 `syncWebBtn`/`syncAgentBtn`(构造期刷 UI)。
- **busy 唯一入口 `setBusy()`**:同步发送按钮红色终止态(primitive-square 图标),新增 busy 赋值禁止裸改字段。
- **回退/重生成 × Agent 残留**:DSH 会话历史不可注入(facade 未导出 fork;buildForkSeed 在 dsh-session 中
  但未暴露),回退时以 `AgentMode.dropSession()` 丢弃会话(同步清引用+configKey,异步 dispose),
  下次发送全新重建——与"重启后 Agent 上下文从零"的产品行为一致。改回退逻辑前先想清楚这一点。
- **工程指令**:`project_instructions`(Rust,工程根同层,不区分大小写,100KB 上限)→
  `AgentMode.loadInstructions()` 缓存一次 → runtime `projectInstructions` 拼在 persona 之后;
  面板在 runAgentTurn 里于思考段之前渲染 `.ai-instr-ref` chip。
- **选中浮层**:`src/ui/selection-tools.ts`(挂 #editor-host 绝对定位;Ctrl+I/ Ctrl+U 经
  editor.addCommand 覆盖 Monaco 默认);「编辑」提交走 `aiPanel.sendSelectionEdit`;
  「添加到对话」的 chips 仅内存(发送时 composeWithRefs 拼引用块,发完清空)。
- **教训(2026-10-04)**:python 批量写入后若用 grep 过滤输出核对,AssertionError 会被
  大小写敏感过滤吞掉造成"假成功"——复核必须看完整输出或逐项 grep 回验。

## 联网栈(三层)工程事实

- 第一层 `web_search(query)`(Rust,必应国内版直连,解析见 `parse_bing_results`,单测含实测 HTML 片段)。
- 第二层 `fetch_static(url)`(Rust,reqwest + HTML→文本;2MB/12000 字符截断)。
- 第三层 `web_render(url)`(Rust,隐藏 WebView2 窗口 + `on_page_load` + `eval_with_callback` 取 outerHTML;
  静默期 1500ms 等 SPA 补渲染;总超时默认 30s)。**不要改用外部 Chrome/Edge --headless**:
  实测部分环境(安全软件)静默拦截,连 --log-file 都 0 字节;WebView2 是 Tauri 硬依赖,唯一可靠通道。
- `web_fetch(url, render)` auto 模式阈值 400 字符;渲染 vs 静态取更长者;输出带来源标注。
- 隐藏渲染窗口 label 前缀 `wr-`;eval 回调是 `Fn`(可多次),oneshot send 须用 `Mutex<Option>` 一次性取走。

## 永久禁令(未经用户明确批准,不得实现,不得"顺手"做)

| 禁区 | 理由 |
|---|---|
| 调试器 UI | 月级黑洞,v0.1 / v0.2 不碰 |
| 插件系统 | 壳还没站稳,不养生态税 |
| Git 界面 | 已有 VSCode / 命令行,重复造轮子 |
| 可视化控件设计器 | 钉死在 **v0.3**,作为"UI 库毕业"的验收标准,见下 |

## 控件设计器为什么钉在 v0.3

控件设计器是吃下易语言 / 极语言用户群的杀手级功能——那批人习惯拖控件画窗体
(极语言:http://140.143.0.163:81/)。但它生成的代码必须指向**玄铁自己的 UI 库**
才有意义;UI 库不成熟之前做设计器 = 生成一堆废代码。所以:

1. 先等 lib/UI 成熟(拖控件 → 生成玄铁 UI 库代码);
2. v0.3 里程碑以"能用设计器拖出一个完整小应用"为 UI 库毕业验收标准。

## 技术事实速查(免去每次考古)

- LSP:`xt_lsp.exe`,stdio + Content-Length 分帧,全文同步(change:1);
  能力 = completion / hover / definition / documentSymbol / publishDiagnostics;
  私有参数:`_xtcPath` 放 initialize params 顶层;`_fsPath` 放 didOpen / didChange / didSave params 顶层。
  IDE 端解析链(顺序):设置 → PATH → `<工作区>\lsp\` → xtc 同目录 → xtc 上 1-2 级的 `lsp\`
  (开发布局 build\env\xtc.exe → 仓库根 lsp\;用户自建工程全靠 xtc 锚定兜底)。
  LSP 连接/重连后必须对已打开文档补发 didOpen,否则这些文档永远没有补全与诊断。
- 运行:`xtc pao <文件.xt>`(编译+运行,go run 语义);语义检查:`xtc 铁 <文件> --检查`。
  **注意**:截至 2026-09-30,所有已构建 xtc(含旧链顶)都不认 pao——它只在未编译的工作区源码里。
  IDE 在运行前探测 `xtc -h` 是否含 pao,否则回退 `tie -sc <缓存目录> → 运行产物` 两步。
- **编译一律用最新自举链顶**(以 `ls -lt build/xtc_s*.exe` 现查为准,勿用记忆里的旧级;旧级一律视为过期)。
  教训:重建 xt_lsp 后必须冒烟验证(补全应含 时/文件/数学 3 项命名空间,总数 72)——
  s6 时代曾出现 6 连建 1 次产出功能残缺二进制(69 项)的现象;s3(2026-09-30 链顶)6/6 正常,
  IR 阶段逐字节确定。当前 lsp/xt_lsp.exe 即 s3 构建(md5 655343d4…)。
- 工程锚:目录含 `玄铁.配置.toml` 即工程根(`[项目] 入口`);包清单是 `tiepm.toml`,两者不是一个东西。
- definition 返回的 uri 是 `file:///` + `:`→`%3A` + 多字节逐字节百分号编码
  (lsp/xt_lsp.xt 的 路径转URI),客户端解码必须 decodeURIComponent 兜底。
- 运行会话直连程序不经 shell:PowerShell 带引号路径要 `&` 前缀而 cmd 不要——直连把两者都绕开。
- **Monaco 汉化机制**:vite 插件把 monaco 内部对 `vs/nls.js` 的解析重定向到 `src/monaco/nls-zh.ts`
  (同签名 shim + `nls-zh-table.ts` 精确查表,查不到回落英文)。改表后必须跑
  `node temp/check_nls_coverage.mjs` 校验键名(临时脚本在仓库 temp/,清掉前先移到别处或重写)。
  键必须与 monaco esm 源码的英文默认值逐字符一致——新增翻译一律从源码提取,严禁凭记忆写键。
- **构建统一用 `npx tauri build`**(2026-10-02 用户立):完整发行构建(前端 + Rust + 打包)一条命令。
  裸 `cargo build --release` 产出的是开发壳(无 custom-protocol)——WebView 去连 localhost:5173 白屏,
  禁止分发;`npx tauri build` 会自动带 custom-protocol 并内嵌前端,不要再手工拼 cargo 参数。
  前端资源是编译期内嵌的:改前端后直接 `npx tauri build` 即可(其内部会先跑 `npm run build`)。
  重编报 `os error 5 拒绝访问` = 旧 exe 还在运行(Windows 文件锁),关掉铸造厂再编。
- **发行构建由用户执行**(2026-10-02 用户立):AI 不在会话里跑 `npx tauri build` / `cargo build`;
  AI 侧的验证边界 = `npx tsc --noEmit`(前端类型) + `cargo test`(src-tauri 单测),
  发行构建与实机冒烟由用户自行执行。
