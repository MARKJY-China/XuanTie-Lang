// 铸造厂可视化 UI 设计器 —— 属性面板元数据(选项键 → 编辑器形态)
// 覆盖面与 docs/铸造厂UI设计器-设计区规范.md §3 值白名单一致:
//   数值 / 颜色(UI.色彩["键"] 或 UI.色16("#hex")) / 布尔 / 枚举(UI.<常量>) / 四边子字典
// 未列出的键一律只读展示 —— 宁可不改,不猜语义(改不认识的键会破坏"设计器不改看不懂的内容"铁律)。
export type PropKind = 'num' | 'color' | 'enum' | 'bool' | 'insets' | 'readonly';

export interface PropSpec {
  kind: PropKind;
  /** 数值范围(仅约束输入框;生成器不做裁剪,超范围仍照发) */
  min?: number;
  max?: number;
  /** 枚举候选(生成器可直发的值文本) */
  enums?: string[];
  hint?: string;
}

/** UI.色彩 的 12 色键(与 lib/UI/UI.xt:98-110 逐字同步) */
export const COLOR_PALETTE: readonly string[] = [
  '白', '黑', '红', '绿', '蓝', '黄', '灰', '深灰', '浅灰', '透明', '主题', '强调',
];

export const PROP_SPECS: Record<string, PropSpec> = {
  // ---- 几何 ----
  x: { kind: 'num' },
  y: { kind: 'num' },
  宽: { kind: 'num', min: 0 },
  高: { kind: 'num', min: 0 },
  平移x: { kind: 'num' },
  平移y: { kind: 'num' },
  锚: { kind: 'insets', min: 0, max: 1, hint: '比例 0~1;单侧锚定/双侧拉伸,留空表示无该侧' },
  偏: { kind: 'insets', hint: '像素偏移,可为负' },
  内边距: { kind: 'insets', min: 0 },
  外边距: { kind: 'insets', min: 0 },
  弹性: { kind: 'num', min: 0, hint: '份额,0 = 不参与分配' },
  间距: { kind: 'num', min: 0 },
  主轴对齐: { kind: 'enum', enums: ['UI.对齐始', 'UI.对齐中', 'UI.对齐末', 'UI.对齐间', 'UI.对齐均', 'UI.对齐均等'] },
  叉轴对齐: { kind: 'enum', enums: ['UI.叉始', 'UI.叉中', 'UI.叉末', 'UI.叉撑'] },
  // ---- 视觉 ----
  底色: { kind: 'color' },
  底色2: { kind: 'color', hint: '与 底色 同时给出才构成渐变' },
  渐变向: { kind: 'enum', enums: ['"竖"', '"横"'] },
  羽化: { kind: 'num', min: 0, max: 64 },
  阴影: { kind: 'readonly', hint: '阴影为字典/多值形态,请手改代码' },
  圆角: { kind: 'num', min: 0 },
  边框色: { kind: 'color' },
  边框宽: { kind: 'num', min: 0 },
  字色: { kind: 'color' },
  字号: { kind: 'num', min: 6, max: 96 },
  字距: { kind: 'num' },
  字对齐: { kind: 'enum', enums: ['UI.对齐始', 'UI.对齐中', 'UI.对齐末'], hint: '文本在自身盒内的水平落点(需 UI 库 ≥ v1.5.4;只影响文本控件)' },
  不透明度: { kind: 'num', min: 0, max: 100, hint: '0~100' },
  可视: { kind: 'bool', hint: '假 = 不参与布局与命中' },
  裁剪: { kind: 'bool' },
  // ---- 三态覆写(直接键;子字典形态 悬浮/按下/禁用 见只读) ----
  悬底色: { kind: 'color' },
  按底色: { kind: 'color' },
  禁底色: { kind: 'color' },
  悬字色: { kind: 'color' },
  按字色: { kind: 'color' },
  禁字色: { kind: 'color' },
  悬浮: { kind: 'readonly', hint: '三态子字典请手改代码' },
  按下: { kind: 'readonly', hint: '三态子字典请手改代码' },
  禁用: { kind: 'readonly', hint: '三态子字典请手改代码' },
  // ---- 行为 ----
  点击: { kind: 'readonly', hint: '回调名:点画布选中控件后在代码区写同名函,此处不改写' },
  触发: { kind: 'readonly', hint: '连发/首按 等触发模式请手改代码' },
  连发间隔: { kind: 'num', min: 0 },
  首按延迟: { kind: 'num', min: 0 },
};

export function specOf(key: string): PropSpec {
  return PROP_SPECS[key] ?? { kind: 'readonly' };
}

/** 工具箱可选控件(与 spec.ts WIDGETS 同步;顺序 = 面板展示序) */
export const TOOLBOX: ReadonlyArray<{ group: string; widgets: readonly string[] }> = [
  { group: '容器', widgets: ['行', '列', '叠', '绝对', '滚动容器'] },
  { group: '控件', widgets: ['文本', '按钮', '矩形', '图片', '图标按钮', '输入栏', '多行编辑', '空白', '弹性'] },
];
