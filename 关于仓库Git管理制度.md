# 关于仓库 Git 管理制度

> 建立日期：2026-11-19 ｜ 规则提出：用户 ｜ 适用：主仓库全部 AI / 人类协作者

## 0. 一句话规则

**所有开发提交先上远端 `develop` 分支并过 CI；CI 通过后，才允许合并进 `master`。**
`master` 必须始终对应一个 **CI 全绿** 的提交；不允许把未过 CI 的开发提交直接放在 `master` 上。

## 1. 背景

2026-11-19，`master` 上的 `9079643`（`执()` 修复）在 GitHub CI 中失败：

- Windows 中文 TEMP 门禁：gcc 自己的临时文件仍使用中文 `TEMP`，链接失败；
- Linux / macOS 字符流 pty 门禁：`执()` 的 POSIX 子进程被放入后台进程组，`stty` 收到 `SIGTTOU`，TUI 示例未进入原始模式。

该提交直接推到了 `master`，导致 `master` 最新提交长时间保持 CI 失败状态。制度原因：开发提交没有先经过 `develop` 的 CI 缓冲。本制度自此生效。

## 2. 分支模型

| 分支 | 定位 | 允许的操作 |
|---|---|---|
| `develop` | **dev 通道**：集成分支，所有开发提交的默认落点 | 接收特性/修复提交，必须跑完整 CI 四平台门禁；push 触发 dev 滚动构建（prerelease tag `dev` + `latest-dev.json`） |
| `master` | **rc 通道**：可发布候选主线 | 只接受**已通过 CI 的 `develop` 合并**、rc/发布维护提交；`v1.0-rc.5` 等正常短版本 RC tag 从 master 打 |
| `stable` | **stable 通道**：线上稳定线 | 只接受从 `master` 已验证内容合并的稳定版；`v1.0.x` stable tag 从 stable 打，独占默认 `latest.json` |
| `hotfix` | **hotfix 通道**：P0 热修短分支 | 从 `stable` 当前发布点切出，只修 P0；修完跑同样 CI，回合 `stable` 并同步 `master`，随后删除 |
| 特性分支（可选） | 大改动隔离 | 从 `develop` 切出，合并回 `develop` 后统一过 CI；命名 `feat/...`、`fix/...` |

四条分支线：`develop` → `master` → `stable`，P0 从 stable 切 `hotfix` 短分支。日常修复只进 develop；develop CI 绿后进 master（rc）；master 经 soak、确认无 P0 后进 stable。stable 只做稳定版，不再吸收开发功能；hotfix 只允许 P0，修完回合 stable 并同步 master。

## 2.1 发布通道（与分支对应）

| 通道 | 分支/触发 | tag 示例 | GitHub Release | 清单 | 频率 |
|---|---|---|---|---|---|
| dev | `develop` push | 滚动 tag `dev`（prerelease） | prerelease，不改变 `/releases/latest` | `latest-dev.json` | 每次合并/每日 |
| rc | `master` 合并后打 tag | `v1.0-rc.5`（正常短版本，不带日期） | 普通 Release（预发布阶段可更新 Latest；v1.0.0 后 rc 只写 `latest-rc.json`） | 预发布阶段 `latest.json`，v1.0.0 后 `latest-rc.json` | 发布前 1–2 周 |
| stable | `stable` 打 tag | `v1.0.0` / `v1.0.1` | Latest | `latest.json`（channel=stable） | 2–4 周或按需 |
| hotfix | `hotfix` 短分支（从 stable 切） | `v1.0.2` | Latest | `latest.json`（channel=stable） | 仅 P0，随时 |

纪律：

- **dev 永远 prerelease**，不允许覆盖 `latest.json`；dev 包不签名/不公证，只保留最近 14 天或最近 5 个。
- **dev Release 必须带对比说明**：正文不能只有版本/提交/通道说明，必须包含「对比 Latest」段（新增/修复/性能/其他改动），由 `tools/dev-release-notes.mjs` 自动对比当前 GitHub Latest Release 生成；没有对比说明的 dev 发布视为不合规（首次无 Latest 时明确写“首次 dev 构建”）。
- **stable 独占默认安装通道**：`latest.json` 只由 stable/hotfix 发布写入；v1.0.0 前的预发布阶段，master 的 rc 可临时写 `latest.json`，但必须在 v1.0.0 发布时切回 stable 独占。
- **RC 用正常短版本**：`v1.0-rc.5`；版本号/源常量/MANIFEST/tag 四处必须一致，不一致拒绝发布。日期/提交只用于 dev 构建名，不污染 RC。
- **发布前 soak**：rc 从 master 出、至少经过 develop CI + master CI；stable 从 rc/stable 出、至少 soak 到约定天数且无 P0。
- 用户显式选择通道：`xtc 升级` 默认 stable，`--通道 dev` 才拿 dev；`--版本 <tag>` 用于钉版本/回滚。


## 3. 标准工作流（强制）

1. **开发提交推 `develop`**：本地完成改动、定向测试后，commit / push 到远端 `develop`；push 事件自动触发 CI。
2. **等 CI 四平台门禁全绿**：Windows gate、Linux gate、macOS gate、Windows ARM64 gate 全部 success；任何一项红都不得进入第 3 步。
3. **合并 `master`**：CI 绿后，将 `develop` 合并进 `master`（fast-forward 或 merge commit 均可），再 push `master`；`master` push 会再跑一次 CI，确认合并后的树仍为绿。
4. **发布**：只有 `master` CI 全绿 + 自举链 DDC + 全量回归通过，才允许打版本 tag、生成 MANIFEST、发布发行包。
5. **失败处理**：`develop` CI 红 → 在 `develop` 上继续修，修到全绿；**不要**为了"先合进去"把红的提交推进 `master`。

## 4. 明确禁止

- 禁止在 `master` 上直接 commit 开发代码（包括"小改动""顺手修"）；
- 禁止 `git push origin HEAD:master` 绕过 `develop`；
- 禁止在 CI 未全绿时合并 `develop` → `master`；
- 禁止 force-push `master` / `develop`（恢复绿的回退提交除外，且必须说明原因并单独审查）；
- 禁止把"本地能编译"当作 CI 已通过；跨平台/中文 TEMP/pty 等门禁只在 CI 覆盖完整。

## 5. 例外与紧急回退

### 5.1 `master` 已经红了

1. **恢复绿色优先**：可以 revert 导致失败的提交（只回退，不夹带新功能），该回退提交允许直接走 `master`，但必须触发 CI 并确认绿；
2. 修复本身仍走 `develop`：在 `develop` 上完成修复、CI 全绿后再合并回 `master`；
3. 不允许以"紧急"为名把未验证的修复直接推到 `master`。

### 5.2 发布/版本维护

tag、`versionLog.md`、`MANIFEST`、release workflow 触发的提交属于发布维护，可在 `master` 绿的前提下直接进行；仍须遵守发布指纹与 tag 纪律。

## 6. CI 门禁内容（当前）

`develop` 和 `master` 的 push / PR 都会跑：

- **gate（Windows）**：GSC→s1→s4 自举 + DDC、语法着色自检、铁铺冒烟、190+ 全量回归（跳过无显示服务窗口用例）、跨单元 ABI/库模式/隐藏窗口专项、**issue #162 中文 TEMP 门禁**；
- **gate-linux**：自举 + DDC、字符流 Linux pty（示例全事件 + C1 契约）；
- **gate-darwin**：自举 + DDC/IR 补判、字符流 macOS pty（示例全事件 + C1 契约）、TLS 冒烟；
- **gate-win-arm64**：Windows ARM64 自举 + 铁铺冒烟。

分支保护建议（GitHub 设置，人工开启）：对 `master` 开启 "Require status checks to pass before merging"，勾选上述 gate；禁止直接 push 到 `master`，只允许 PR 合并。制度不依赖某个平台的按钮，但开启保护可把纪律变成硬门禁。

## 7. 提交与署名

- commit 作者使用仓库配置的 GitHub 账号身份（当前 `问号盒 <146653001+MARKJY-China@users.noreply.github.com>`），不得使用第三方组织/无关账号名义；`玄铁社区` 是历史贡献者的提交身份，不再作为本仓库 AI 提交身份；
- commit subject 使用 `类型: 一句话`（feat/fix/docs/test/ci/chore 等）；正文写清问题、改动、验证；末尾保留由哪个模型/Harness 执行、人工已审核的署名行；
- 公开 Issue/PR 回复按 `AGENTS.md` 的署名规则附模型、Harness、人工审核状态。

## 8. 执行检查清单

- [ ] 改动在 `develop`（或从 develop 切出的特性分支）
- [ ] 定向测试已跑
- [ ] `develop` push 后四平台 CI 全绿
- [ ] 合并 `master` 后再次确认 CI 绿
- [ ] 若发布：自举 DDC、全量回归、发布指纹/tag 均通过

---

<sub><span style="color:#999">最后更新：2026-11-19</span></sub>
