// 一键运行:优先 `xtc pao <文件.xt>`(编译+运行一步式,go run 语义);
// 旧版 xtc 不认 pao(实测:截至 2026-09-30 所有已构建二进制都只认 tie),
// 回退两步:tie 产物到应用缓存目录 → 运行产物(PowerShell 单命令串起来)。
import * as backend from '../backend';
import { resolveXtc } from '../settings';
import { basename, dirname } from '../util';
import type { TerminalPane } from '../term/terminal';

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export class Runner {
  constructor(
    private term: TerminalPane,
    private getWorkspace: () => string,
  ) {}

  async runFile(path: string): Promise<void> {
    const xtc = await resolveXtc();
    if (!xtc) {
      throw new Error('未找到 xtc:请在设置里配置 xtc.exe 路径,或把它加入 PATH');
    }
    const cwd = this.getWorkspace() || dirname(path);
    const pao = await backend.toolPaoSupport(xtc).catch(() => false);
    if (pao) {
      await this.term.runCommand(`运行 · ${basename(path)}`, cwd, xtc, ['pao', path]);
      return;
    }
    const cache = await backend.runCacheDir();
    const out = backend.joinPath(cache, `foundry_${Date.now()}.exe`);
    const cmd =
      `& ${psQuote(xtc)} tie ${psQuote(path)} -sc ${psQuote(out)}` +
      `; if ($LASTEXITCODE -eq 0) { & ${psQuote(out)} }`;
    await this.term.runCommand(`运行 · ${basename(path)}(tie+运行)`, cwd, 'powershell.exe', [
      '-NoLogo',
      '-Command',
      cmd,
    ]);
  }
}
