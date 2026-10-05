// 铸造厂可视化 UI 设计器 —— 设计区格式规范 v1 的机器可读常量
// 唯一真源: docs/铸造厂UI设计器-设计区规范.md(两边改动须同步)
// 对标: 玄铁 UI 库 v1.5.4 / 渲染库 v1.3.1
//
// 设计区 = 源文件里一段由设计器维护的"声明式代码区"(标记注释包裹、内含一个构建函)。
// 解析(parser)/生成(generator)/区段读写(region) 共享本文件的约定,保证两侧一致。

/** 设计区开始标记(逐字;名字由用户/设计器给定,允许中文) */
export function markBegin(name: string): string {
  return `// ===== 铸造厂·设计区 开始:${name} =====`;
}

/** 设计区结束标记(逐字) */
export function markEnd(name: string): string {
  return `// ===== 铸造厂·设计区 结束:${name} =====`;
}

/** 标记识别(容忍行首空白与行尾空白;名字不含空白与 =) */
export const MARK_BEGIN_RE = /^\s*\/\/ ===== 铸造厂·设计区 开始:([^=\s]+) =====\s*$/;
export const MARK_END_RE = /^\s*\/\/ ===== 铸造厂·设计区 结束:([^=\s]+) =====\s*$/;

/** 设计区构建函所在模块别名(规范: 引 "UI" 予 UI;设计区只认 UI.<控件名>) */
export const LIB_ALIAS = 'UI';

/**
 * 选项键规范序(生成器按此排序 → 确定性、diff 稳定)。
 * 收集口径: GUIDE/UI/选项键/ 下 41 个键文档 + 三态覆写子字典键;
 * 新键一律追加到所属组末尾,不得插乱既有顺序(否则全仓 diff 抖动)。
 */
export const KEY_ORDER: readonly string[] = [
  // 几何(含四边子字典键:锚/偏/内边距/外边距 的 左/上/右/下)
  'x', 'y', '宽', '高', '锚', '偏', '左', '上', '右', '下', '平移x', '平移y', '弹性', '间距', '外边距', '内边距', '主轴对齐', '叉轴对齐',
  // 视觉
  '底色', '底色2', '渐变向', '羽化', '阴影', '圆角', '边框色', '边框宽', '字色', '字号', '字距', '不透明度', '可视', '裁剪',
  // 视觉(续;新键按纪律追加在组末尾,不插乱既有顺序)
  '字对齐',
  // 三态覆写
  '悬浮', '按下', '禁用', '悬底色', '按底色', '禁底色', '悬字色', '按字色', '禁字色',
  // 行为
  '点击', '触发', '连发间隔', '首按延迟',
];

/** 未知键(null = 不在规范序中)在生成时排在规范序键之后、按源出现序保留 */
export function keyRank(k: string): number {
  const i = KEY_ORDER.indexOf(k);
  return i < 0 ? KEY_ORDER.length : i;
}

/** 控件参数形态:'options' 恒有且恒在末位 */
export type ArgShape = 'children' | 'options' | 'value' | 'src' | 'state' | 'key' | 'num';

export interface WidgetSpec {
  kind: 'container' | 'leaf';
  args: readonly ArgShape[];
}

/**
 * 控件形态表(对齐 UI 库 v1.5.3 的 14 个构造器)。
 * 'children' 槽只收 [叶子调用 | 容器名引用];'state' 槽收标识符;'key' 槽收字符串。
 */
export const WIDGETS: Readonly<Record<string, WidgetSpec>> = {
  '行':       { kind: 'container', args: ['children', 'options'] },
  '列':       { kind: 'container', args: ['children', 'options'] },
  '叠':       { kind: 'container', args: ['children', 'options'] },
  '绝对':     { kind: 'container', args: ['children', 'options'] },
  '滚动容器': { kind: 'container', args: ['children', 'options'] },
  '文本':     { kind: 'leaf', args: ['value', 'options'] },
  '按钮':     { kind: 'leaf', args: ['value', 'options'] },
  '矩形':     { kind: 'leaf', args: ['options'] },
  '图片':     { kind: 'leaf', args: ['src', 'options'] },
  '图标按钮': { kind: 'leaf', args: ['src', 'options'] },
  '输入栏':   { kind: 'leaf', args: ['state', 'key', 'options'] },
  '多行编辑': { kind: 'leaf', args: ['state', 'key', 'options'] },
  '空白':     { kind: 'leaf', args: ['options'] },
  '弹性':     { kind: 'leaf', args: ['num', 'options'] },
};

/** 生成格式常量(全部为规范条款,见文档"生成器硬规矩") */
export const GEN = {
  /** 缩进:与仓库 .xt 文件一致,4 空格 */
  indent: '    ',
  /** 根节点变量名(容器根与外层叶子根都用它) */
  rootVar: '根',
  /** 规范序之外的新键追加于此前缀(设计器分配容器/叶子变量名的兜底前缀) */
  nodeVarPrefix: '节点',
} as const;

/** 设计区注释头(紧跟开始标记的说明行,逐字) */
export const REGION_NOTE = '// (本区由设计器维护;手工改动仅限属性值;非子集写法将导致本区只读)';
