# 玄铁 (XuanTie) <版本>

<!--
发布说明模板（rc / stable / hotfix 通用）。

用法:
  1. 复制为 release/RELEASE_<tag>.md —— 文件名必须与 tag 完全一致(例 release/RELEASE_v1.0-rc.4-20261119.1.md),
     release.yml 才会把它作为 GitHub Release 正文;否则回退自动生成。
  2. 替换所有 <...> 占位符,发布前不得留空;本文件不要直接改。
  3. tag 必须满足 v<版本>-<YYYYMMDD>.<序号>;完整 tag == xuantie_compiler/玄铁.xt 的「设 版本号」常量 == 包内 MANIFEST 的「版本:」行
     == 包内 MANIFEST.txt 的「版本:」行。v1.0.0 起 stable tag 形如 v1.0.0 / v1.0.1。
  4. 本版若为稳定版,首句写“第 N 个正式版”;rc 写“第 N 个候选正式版”。
-->

<一句话定位本版：主要改进方向 / 是否推荐默认升级 / 有无破坏性变更>

**下载**（由 GitHub Actions 多平台流水线自动构建；发行包同时在雨云 ROS 提供国内直链）

- `xuantie_<tag>_windows_amd64.tar.gz` — Windows 绿色包（<是否内嵌 clang/MinGW>）
- `xuantie_<tag>_linux_x86_64.tar.gz` — Linux 绿色包（需系统 clang；见包内 README）
- `xuantie_<tag>_darwin_arm64.tar.gz` — macOS（Apple Silicon）绿色包
- <arm64 平台 / 安装器 / 铸造厂 IDE：按本版实际产物填写；没有就写“本版不含”>

## 升级方式

- 默认稳定通道：`xtc 升级`（读 `latest.json`，`channel=stable`）
- 明确选择通道：`xtc 升级 --通道 stable` / `xtc 升级 --通道 dev`
- 钉版本 / 回滚：`xtc 升级 --版本 <旧 tag>`
- 手动：下载对应平台 tar.gz 解压覆盖；升级后 `xtc -V` 应显示本版版本 + 通道 + commit

## 变更

### 语言与编译器

- <...>

### 工具链与发行设施

- <...>

### 运行时与官方库

- <...>

### 配套 IDE：玄铁铸造厂

- <...>

## 已知问题

- <本版已知缺陷/限制：写清影响面 + 规避方式；宁可多写，不要写“无”除非已过一遍 open issue>

## 校验

- 构建提交：`<完整 sha>`（应与 tag 指向的提交一致，可由 `git rev-list -n1 <tag>` 复核）
- 包内 `MANIFEST.txt` 记录编译器与自举链各级 md5、对应提交哈希、包内全部文件 md5；`xtc -h` 可打印「编译器自述」段
- 各平台 sha256 / size 见 `latest.json` 的 `assets.<平台>`

## 通道说明

- **stable**：默认通道，`latest.json`（`channel=stable`）由 stable/hotfix 独占；低频、只收 soak 过的版本
- **hotfix**：P0 热修短分支（从 `stable` 切出，修完回合 `stable` 并同步 `master`），发布时复用 stable 通道与 `latest.json`
- **rc**：`master` 打的候选版；预发布阶段写入 `latest.json`，v1.0.0 起只写 `latest-rc.json`
- **dev**：`develop` 滚动构建，prerelease tag `dev` + `latest-dev.json`；不签名、不保证稳定，仅供提前试用/报 bug

---

<sub><span style="color:#999">最后更新：2026-11-19</span></sub>
