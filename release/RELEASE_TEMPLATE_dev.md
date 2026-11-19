# 玄铁 (XuanTie) dev 滚动构建 <dev 版本>

<!--
dev 通道发布说明模板。

说明:
  - dev 的 GitHub Release 正文由 dev.yml 在每次构建时自动生成,不会读取本模板;
  - 本模板用于“需要人工写一份更完整的 dev 说明”的场景:复制为
    release/RELEASE_<dev 版本>.md 并提交(纯文档改动静默不触发 dev 构建,见 dev.yml 的 paths-ignore);
  - dev 版本号格式:v<当前版本常量>-dev.<YYYYMMDD>.<sha7>;dev.yml 构建前会把版本常量临时 patch 成该版本,所以 -V 与 MANIFEST 都自洽;
    滚动 tag 固定为 `dev`(prerelease),不是版本号;
  - 本模板只解释“这一滚”的差异;版本/提交/日期等事实字段以 latest-dev.json 为准。
-->

- 版本：`<dev 版本>`
- 提交：`<完整 sha>`
- 构建日期：<YYYY-MM-DD>
- 清单：`latest-dev.json`（ROS 桶根目录为唯一真源；本 Release 附件为同内容副本）

## 通道说明

- 四分支模型：`develop`=dev / `master`=rc / `stable`=stable / `hotfix`=P0 热修短分支（从 stable 切出、修完回合 stable 并同步 master；发布时复用 stable 通道）；
- dev 是 `develop` 分支的最新快照，**滚动更新**、**不签名/不公证**、**不保证稳定**；
- GitHub 上为 prerelease 的滚动 tag `dev`，**不会**出现在 `/releases/latest`，不影响 stable/rc 用户的 `latest.json`；
- GitHub 只保留最近一次 dev 构建；ROS 上 dev 版本目录按“最近 14 天或最近 5 个”清理。

## 本滚动的变更摘要

- <基于 develop 最近合并的提交概述；不必展开全部细节，指向相关 Issue/PR 即可>
- <若包含面向用户的破坏性变更或行为变化，必须写在这里>

## 已知问题

- **`xtc -V`**：dev.yml 已在构建前把版本常量临时改为本 dev 版本，`-V` 应显示 `通道=dev` 与提交；若发现仍是旧通道，以 `latest-dev.json` 的 `version/commit` 和 `-V` 输出为准报 issue。
- dev 通道本身允许存在问题；列出已知缺陷与规避方式
- 报 bug 请附 `xtc -V` 输出（含版本、通道、commit）与 `latest-dev.json` 里的 `version/commit`

## 升级方式

- 自动：`xtc 升级 --通道 dev`（读 `latest-dev.json`；首次从 stable 切 dev 会打印警告）
- 手动：下载本页对应平台 `xuantie_<dev 版本>_<平台>.tar.gz` 解压覆盖
- 回滚：`xtc 升级 --通道 stable`，或重装最近一次 stable/rc 包

## 校验

- 构建提交：`<完整 sha>`（应等于 `git rev-parse <本次 develop 提交>`）
- 包内 `MANIFEST.txt` 记录编译器/自举链各级 md5 与提交哈希；`xtc -h` 可打印「编译器自述」段
- 各平台 sha256 / size 见 `latest-dev.json` 的 `assets.<平台>`

---

<sub><span style="color:#999">最后更新：2026-11-19</span></sub>
