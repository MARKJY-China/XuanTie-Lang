// DOM 骨架与面板尺寸分割条(纯 DOM,无框架)
export interface LayoutHandles {
  app: HTMLElement;
  toolbar: HTMLElement;
  sidebar: HTMLElement;
  sidebarTitle: HTMLElement;
  btnRefreshTree: HTMLElement;
  treeHost: HTMLElement;
  sidebarSplit: HTMLElement;
  tabbar: HTMLElement;
  monacoHost: HTMLElement;
  welcome: HTMLElement;
  welcomeRec: HTMLElement;
  bottomPanel: HTMLElement;
  bottomSplit: HTMLElement;
  btabTerm: HTMLElement;
  btabProblems: HTMLElement;
  termSessionBar: HTMLElement;
  termHost: HTMLElement;
  problemsHost: HTMLElement;
  statusbar: HTMLElement;
}

const TEMPLATE = `
<div id="toolbar">
  <span class="logo">◈ 玄铁铸造厂</span>
  <button class="tbtn" id="btn-open">打开文件夹</button>
  <button class="tbtn" id="btn-new">新建工程</button>
  <div class="sep"></div>
  <button class="tbtn primary" id="btn-run">▶ 运行</button>
  <button class="tbtn" id="btn-stop">■ 停止</button>
  <div class="sep"></div>
  <div class="menu-anchor" id="tiepm-anchor">
    <button class="tbtn" id="btn-tiepm">铁铺 ▾</button>
    <div class="dropdown" id="menu-tiepm">
      <div class="dd-item" data-act="install">安装包…</div>
      <div class="dd-item" data-act="search">搜索包…</div>
      <div class="dd-item" data-act="list">列出已装</div>
      <div class="dd-item" data-act="clean">清理缓存</div>
    </div>
  </div>
  <div class="spacer"></div>
  <button class="tbtn" id="btn-settings">⚙ 设置</button>
</div>
<div id="main-row">
  <div id="sidebar">
    <div id="sidebar-head">
      <span class="title" id="sidebar-title">资源管理器</span>
      <button class="ibtn" id="btn-refresh-tree" title="刷新">⟳</button>
    </div>
    <div id="file-tree"></div>
  </div>
  <div id="sidebar-split"></div>
  <div id="editor-col">
    <div id="tabbar"></div>
    <div id="editor-host">
      <div id="monaco-host"></div>
      <div id="welcome">
        <div class="wl-logo">玄铁铸造厂</div>
        <div class="wl-sub">玄铁语言官方 IDE · v0.1 —— 打开或新建一个工程,开始铸造</div>
        <div class="wl-btns">
          <button class="wlbtn" id="wl-open">打开文件夹</button>
          <button class="wlbtn" id="wl-new">新建工程</button>
        </div>
        <div class="wl-rec" id="wl-rec"></div>
      </div>
    </div>
  </div>
</div>
<div id="bottom-split"></div>
<div id="bottom-panel">
  <div id="bottom-tabs">
    <button class="btab active" id="btab-term">终端</button>
    <button class="btab" id="btab-problems">问题</button>
    <div class="spacer"></div>
    <div id="term-session-bar"></div>
  </div>
  <div id="term-host"></div>
  <div id="problems-host"></div>
</div>
<div id="statusbar">
  <span class="sb-item" id="sb-project">未打开工程</span>
  <span class="sb-item" id="sb-lsp"><span class="dot pending"></span>LSP 未连接</span>
  <span class="spacer"></span>
  <span class="sb-item" id="sb-cursor">Ln 1, Col 1</span>
  <span class="sb-item" id="sb-lang">玄铁</span>
</div>
<div id="modal-root"><div class="overlay"></div></div>
<div id="ctx-root"></div>
<div id="toast-host"></div>
`;

function must(root: ParentNode, id: string): HTMLElement {
  const el = root.querySelector('#' + id);
  if (!(el instanceof HTMLElement)) {
    throw new Error(`布局缺元素 #${id}`);
  }
  return el;
}

export function buildLayout(root: HTMLElement): LayoutHandles {
  root.innerHTML = TEMPLATE;
  return {
    app: root,
    toolbar: must(root, 'toolbar'),
    sidebar: must(root, 'sidebar'),
    sidebarTitle: must(root, 'sidebar-title'),
    btnRefreshTree: must(root, 'btn-refresh-tree'),
    treeHost: must(root, 'file-tree'),
    sidebarSplit: must(root, 'sidebar-split'),
    tabbar: must(root, 'tabbar'),
    monacoHost: must(root, 'monaco-host'),
    welcome: must(root, 'welcome'),
    welcomeRec: must(root, 'wl-rec'),
    bottomPanel: must(root, 'bottom-panel'),
    bottomSplit: must(root, 'bottom-split'),
    btabTerm: must(root, 'btab-term'),
    btabProblems: must(root, 'btab-problems'),
    termSessionBar: must(root, 'term-session-bar'),
    termHost: must(root, 'term-host'),
    problemsHost: must(root, 'problems-host'),
    statusbar: must(root, 'statusbar'),
  };
}

export function initSplitters(L: LayoutHandles): void {
  let dragging: 'side' | 'bottom' | null = null;

  L.sidebarSplit.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = 'side';
  });
  L.bottomSplit.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = 'bottom';
  });
  window.addEventListener('mousemove', (e) => {
    if (dragging === 'side') {
      const w = Math.min(600, Math.max(140, e.clientX));
      document.documentElement.style.setProperty('--sidebar-w', w + 'px');
    } else if (dragging === 'bottom') {
      const h = Math.min(600, Math.max(80, window.innerHeight - e.clientY - 24));
      document.documentElement.style.setProperty('--bottom-h', h + 'px');
    }
  });
  window.addEventListener('mouseup', () => {
    dragging = null;
  });

  // 铁铺下拉:点按钮开合,点别处收起
  const anchor = must(L.toolbar, 'tiepm-anchor');
  const menu = must(L.toolbar, 'menu-tiepm');
  must(L.toolbar, 'btn-tiepm').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!anchor.contains(e.target as Node)) menu.classList.remove('open');
  });
}
