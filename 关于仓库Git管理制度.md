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
| `master` | 可发布、可交付的主线 | 只接受**已通过 CI 的 `develop` 合并**、发布维护提交（tag/versionLog/MANIFEST）以及恢复绿色的回退提交；禁止日常开发直接提交 |
| `develop` | 集成分支，所有开发提交的默认落点 | 接收特性/修复提交，必须跑完整 CI 四平台门禁；允许失败后继续修复 |
| 特性分支（可选） | 大改动隔离 | 从 `develop` 切出，合并回 `develop` 后统一过 CI；命名 `feat/...`、`fix/...` |

远端 `develop` 与 `master` 都是主仓库分支；开发分支不要长期分叉。

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
