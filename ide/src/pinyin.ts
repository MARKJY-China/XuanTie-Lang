// 中文标签补 filterText:全拼 + 首字母 + 多音字全部读音,让补全可用拼音筛选
// 移植自 extensions/xuantie-syntax/lspClient.js 的 withPinyinFilter
// (多音字实例:行 → xing/hang/heng 均可筛中,否则打 UI.hang 补不出 UI.行)
import { pinyin } from 'pinyin-pro';

export function withPinyinFilter(label: string): string {
  try {
    if (/[\u4e00-\u9fa5]/.test(label)) {
      const arr = pinyin(label, { toneType: 'none', type: 'array' }) as string[];
      const parts = [arr.join(''), arr.map((p) => p[0]).join('')];
      const readings = new Set<string>();
      const initials = new Set<string>();
      for (const ch of label) {
        if (/[\u4e00-\u9fa5]/.test(ch)) {
          const multi = pinyin(ch, { toneType: 'none', type: 'array', multiple: true }) as string[];
          for (const r of multi) {
            readings.add(r);
            initials.add(r[0]);
          }
        }
      }
      parts.push(...readings, ...initials, label);
      return parts.join(' ');
    }
  } catch {
    // 拼音转换失败退化为原标签,不影响补全可用性
  }
  return label;
}
