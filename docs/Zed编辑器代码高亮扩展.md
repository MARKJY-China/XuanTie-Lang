# Zed 编辑器代码高亮扩展

Zed（[zed.dev](https://zed.dev)）编辑器的玄铁语言支持，位于仓库 `extensions/xuantie-zed/`。基于 tree-sitter 实现 `.xt` 文件的语法高亮，与 VS Code 插件（`extensions/xuantie-syntax/`）同源 token 表。

## 安装

1. 打开 Zed，命令面板（`cmd+shift+p` / `ctrl+shift+p`）执行 `zed: install dev extension`。
2. 选中本仓库的 `extensions/xuantie-zed` 目录。
3. 等待状态栏出现 "Installing xuantie-language extension..." 并完成，打开 `.xt` 文件即生效。

详细说明见 [extensions/xuantie-zed/README.md](../extensions/xuantie-zed/README.md)。

## 代码配色

高亮捕获走 Zed 标准 token，颜色随当前主题。若希望代码颜色与官方文档站（[xt.markjy.com](https://xt.markjy.com)）代码块一致，通过 Zed 设置的 `theme_overrides` 覆盖（具体色值见扩展 README）。

## 维护

grammar 改动：修改 `grammars/xuantie-zed/grammar-src/grammar.js` 后重新编译 wasm，并同步 `languages/xuantie/highlights.scm`。
