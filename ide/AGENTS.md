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
- **发行 exe 必须带 custom-protocol**:`cargo build --release --features custom-protocol`(或 `npx tauri build`)。
  裸 `cargo build --release` 产出的是开发壳——WebView 去 连 localhost:5173 白屏,资源不内嵌(体积也小 1MB+)。
  前端资源是编译期内嵌的:改前端后必须 `npm run build` 再编 Rust。
