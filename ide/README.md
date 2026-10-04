# 玄铁铸造厂(ide/)

玄铁语言官方 IDE。Tauri 2 壳 + Monaco + xt_lsp + xterm.js。
终态(见根 readme「大致计划」v2.0.0)是用玄铁自己的渲染/UI 库自写 IDE;本目录是
那条路成熟之前用成熟技术栈先落地的"壳"。

对标库版本说明:本子工程当前 **v0.4.0**,对标玄铁 v1.0-rc.3 工具链(编译器:自举链 s8;
xtc / tiepm / xt_lsp 均可用)。

## v0.4.0 功能

- **智器对话(AI)**:官方通道(社区代理)/ 自定义提供商直连双通道,SSE 流式、思考折叠、
  引用徽章、用量统计(缓存命中)、会话按工程持久化;**图片/视频多模态**(两种模式均支持);
  流中断三层恢复(适配器非流式降级补全、「继续」按钮、反馈链路与作者联系方式);
  上下文自动压缩(阈值按模型上下文配置,`/compact` 手动触发)、玄铁基础认知注入
  (社区后台可编辑,离线回退内置)、工程指令(AGENTS.md)自动携带。
- **Agent 模式(DSH 内核)**:读写工程文件、执行命令(审批三模式 + 命令白名单)、
  web_search / web_fetch / web_render(隐藏 WebView2 无头渲染)、docs_search(块返回)、
  example_search(文档代码块示例)、check_code(临时文件编译校验,不落工程根)、
  write_file 落盘后自动 `xtc -jc` 检查;AI 文件访问三态权限(禁止/询问/允许)。
- **环境自检**:打开工程后台校验本地工具链与基础语义,状态栏徽标(橙/红/绿,通过后
  5 分钟自动隐藏)、双击开 CI 式控制台(逐行实时日志);结果注入 AI 环境快照。
- **玄铁语言服务**:补全(拼音筛选,含多音字)、悬停、Ctrl+点击 / F12 跳定义、大纲
  (含静态兜底)、实时诊断 + 保存级语义诊断;Monaco 全中文界面(nls shim)。
- **文件树**:眼睛三态显示(build 目录豁免)、Ctrl/Shift 多选与框选、右键复制路径 /
  「添加到对话」(多选批量)、空白区新建。
- **编辑器与交互**:选中浮层(编辑 Ctrl+I / 添加到对话 Ctrl+U)、终端/构建输出/问题面板
  一键「添加到对话」、亮暗主题、字号与整窗缩放、文件编码探测与转换保存。
- **编译与运行**:编译当前文件(Ctrl+Shift+B)/ 整个工程,产物入 工程build(可自定义);
  一键运行(`xtc pao` 探测、旧编译器回退 tie+运行)。
- **菜单栏**:文件(打开/新建工程/**打开最近工程**/保存/刷新/**以管理员身份重启**)、
  编辑、查看、编译、终端、帮助(官方文档 / **反馈问题** / 关于)。
- **工具与账号**:内嵌终端(ConPTY + xterm 多会话)、铁铺(安装/搜索/列出/清理/更新检查)、
  新建工程模板、账号(社区统一账号 / AI 用量与订阅)。

禁令(调试器 UI / 插件系统 / Git 界面 / 控件设计器)见 [AGENTS.md](AGENTS.md);
实现细节与踩坑记录见 [NOTES.md](NOTES.md);版本史见 [versionLog.md](versionLog.md)。

## 构建

前置:Node ≥ 18、Rust(MSVC 工具链)、WebView2 Runtime(Win10/11 一般自带)。

```bash
cd ide
npm install
npm run tauri dev     # 开发(先起 vite,再起 Tauri 窗口)
npm run tauri build   # 发行包(NSIS 安装包)
```

仅构建前端做类型检查:`npm run build`(tsc --noEmit + vite build)。

注意:裸 `cargo build --release`(不带 custom-protocol)产出的是开发壳——WebView 会去连
localhost:5173 白屏,禁止当发行物分发;`npx tauri build` 自动带 custom-protocol 并内嵌前端。

## 工具链配置

「⚙ 设置」里可指定三个 exe(留空则按 PATH 自动探测,顺序:设置 → PATH → 工作区约定位置):

- `xt_lsp.exe` —— LSP 服务器(本仓库开发布局在 `lsp/xt_lsp.exe`)
- `xtc.exe` —— 编译器(建议指向含预编译 runtime `.o` 的目录:无 `.o` 时每次编译现场编 C,慢约 7 秒)
- `tiepm.exe` —— 铁铺

保存级语义诊断依赖 xtc:xt_lsp 在 didSave 时会调 `xtc 铁 <文件> --检查` 并把
语义错误合并进诊断。打字时的实时波浪线来自 xt_lsp 自带解析器,与该设置无关。

## 目录

```
src/          前端(TS + Vite,零框架)
  lang/xt.ts        Monarch 语法 + 主题
  lsp/              JSON-RPC 客户端 + Monaco 功能挂接
  term/             xterm 多会话终端
  run/  tiepm/      运行器 / 铁铺入口
  ai/               智器对话面板 / 会话持久化 / 文档体系
    dsh/            Agent 内核接线(agent-mode / adapter-openai / tools / runtime)
  ui/               布局 / 标签页 / 文件树 / 问题面板 / 弹层 / 校验控制台
src-tauri/    Rust 后端:fsops / lsp / pty / tools / scaffold / http(流式) /
              docs(文档库) / preflight(环境自检) / ailog(链路日志)
vendor/dsh/   DeepSeek Harness 内核(MIT,随附 LICENSE 与 THIRD_PARTY_NOTICES)
```
