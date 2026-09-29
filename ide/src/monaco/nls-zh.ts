// monaco vs/nls.js 的中文 shim —— vite 插件(见 vite.config.ts)把 monaco 内部全部对
// vs/nls.js 的解析重定向到这里。同签名实现 localize/localize2,输出前按英文默认值
// 精确查 nls-zh-table,查不到自动回落英文(升级 monaco 不会崩,只会缺翻译)。
import { ZH_TABLE } from './nls-zh-table';

function format(message: string, args: unknown[]): string {
  if (args.length === 0) return message;
  return message.replace(/\{(\d+)\}/g, (match, index) => {
    const arg = args[Number(index)];
    if (
      typeof arg === 'string' ||
      typeof arg === 'number' ||
      typeof arg === 'boolean' ||
      arg === undefined ||
      arg === null
    ) {
      return String(arg);
    }
    return match;
  });
}

function zh(message: string): string {
  return ZH_TABLE[message] ?? message;
}

export function localize(_data: unknown, message: string, ...args: unknown[]): string {
  return format(zh(message), args);
}

export function localize2(
  _data: unknown,
  originalMessage: string,
  ...args: unknown[]
): { value: string; original: string } {
  // value 为本地化结果;original 保持英文原样(对比/遥测用途)
  return { value: format(zh(originalMessage), args), original: format(originalMessage, args) };
}

export function getNLSLanguage(): string {
  return 'zh-cn';
}

export function getNLSMessages(): string[] | undefined {
  return undefined;
}
