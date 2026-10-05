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
  btnDesignerToggle: HTMLButtonElement;
  designerHost: HTMLElement;
  monacoHost: HTMLElement;
  welcome: HTMLElement;
  welcomeRec: HTMLElement;
  bottomPanel: HTMLElement;
  bottomSplit: HTMLElement;
  btabTerm: HTMLElement;
  btabBuild: HTMLElement;
  btabProblems: HTMLElement;
  badgeBuild: HTMLElement;
  badgeProblems: HTMLElement;
  termSessionBar: HTMLElement;
  termHost: HTMLElement;
  buildHost: HTMLElement;
  problemsHost: HTMLElement;
  aiDock: HTMLElement;
  aiSplit: HTMLElement;
  aiMsgs: HTMLElement;
  aiRefChips: HTMLElement;
  aiAttachBar: HTMLElement;
  btnAiAttach: HTMLElement;
  aiStatsBar: HTMLElement;
  aiStatTurn: HTMLElement;
  aiStatUsage: HTMLElement;
  aiStatCtx: HTMLElement;
  editorHost: HTMLElement;
  aiInput: HTMLTextAreaElement;
  btnAiNew: HTMLElement;
  btnAiHistory: HTMLElement;
  btnAiOutline: HTMLElement;
  btnAiSettings: HTMLElement;
  btnAiClose: HTMLElement;
  btnAiSend: HTMLElement;
  aiModelBtn: HTMLElement;
  aiAgentBtn: HTMLElement;
  aiModeBtn: HTMLElement;
  aiApprovals: HTMLElement;
  aiDrag: HTMLElement;
  aiOutline: HTMLElement;
  aiScrollBottom: HTMLElement;
  aiConsoleBtn: HTMLElement;
  aiMask: HTMLElement;
  aiMaskText: HTMLElement;
  aiMaskBtn: HTMLElement;
  aiBody: HTMLElement;
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
  btnAccount: HTMLElement;
  accountLabel: HTMLElement;
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
  <button class="tbtn" id="btn-account" title="玄铁社区账号"><i class="codicon codicon-account"></i><span id="account-label">账号</span></button>
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
    <div id="tabbar-row">
      <div id="tabbar"></div>
      <button class="ibtn tbtoggle" id="btn-designer-toggle" title="UI 设计器(代码 ⇄ 界面视图)"><i class="codicon codicon-layout"></i></button>
    </div>
    <div id="editor-host">
      <div id="monaco-host"></div>
      <div id="designer-host" class="hidden"></div>
      <div id="welcome">
        <div class="wl-logo">玄铁铸造厂</div>
        <div class="wl-sub">玄铁语言官方 IDE · v0.2 · 打开或新建一个工程,开始铸造</div>
        <div class="wl-btns">
          <button class="wlbtn" id="wl-open">打开文件夹</button>
          <button class="wlbtn" id="wl-new">新建工程</button>
        </div>
        <div class="wl-rec" id="wl-rec"></div>
      </div>
    </div>
    <div id="bottom-split"></div>
    <div id="bottom-panel">
      <div id="bottom-tabs">
        <button class="btab active" id="btab-term"><i class="codicon codicon-terminal"></i>终端</button>
        <button class="btab" id="btab-build"><i class="codicon codicon-tools"></i>构建<i class="badge" id="badge-build" style="display:none"></i></button>
        <button class="btab" id="btab-problems"><i class="codicon codicon-warning"></i>问题<i class="badge count" id="badge-problems" style="display:none"></i></button>
        <div class="spacer"></div>
        <div id="term-session-bar"></div>
      </div>
      <div id="term-host"></div>
      <div id="build-host"></div>
      <div id="problems-host"></div>
    </div>
  </div>
  <div id="ai-split"></div>
  <div id="ai-dock">
    <div id="ai-head">
      <span class="ai-title"><i class="codicon codicon-hubot"></i>智器对话</span>
      <span class="spacer"></span>
      <button class="ibtn" id="btn-ai-outline" title="对话大纲"><i class="codicon codicon-list-unordered"></i></button>
      <button class="ibtn" id="btn-ai-history" title="会话历史(当前工程)"><i class="codicon codicon-history"></i></button>
      <button class="ibtn" id="btn-ai-new" title="新建会话"><i class="codicon codicon-add"></i></button>
      <button class="ibtn" id="btn-ai-console" title="控制台(开发者模式)" style="display:none"><i class="codicon codicon-output"></i></button>
      <button class="ibtn" id="btn-ai-settings" title="管理 AI 提供商"><i class="codicon codicon-settings-gear"></i></button>
      <button class="ibtn" id="btn-ai-close" title="收起"><i class="codicon codicon-close"></i></button>
    </div>
    <div id="ai-body">
      <div id="ai-msgs"></div>
      <div id="ai-outline" style="display:none"></div>
      <button id="ai-scroll-bottom" title="回到底部" style="display:none"><i class="codicon codicon-arrow-down"></i></button>
      <div id="ai-mask" style="display:none">
        <div id="ai-mask-icon" style="display:none"><i class="codicon codicon-hubot"></i></div>
        <div id="ai-mask-text"></div>
        <button class="mbtn primary" id="ai-mask-btn" style="display:none">重新连接</button>
      </div>
    </div>
    <div id="ai-approvals"></div>
    <div id="ai-input-wrap">
      <div id="ai-drag" title="拖拽调整输入栏最大高度"></div>
      <div id="ai-input-box">
        <div id="ai-attach-bar" style="display:none"></div>
        <div id="ai-ref-chips" style="display:none"></div>
        <textarea id="ai-input" placeholder="询问玄铁或任何编程问题…(Enter 发送,Shift+Enter 换行)"></textarea>
        <div id="ai-toolbar">
          <button class="ai-tool" id="ai-attach-btn" title="添加图片/视频"><i class="codicon codicon-add"></i></button>
          <button class="ai-tool" id="ai-model-btn" title="选择模型与思考程度">玄铁AI<i class="codicon codicon-chevron-down"></i></button>
          <button class="ai-tool" id="ai-mode-btn" title="Agent 审批模式(对下一次发送生效)">变更前确认<i class="codicon codicon-chevron-down"></i></button>
          <button class="ai-tool" id="ai-agent-btn" title="Agent 模式:开启后可读写文件、执行命令,危险操作逐次审批"><i class="codicon codicon-hubot"></i></button>
          <span class="spacer"></span>
          <button id="btn-ai-send" title="发送(进行中点击=停止)"><i class="codicon codicon-send"></i></button>
        </div>
        <div id="ai-stats-bar" style="display:none">
          <span class="stat-item" id="stat-turn"></span>
          <span class="stat-item" id="stat-usage"></span>
          <span class="stat-item stat-right" id="stat-ctx" title="点击查看用量明细"></span>
        </div>
      </div>
    </div>
  </div>
</div>
<div id="statusbar">
  <span class="sb-item" id="sb-project">未打开工程</span>
  <span class="sb-item" id="sb-lsp"><span class="dot pending"></span>LSP 未连接</span>
  <span class="sb-item sb-click" id="sb-preflight" style="display:none" title="双击查看校验详情"></span>
  <span class="spacer"></span>
  <span class="sb-item sb-mode" id="sb-mode" style="display:none" title="以管理员权限运行"><i class="codicon codicon-shield"></i>管理员模式</span>
  <span class="sb-item sb-click" id="sb-encoding" title="文件编码:点击以其他编码重新打开或保存"></span>
  <span class="sb-item sb-cloud" id="sb-cloud" style="display:none" title="点击查看详情">未连接玄铁服务器</span>
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
    btnDesignerToggle: must(root, 'btn-designer-toggle') as HTMLButtonElement,
    designerHost: must(root, 'designer-host'),
    monacoHost: must(root, 'monaco-host'),
    welcome: must(root, 'welcome'),
    welcomeRec: must(root, 'wl-rec'),
    bottomPanel: must(root, 'bottom-panel'),
    bottomSplit: must(root, 'bottom-split'),
    btabTerm: must(root, 'btab-term'),
    btabBuild: must(root, 'btab-build'),
    btabProblems: must(root, 'btab-problems'),
    badgeBuild: must(root, 'badge-build'),
    badgeProblems: must(root, 'badge-problems'),
    termSessionBar: must(root, 'term-session-bar'),
    termHost: must(root, 'term-host'),
    buildHost: must(root, 'build-host'),
    problemsHost: must(root, 'problems-host'),
    aiDock: must(root, 'ai-dock'),
    aiSplit: must(root, 'ai-split'),
    aiMsgs: must(root, 'ai-msgs'),
    aiRefChips: must(root, 'ai-ref-chips'),
    aiAttachBar: must(root, 'ai-attach-bar'),
    btnAiAttach: must(root, 'ai-attach-btn'),
    aiStatsBar: must(root, 'ai-stats-bar'),
    aiStatTurn: must(root, 'stat-turn'),
    aiStatUsage: must(root, 'stat-usage'),
    aiStatCtx: must(root, 'stat-ctx'),
    editorHost: must(root, 'editor-host'),
    aiInput: must(root, 'ai-input') as HTMLTextAreaElement,
    btnAiNew: must(root, 'btn-ai-new'),
    btnAiHistory: must(root, 'btn-ai-history'),
    btnAiSettings: must(root, 'btn-ai-settings'),
    btnAiClose: must(root, 'btn-ai-close'),
    btnAiSend: must(root, 'btn-ai-send'),
    aiModelBtn: must(root, 'ai-model-btn'),
    aiAgentBtn: must(root, 'ai-agent-btn'),
    aiModeBtn: must(root, 'ai-mode-btn'),
    aiApprovals: must(root, 'ai-approvals'),
    aiDrag: must(root, 'ai-drag'),
    btnAiOutline: must(root, 'btn-ai-outline'),
    aiOutline: must(root, 'ai-outline'),
    aiScrollBottom: must(root, 'ai-scroll-bottom'),
    aiConsoleBtn: must(root, 'btn-ai-console'),
    aiMask: must(root, 'ai-mask'),
    aiMaskText: must(root, 'ai-mask-text'),
    aiMaskBtn: must(root, 'ai-mask-btn'),
    aiBody: must(root, 'ai-body'),
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
    btnAccount: must(root, 'btn-account'),
    accountLabel: must(root, 'account-label'),
  };
}

function closeAllMenus(): void {
  document.querySelectorAll('.dropdown.open').forEach((d) => d.classList.remove('open'));
  document.querySelectorAll('.menu-btn.open').forEach((b) => b.classList.remove('open'));
}

// VSCode 式菜单栏:点击开合;开着时悬停另一个标题直接切换;点外部/Esc 收起。
// 菜单内容在每次打开时重建 —— 供动态子菜单(如「打开最近工程」)取最新数据。
function attachMenu(btn: HTMLElement, items: MenuItemDecl[], onAction: (act: string) => void): void {
  // 下拉挂在按钮自身(.menu-btn 为 relative 锚),避免落到未定位祖先
  const menu = document.createElement('div');
  menu.className = 'dropdown menudrop';

  const buildRows = (container: HTMLElement, list: MenuItemDecl[]): void => {
    for (const item of list) {
      if (item.act === 'sep') {
        container.appendChild(Object.assign(document.createElement('div'), { className: 'ctx-sep' }));
        continue;
      }
      const row = document.createElement('div');
      row.className = 'dd-item';
      const label = document.createElement('span');
      label.textContent = item.label;
      row.appendChild(label);
      // 子菜单:VSCode 式 `>` 悬停展开;内容可为函数(打开时求值,动态列表)
      if (item.submenu) {
        row.classList.add('has-sub');
        const chev = document.createElement('span');
        chev.className = 'dd-chev';
        chev.textContent = '›';
        row.appendChild(chev);
        const sub = document.createElement('div');
        sub.className = 'dd-sub dropdown menudrop';
        buildRows(sub, typeof item.submenu === 'function' ? item.submenu() : item.submenu);
        row.appendChild(sub);
        container.appendChild(row);
        continue;
      }
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
      container.appendChild(row);
    }
  };

  btn.appendChild(menu);

  const openFresh = (): void => {
    menu.innerHTML = '';
    buildRows(menu, items);
    menu.classList.add('open');
    btn.classList.add('open');
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !menu.classList.contains('open');
    closeAllMenus();
    if (willOpen) openFresh();
  });
  btn.addEventListener('mouseenter', () => {
    const anyOpen = document.querySelector('.menudrop.open');
    if (anyOpen && anyOpen !== menu) {
      closeAllMenus();
      openFresh();
    }
  });
}

// act === 'sep' 仅用于在声明里画分隔线,不会触发回调
export interface MenuItemDecl {
  act: string;
  label: string;
  shortcut?: string;
  /** 子菜单(VSCode 式 `>` 悬停展开):数组或函数(菜单每次打开时求值,供动态列表) */
  submenu?: MenuItemDecl[] | (() => MenuItemDecl[]);
}

export interface MenuDecl {
  btn: HTMLElement;
  items: MenuItemDecl[];
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

export function initSplitters(L: LayoutHandles, hooks?: { onAiWidth?(w: number): void }): void {
  let dragging: 'side' | 'bottom' | 'ai' | null = null;

  L.sidebarSplit.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = 'side';
  });
  L.bottomSplit.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = 'bottom';
  });
  L.aiSplit.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = 'ai';
  });
  window.addEventListener('mousemove', (e) => {
    if (dragging === 'side') {
      const w = Math.min(600, Math.max(140, e.clientX));
      document.documentElement.style.setProperty('--sidebar-w', w + 'px');
    } else if (dragging === 'ai') {
      // 右侧 dock:宽度 = 窗口右缘到光标的距离
      const w = Math.min(720, Math.max(260, window.innerWidth - e.clientX));
      document.documentElement.style.setProperty('--ai-w', w + 'px');
    } else if (dragging === 'bottom') {
      const h = Math.min(600, Math.max(80, window.innerHeight - e.clientY - 24));
      document.documentElement.style.setProperty('--bottom-h', h + 'px');
    }
  });
  window.addEventListener('mouseup', () => {
    if (dragging === 'ai' && hooks?.onAiWidth) {
      // 拖拽结束才落一次(不在 mousemove 里每帧写盘)
      const w = Math.min(800, Math.max(260, parseInt(getComputedStyle(document.documentElement).getPropertyValue('--ai-w'), 10) || 340));
      hooks.onAiWidth(w);
    }
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
