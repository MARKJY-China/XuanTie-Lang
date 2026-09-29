# 玄铁铸造厂(ide/)

玄铁语言官方 IDE 的 v0.x 过渡版:Tauri 2 壳 + Monaco + 现有 xt_lsp + xterm.js。
终态(见根 readme「大致计划」v2.0.0)是用玄铁自己的渲染/UI 库自写 IDE;本目录是
那条路成熟之前用成熟技术栈先落地的"壳"。

对标库版本说明:本子工程当前 v0.2.0,对标玄铁 v1.0.0(xtc / tiepm / xt_lsp 均可用)。

## v0.2.0 功能

- 文件树:眼睛三态显示(完全 / 半显示 / 不显示,build 目录豁免)、专属图标
  (.xt 用玄铁 .ico,md/txt/toml/json 各有图标)、右键复制相对/完整路径、空白区新建
- Monaco 编辑器:玄铁 Monarch 语法高亮、**全中文界面**(nls shim)、LSP 补全(拼音筛选,
  含多音字)、悬停、Ctrl+点击 / F12 跳定义、大纲(Ctrl+Shift+O,含静态兜底)、
  实时诊断 + 保存级语义诊断
- 菜单栏:文件 / 编辑 / 查看(终端面板与侧栏开关) / 编译 / 终端 / 帮助(官方文档、关于)
- 编译:当前文件(Ctrl+Shift+B)或整个项目,产物统一入 工程build 目录(可在设置自定义)
- 一键运行:保存全部 → `xtc pao` 探测,旧编译器自动回退 tie+运行;输出进独立会话
- 自绘一体化标题栏(窗口控制内嵌,拖拽/双击最大化)
- 内嵌终端:ConPTY + xterm.js 多会话(新建 Ctrl+Shift+` / 清空 / 关闭)
- 铁铺:安装 / 搜索 / 列出 / 清理
- 新建工程:控制台示例 / 空白工程,自动生成 `玄铁.配置.toml` + `主.xt`
- 帮助:官方文档(xt.markjy.com)、关于(版本 / 版权 / 开源仓库 / 当前 XTC 版本)

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

纯 cargo 产出发行 exe(前端资源是编译期内嵌的,先 `npm run build` 再编 Rust):

```bash
npm run build
cargo build --release --features custom-protocol --manifest-path src-tauri/Cargo.toml
```

注意:裸 `cargo build --release`(不带 custom-protocol)产出的是开发壳——WebView 会去连
localhost:5173 白屏,禁止当发行物分发。

## 工具链配置

「⚙ 设置」里可指定三个 exe(留空则按 PATH 自动探测,顺序:设置 → PATH → 工作区约定位置):

- `xt_lsp.exe` —— LSP 服务器(本仓库开发布局在 `lsp/xt_lsp.exe`)
- `xtc.exe` —— 编译器
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
  ui/               布局 / 标签页 / 文件树 / 问题面板 / 弹层
src-tauri/    Rust 后端:fsops(文件)/ lsp(进程桥)/ pty(ConPTY)/ tools(定位+设置)/ scaffold(模板)
```
