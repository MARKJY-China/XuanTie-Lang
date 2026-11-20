# 玄铁 (XuanTie) v1.0-rc.5

第五个候选版。本版集中交付了 2026-11-12 至 2026-11-20 期间合入的编译器/运行时修复、渲染与 UI 库更新、字符流库、铸造厂 IDE 0.8.0，以及 dev/rc/stable/hotfix 四通道发布设施。

**下载**（由 GitHub Actions 多平台流水线自动构建；发行包同时在雨云 ROS 提供国内直链）

- `xuantie_v1.0-rc.5_windows_amd64.tar.gz` — Windows 绿色包（自带 clang/MinGW，解压即可用 `xtc`）
- `xuantie_v1.0-rc.5_linux_x86_64.tar.gz` — Linux 绿色包（需系统 clang；见包内 README）
- `xuantie_v1.0-rc.5_darwin_arm64.tar.gz` — macOS（Apple Silicon）绿色包
- `xuantie_v1.0-rc.5_windows_amd64_setup.exe` — Windows AMD64 安装器（Inno Setup，含 `xtc`/`tiepm`/`xt_lsp`/VSCode 插件；可选加入 PATH）
- ARM64 包与铸造厂 IDE 是否随本版发布，以 Release 附件列表为准；未列出的平台请用绿色包。

## 升级方式

- 默认稳定通道：`xtc 升级`（读 `latest.json`）
- 明确选择通道：`xtc 升级 --通道 stable` / `xtc 升级 --通道 dev`
- 钉版本 / 回滚：`xtc 升级 --版本 v1.0-rc.5`（或更旧 tag）
- 手动：下载对应平台 tar.gz 解压覆盖；升级后 `xtc -V` 显示 `版本 + 通道 + 提交`
- 发布后 `latest.json` 的 `channel`/`version`/`commit` 与本 tag 一致；安装前可用 `--检查` 只看版本不覆盖

## 变更

### 编译器和运行时

- **`执()` 重写（issue #162）**：Windows 不再写临时 `.bat`，改为 `CreateProcessW + 管道 + CREATE_NO_WINDOW`；命令 UTF-8→UTF-16，消除中文 TEMP 路径、临时文件竞争与 AV 误报；输出改倍增缓冲（上限 64 MiB）；新增 `执(命令, 超时毫秒)`（JobObject/进程组超时终止）；非零退出码一律失败。
- **HTTP 长跳转修复**：runtime 的 HTTP 请求/重定向缓冲从 1024 扩到 8192，修复 GitHub Release 资产长 Location 被截断导致 `xtc 升级` 空响应；`--通道 dev`/`--版本` 的清单与下载路径已实测。
- **算术/位运算/取反/`字()` 超域显式报错（issue #153）**：明确的整数越界不再静默回绕。
- **跨单元 ABI / `-lib` 库编译 / 实例化 / 整域 / 转义修复**：补 issue #140/#141 回归门禁。
- **运行时修复**：线程池泵送、通道超时、实例序列化、BOM、整域入口；子进程 stdin 流式写入；内存泄漏守卫。
- **字符流库**：新增字符界面底层 tty 传输与键盘/鼠标事件库，含 Windows 控制台后端；示例首帧显示与刷新闪烁修复，新增可复现测试集和 Linux/macOS pty CI 门禁。

### 官方库

- **渲染库 1.3.11**：字体链回退（主字体缺字向回退字体借）、HIGHDPI 高清文字、码点扩段与缺字告警、隐藏窗口、纹理池耗尽/截图漏批/无边框客户区修复、Linux/macOS 渲染链接适配；`加载音效` 格式口径实测修正（WAV/Ogg Vorbis/MP3 支持，FLAC 不支持）。
- **UI 库 1.8.1**：图标中文名、滚动控制、IM 输入与布局、三态色、文本排版、HiDPI 字号、字叉对齐；内置 Lucide 图标。
- **渲染/UI 编译门禁**：darwin/linux 字体四入口探针。

### 工具链、IDE 与发行设施

- **铸造厂 IDE 0.8.0**：设计器图标选择器、LSP 图标补全、铁铺独立窗口、设计器渲染入口补入。
- **官网**：页脚署名、表格短列排版、部署上传进度。
- **发布设施（issue #163）**：dev/rc/stable/hotfix 四通道；`develop` push 产出滚动 dev prerelease 与 `latest-dev.json`；`latest.json` 由 stable/hotfix（预发布阶段 rc）独占；`xtc 升级 --通道 dev` / `--版本`；升级器改用运行时 HTTP，不再依赖系统 `curl`。
- **CI**：新增 Windows 中文 TEMP `执()` 门禁、字符流 pty 门禁，全量回归 195 项；修复 `tools/regress.py --skip` 的子串误匹配（曾吞掉 196/197/198 用例）。

## 已知问题

- 本版是候选版（RC），不承诺生产稳定性；升级前请备份当前安装目录。
- Windows 上 `cmd` 内建命令/旧程序的输出编码仍可能跟随系统 ANSI 代码页（如 `echo 中文` 可能输出 GBK 字节）；需要 UTF-8 时使用会输出 UTF-8 的程序或自行转码。
- Windows 字符流 TUI 的真实交互需在 Windows Terminal 手工验收；CI 只覆盖编译与非交互路径。
- dev 通道包不签名、不公证；macOS 用户需自行放行。本 RC 的安装器签名/公证状态以 Release 附件说明为准。
- 已知问题持续登记在 GitHub Issues；`xtc 升级 --版本 <tag>` 可随时回滚。

## 校验

- 构建提交：以本 tag 的 `MANIFEST.txt` 中 `提交:` 行为准（必须等于 tag 指向提交；`release.yml` 发布前硬校验）。
- 包内 `MANIFEST.txt` 记录编译器与自举链各级 md5、对应提交哈希、包内全部文件 md5；`xtc -h` 可打印「编译器自述」段。
- 各平台 sha256 / size 见 `latest.json` 的 `assets.<平台>`。

## 通道说明

- **stable**：默认通道，`latest.json`（`channel=stable`）由 stable/hotfix 独占；低频、只收 soak 过的版本。
- **hotfix**：P0 热修短分支（从 `stable` 切出，修完回合 `stable` 并同步 `master`），发布时复用 stable 通道与 `latest.json`。
- **rc**：`master` 打的候选版；预发布阶段写入 `latest.json`，v1.0.0 起只写 `latest-rc.json`。
- **dev**：`develop` 滚动构建，prerelease tag `dev` + `latest-dev.json`；不签名、不保证稳定。

## 贡献者致谢

- 感谢参与 issue #140/#141/#153/#155/#162/#163 与字符流、渲染、IDE 测试的贡献者；详见提交历史与 GitHub Release 自动差异。

---

<sub><span style="color:#999">最后更新：2026-11-19</span></sub>
