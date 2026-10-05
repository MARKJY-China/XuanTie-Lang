// 铸造厂可视化 UI 设计器 —— 编辑内核(切片 3;纯函数,不碰 DOM,全部可单测)
// 编辑只改六类键:x / y / 宽 / 高 / 平移x / 平移y —— 均在设计区子集内,
// 写回文本一律由 generator 重发(规范序、无尾随逗号),绝不手工拼字符串。
//
// 语义依据(lib/UI/UI.xt v1.5.3,与 layout.ts 引擎逐条对齐):
//   · 平移 是最终位置的加项(_布x = x + 平移x),不影响兄弟布局 → 任何有父的节点都能靠它移动;
//   · 绝对容器的非锚定子项按 x/y 直摆(相对容器内容盒)→ 移动写 x/y(增量语义与基准无关);
//   · 锚定节点忽略 x/y,只认 锚/偏 → 移动写 平移;
//   · 双锚轴(左+右 / 上+下)尺寸由两锚点决定,显式 宽/高 不生效 → 该轴禁改尺寸;
//   · 行/列/滚动容器 主轴格子尺寸源自子项自身尺寸,有弹性份额时还会加分配量 →
//     无弹性可改(渲染尺寸随 宽/高 走),有弹性禁改(改了看不出来,宁拦不静默)。
import type { DesignNode, Val } from './parser';
import { flexShare } from './layout';

/** 尺寸下限(px):缩放到 0 会让节点不可再选中 */
export const MIN_SIZE = 8;

// ---------------------------------------------------------------- 选项读写

export function numOpt(node: DesignNode, key: string): number | undefined {
  const v = node.options.find((o) => o.key === key)?.value;
  return v && v.t === 'num' ? Number(v.raw) : undefined;
}

export function hasOpt(node: DesignNode, key: string): boolean {
  return node.options.some((o) => o.key === key);
}

/** 数字发射格式:整数不带小数点;小数最多两位、去尾零(x: 12 / x: -4.5) */
export function fmtNum(n: number): string {
  const r = Math.round(n * 100) / 100;
  return String(r);
}

/** 增/改数字选项(保持 options 数组,排序交给 generator) */
export function setNumOpt(node: DesignNode, key: string, n: number): void {
  const v: Val = { t: 'num', raw: fmtNum(n) };
  const i = node.options.findIndex((o) => o.key === key);
  if (i >= 0) node.options[i] = { key, value: v };
  else node.options.push({ key, value: v });
}

/** 增量改数字选项:delta 为 0 且键原本不存在 → 不动(避免留下 "平移x": 0 噪声) */
export function bumpNumOpt(node: DesignNode, key: string, delta: number): boolean {
  if (delta === 0 && !hasOpt(node, key)) return false;
  setNumOpt(node, key, (numOpt(node, key) ?? 0) + delta);
  return true;
}

// ---------------------------------------------------------------- 树结构

export function findParent(root: DesignNode, target: DesignNode): DesignNode | null {
  for (const ch of root.children) {
    if (ch === target) return root;
    const r = findParent(ch, target);
    if (r) return r;
  }
  return null;
}

/** 根到节点的子项下标路径(重解析后按路径还原选中;空数组 = 根自身) */
export function findPath(root: DesignNode, target: DesignNode): number[] | null {
  if (root === target) return [];
  for (let i = 0; i < root.children.length; i++) {
    const p = findPath(root.children[i], target);
    if (p) return [i, ...p];
  }
  return null;
}

/** 按路径取节点(路径失效返 null) */
export function nodeAtPath(root: DesignNode, path: number[]): DesignNode | null {
  let cur: DesignNode = root;
  for (const i of path) {
    const next = cur.children[i];
    if (!next) return null;
    cur = next;
  }
  return cur;
}

export type LevelOp = 'up' | 'down' | 'top' | 'bottom';

/**
 * 层级操作:改节点在父 children 里的次序。
 * 叠/绝对 中 children 序 = 绘制序(末位在最上层);行/列/滚动容器 中 = 排布序。
 * 'top' 移到末尾(叠/绝对 = 最上层),'bottom' 移到开头。
 */
export function levelOp(root: DesignNode, node: DesignNode, op: LevelOp): boolean {
  const p = findParent(root, node);
  if (!p) return false; // 根无层级
  const arr = p.children;
  const i = arr.indexOf(node);
  if (i < 0) return false;
  switch (op) {
    case 'up':
      if (i === 0) return false;
      [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
      return true;
    case 'down':
      if (i === arr.length - 1) return false;
      [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
      return true;
    case 'bottom':
      if (i === 0) return false;
      arr.splice(i, 1);
      arr.unshift(node);
      return true;
    case 'top':
      if (i === arr.length - 1) return false;
      arr.splice(i, 1);
      arr.push(node);
      return true;
  }
}

// ---------------------------------------------------------------- 几何判定

export function hasAnchor(node: DesignNode): boolean {
  return hasOpt(node, '锚');
}

/** 锚双挂(拉伸)轴:该轴尺寸由两侧锚点决定,显式 宽/高 不生效 */
export function stretchedAxes(node: DesignNode): { x: boolean; y: boolean } {
  const a = node.options.find((o) => o.key === '锚')?.value;
  if (!a || a.t !== 'dict') return { x: false, y: false };
  const has = (k: string): boolean => a.entries.some((e) => e.key === k);
  return { x: has('左') && has('右'), y: has('上') && has('下') };
}

/** 位置写入方式:'xy' = 写 x/y(绝对容器非锚定子项);'offset' = 写 平移x/平移y;'none' = 根 */
export type MoveMode = 'xy' | 'offset' | 'none';

export function moveMode(node: DesignNode, parent: DesignNode | null): MoveMode {
  if (!parent) return 'none';
  if (hasAnchor(node)) return 'offset';
  if (parent.widget === '绝对') return 'xy';
  return 'offset';
}

/**
 * 尺寸不可手调的轴:
 *   双锚轴(hidden 尺寸由锚点决定)+ 有弹性份额的流式主轴(份额吃掉增量,改了看不出来)。
 */
export function lockedAxes(node: DesignNode, parent: DesignNode | null): { x: boolean; y: boolean } {
  const s = stretchedAxes(node);
  let lx = s.x;
  let ly = s.y;
  if (parent && flexShare(node) > 0) {
    if (parent.widget === '行') lx = true;
    else if (parent.widget === '列' || parent.widget === '滚动容器') ly = true;
  }
  return { x: lx, y: ly };
}

// ---------------------------------------------------------------- 移动

/** 移动节点:dx/dy 为本次拖拽增量,writes 依 moveMode 落到 x/y 或 平移x/平移y */
export function applyMove(node: DesignNode, mode: MoveMode, dx: number, dy: number): boolean {
  const rx = Math.round(dx);
  const ry = Math.round(dy);
  if (mode === 'none') return false;
  if (mode === 'xy') {
    const a = bumpNumOpt(node, 'x', rx);
    const b = bumpNumOpt(node, 'y', ry);
    return a || b;
  }
  const a = bumpNumOpt(node, '平移x', rx);
  const b = bumpNumOpt(node, '平移y', ry);
  return a || b;
}

// ---------------------------------------------------------------- 吸附

export interface Rect { x: number; y: number; w: number; h: number }
/** 参考线:axis='x' 竖线(pos 为 x 坐标),axis='y' 横线;from/to 为线段两端(画布坐标) */
export interface Guide { axis: 'x' | 'y'; pos: number; from: number; to: number }

export interface SnapResult { dx: number; dy: number; guides: Guide[] }

function linesOf(r: Rect, axis: 'x' | 'y'): number[] {
  return axis === 'x' ? [r.x, r.x + r.w / 2, r.x + r.w] : [r.y, r.y + r.h / 2, r.y + r.h];
}

/** 节点自身在 axis 上的三条线里离 target 线最近的一条 → {delta, 目标线} */
function bestSnap(own: number[], targets: number[], thr: number): { delta: number; pos: number } | null {
  let best: { delta: number; pos: number } | null = null;
  for (const t of targets) {
    for (const o of own) {
      const d = t - o;
      if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, pos: t };
    }
  }
  return best;
}

/**
 * 拖拽吸附:把"当前矩形 + 原始增量"摆放出的矩形,与参考矩形(兄弟/父容器)的
 * 边与中线做对位(阈值 thr 内取最近一条),返回修正后的增量与参考线。
 */
export function snapMove(box: Rect, targets: Rect[], dx: number, dy: number, thr: number): SnapResult {
  const p: Rect = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h };
  const guides: Guide[] = [];
  let ax = dx;
  let ay = dy;
  const tx: number[] = [];
  const ty: number[] = [];
  for (const t of targets) {
    tx.push(...linesOf(t, 'x'));
    ty.push(...linesOf(t, 'y'));
  }
  const sx = bestSnap(linesOf(p, 'x'), tx, thr);
  if (sx) {
    ax = dx + sx.delta;
    const span = spanOf(p, targets, 'x', sx.pos);
    guides.push({ axis: 'x', pos: sx.pos, from: span.from, to: span.to });
  }
  const sy = bestSnap(linesOf(p, 'y'), ty, thr);
  if (sy) {
    ay = dy + sy.delta;
    const span = spanOf(p, targets, 'y', sy.pos);
    guides.push({ axis: 'y', pos: sy.pos, from: span.from, to: span.to });
  }
  return { dx: ax, dy: ay, guides };
}

/** 参考线绘制跨度:覆盖被拖矩形与所有"压线"参考矩形的投影并集(留 6px 余量) */
function spanOf(p: Rect, targets: Rect[], axis: 'x' | 'y', pos: number): { from: number; to: number } {
  const lo = axis === 'x' ? p.y : p.x;
  const hi = axis === 'x' ? p.y + p.h : p.x + p.w;
  let from = lo;
  let to = hi;
  for (const t of targets) {
    const lines = linesOf(t, axis === 'x' ? 'x' : 'y');
    if (!lines.some((v) => Math.abs(v - pos) < 0.5)) continue;
    const tlo = axis === 'x' ? t.y : t.x;
    const thi = axis === 'x' ? t.y + t.h : t.x + t.w;
    from = Math.min(from, tlo);
    to = Math.max(to, thi);
  }
  return { from: from - 6, to: to + 6 };
}

// ---------------------------------------------------------------- 缩放

export type HandleCode = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
/** 手柄是否改变左/上边(需同时移动节点原点,根与不可移动节点不给这类手柄) */
export function handleMovesNearEdge(h: HandleCode): boolean {
  return h.includes('w') || h.includes('n');
}

/** 该手柄压到的轴 */
export function handleAxes(h: HandleCode): { x: boolean; y: boolean } {
  return { x: h.includes('e') || h.includes('w'), y: h.includes('s') || h.includes('n') };
}

/**
 * 缩放手柄落点 → 写 宽/高(必要时按 moveMode 移动原点,保证被拖边跟手)。
 * box 为该节点当前布局矩形(增量基准);锁定的轴整体忽略。
 * 返回是否发生了写入。
 */
export function applyResize(
  node: DesignNode,
  mode: MoveMode,
  box: Rect,
  handle: HandleCode,
  dx: number,
  dy: number,
  locked: { x: boolean; y: boolean },
): boolean {
  const axes = handleAxes(handle);
  let changed = false;
  if (axes.x && !locked.x) {
    const base = numOpt(node, '宽') ?? box.w;
    if (handle.includes('e')) {
      setNumOpt(node, '宽', Math.max(MIN_SIZE, base + dx));
      changed = true;
    } else if (handle.includes('w') && mode !== 'none') {
      const w = Math.max(MIN_SIZE, base - dx);
      const used = base - w; // 触底截断时实际吃进的量(拖左边缘:边缘位移 = 宽收缩量)
      if (mode === 'xy') bumpNumOpt(node, 'x', used);
      else bumpNumOpt(node, '平移x', used);
      setNumOpt(node, '宽', w);
      changed = true;
    }
  }
  if (axes.y && !locked.y) {
    const base = numOpt(node, '高') ?? box.h;
    if (handle.includes('s')) {
      setNumOpt(node, '高', Math.max(MIN_SIZE, base + dy));
      changed = true;
    } else if (handle.includes('n') && mode !== 'none') {
      const h = Math.max(MIN_SIZE, base - dy);
      const used = base - h;
      if (mode === 'xy') bumpNumOpt(node, 'y', used);
      else bumpNumOpt(node, '平移y', used);
      setNumOpt(node, '高', h);
      changed = true;
    }
  }
  return changed;
}

/**
 * 缩放的吸附:把"被拖的那条边"对到参考矩形边/中线(阈值内),返回修正增量与参考线。
 * 只吸附正在动的边,不动边不参与(否则会看到尺寸莫名跳动)。
 */
export function snapResize(box: Rect, targets: Rect[], handle: HandleCode, dx: number, dy: number, thr: number): SnapResult {
  const guides: Guide[] = [];
  let ax = dx;
  let ay = dy;
  const tx: number[] = [];
  const ty: number[] = [];
  for (const t of targets) {
    tx.push(...linesOf(t, 'x'));
    ty.push(...linesOf(t, 'y'));
  }
  if (handle.includes('e') || handle.includes('w')) {
    const edge = handle.includes('e') ? box.x + box.w + dx : box.x + dx;
    const best = bestSnap([edge], tx, thr);
    if (best) {
      ax = dx + best.delta;
      guides.push({ axis: 'x', pos: best.pos, from: box.y - 6, to: box.y + box.h + 6 });
    }
  }
  if (handle.includes('n') || handle.includes('s')) {
    const edge = handle.includes('s') ? box.y + box.h + dy : box.y + dy;
    const best = bestSnap([edge], ty, thr);
    if (best) {
      ay = dy + best.delta;
      guides.push({ axis: 'y', pos: best.pos, from: box.x - 6, to: box.x + box.w + 6 });
    }
  }
  return { dx: ax, dy: ay, guides };
}
