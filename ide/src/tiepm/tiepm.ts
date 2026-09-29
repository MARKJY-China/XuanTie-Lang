// 铁铺(tiepm)入口:安装/搜索/列出/清理,子命令直接进终端会话
import { resolveTiepm } from '../settings';
import type { TerminalPane } from '../term/terminal';

export class Tiepm {
  constructor(
    private term: TerminalPane,
    private getWorkspace: () => string,
  ) {}

  private async exec(args: string[], label: string): Promise<void> {
    const tiepm = await resolveTiepm();
    if (!tiepm) {
      throw new Error('未找到 tiepm:请在设置里配置 tiepm.exe 路径,或把它加入 PATH');
    }
    await this.term.runCommand(label, this.getWorkspace(), tiepm, args);
  }

  install(name: string): Promise<void> {
    return this.exec(['az', name], `铁铺 · 安装 ${name}`);
  }

  search(keyword: string): Promise<void> {
    return this.exec(['ss', keyword], `铁铺 · 搜索 ${keyword}`);
  }

  list(): Promise<void> {
    return this.exec(['lc'], '铁铺 · 已装列表');
  }

  clean(): Promise<void> {
    return this.exec(['ql'], '铁铺 · 清理缓存');
  }
}
