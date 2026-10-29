# VSCode 编辑器插件安装

玄铁 (XuanTie) 的 VS Code 扩展位于仓库 `extensions/xuantie-syntax/`，提供语法高亮、LSP 实时诊断、拼音补全、代码片段、大纲导航与跳转定义。适用于 VS Code 及一切基于 VS Code 内核的 IDE（Trae、JoyCode 等）。

## 安装

扩展未上架 Marketplace，采用手动复制方式：将 `extensions/xuantie-syntax/` 整个文件夹复制到目标 IDE 的用户扩展目录，重启 IDE 即可。

### 各平台扩展目录

| IDE | Windows | macOS / Linux |
|-----|---------|---------------|
| VS Code | `%USERPROFILE%\.vscode\extensions` | `~/.vscode/extensions` |
| Trae | `%USERPROFILE%\.trae\extensions` | `~/.trae/extensions` |
| JoyCode | — | `~/.joycode-editor/extensions` |

> 文件夹名建议改为 `<publisher>.<name>-<version>` 格式（如 `xuantie.xuantie-syntax-2.3.4`），与 IDE 扩展目录惯例一致。

示例（macOS，装到 VS Code）：

```bash
cp -R extensions/xuantie-syntax ~/.vscode/extensions/xuantie.xuantie-syntax-2.3.4
```

### 验证

重启 IDE 后打开任意 `.xt` 文件：

- 高亮、代码片段、拼音补全即时生效（纯前端能力，无需任何配置）
- 扩展管理器中出现 "XuanTie Syntax Highlighting" 即安装成功

## LSP 诊断（可选）

LSP 服务器与 XTC 编译器同源，提供实时诊断（红波浪线）、智能补全、悬停提示、跳转定义、大纲导航。扩展激活时自动查找并拉起 LSP 服务器（默认 stdio 模式），查找顺序：

1. 配置项 `xuantie.lspServerPath` 指定的路径
2. 扩展目录下 `server/xt_lsp.exe`（Windows）/ `server/xt_lsp`（macOS/Linux）
3. 系统 PATH 中的 `xt_lsp.exe`（Windows，`where` 查找）/ `xt_lsp`（macOS/Linux，`which` 查找）

- **Windows**：安装包自带的 `xt_lsp.exe` 已内置，开箱即用。
- **macOS / Linux**：需自行构建 `xt_lsp` 并放入 PATH（如 `~/bin`），或通过 `xuantie.lspServerPath` 指定完整路径。未找到时扩展会安全跳过 LSP，不影响高亮/片段/拼音补全。

LSP 是否生效可在 IDE 输出面板的「玄铁 LSP」频道查看日志（含服务器路径、握手结果、诊断发布记录）。

## 维护

- 语法规则：`syntaxes/xuantie.tmLanguage.json`（TextMate 格式）
- 代码片段：`snippets/pinyin.code-snippets`
- LSP 客户端：`lspClient.js`（零依赖，node net 手卷 LSP 帧，平台感知查找服务器）
- 详细功能说明见 [extensions/xuantie-syntax/README.md](../extensions/xuantie-syntax/README.md)