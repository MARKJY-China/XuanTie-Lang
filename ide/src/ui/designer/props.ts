// 铸造厂可视化 UI 设计器 —— 属性面板元数据(键 → 编辑器形态 / 分组 / 逐控件可用键)
// 覆盖面与 docs/铸造厂UI设计器-设计区规范.md §3 值白名单一致:
//   数值 / 颜色(UI.色彩["键"] 或 UI.色16("#hex") 或 UI.色(r,g,b,a)) / 布尔 / 枚举(UI.<常量>) / 四边子字典
// 未列出的键一律只读展示 —— 宁可不改,不猜语义(改不认识的键会破坏"设计器不改看不懂的内容"铁律)。
//
// WIDGET_KEYS 是"该控件写哪些键才有用"的矩阵,依据 lib/UI/UI.xt 的读取点逐个核对:
//   · 字对齐/字号/字色 → 仅 文本 的绘制分支(lib v1.5.4;字距 在 文本 路径是硬编码 1,故文本不列,
//     只有 输入栏/多行编辑 吃 字距);
//   · 图标尺寸/图标色 → 图片/图标按钮(lib:420/466-468);
//   · 底色/圆角/边框/三态/行为 → 全控件通用(lib 合选项 无类型判断);
//   · 弹性和间距 由父容器读取(行/列/滚动容器),但任意节点都能带 弹性 份额。
// 依据不到位的键宁可不出现在"＋属性"菜单里 —— 未知键在玄铁里不报错、静默忽略,菜单给错就是骗人。
export type PropKind = 'num' | 'color' | 'enum' | 'bool' | 'insets' | 'readonly';

/** 面板分组(Godot 检视器式的分类栏;顺序即展示序) */
export type PropGroup = '几何' | '文字' | '视觉' | '图标' | '三态覆写' | '行为';

export const GROUP_ORDER: readonly PropGroup[] = ['几何', '文字', '视觉', '图标', '三态覆写', '行为'];

export interface PropSpec {
  kind: PropKind;
  group: PropGroup;
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
  x: { kind: 'num', group: '几何' },
  y: { kind: 'num', group: '几何' },
  宽: { kind: 'num', group: '几何', min: 0 },
  高: { kind: 'num', group: '几何', min: 0 },
  平移x: { kind: 'num', group: '几何' },
  平移y: { kind: 'num', group: '几何' },
  锚: { kind: 'insets', group: '几何', min: 0, max: 1, hint: '比例 0~1;单侧锚定/双侧拉伸,留空表示无该侧' },
  偏: { kind: 'insets', group: '几何', hint: '像素偏移,可为负' },
  内边距: { kind: 'insets', group: '几何', min: 0 },
  外边距: { kind: 'insets', group: '几何', min: 0 },
  弹性: { kind: 'num', group: '几何', min: 0, hint: '份额,0 = 不参与分配(由父容器读取)' },
  间距: { kind: 'num', group: '几何', min: 0, hint: '仅 行/列/滚动容器 读取' },
  主轴对齐: { kind: 'enum', group: '几何', enums: ['UI.对齐始', 'UI.对齐中', 'UI.对齐末', 'UI.对齐间', 'UI.对齐均', 'UI.对齐均等'], hint: '仅 行/列/滚动容器 读取' },
  叉轴对齐: { kind: 'enum', group: '几何', enums: ['UI.叉始', 'UI.叉中', 'UI.叉末', 'UI.叉撑'] },
  // ---- 文字 ----
  字色: { kind: 'color', group: '文字' },
  字号: { kind: 'num', group: '文字', min: 6, max: 96 },
  字距: { kind: 'num', group: '文字', hint: '仅 输入栏/多行编辑 读取(文本控件由库硬编码 1)' },
  字对齐: { kind: 'enum', group: '文字', enums: ['UI.对齐始', 'UI.对齐中', 'UI.对齐末'], hint: '仅 文本 读取(按钮恒居中);需 UI 库 ≥ v1.5.4' },
  // ---- 视觉 ----
  底色: { kind: 'color', group: '视觉' },
  底色2: { kind: 'color', group: '视觉', hint: '与 底色 同时给出才构成渐变' },
  渐变向: { kind: 'enum', group: '视觉', enums: ['"竖"', '"横"'] },
  羽化: { kind: 'num', group: '视觉', min: 0, max: 64 },
  阴影: { kind: 'readonly', group: '视觉', hint: '阴影为字典/多值形态,请手改代码' },
  圆角: { kind: 'num', group: '视觉', min: 0 },
  边框色: { kind: 'color', group: '视觉' },
  边框宽: { kind: 'num', group: '视觉', min: 0 },
  不透明度: { kind: 'num', group: '视觉', min: 0, max: 100, hint: '0~100' },
  可视: { kind: 'bool', group: '视觉', hint: '假 = 不参与布局与命中' },
  裁剪: { kind: 'bool', group: '视觉' },
  // ---- 图标(图片/图标按钮) ----
  图标尺寸: { kind: 'num', group: '图标', min: 0, hint: '0 = 自动(按控件 宽/高)' },
  图标色: { kind: 'color', group: '图标', hint: 'tint;透明 = 不染色' },
  // ---- 三态覆写(直接键;子字典形态 悬浮/按下/禁用 见只读) ----
  悬底色: { kind: 'color', group: '三态覆写' },
  按底色: { kind: 'color', group: '三态覆写' },
  禁底色: { kind: 'color', group: '三态覆写' },
  悬字色: { kind: 'color', group: '三态覆写' },
  按字色: { kind: 'color', group: '三态覆写' },
  禁字色: { kind: 'color', group: '三态覆写' },
  悬浮: { kind: 'readonly', group: '三态覆写', hint: '三态子字典请手改代码' },
  按下: { kind: 'readonly', group: '三态覆写', hint: '三态子字典请手改代码' },
  禁用: { kind: 'readonly', group: '三态覆写', hint: '三态子字典请手改代码' },
  // ---- 行为 ----
  点击: { kind: 'readonly', group: '行为', hint: '回调名:点画布选中控件后在代码区写同名函,此处不改写' },
  触发: { kind: 'readonly', group: '行为', hint: '连发/首按 等触发模式请手改代码' },
  连发间隔: { kind: 'num', group: '行为', min: 0 },
  首按延迟: { kind: 'num', group: '行为', min: 0 },
};

export function specOf(key: string): PropSpec {
  return PROP_SPECS[key] ?? { kind: 'readonly', group: '视觉' };
}

// ---------------------------------------------------------------- 逐控件可用键

const 几何 = ['x', 'y', '宽', '高', '锚', '偏', '平移x', '平移y', '外边距', '内边距', '弹性'];
const 三态 = ['悬底色', '按底色', '禁底色', '悬字色', '按字色', '禁字色'];
const 行为 = ['点击', '触发', '连发间隔', '首按延迟'];
const 字块 = ['字色', '字号'];
const 视觉块 = ['底色', '底色2', '渐变向', '羽化', '圆角', '边框色', '边框宽', '不透明度', '可视', '裁剪'];
const 容器块 = ['间距', '主轴对齐', '叉轴对齐'];

/** 控件 → 可写键(顺序即"＋属性"菜单分组序;组内按此序) */
export const WIDGET_KEYS: Record<string, readonly string[]> = {
  文本: [...几何, ...字块, '字对齐', ...视觉块, ...三态, ...行为],
  按钮: [...几何, ...字块, ...视觉块, ...三态, ...行为],
  输入栏: [...几何, ...字块, '字距', ...视觉块, ...三态, ...行为],
  多行编辑: [...几何, ...字块, '字距', ...视觉块, ...三态, ...行为],
  矩形: [...几何, ...视觉块, ...三态, ...行为],
  图片: [...几何, ...视觉块, '图标尺寸', '图标色', ...三态, ...行为],
  图标按钮: [...几何, ...视觉块, '图标尺寸', '图标色', ...三态, ...行为],
  空白: ['x', 'y', '宽', '高', '锚', '偏', '平移x', '平移y', '内边距', '外边距', '不透明度', '可视'],
  弹性: ['x', 'y', '宽', '高', '锚', '偏', '平移x', '平移y', '外边距', '弹性', '不透明度', '可视'],
  行: [...几何, ...容器块, ...视觉块, ...三态, ...行为],
  列: [...几何, ...容器块, ...视觉块, ...三态, ...行为],
  叠: [...几何, ...容器块, ...视觉块, ...三态, ...行为],
  绝对: [...几何, ...容器块, ...视觉块, ...三态, ...行为],
  滚动容器: [...几何, ...容器块, ...视觉块, ...三态, ...行为],
};

/** 该控件还没写的可写键(供"＋属性"菜单;只读键永不出现在菜单里) */
export function addableKeys(widget: string, present: readonly string[]): string[] {
  const keys = WIDGET_KEYS[widget] ?? 几何;
  const have = new Set(present);
  return keys.filter((k) => !have.has(k) && PROP_SPECS[k] !== undefined && PROP_SPECS[k].kind !== 'readonly');
}

/** 工具箱可选控件(与 spec.ts WIDGETS 同步;顺序 = 面板展示序) */
export const TOOLBOX: ReadonlyArray<{ group: string; widgets: readonly string[] }> = [
  { group: '容器', widgets: ['行', '列', '叠', '绝对', '滚动容器'] },
  { group: '控件', widgets: ['文本', '按钮', '矩形', '图片', '图标按钮', '输入栏', '多行编辑', '空白', '弹性'] },
];
