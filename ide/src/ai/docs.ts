// 玄铁语言文档库:启动时经社区 /api/ai/docs/version 比对版本号,不同则从文档站
// 拉取 all.txt 并本地切分落盘(Rust fetch_docs);Agent 每轮注入 INDEX 索引,
// 真正阅读靠 read_file 按需取单篇——不把全文塞进上下文。
import * as backend from '../backend';
import { getSettings, saveSettings } from '../settings';

/** 检查并（必要时）拉取文档。返回更新结果；失败/无需更新返回 null（静默，不打扰启动）。 */
export async function checkAndFetchDocs(): Promise<{ count: number; version: string } | null> {
  const base = getSettings().account.baseUrl.replace(/\/+$/, '');
  if (!base) return null;
  try {
    const r = await backend.httpJson('GET', base + '/api/ai/docs/version', null, undefined, undefined, 8);
    const j = JSON.parse(r.body) as {
      ok?: boolean;
      data?: { version?: string; base?: string };
    };
    if (!j.ok || !j.data?.version) return null;
    const version = j.data.version;
    const docsBase = (j.data.base || 'https://xt.markjy.com').replace(/\/+$/, '');
    // 版本一致且本地已有文档 → 跳过
    if ((getSettings().docsVersion ?? '') === version) {
      const local = await backend.docsIndex().catch(() => null);
      if (local) return null;
    }
    const res = await backend.fetchDocs(docsBase, version);
    await saveSettings({ ...getSettings(), docsVersion: version });
    console.info('[docs] 玄铁文档已更新', version, res.count, '篇 →', res.dir);
    return { count: res.count, version };
  } catch (err) {
    // 无网/老服务端/文档站不可达:静默降级(未拉取过文档时 Agent 仍可正常工作)
    console.info('[docs] 文档检查/拉取失败(静默):', err);
    return null;
  }
}
