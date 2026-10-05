// 铸造厂可视化 UI 设计器 —— 画布绘制(纯 DOM,不依赖玄铁运行时)
// 以嵌套 div 复刻 UI 库观感:底色/圆角/边框/字号字色/不透明度/裁剪/淡显(可视=假)。
// 文本与输入栏用文案/占位显示;状态绑定以 {键} 形式标出(斜体强调);图片/图标按钮为占位块。
// 命中:每个盒子带 data-ix;点击由 panel 统一处理。
import type { DesignNode, Val } from './parser';
import type { LayoutBox, LayoutResult } from './layout';

/** UI.色彩 12 色板(与 lib/UI/UI.xt 同步;库改色板须同步此处) */
const PALETTE: Record<string, string> = {
  白: 'rgba(255,255,255,1)',
  黑: 'rgba(0,0,0,1)',
  红: 'rgba(255,80,80,1)',
  绿: 'rgba(80,220,80,1)',
  蓝: 'rgba(80,120,255,1)',
  黄: 'rgba(255,220,60,1)',
  灰: 'rgba(140,140,140,1)',
  深灰: 'rgba(50,50,50,1)',
  浅灰: 'rgba(220,220,220,1)',
  透明: 'rgba(0,0,0,0)',
  主题: 'rgba(70,130,220,1)',
  强调: 'rgba(255,140,40,1)',
};

function optVal(node: DesignNode, key: string): Val | undefined {
  return node.options.find(o => o.key === key)?.value;
}
function numOf(node: DesignNode, key: string): number | undefined {
  const v = optVal(node, key);
  return v && v.t === 'num' ? Number(v.raw) : undefined;
}
function colorOf(v: Val | undefined): string | undefined {
  return v && v.t === 'colorConst' ? PALETTE[v.key] : undefined;
}

function textNode(host: HTMLElement, text: string, node: DesignNode, center: boolean): void {
  const s = document.createElement('span');
  s.className = 'ds-label';
  s.textContent = text;
  if (center) s.classList.add('ds-center');
  const fs = numOf(node, '字号') ?? 16;
  s.style.fontSize = fs + 'px';
  const fc = colorOf(optVal(node, '字色'));
  if (fc) s.style.color = fc;
  // 字对齐(库 v1.5.4):文本在自身盒内的水平落点;仅 文本 控件吃这个键(按钮恒居中)
  if (!center) {
    const align = optVal(node, '字对齐');
    const key = align && align.t === 'libConst' ? align.name : align && align.t === 'str' ? align.v : '';
    const css = key === 'UI.对齐中' || key === '中' ? 'center' : key === 'UI.对齐末' || key === '末' ? 'right' : '';
    if (css) {
      host.style.textAlign = css;
      s.style.width = '100%';
    }
  }
  host.appendChild(s);
}

/** 叶子文案:字面量原文 / 状态绑定 {键}(斜体强调) */
function leafLabel(node: DesignNode): { text: string; dynamic: boolean } {
  const v = node.args[0];
  if (v && v.t === 'str') return { text: v.v, dynamic: false };
  if (v && v.t === 'stateGet') return { text: `{${v.key}}`, dynamic: true };
  return { text: '', dynamic: false };
}

export interface PaintResult {
  /** data-ix → 节点(面板用于命中回查) */
  nodes: DesignNode[];
  /** data-ix → 盒子元素(拖拽预览改 transform/尺寸用) */
  els: HTMLElement[];
  /** 节点 → 布局矩形(拖拽算增量、吸附取参考线用) */
  boxes: Map<DesignNode, LayoutBox>;
  /** 画布框(参考线挂载点) */
  frame: HTMLElement;
}

/** 八角缩放手柄(顺序即 DOM 顺序;data-h 命中用) */
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;

export function paintDesign(host: HTMLElement, laid: LayoutResult, selected: DesignNode | null, onPick: (n: DesignNode) => void): PaintResult {
  host.innerHTML = '';
  const byNode = new Map<DesignNode, LayoutBox>();
  for (const b of laid.boxes) byNode.set(b.node, b);
  const nodes: DesignNode[] = [];
  const els: HTMLElement[] = [];

  const frame = document.createElement('div');
  frame.className = 'ds-frame';
  frame.style.width = laid.frameW + 'px';
  frame.style.height = laid.frameH + 'px';

  const build = (node: DesignNode, ox: number, oy: number): HTMLElement => {
    const b = byNode.get(node);
    const el = document.createElement('div');
    el.className = 'ds-node';
    if (!b) {
      // 兜底(理论不可达):0 尺寸占位,避免画布缺节点且不崩
      el.style.left = '0px';
      el.style.top = '0px';
    } else {
      el.style.left = b.x - ox + 'px';
      el.style.top = b.y - oy + 'px';
      el.style.width = Math.max(0, b.w) + 'px';
      el.style.height = Math.max(0, b.h) + 'px';
    }
    el.dataset.ix = String(nodes.length);
    el.dataset.w = node.widget;
    els.push(el);
    nodes.push(node);

    const bg = colorOf(optVal(node, '底色'));
    if (bg) el.style.background = bg;
    const r = numOf(node, '圆角');
    if (r) el.style.borderRadius = r + 'px';
    const bw = numOf(node, '边框宽');
    if (bw) el.style.border = `${bw}px solid ${colorOf(optVal(node, '边框色')) ?? 'rgba(255,255,255,.25)'}`;
    const op = numOf(node, '不透明度');
    if (op !== undefined) el.style.opacity = String(Math.max(0, Math.min(1, op / 100)));
    if (b?.dim) el.style.opacity = '0.3';
    if (b?.clip) el.style.overflow = 'hidden';

    switch (node.widget) {
      case '文本': {
        const l = leafLabel(node);
        textNode(el, l.text, node, false);
        if (l.dynamic) (el.firstChild as HTMLElement).classList.add('ds-dyn');
        break;
      }
      case '按钮': {
        const l = leafLabel(node);
        textNode(el, l.text, node, true);
        if (l.dynamic) (el.firstChild as HTMLElement).classList.add('ds-dyn');
        break;
      }
      case '输入栏':
      case '多行编辑': {
        const key = node.args[1];
        const 占位 = optVal(node, '占位');
        const text = 占位 && 占位.t === 'str' ? 占位.v : key && key.t === 'str' ? key.v : '';
        const s = document.createElement('span');
        s.className = 'ds-label ds-placeholder';
        s.textContent = text;
        el.appendChild(s);
        break;
      }
      case '图片':
      case '图标按钮': {
        const s = document.createElement('span');
        s.className = 'ds-label ds-ph';
        s.textContent = '▣';
        el.appendChild(s);
        break;
      }
      case '弹性': {
        el.classList.add('ds-guide');
        const s = document.createElement('span');
        s.className = 'ds-guide-tag';
        s.textContent = '弹性';
        el.appendChild(s);
        break;
      }
      case '空白':
        el.classList.add('ds-guide');
        break;
      default:
        break;
    }

    if (node === selected) {
      el.classList.add('ds-sel');
      // 八角手柄:命中落点用;是否可用(锁定轴/根)由面板在拖拽开始时判定
      for (const h of HANDLES) {
        const hp = document.createElement('div');
        hp.className = 'ds-h ds-h-' + h;
        hp.dataset.h = h;
        el.appendChild(hp);
      }
    }
    if (b) {
      for (const ch of node.children) el.appendChild(build(ch, b.x, b.y));
    }
    return el;
  };

  const rootBox = laid.boxes[0];
  if (rootBox) frame.appendChild(build(rootBox.node, 0, 0));
  frame.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null;
    const el = t?.closest('[data-ix]') as HTMLElement | null;
    if (!el) return;
    const ix = Number(el.dataset.ix);
    const n = nodes[ix];
    if (n) onPick(n);
  });
  host.appendChild(frame);
  return { nodes, els, boxes: byNode, frame };
}
