# Xuantie Language for Zed

玄铁 (XuanTie) 编程语言在 Zed 编辑器中的语法高亮扩展，基于 tree-sitter 重建（上游 VS Code 插件 `xuantie-syntax` 为 TextMate 格式，Zed 只认 tree-sitter）。

## 功能

- `.xt` 文件语法高亮（与 VS Code 插件同源 token 表：声明、控制、字符串、数字、库函数、注释、标点等）
- grammar 已编译为 wasm 随扩展分发，clone 即用，无需本地 tree-sitter 工具链

## 安装（dev extension 方式）

1. 克隆或复制本目录到本地：
   ```plaintext
   https://github.com/MARKJY-China/XuanTie-Lang
   ```
   扩展位于仓库 `extensions/xuantie-zed/`。
2. 打开 Zed，命令面板（`cmd+shift+p` / `ctrl+shift+p`）执行 `zed: install dev extension`。
3. 在 macOS 文件选择面板中选中 `extensions/xuantie-zed` 目录（Zed 要求选中包含 `extension.toml` 的目录），确认后等待安装完成（首次会显示 "Installing xuantie-language extension..."）。
4. 打开 `.xt` 文件即可看到语法高亮。

卸载：命令面板执行 `zed: extensions`，在扩展列表中找到 Xuantie Language 移除即可。

## 代码配色

语法高亮捕获走 Zed 标准 token（`@keyword`、`@string`、`@number`、`@function`、`@comment` 等），颜色随当前 Zed 主题。若希望代码颜色与玄铁官方文档站（xt.markjy.com）代码块一致，可在 Zed 设置（`zed: open settings`）中加入：

```json
{
  "theme_overrides": {
    "One Dark": {
      "syntax": {
        "keyword": { "color": "#569cd6" },
        "keyword.control": { "color": "#c586c0" },
        "string": { "color": "#98c379" },
        "number": { "color": "#4c9a91" },
        "function": { "color": "#b8a965" },
        "variable": { "color": "#bd976a" },
        "comment": { "color": "#80a665" },
        "punctuation": { "color": "#666666" }
      }
    }
  }
}
```

浅色主题（One Light）对应官方站浅色代码块色值：keyword `#0000ff`、string `#22863a`、number `#2f798a`、function `#998418`、comment `#59873a`、variable `#b07d48`、punctuation `#999999`。

## 目录结构

```plaintext
extension.toml            扩展清单（grammar 以 wasm 分发）
grammars/xuantie.wasm     tree-sitter 预编译 grammar（wasm）
grammar-src/              grammar.js 源码（生成 wasm 的上游，可维护）
languages/xuantie/
  config.toml             语言配置（后缀 .xt、注释、括号等）
  highlights.scm          高亮查询规则
README.md                 本说明
```

## 维护说明

- grammar 改动后需重新编译 wasm：`tree-sitter generate`（在 `grammar-src/`）+ 编译为 `grammars/xuantie.wasm`，并同步 `languages/xuantie/highlights.scm`。
- 高亮规则验证：
  ```plaintext
  tree-sitter query -p grammar-src languages/xuantie/highlights.scm <示例.xt>
  ```

## 许可证

MIT
