# ide/vendor/dsh —— DeepSeek Harness 核心链(vendored)

## 来源与版本基线

- 来源仓库:[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)(MIT,见本目录 `LICENSE` / `THIRD_PARTY_NOTICES.md`)
- 版本基线:DSH 包 `0.2.0-rc.2`;vendored Cordis 栈:`@deepseek-ai/cordis 4.0.4`、`@deepseek-ai/cosmokit 1.8.5`、`@deepseek-ai/schemastery 3.18.4`
- 源码快照(只读存档):仓库 `temp/deepseek-harness/`;可行性验证记录:`temp/dsh-spike/REPORT.md`

## 重建

```bash
cd ide
npm install                 # esbuild / zod / @standard-schema/spec 在 devDependencies
node vendor/dsh/build.mjs   # → vendor/dsh/dist/dsh-core.mjs(非 minify,vite 构建期再压)
```

`gen-alias.mjs` 由 build.mjs 按需自动调用(扫描 packages/*/package.json 生成包名→src 的 alias.json)。

## 裁剪决策

- **摘入 18 包**(packages/):cordis、cosmokit、schemastery(基础栈);dsh-scope、dsh-session、dsh-agent、dsh-agent-loop、dsh-system-prompt、dsh-tools、dsh-llm(核心链);dsh-brand、dsh-util-values、dsh-util-crypto、dsh-timeout、dsh-typert-protocol(运行时依赖);dsh-session-projection(agent-loop 硬 inject `sessionProjections`)、dsh-session-persistence(agent-loop 值引用 `SessionPersistenceNotFoundError`)、dsh-sandbox(dsh-tools/ptc.ts 值引用)。
- **未摘**:cordis-plugin-timer、dsh-invariants、dsh-user-approval、dsh-sandbox-policy、dsh-ptc-runtime、dsh-attachment、dsh-workspace、session-persistence-jsonl、llm-deepseek 等——对本链全为 type-only import 或携带 node:fs 的执行/持久化实现,经 esbuild 实测不在运行时闭包。
- **typert 生成物**:dsh-llm 的 `./typert`、`./remote` exports 子路径指向构建期生成物,本链不 import,直接用 src 绕过,未复现 DSH 的 tsc/tsdown/typert 构建。

## 浏览器 shim(shims/,7 个;语义差异见各文件头注释)

`node:crypto`(WebCrypto 等价)、`node:async_hooks`(单全局槽 ALS,**多异步流交错串台**,仅影响子代理编排)、`node:util/types`(thenable 判定)、`node:path`(仅 isAbsolute)、`node:module`(createRequire 写死版本 `0.2.0-rc.2`,升级基线时必须同步)、`node:fs` / `node:os`(抛错 stub,dsh-sandbox 带入;浏览器链走到即架构错误,刻意当场炸开)。

## 使用面

`facade.ts` 是唯一出口 → `dist/dsh-core.mjs`;ide 侧经 vite alias `@dsh-core` **动态 import**(懒加载,不进主 chunk),类型声明手写在 `ide/src/ai/dsh/dsh-core.d.ts`(窄面,只声明用到的符号)。
