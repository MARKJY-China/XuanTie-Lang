// 铸造厂可视化 UI 设计器 —— 子集布局引擎(只读画布用)
// 纯函数:输入节点树 + 文本测量回调,输出每个节点的绝对矩形(供 paint.ts 绘制)。
// 规则对齐 UI 库 v1.5.3(指南 §控件详解/§锚点布局):
//   行/列 = 主轴堆叠(间距/弹性/主轴对齐/叉轴对齐/外边距);绝对 = 子项 x/y 直摆、不裁剪;
//   叠 = 子项默认吃满内容槽(可被显式 宽/高 收缩);滚动容器 = 纵向堆叠 + 视口裁剪;
//   锚/偏 = 槽位内比例+像素(双锚拉伸/单锚定点[<0.5 前向,>0.5 后向,=0.5 居中]/无锚左上);
//   平移x/y 叠加;可视=假 设计器仍布局但淡显(与库"直接跳过"不同,便于选中,见 notes)。
// 已知近似(仅影响画布观感,不影响生成文本):文字行高=字号×1.25;按钮/输入栏默认高按常见值;
// 图片在读不到真实尺寸时用占位框;圆角上限等细节从简。
import type { DesignNode, Val } from './parser';

export interface LayoutBox {
  node: DesignNode;
  /** 绝对坐标(相对设计画布左上) */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 滚动容器子树的裁剪区 */
  clip?: { x: number; y: number; w: number; h: number };
  /** 可视=假 → 淡显 */
  dim?: boolean;
}

export interface LayoutResult {
  boxes: LayoutBox[];
  frameW: number;
  frameH: number;
  notes: string[];
}

export interface Measure {
  (text: string, fontSize: number): { w: number; h: number };
}

export const DEFAULT_FRAME = { w: 800, h: 560 };

/**
 * 弹性份额:弹性 控件取其一号实参;其余控件取 弹性 选项(库:两处都可给弹性份额)。
 * 编辑内核(edit.ts)判"主轴尺寸能否手调"也用它,故独立导出,勿与 layoutTree 内各留一份。
 */
export function flexShare(node: DesignNode): number {
  if (node.widget === '弹性') {
    const v = node.args[0];
    return v && v.t === 'num' ? Number(v.raw) || 0 : 0;
  }
  return numOpt(node, '弹性') ?? 0;
}

// ---------- 选项取数 ----------

function opt(node: DesignNode, key: string): Val | undefined {
  return node.options.find(o => o.key === key)?.value;
}

function numOpt(node: DesignNode, key: string): number | undefined {
  const v = opt(node, key);
  if (v && v.t === 'num') {
    const n = Number(v.raw);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function fontSize(node: DesignNode): number {
  return numOpt(node, '字号') ?? 16;
}

/** 外边距/内边距:支持 数字(四边同值)或 四边子字典 {左,上,右,下} */
interface Insets { l: number; t: number; r: number; b: number }

function insetsOf(v: Val | undefined): Insets {
  if (!v) return { l: 0, t: 0, r: 0, b: 0 };
  if (v.t === 'num') {
    const n = Number(v.raw) || 0;
    return { l: n, t: n, r: n, b: n };
  }
  if (v.t === 'dict') {
    const g = (k: string): number => {
      const e = v.entries.find(x => x.key === k);
      return e && e.value.t === 'num' ? Number(e.value.raw) || 0 : 0;
    };
    return { l: g('左'), t: g('上'), r: g('右'), b: g('下') };
  }
  return { l: 0, t: 0, r: 0, b: 0 };
}

function insetsOpt(node: DesignNode, key: string): Insets {
  return insetsOf(opt(node, key));
}

interface Anchor { 左?: number; 上?: number; 右?: number; 下?: number; px: Insets }

function anchorOpt(node: DesignNode): Anchor | undefined {
  const v = opt(node, '锚');
  if (!v || v.t !== 'dict' || v.entries.length === 0) return undefined;
  const num = (k: string): number | undefined => {
    const e = v.entries.find(x => x.key === k);
    return e && e.value.t === 'num' ? Number(e.value.raw) : undefined;
  };
  const a: Anchor = { px: insetsOpt(node, '偏') };
  const l = num('左');
  const t = num('上');
  const r = num('右');
  const b = num('下');
  if (l !== undefined) a.左 = l;
  if (t !== undefined) a.上 = t;
  if (r !== undefined) a.右 = r;
  if (b !== undefined) a.下 = b;
  return a;
}

// ---------- 固有尺寸 ----------

function intrinsic(node: DesignNode, m: Measure): { w: number; h: number } {
  const 内边距 = insetsOpt(node, '内边距');
  switch (node.widget) {
    case '文本': {
      const v = node.args[0];
      const text = v && v.t === 'str' ? v.v : v && v.t === 'stateGet' ? `{${v.key}}` : '';
      const fs = fontSize(node);
      const s = m(text, fs);
      return { w: s.w, h: s.h };
    }
    case '按钮': {
      const v = node.args[0];
      const text = v && v.t === 'str' ? v.v : v && v.t === 'stateGet' ? `{${v.key}}` : '';
      const fs = fontSize(node);
      const s = m(text, fs);
      const pad = opt(node, '内边距') ? 内边距 : { l: 8, t: 8, r: 8, b: 8 };
      return { w: s.w + pad.l + pad.r, h: s.h + pad.t + pad.b };
    }
    case '矩形':
      return { w: 0, h: 0 };
    case '图标按钮':
      return { w: 28, h: 28 };
    case '图片':
      return { w: 100, h: 100 }; // 占位:设计期读不到纹理真实尺寸
    case '输入栏':
      return { w: 240, h: (fontSize(node) + 8) + 内边距.t + 内边距.b };
    case '多行编辑':
      return { w: 420, h: fontSize(node) * 1.25 * 8 + 内边距.t + 内边距.b };
    case '空白':
    case '弹性':
      return { w: 0, h: 0 };
    default: {
      // 容器:行/列/叠/绝对按子项包围盒(粗略),滚动容器按视口
      if (node.widget === '滚动容器') {
        return { w: 300, h: numOpt(node, '高') ?? 200 };
      }
      let w = 0;
      let h = 0;
      for (const ch of node.children) {
        const n = resolvedSize(ch, m);
        w = Math.max(w, n.w + 内边距.l + 内边距.r);
        h = Math.max(h, n.h + 内边距.t + 内边距.b);
      }
      return { w: w + 内边距.l + 内边距.r, h: h + 内边距.t + 内边距.b };
    }
  }
}

/** 节点自身尺寸:显式 宽/高 优先,否则固有 */
function resolvedSize(node: DesignNode, m: Measure): { w: number; h: number } {
  const i = intrinsic(node, m);
  return { w: numOpt(node, '宽') ?? i.w, h: numOpt(node, '高') ?? i.h };
}

// ---------- 槽位内定位(锚/偏) ----------

function axisPlace(
  ratioNear: number | undefined,
  ratioFar: number | undefined,
  pxNear: number,
  pxFar: number,
  slotStart: number,
  slotSize: number,
  explicit: number | undefined,   // 显式 宽/高
  intrinsicV: number,             // 固有尺寸
  fill: boolean,                  // 叠容器语义:未显式时吃满槽位
): { start: number; size: number } {
  const own = explicit ?? intrinsicV;
  if (ratioNear !== undefined && ratioFar !== undefined) {
    // 双锚 = 拉伸
    const a = slotStart + ratioNear * slotSize + pxNear;
    const b = slotStart + ratioFar * slotSize + pxFar;
    return { start: a, size: Math.max(0, b - a) };
  }
  if (ratioNear !== undefined) {
    // 单锚: <0.5 前向; >0.5 后向; =0.5 居中
    let start: number;
    if (ratioNear < 0.5) start = slotStart + ratioNear * slotSize + pxNear;
    else if (ratioNear > 0.5) start = slotStart + ratioNear * slotSize + pxNear - own;
    else start = slotStart + ratioNear * slotSize + pxNear - own / 2;
    return { start, size: own };
  }
  if (ratioFar !== undefined) {
    // 仅远锚(右/下):以远侧比例点为基准定尺寸
    const far = slotStart + ratioFar * slotSize + pxFar;
    const start = ratioFar > 0.5 ? far - own : far;
    return { start, size: own };
  }
  // 无锚:槽位左上 + 自身尺寸(叠容器 fill=真 → 未显式时吃满槽位)
  return { start: slotStart, size: explicit ?? (fill ? slotSize : intrinsicV) };
}

// ---------- 主流程 ----------

export function layoutTree(root: DesignNode, m: Measure): LayoutResult {
  const notes: string[] = [];
  const frameW = numOpt(root, '宽') ?? DEFAULT_FRAME.w;
  const frameH = numOpt(root, '高') ?? DEFAULT_FRAME.h;
  if (numOpt(root, '宽') === undefined || numOpt(root, '高') === undefined) {
    notes.push(`根容器未给 宽/高,按设计基准 ${frameW}×${frameH} 布局`);
  }
  const boxes: LayoutBox[] = [];

  const 平移x = (n: DesignNode): number => numOpt(n, '平移x') ?? 0;
  const 平移y = (n: DesignNode): number => numOpt(n, '平移y') ?? 0;

  /**
   * 把节点摆进"槽位";mode='cell' 表示槽位已由流式布局定量——主轴尺寸直接吃格位(mainAxis 指主轴),
   * 交叉轴为 显式尺寸 > 格位(叉撑);mode='slot' 表示槽位只是可用区(叠/绝对/根),
   * 节点按 显式尺寸→固有→(叠)吃满 决定自身尺寸。
   */
  const place = (node: DesignNode, slot: { x: number; y: number; w: number; h: number }, mode: 'cell' | 'slot', fill: boolean, clip: LayoutBox['clip'] | undefined, dimIn: boolean, mainAxis?: 'x' | 'y'): void => {
    const base = resolvedSize(node, m);
    const 宽显 = mode === 'cell'
      ? (mainAxis === 'x' ? slot.w : (numOpt(node, '宽') ?? slot.w))
      : numOpt(node, '宽');
    const 高显 = mode === 'cell'
      ? (mainAxis === 'y' ? slot.h : (numOpt(node, '高') ?? slot.h))
      : numOpt(node, '高');
    const own = { w: 宽显 ?? base.w, h: 高显 ?? base.h };
    const a = anchorOpt(node);
    const 偏 = a ? a.px : { l: 0, t: 0, r: 0, b: 0 };
    const 水平 = axisPlace(a?.左, a?.右, 偏.l, 偏.r, slot.x, slot.w, 宽显, own.w, fill);
    const 垂直 = axisPlace(a?.上, a?.下, 偏.t, 偏.b, slot.y, slot.h, 高显, own.h, fill);
    const rect = {
      x: 水平.start + 平移x(node),
      y: 垂直.start + 平移y(node),
      w: 水平.size,
      h: 垂直.size,
    };
    const 可视 = opt(node, '可视');
    const dim = dimIn || (可视?.t === 'bool' && 可视.v === false);
    boxes.push({ node, ...rect, clip, dim: dim || undefined });
    // 塌缩提示:带锚/偏 却量出 0 尺寸,十有八九是锚写法有误(如 {上:0,下:0} 退化双锚)
    if ((rect.w <= 0 || rect.h <= 0) && a && notes.length < 6) {
      notes.push(`第 ${node.line} 行 ${node.widget} 尺寸为 0:检查 锚/偏 写法(单锚用一侧;双锚需两侧比例拉开)`);
    }

    // 内容盒(内边距)
    const pad = insetsOpt(node, '内边距');
    const content = { x: rect.x + pad.l, y: rect.y + pad.t, w: Math.max(0, rect.w - pad.l - pad.r), h: Math.max(0, rect.h - pad.t - pad.b) };
    let childClip = clip;
    let childSlot = content;

    if (node.widget === '绝对') {
      // 子项:无锚 → 自身 x/y 直摆(平移由 place 统一叠加);带锚 → 相对容器内容盒定位(锚的本义)
      for (const ch of node.children) {
        if (anchorOpt(ch)) {
          placeIntoCell(ch, content, 'slot', false, childClip, dim);
          continue;
        }
        const o = resolvedSize(ch, m);
        const cx = content.x + (numOpt(ch, 'x') ?? 0);
        const cy = content.y + (numOpt(ch, 'y') ?? 0);
        placeIntoCell(ch, { x: cx, y: cy, w: o.w, h: o.h }, 'slot', false, childClip, dim);
      }
      return;
    }
    if (node.widget === '叠') {
      for (const ch of node.children) placeIntoCell(ch, content, 'slot', true, childClip, dim);
      return;
    }
    if (node.widget === '滚动容器') {
      const vh = numOpt(node, '高') ?? 200;
      const view = { x: content.x, y: content.y, w: content.w, h: vh };
      childClip = { x: view.x, y: view.y, w: view.w, h: view.h };
      childSlot = view;
    }
    if (node.widget === '行' || node.widget === '列' || node.widget === '滚动容器') {
      layoutFlow(node, node.widget !== '列' && node.widget !== '滚动容器', childSlot, childClip, dim);
      return;
    }
    // 叶子(文本/按钮/…):无子项
  };

  /** 把子节点放进"格子" */
  const placeIntoCell = (node: DesignNode, cell: { x: number; y: number; w: number; h: number }, mode: 'cell' | 'slot', fill: boolean, clip: LayoutBox['clip'] | undefined, dim: boolean, mainAxis?: 'x' | 'y'): void => {
    place(node, cell, mode, fill, clip, dim, mainAxis);
  };

  /** 行/列/滚动容器:主轴堆叠 */
  const layoutFlow = (node: DesignNode, horizontal: boolean, slot: { x: number; y: number; w: number; h: number }, clip: LayoutBox['clip'] | undefined, dim: boolean): void => {
    const gap = numOpt(node, '间距') ?? 0;
    const kids = node.children;
    const mainSlot = horizontal ? slot.w : slot.h;
    const crossSlot = horizontal ? slot.h : slot.w;

    const mains: number[] = [];
    const margins: Insets[] = [];
    const flexes: number[] = [];
    for (const ch of kids) {
      const o = resolvedSize(ch, m);
      mains.push(horizontal ? o.w : o.h);
      const mg = insetsOpt(ch, '外边距');
      // 外边距对锚定节点不适用(库行为);此处按是否存在锚决定是否计入
      margins.push(anchorOpt(ch) ? { l: 0, t: 0, r: 0, b: 0 } : mg);
      flexes.push(flexShare(ch));
    }
    const base = mains.reduce((s, v, i) => s + v + (horizontal ? margins[i].l + margins[i].r : margins[i].t + margins[i].b), 0) + gap * Math.max(0, kids.length - 1);
    let leftover = Math.max(0, mainSlot - base);
    const flexSum = flexes.reduce((s, v) => s + v, 0);
    if (flexSum > 0) {
      for (let i = 0; i < kids.length; i++) {
        if (flexes[i] > 0) mains[i] += (leftover * flexes[i]) / flexSum;
      }
      leftover = 0;
    }
    // 主轴对齐
    const align = (opt(node, '主轴对齐') as { t: 'str'; v: string } | undefined)?.v ?? '始';
    let cursor = horizontal ? slot.x : slot.y;
    let step = gap;
    if (leftover > 0) {
      if (align === '中') cursor += leftover / 2;
      else if (align === '末') cursor += leftover;
      else if (align === '间') step = gap + leftover / Math.max(1, kids.length - 1);
      else if (align === '均' || align === '均等') {
        step = gap + leftover / kids.length;
        cursor += leftover / (2 * kids.length);
      }
    }
    const crossAlign = (opt(node, '叉轴对齐') as { t: 'str'; v: string } | undefined)?.v ?? '叉撑';
    for (let i = 0; i < kids.length; i++) {
      const ch = kids[i];
      const mg = margins[i];
      const mainStart = cursor + (horizontal ? mg.l : mg.t);
      let cellCross = 0;
      let crossStart = horizontal ? slot.y : slot.x;
      if (crossAlign === '叉撑') cellCross = crossSlot;
      else {
        const o = resolvedSize(ch, m);
        const cs = horizontal ? o.h : o.w;
        cellCross = cs;
        if (crossAlign === '叉中') crossStart += (crossSlot - cs) / 2;
        else if (crossAlign === '叉末') crossStart += crossSlot - cs;
      }
      const cell = horizontal
        ? { x: mainStart, y: crossStart, w: mains[i], h: cellCross }
        : { x: crossStart, y: mainStart, w: cellCross, h: mains[i] };
      placeIntoCell(ch, cell, 'cell', false, clip, dim, horizontal ? 'x' : 'y');
      cursor = mainStart + mains[i] + (horizontal ? mg.r : mg.b);
      if (i < kids.length - 1) cursor += step;
    }
  };

  place(root, { x: 0, y: 0, w: frameW, h: frameH }, 'slot', true, undefined, false);
  return { boxes, frameW, frameH, notes };
}
