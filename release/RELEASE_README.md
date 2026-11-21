# 发布基础设施(release/)

> 对标制度：四分支发布制度（2026-11-19 起，见根目录 [关于仓库Git管理制度.md](../关于仓库Git管理制度.md) §2.1）
> 对应 Issue：[#163 发布通道：dev/stable 双轨 + latest*.json](https://github.com/MARKJY-China/XuanTie-Lang/issues/163)
> 本目录只管“怎么发”；升级器读取行为见 [docs/发布与升级源.md](../docs/发布与升级源.md)。

## 1. 四分支 × 四通道 × tag

| 分支 | 通道 | 触发 | tag | GitHub Release | 清单（唯一真源） | 工作流 |
|---|---|---|---|---|---|---|
| `develop` | dev | push `develop`（纯文档/图片改动不触发）或手动 dispatch | 滚动 tag `dev`（prerelease，每次构建删除重建） | prerelease，**不改变** `/releases/latest` | `latest-dev.json` | `.github/workflows/dev.yml` |
| `master` | rc | 打 tag 推送 | 正常短版本，例 `v1.0-rc.5` | 普通 Release（预发布阶段可更新 Latest） | 预发布阶段 `latest.json`；v1.0.0 起 `latest-rc.json` | `.github/workflows/release.yml` |
| `stable` | stable | 打 tag 推送 | `v1.0.0` / `v1.0.1` | Latest | `latest.json`（`channel=stable`，stable/hotfix 独占） | `.github/workflows/release.yml` |
| `hotfix` | stable / hotfix | P0 热修：从 `stable` 切出的短分支，修完回合 `stable` 并同步 `master`；合回后打 tag | `v1.0.x` | Latest | `latest.json`（`channel=stable`，stable/hotfix 独占） | `.github/workflows/release.yml` |

说明：`hotfix` 是**短分支**而非常驻发布线；它不单独拥有通道清单，复用 stable 通道（`latest.json`，`channel=stable`）。hotfix 只允许 P0，必须走与 develop 相同的 CI 门禁，回合 `stable` 后再把 `stable` 同步回 `master`，避免 rc 线缺补丁。

### tag 格式

```
v<RC 版本>
例：v1.0-rc.5

RC/stable 使用正常短版本；dev 使用 `-dev.N` 序号，不写日期/提交。
```

- **完整 tag == 编译器版本常量（`xuantie_compiler/玄铁.xt` 的 `设 版本号`）== 包内 `MANIFEST.txt` 的「版本:」行**；正式 tag 不含日期/提交，dev 的 `dev.N` 只用于 dev Release/清单。
- 无日期后缀的 tag（如 `v1.0.0`）同样必须与版本常量完全相等。
- 指纹门禁（`release.yml` 的 publish job）校验：包内「提交:」== tag 指向提交；「版本:」== **完整 tag 名**。不一致直接拒绝发布。

### dev 版本号

```
v<下一个待发布版本>-dev.<N>
例：v1.0-rc.6-dev.1
```

- **基准版本是当前源码版本常量的下一个版本**：源码 `v1.0-rc.5` → dev `v1.0-rc.6-dev.N`；源码 `v1.0.0` → dev `v1.0.1-dev.N`。
- 同一基准版本内只递增 `N`；基准版本变化（发布了新的 latest/RC）时 `N` 重置为 1。
- `N` 由 `dev.yml` 的 meta job 读取 GitHub 滚动 `dev` Release 的 name 后 +1；没有旧 Release 或基准不匹配时从 1 开始。
- 由 `dev.yml` 的 build job 在 checkout 后把 `设 版本号` **临时 patch 成该 dev 版本**（仅 CI 工作区，不提交），因此 dev 包内 `-V` 与 MANIFEST 均为 dev 版本。
- 滚动 tag 仍固定为 `dev`（prerelease）；包内 MANIFEST「版本:」== dev 版本，`-V` 显示 `通道=dev`，升级器仍以清单 `commit` 做最强校验。

## 2. 工作流

### `dev.yml`（push `develop`）

1. `meta`：校验分支为 `develop`，从版本常量推导 dev 版本；
2. `build`（矩阵，与 `release.yml` 的 lang 矩阵一致）：
   - `windows_amd64`（windows-latest）
   - `linux_x86_64`（ubuntu-latest）
   - `darwin_arm64`（macos-15）
   每平台：GSC → 自举链 + DDC 门禁 → tiepm / xt_lsp → `make_pkg.sh` → `xuantie_<dev版本>_<平台>.tar.gz`；
3. `publish`：指纹校验（提交/版本）→ 生成 `latest-dev.json`（先本地生成供 Release 附件）→ **对比当前 GitHub Latest Release 生成变更摘要（新增/修复/性能/其他，`tools/dev-release-notes.mjs`）** → 删除旧 `dev` release+tag → 重建 **prerelease** `dev`（正文必须包含该对比段）→ 校验 `/releases/latest` 未被 dev 影响 → 上传 ROS 并刷新 `latest-dev.json` → 尽力校验 `latest.json` 未被覆盖。

dev 通道**不产安装器、不签名/不公证、不发 arm64 与铸造厂 IDE**（这些只走 `release.yml`）；产物格式为 tar.gz。

> **dev 发布门禁**：workflow 对比上一次滚动 tag `dev`，若改动仅落在 `docs/`、`GUIDE/`、`ide/` 或 Markdown，则不重发 dev Release（保留旧版）；手动 `workflow_dispatch` 强制发布。

> **dev Release 正文规则**：除版本/提交/通道说明外，必须包含自动生成的「对比 Latest」段；仅写构建元数据不合规。

### `release.yml`（push tag `v*`）

5 平台语言包（win-amd64 / linux-x86_64 / darwin-arm64 / linux-arm64 / win-arm64）+ 铸造厂 IDE（Windows）→ 指纹门禁 → 上传 ROS + 写 `latest.json` → 创建 GitHub Release：

- 若仓库中存在 `release/RELEASE_<tag>.md`（文件名与 tag 完全一致），用它作为 Release 正文，GitHub 再追加自动差异说明；
- 否则回退 `generate_release_notes`。

手动 dispatch 只构建并上传 artifacts（预演），不上 ROS、不建 Release。预演仍校验提交指纹，但跳过版本行比对（没有 tag）。

### `ci.yml`（门禁）

发布前置条件：改动在 `develop` 过四平台 CI → 合 `master` 再绿 → 才允许打 tag。`release.yml` 不代替 CI 门禁。

### hotfix（P0 热修，短分支，无独立工作流）

从 `stable` 切出 `hotfix` 短分支 → 修复 + 与 develop 同口径 CI → 合回 `stable` → 打 `v1.0.x` tag（走 `release.yml`，写 `latest.json`，`channel=stable`）→ 再把 `stable` 同步回 `master`。
hotfix 只允许 P0；不新增工作流、不新增通道清单，发布基础设施与 stable 完全一致。

## 3. 通道清单（升级器唯一真源）

地址：

- **默认**：GitHub Release 资产(`releases/latest/download/latest.json` / `releases/download/dev/latest-dev.json`)；清单内 URL 也指向 GitHub 资产。
- **国内镜像**：ROS 桶根目录，文档站可反代；ROS 写失败时发布流水线以 `--best-effort` 继续，清单仍由 GitHub 资产提供，不阻塞 Release（见 [docs/发布与升级源.md](../docs/发布与升级源.md)）。

| 通道 | ROS key | 建议文档站地址 |
|---|---|---|
| stable | `latest.json` | `https://xuantie.markjy.com/api/latest.json` |
| dev | `latest-dev.json` | `https://xuantie.markjy.com/api/latest-dev.json`（需 nginx 增加路由） |
| rc（v1.0.0 起预留） | `latest-rc.json` | `https://xuantie.markjy.com/api/latest-rc.json`（届时增加） |

stable 清单示例（dev 同构，仅 `channel`/`version`/`tag` 与平台集合不同）：

```json
{
  "channel": "stable",
  "version": "v1.0-rc.5",
  "commit": "<完整 40 位 sha>",
  "date": "2026-11-19",
  "notes_url": "https://github.com/MARKJY-China/XuanTie-Lang/releases/tag/v1.0-rc.5",
  "tag": "v1.0-rc.5",
  "published_at": "2026-11-19T00:00:00.000Z",
  "assets": {
    "windows_amd64": {
      "url": "https://github.com/MARKJY-China/XuanTie-Lang/releases/download/v1.0-rc.5/xuantie_v1.0-rc.5_windows_amd64.tar.gz",
      "sha256": "……",
      "size": 63286234
    }
  },
  "platforms": {
    "windows_amd64": { "url": "…同上…", "sha256": "……", "size": 63286234 }
  },
  "manifests": {
    "windows_amd64": { "url": "…/MANIFEST_windows_amd64.txt", "sha256": "……", "size": 4096 }
  }
}
```

字段说明：

| 字段 | 说明 |
|---|---|
| `channel` | `stable` / `dev`（v1.0.0 起 rc 预留 `rc`） |
| `version` | 发布版本：stable/rc 为 tag 全名；dev 为 dev 版本串 |
| `commit` | 构建提交（完整 sha），升级后可用它做版本自检 |
| `date` | 发布/构建日期 `YYYY-MM-DD`（UTC） |
| `notes_url` | 对应 GitHub Release 页面 |
| `tag` | 发布 tag；dev 固定为 `dev` |
| `published_at` | ISO 时间，兼容旧消费方 |
| `assets` | 平台 → `{url, sha256, size}`；**升级器优先读它** |
| `platforms` | 与 `assets` 同形，兼容旧版 xtc 升级 / 文档站 |
| `manifests` | 平台 → 对应 `MANIFEST_<平台>.txt` 的 `{url, sha256, size}`，供第三方核验 |

平台键固定为：`windows_amd64` / `windows_arm64` / `linux_x86_64` / `linux_arm64` / `darwin_arm64`。
**当前 dev 清单只有 `windows_amd64` / `linux_x86_64` / `darwin_arm64` 三个键**，消费方必须容忍缺键（参照 [xt-ecosystem/contracts/community-ide-bridge.md](../xt-ecosystem/contracts/community-ide-bridge.md) 的缺键容忍要求，缺自身平台键时明确报错/静默跳过，不得崩溃）。

生成/上传命令（`tools/publish-ros.mjs`）：

```bash
# stable（默认通道；release.yml 在 tag 发布时调用）
node tools/publish-ros.mjs --dir artifacts --version "$TAG" --channel stable

# dev（dev.yml 调用；--dry-run 只写本地清单，供 Release 附件复用）
node tools/publish-ros.mjs --dir artifacts --version "$DEV_VERSION" --channel dev --dry-run

# rc（v1.0.0 之后的 rc tag；写 latest-rc.json）
node tools/publish-ros.mjs --dir artifacts --version "$TAG" --channel rc

# 本地演练（不上传）
node tools/publish-ros.mjs --dir release --version v1.0-rc.4 --dry-run
```

脚本参数：`--channel stable|dev|rc`（默认 stable）、`--commit`（缺省 `GITHUB_SHA`）、`--date`（缺省 UTC 当天）、`--notes-url`（缺省由 `GITHUB_REPOSITORY` + tag 推导）、`--tag`、`--manifest-out`。
清单文件名与通道一一绑定（`stable→latest.json`、`dev→latest-dev.json`、`rc→latest-rc.json`），**dev/rc 无法写出 `latest.json`**（脚本硬拒绝）。

## 4. 发布流程清单

### dev（无人工，自动）

1. push `develop` → `dev.yml` 自动跑；
2. 验证：GitHub Releases 出现 prerelease `dev`（tag 指向本次提交）、`latest-dev.json` 与本 Release 附件一致；
3. 确认 `/releases/latest` 仍是 stable/rc（工作流自带校验）。

### rc（master）

1. `develop` CI 全绿 → 合并 `master` → master CI 全绿；
2. 从 [RELEASE_TEMPLATE_stable.md](RELEASE_TEMPLATE_stable.md) 复制出 `release/RELEASE_<tag>.md` 并补齐内容（文件会被 `release.yml` 用作 Release 正文）；
3. 修改版本常量到**完整目标 tag**（发布维护提交，走 master）；
4. `git tag v1.0-rc.5` 并 push tag；
5. 等 `release.yml`：确认指纹门禁通过、Release 正文正确、`latest.json` 的 `version/commit/channel` 正确（清单由流水线自动校验）。

### stable（stable 分支）

1. rc 版本 soak 到约定天数、无 P0；
2. 合并到 `stable`，版本常量改到目标稳定版本；
3. 同样准备 `release/RELEASE_<tag>.md`；
4. 打 tag `v1.0.x` push → `release.yml`；
5. 验证 `latest.json`：`channel=stable`、version/commit 正确，GitHub Latest 指向本版。

### hotfix（P0 热修，从 stable 切出）

1. 从 `stable` 切 `hotfix` 短分支，只修 P0；
2. 与 develop 同口径 CI 全绿 → 合回 `stable`，并把 `stable` 同步回 `master`；
3. 版本常量改到目标补丁版本，准备 `release/RELEASE_<tag>.md`；
4. 打 tag `v1.0.x` push → `release.yml`（与 stable 同一条流水线）；
5. 验证 `latest.json` 的 `channel=stable`、version/commit 与 Latest 指向。

### 回滚

- 升级器侧：`xtc 升级 --版本 <旧 tag>`（直接按 tag 取包，绕过清单）；
- 清单侧：stable 回滚 = 重新发布旧版本 tag 的清单（目前需人工重发；`publish-ros.mjs` 支持对任意版本目录重复执行）。

## 5. 发布说明模板

| 文件 | 用途 |
|---|---|
| [RELEASE_TEMPLATE_stable.md](RELEASE_TEMPLATE_stable.md) | rc / stable / hotfix 发布说明模板（已知问题、升级方式、通道说明、校验） |
| [RELEASE_TEMPLATE_dev.md](RELEASE_TEMPLATE_dev.md) | dev 通道人工说明模板（dev 的 Release 正文由 `dev.yml` 自动生成，本模板供需要更完整说明时使用） |
| [RELEASE_v1.0-rc.5.md](RELEASE_v1.0-rc.5.md) | 本 RC 的发布说明 |

约定：

- 发布说明文件名必须是 `RELEASE_<tag>.md`，`release.yml` 才认；
- 模板里的 `<...>` 占位符发布前必须全部替换；
- 内容至少包含：版本定位、下载/升级方式、变更分组、已知问题、校验指纹、通道说明。

注意：`.gitignore` 规则 `/release/*` 只放行 `RELEASE_*.md`、`make_pkg.sh`、`xuantie_setup.iss`。因此本说明文件名为 `RELEASE_README.md`（不叫 `README.md`），否则不会入库。

## 6. 保留与清理策略

- **GitHub dev**：只保留一个滚动 release —— `dev.yml` 每次先删除旧 `dev` release + tag 再重建，不产生资产堆积，也不产生 “latest”。
- **ROS dev**：每次发布写 `releases/<dev 版本>/`（不可变目录），按“最近 14 天或最近 5 个”策略清理。**当前未自动化**：需要维护者在雨云 ROS 控制台删除过期 `releases/v*-dev.*/` 前缀（后续可给 `publish-ros.mjs` 加 list/delete 实现）。
- **stable / rc / hotfix 发布版本**：永久保留；版本目录不可变，便于回滚与第三方核验（hotfix 的版本目录同样在 stable 通道下）。
- **签名**：dev 不签名/不公证；stable 安装包与签名/公证按 Issue #163 后续阶段推进（本仓库当前产物为 tar.gz + Windows 安装器）。

## 7. 一次性配置

### GitHub Secrets（release.yml / dev.yml 共用）

| Secret | 说明 |
|---|---|
| `ROS_ENDPOINT` | 例如 `https://cn-sy1.rains3.com` |
| `ROS_BUCKET` | 雨云 ROS 桶名 |
| `ROS_ACCESS_KEY` | 雨云 AccessKey |
| `ROS_SECRET_KEY` | 雨云 SecretKey |
| `ROS_PUBLIC_BASE` | 公网前缀，例如 `https://download.xt.markjy.com`；**缺它清单 url 为空，脚本 exit 2** |

`GITHUB_TOKEN` 用工作流 `permissions: contents: write` 即可创建 Release / 删除滚动 dev release，无需额外 PAT。

### 文档站 nginx（二选一，与现有 latest.json 同口径）

```nginx
location = /api/latest.json {
    return 302 https://download.xt.markjy.com/latest.json;
}
location = /api/latest-dev.json {
    return 302 https://download.xt.markjy.com/latest-dev.json;
}
```

dev 路由属于新增配置，尚未在文档站落地（见“未完成项”）。

## 8. 未完成项（发布侧）

- [x] **dev 包内 `xtc -V` 已自洽（方案 A 已落地）**：`dev.yml` 在 checkout 后、自举/打包前把 `设 版本号` 临时 patch 为 `$DEV_VERSION`（仅 CI 工作区，不提交）；dev 包 `-V` 显示 `通道=dev`，MANIFEST「版本:」== dev 版本；发布指纹按 `$DEV_VERSION` 校验。
- [ ] 文档站 `/api/latest-dev.json` 反代路由未配置；
- [ ] ROS 上 dev 版本目录的 14 天清理未自动化；
- [ ] v1.0.0 之后 rc 通道切 `latest-rc.json`：脚本已支持 `--channel rc`，`release.yml` 待按 tag 切换调用；
- [ ] 升级器（`xtc 升级 --通道 dev` / `--版本`）与 IDE updater 跟随通道，由编译器/IDE 侧实现（本目录只保证清单可用）；
- [ ] `xt-ecosystem/contracts/` 尚无“升级源清单”契约文件（AGENTS.md 要求跨仓库接口建契约）；清单字段定稿见本文件第 3 节，需 lead 决定是否新建契约；
- [ ] stable 安装包签名 / macOS 公证（Issue #163 后续阶段）。

---

<sub><span style="color:#999">最后更新：2026-11-19</span></sub>
