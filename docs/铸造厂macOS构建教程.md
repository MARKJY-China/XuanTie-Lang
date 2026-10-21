# 玄铁铸造厂:macOS 构建教程

> 目的:即使没有 Mac 环境,也能照本文档在 GitHub Actions(macos runner)上
> 打包出玄铁铸造厂的 macOS 应用,并以 .dmg 分发(Release 上传 dmg 而非 .app 目录/zip)。

## 1. 工程是什么

- 位置:仓库 `ide/` 子工程(玄铁铸造厂,官方 IDE)
- 技术栈:Tauri 2 壳(Rust)+ Monaco 编辑器 + xt_lsp(LSP)+ xterm.js(终端)
- 关键约束:Tauri 只能**同平台构建**——macOS 安装包只能在 macOS 上打,
  不能用 Windows/Linux 交叉编译。这就是必须用 mac runner 的原因。

## 2. macOS 特有配置(tauri.conf.json,已就绪)

| 配置项 | 值 | 说明 |
|---|---|---|
| `productName` | 玄铁铸造厂 | 决定 .app/.dmg 文件名(Dock 图标 tooltip 也用它) |
| `macOSPrivateApi` | true | 必需,配合无边框 Overlay 标题栏 |
| `windows[0].decorations` | true | 真窗口装饰,左上角红绿灯由系统接管 |
| `windows[0].hiddenTitle` | true | 隐藏标题栏文字,红绿灯仍显示 |
| `windows[0].titleBarStyle` | "Overlay"(大写) | 小写会报 schema 错 |
| `bundle.targets` | ["nsis","app"] | 打 dmg 用命令行 `--bundles app,dmg`,不必改配置 |
| 图标 | `icons/icon.icns` | 橙色铁砧,IDE 专属图标(非玄铁语言标) |

## 3. 本机构建(macOS)

前置:Node 20+ / Rust stable / Xcode Command Line Tools(`xcode-select --install`)。

```bash
cd ide
npm install
npm run tauri build -- --bundles app,dmg
```

产物:

- app 目录:`src-tauri/target/release/bundle/macos/玄铁铸造厂.app`
- dmg 安装包:`src-tauri/target/release/bundle/dmg/` 下(文件名含版本与架构)

验证:打开 `玄铁铸造厂.app`。

> 注意:左上角红绿灯(关闭/最小化/全屏三个圆点)只在**打包后的 .app** 里出现。
> `npm run tauri dev` 的裸二进制没有 Info.plist 私有 API 授权,看不到红绿灯属正常,
> 不要用 dev 判断红绿灯是否生效。

## 4. GitHub Actions 打包(无 Mac 也能出包)

最小 workflow:macos-latest runner 自带 Xcode/Node,每次都是全新机器,
**不需要提前安装任何玄铁工具链**(铸造厂是独立应用,自包含)。

```yaml
name: build-macos-dmg

on:
  workflow_dispatch:
  push:
    tags: ['v*']

permissions:
  contents: write   # 上传 release 资产需要;只取 artifact 可去掉

jobs:
  dmg:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: dtolnay/rust-toolchain@stable
      - run: npm ci
        working-directory: ide
      - run: npm run tauri build -- --bundles app,dmg
        working-directory: ide
      - uses: actions/upload-artifact@v4
        with:
          name: macos-dmg
          path: ide/src-tauri/target/release/bundle/dmg/*.dmg
```

要点:

- 未签名/未公证的 dmg:用户首次打开需右键 → 打开(绕过 Gatekeeper)。
  想免这一步,需 Apple Developer 证书做签名 + 公证,本文档不展开。
- 双架构合一(arm64 + x86_64 一个包):加 `--target universal-apple-darwin`,
  但要求 Rust 已装 `aarch64-apple-darwin` 与 `x86_64-apple-darwin` 两个 target
  (runner 上 `rustup target add`),且合并较慢。单架构 dmg 已够用时不必上。

## 5. 发布到 GitHub Release(dmg 分发)

- GitHub Release 资产**不能传 .app 目录**(文件夹无法作为资产上传);.zip 不适合应用分发。
- 正确姿势:上传 dmg(自带挂载、拖入 Applications 的安装体验)。
- 自动上传(workflow 里,配合上面的 tag 触发):

```yaml
      - uses: softprops/action-gh-release@v2
        if: startsWith(github.ref, 'refs/tags/')
        with:
          files: ide/src-tauri/target/release/bundle/dmg/*.dmg
```

手动也可:构建完把 dmg 直接拖进 Release 编辑页。

## 6. 常见坑(实测)

| 坑 | 现象 | 解法 |
|---|---|---|
| dev 下没有红绿灯 | dev 裸二进制左上角无三个圆点 | 用打包后的 .app 验证(私有 API 授权只在 bundle 里) |
| titleBarStyle 报 schema 错 | 小写 overlay 不认 | 必须大写 `"Overlay"` |
| 中文文件名上传 | Actions 传中文名 dmg 正常 | 无需改名 |
| 重复开终端报"会话已存在" | 窗口销毁重建后 pty 会话残留 | 已修:窗口 Destroyed 时清空 pty 会话 |
| 终端拉起 powershell.exe | macOS 上找不到该程序 | 已修:默认 shell 按平台(Windows=powershell.exe,其他=$SHELL) |
| LSP 报找不到 xt_lsp | macOS 无 xt_lsp 二进制/未入 PATH | 把玄铁工具链装进 PATH,或在设置里手工指定路径 |

## 7. 与 Windows 构建的关系

- 同一份源码,Windows runner 上 `--bundles nsis` 出 nsis 安装包,互不影响。
- macOS 适配改动均为平台分支(Rust `cfg(target_os="macos")` + 前端平台判断),
  Windows 走原有逻辑:红点=真正关闭退出、自绘右上角三键、窗口内自绘菜单栏。
