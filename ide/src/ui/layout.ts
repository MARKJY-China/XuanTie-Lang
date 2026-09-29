// DOM 骨架、面板尺寸分割条、VSCode 式菜单栏、自绘标题栏(纯 DOM,无框架)
// 图标纪律(AGENTS.md):禁止 Emoji,一律 @vscode/codicons + 玄铁 .ico
import xtIco from '../assets/xuantie.ico';

export interface LayoutHandles {
  app: HTMLElement;
  toolbar: HTMLElement;
  sidebar: HTMLElement;
  sidebarTitle: HTMLElement;
  btnEye: HTMLElement;
  eyeIco: HTMLElement;
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
  menubarFileBtn: HTMLElement;
  menubarEditBtn: HTMLElement;
  menubarViewBtn: HTMLElement;
  menubarBuildBtn: HTMLElement;
  menubarTermBtn: HTMLElement;
  menubarHelpBtn: HTMLElement;
  winMin: HTMLElement;
  winMax: HTMLElement;
  winMaxIco: HTMLElement;
  winClose: HTMLElement;
}

const TEMPLATE = `
<div id="toolbar" data-tauri-drag-region>
  <img class="titlebar-ico" src="${xtIco}" alt="" draggable="false" data-tauri-drag-region />
  <div class="menubar">
    <button class="menu-btn" id="menu-btn-file">文件(F)</button>
    <button class="menu-btn" id="menu-btn-edit">编辑(E)</button>
    <button class="menu-btn" id="menu-btn-view">查看(V)</button>
    <button class="menu-btn" id="menu-btn-build">编译(B)</button>
    <button class="menu-btn" id="menu-btn-term">终端(T)</button>
    <button class="menu-btn" id="menu-btn-help">帮助(H)</button>
  </div>
  <div class="spacer"></div>
  <button class="tbtn primary" id="btn-run" title="编译并运行当前文件 (F5)"><i class="codicon codicon-play"></i>运行</button>
  <button class="tbtn" id="btn-stop" title="停止运行会话"><i class="codicon codicon-debug-stop"></i>停止</button>
  <div class="menu-anchor" id="tiepm-anchor">
    <button class="tbtn" id="btn-tiepm"><i class="codicon codicon-package"></i>铁铺<i class="codicon codicon-chevron-down caret"></i></button>
    <div class="dropdown" id="menu-tiepm">
      <div class="dd-item" data-act="install">安装包…</div>
      <div class="dd-item" data-act="search">搜索包…</div>
      <div class="dd-item" data-act="list">列出已装</div>
      <div class="dd-item" data-act="clean">清理缓存</div>
    </div>
  </div>
  <button class="tbtn" id="btn-settings" title="工具链路径设置"><i class="codicon codicon-settings-gear"></i>设置</button>
  <div class="sep"></div>
  <div id="win-controls">
    <button class="winbtn" id="win-min" title="最小化"><i class="codicon codicon-chrome-minimize"></i></button>
    <button class="winbtn" id="win-max" title="最大化"><i class="codicon codicon-chrome-maximize" id="win-max-ico"></i></button>
    <button class="winbtn winbtn-close" id="win-close" title="关闭"><i class="codicon codicon-chrome-close"></i></button>
  </div>
</div>
<div id="main-row">
  <div id="sidebar">
    <div id="sidebar-head">
      <span class="title" id="sidebar-title">资源管理器</span>
      <button class="ibtn" id="btn-eye" title="文件树显示:半显示"><i class="codicon codicon-preview" id="eye-ico"></i></button>
      <button class="ibtn" id="btn-refresh-tree" title="刷新"><i class="codicon codicon-refresh"></i></button>
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
        <div class="wl-sub">玄铁语言官方 IDE · v0.1 · 打开或新建一个工程,开始铸造</div>
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
    <button class="btab active" id="btab-term"><i class="codicon codicon-terminal"></i>终端</button>
    <button class="btab" id="btab-problems"><i class="codicon codicon-warning"></i>问题</button>
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
    btnEye: must(root, 'btn-eye'),
    eyeIco: must(root, 'eye-ico'),
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
    menubarFileBtn: must(root, 'menu-btn-file'),
    menubarEditBtn: must(root, 'menu-btn-edit'),
    menubarViewBtn: must(root, 'menu-btn-view'),
    menubarBuildBtn: must(root, 'menu-btn-build'),
    menubarTermBtn: must(root, 'menu-btn-term'),
    menubarHelpBtn: must(root, 'menu-btn-help'),
    winMin: must(root, 'win-min'),
    winMax: must(root, 'win-max'),
    winMaxIco: must(root, 'win-max-ico'),
    winClose: must(root, 'win-close'),
  };
}

function closeAllMenus(): void {
  document.querySelectorAll('.dropdown.open').forEach((d) => d.classList.remove('open'));
  document.querySelectorAll('.menu-btn.open').forEach((b) => b.classList.remove('open'));
}

// VSCode 式菜单栏:点击开合;开着时悬停另一个标题直接切换;点外部/Esc 收起
function attachMenu(
  btn: HTMLElement,
  items: Array<{ act: string; label: string; shortcut?: string }>,
  onAction: (act: string) => void,
): void {
  // 下拉挂在按钮自身(.menu-btn 为 relative 锚),避免落到未定位祖先
  const menu = document.createElement('div');
  menu.className = 'dropdown menudrop';
  for (const item of items) {
    if (item.act === 'sep') {
      menu.appendChild(Object.assign(document.createElement('div'), { className: 'ctx-sep' }));
      continue;
    }
    const row = document.createElement('div');
    row.className = 'dd-item';
    const label = document.createElement('span');
    label.textContent = item.label;
    row.appendChild(label);
    if (item.shortcut) {
      const sc = document.createElement('span');
      sc.className = 'shortcut';
      sc.textContent = item.shortcut;
      row.appendChild(sc);
    }
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllMenus();
      onAction(item.act);
    });
    menu.appendChild(row);
  }
  btn.appendChild(menu);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !menu.classList.contains('open');
    closeAllMenus();
    if (willOpen) {
      menu.classList.add('open');
      btn.classList.add('open');
    }
  });
  btn.addEventListener('mouseenter', () => {
    const anyOpen = document.querySelector('.menudrop.open');
    if (anyOpen && anyOpen !== menu) {
      closeAllMenus();
      menu.classList.add('open');
      btn.classList.add('open');
    }
  });
}

// act === 'sep' 仅用于在声明里画分隔线,不会触发回调
export interface MenuDecl {
  btn: HTMLElement;
  items: Array<{ act: string; label: string; shortcut?: string }>;
}

export function initMenus(menus: MenuDecl[], onAction: (act: string) => void): void {
  for (const m of menus) attachMenu(m.btn, m.items, onAction);
  document.addEventListener('click', (e) => {
    const anchor = (e.target as HTMLElement | null)?.closest('.menu-anchor, .menubar');
    if (!anchor) closeAllMenus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllMenus();
  });
}

// 自绘标题栏窗口控制:最小化/最大化还原/关闭;拖拽与双击最大化由 data-tauri-drag-region 承担
export function initWindowControls(L: LayoutHandles): void {
  void (async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();

    const syncMaxIcon = (): void => {
      void win.isMaximized().then((maxed) => {
        L.winMaxIco.className = 'codicon ' + (maxed ? 'codicon-chrome-restore' : 'codicon-chrome-maximize');
        L.winMax.title = maxed ? '向下还原' : '最大化';
      });
    };

    L.winMin.addEventListener('click', () => void win.minimize());
    L.winMax.addEventListener('click', () => {
      void win.toggleMaximize();
      window.setTimeout(syncMaxIcon, 120);
    });
    L.winClose.addEventListener('click', () => void win.close());
    void win.onResized(() => syncMaxIcon());
    syncMaxIcon();
  })();
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
    closeAllMenus();
    menu.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!anchor.contains(e.target as Node)) menu.classList.remove('open');
  });
}
