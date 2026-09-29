// 玄铁铸造厂 v0.1 —— 主胶水层:装配布局/编辑器/LSP/终端/运行/铁铺/文件树
// v0.1 作用域纪律见 ide/AGENTS.md(调试器 UI / 插件系统 / Git 界面 / 控件设计器 = 禁区)
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { open as pickDialog } from '@tauri-apps/plugin-dialog';
import { registerXtLanguage } from './lang/xt';
import * as backend from './backend';
import {
  getSettings,
  loadSettings,
  resolveLspServer,
  resolveXtc,
  saveSettings,
} from './settings';
import { XtLspClient, type LspStatus } from './lsp/client';
import { attachLspFeatures } from './lsp/features';
import { buildLayout, initSplitters } from './ui/layout';
import { TabManager } from './ui/tabs';
import { FileTree } from './ui/filetree';
import { ProblemsPanel } from './ui/problems';
import {
  confirmBox,
  promptText,
  showContextMenu,
  showCustomModal,
  showToast,
  type ContextMenuItem,
} from './ui/dialogs';
import { TerminalPane } from './term/terminal';
import { Runner } from './run/run';
import { Tiepm } from './tiepm/tiepm';
import { PROJECT_TEMPLATES, createProject } from './templates';
import { basename, dirname } from './util';
import type { FileNode } from './types';

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

registerXtLanguage();

const L = buildLayout(document.getElementById('app') as HTMLElement);
initSplitters(L);

const editor = monaco.editor.create(L.monacoHost, {
  model: null,
  theme: 'xuantie-dark',
  fontSize: 14,
  fontFamily: '"Cascadia Mono", Consolas, "Microsoft YaHei UI", monospace',
  automaticLayout: true,
  minimap: { enabled: true },
  scrollBeyondLastLine: false,
  bracketPairColorization: { enabled: true },
  // 中文是主体字符:Monaco 的"歧义字符"高亮会给全文加点状下划线,必须关
  unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
});

let workspace = '';
let entryFile = '';

const sbProject = document.getElementById('sb-project') as HTMLElement;
const sbLsp = document.getElementById('sb-lsp') as HTMLElement;
const sbCursor = document.getElementById('sb-cursor') as HTMLElement;

const lsp = new XtLspClient();
const problems = new ProblemsPanel(L.problemsHost, (p, line, column) => {
  void tabs.openFile(p, { line, column });
});
const tabs = new TabManager(
  L.tabbar,
  editor,
  {
    onDidOpen: (p, text) => lsp.didOpen(p, text),
    onDidChange: (p, text) => lsp.didChange(p, text),
    onDidSave: (p) => lsp.didSave(p),
    onDidClose: (p) => {
      lsp.didClose(p);
      problems.update(p, []);
    },
    onActivate: () => undefined,
  },
  (p) => confirmBox('关闭未保存', `${basename(p)} 有未保存的更改,放弃并关闭?`),
);
const term = new TerminalPane(L.termHost, L.termSessionBar);
const runner = new Runner(term, () => workspace);
const tiepm = new Tiepm(term, () => workspace);

lsp.onStatus(updateLspStatus);
attachLspFeatures(lsp, editor, {
  openAt: (p, line, column) => {
    void tabs.openFile(p, { line, column });
  },
  onDiagnostics: (p, diags) => problems.update(p, diags),
});

editor.onDidChangeCursorPosition((e) => {
  sbCursor.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
});

const fileTree = new FileTree(L.treeHost, {
  openFile: (p) => {
    tabs.openFile(p).catch((err: unknown) => showToast(`打开失败: ${String(err)}`, 'err'));
  },
  onContext: (e, node) => showTreeMenu(e, node),
});

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺元素 #${id}`);
  return el;
}

function updateLspStatus(s: LspStatus, detail: string): void {
  const label = s === 'connected' ? 'LSP 已连接' : s === 'connecting' ? 'LSP 连接中' : 'LSP 未连接';
  const dotCls = s === 'connected' ? 'ok' : s === 'connecting' ? 'pending' : 'bad';
  sbLsp.innerHTML = `<span class="dot ${dotCls}"></span>`;
  sbLsp.appendChild(document.createTextNode(label));
  sbLsp.title = detail;
}

function setBottomTab(which: 'term' | 'problems'): void {
  L.btabTerm.classList.toggle('active', which === 'term');
  L.btabProblems.classList.toggle('active', which === 'problems');
  L.termHost.style.display = which === 'term' ? 'block' : 'none';
  L.problemsHost.classList.toggle('active', which === 'problems');
}

function setBottomVisible(visible: boolean): void {
  L.bottomPanel.classList.toggle('hidden', !visible);
  L.bottomSplit.style.display = visible ? '' : 'none';
}

async function startLsp(): Promise<void> {
  await lsp.stop();
  const server = await resolveLspServer(workspace);
  if (!server) {
    const detail = '未找到 xt_lsp.exe:设置 → PATH → 工作区 lsp\\ → xtc 同目录/上两级 全部落空';
    updateLspStatus('disconnected', detail);
    showToast(detail + '。可在 ⚙ 设置里手工指定。', 'err');
    return;
  }
  const xtc = await resolveXtc();
  try {
    await lsp.start(server, workspace, xtc ?? '');
  } catch (err) {
    updateLspStatus('disconnected', String(err));
    showToast(`LSP 启动失败: ${String(err)}`, 'err');
    return;
  }
  // 重连/晚连接场景:已打开的文档补发 didOpen,否则它们永远收不到补全与诊断
  for (const p of tabs.getAllPaths()) {
    const text = tabs.getText(p);
    if (text !== null) lsp.didOpen(p, text);
  }
}

async function reloadTree(): Promise<void> {
  if (!workspace) return;
  try {
    fileTree.setTree(await backend.fsListTree(workspace));
  } catch (err) {
    showToast(`刷新文件树失败: ${String(err)}`, 'err');
  }
}

async function openWorkspace(dir: string): Promise<void> {
  try {
    fileTree.setTree(await backend.fsListTree(dir));
  } catch (err) {
    showToast(`读取目录失败: ${String(err)}`, 'err');
    return;
  }
  workspace = dir;
  entryFile = '';
  try {
    const cfg = await backend.fsReadFile(backend.joinPath(dir, '玄铁.配置.toml'));
    const m = /入口\s*=\s*"([^"]+)"/.exec(cfg);
    if (m) entryFile = m[1];
  } catch {
    // 无 玄铁.配置.toml:按普通文件夹编辑,不算错误
  }
  L.welcome.classList.add('hidden');
  L.sidebarTitle.textContent = basename(dir);
  sbProject.textContent = entryFile ? `${basename(dir)} · 入口 ${entryFile}` : basename(dir);
  await startLsp();
  const s = getSettings();
  if (s.lastWorkspace !== dir) {
    try {
      await saveSettings({ ...s, lastWorkspace: dir });
    } catch {
      // 设置写失败不阻塞主流程
    }
  }
  await term.ensureMain(dir);
}

async function pickDir(title: string): Promise<string | null> {
  const r = await pickDialog({ directory: true, title });
  return typeof r === 'string' ? r : null;
}

async function pickFile(title: string): Promise<string | null> {
  const r = await pickDialog({ multiple: false, title });
  return typeof r === 'string' ? r : null;
}

// ---- 文件树右键 ----
function showTreeMenu(e: MouseEvent, node: FileNode): void {
  const items: ContextMenuItem[] = [];
  if (node.isDir) {
    items.push({ label: '新建文件', action: () => void newFileIn(node.path) });
    items.push({ label: '新建文件夹', action: () => void newDirIn(node.path) });
  }
  items.push({ label: '重命名', action: () => void renameNode(node) });
  items.push({ label: '删除', danger: true, action: () => void deleteNode(node) });
  showContextMenu(e.clientX, e.clientY, items);
}

async function newFileIn(dir: string): Promise<void> {
  const name = await promptText('新建文件', `位置:${dir}`, '新文件.xt');
  if (!name) return;
  const path = backend.joinPath(dir, name);
  try {
    if (await backend.fsExists(path)) {
      showToast('同名文件已存在', 'err');
      return;
    }
    await backend.fsCreateFile(path, '');
    await reloadTree();
    if (name.toLowerCase().endsWith('.xt')) await tabs.openFile(path);
  } catch (err) {
    showToast(`创建失败: ${String(err)}`, 'err');
  }
}

async function newDirIn(dir: string): Promise<void> {
  const name = await promptText('新建文件夹', `位置:${dir}`, '新文件夹');
  if (!name) return;
  try {
    const path = backend.joinPath(dir, name);
    if (await backend.fsExists(path)) {
      showToast('同名文件夹已存在', 'err');
      return;
    }
    await backend.fsCreateDir(path);
    await reloadTree();
  } catch (err) {
    showToast(`创建失败: ${String(err)}`, 'err');
  }
}

async function renameNode(node: FileNode): Promise<void> {
  const newName = await promptText('重命名', '新名称', node.name);
  if (!newName || newName === node.name) return;
  const from = node.path;
  const to = backend.joinPath(dirname(from), newName);
  try {
    if (await backend.fsExists(to)) {
      showToast('目标名已存在', 'err');
      return;
    }
    if (tabs.isOpen(from) && !(await tabs.close(from))) return;
    await backend.fsRename(from, to);
    await reloadTree();
  } catch (err) {
    showToast(`重命名失败: ${String(err)}`, 'err');
  }
}

async function deleteNode(node: FileNode): Promise<void> {
  const ok = await confirmBox('删除', `确定删除「${node.name}」?(移入回收站)`);
  if (!ok) return;
  try {
    if (tabs.isOpen(node.path) && !(await tabs.close(node.path))) return;
    await backend.fsDelete(node.path);
    await reloadTree();
  } catch (err) {
    showToast(`删除失败: ${String(err)}`, 'err');
  }
}

// ---- 新建工程 ----
function newProjectModal(): Promise<void> {
  return showCustomModal('新建工程', (body, close) => {
    const rName = document.createElement('div');
    rName.className = 'mrow';
    rName.appendChild(document.createElement('label')).textContent = '工程名';
    const inName = document.createElement('input');
    inName.type = 'text';
    inName.value = '我的工程';
    rName.appendChild(inName);

    const rDir = document.createElement('div');
    rDir.className = 'mrow';
    rDir.appendChild(document.createElement('label')).textContent = '父目录';
    const line = document.createElement('div');
    line.className = 'rowline';
    const inDir = document.createElement('input');
    inDir.type = 'text';
    inDir.placeholder = '选择或输入目录';
    const btnDir = document.createElement('button');
    btnDir.className = 'mbtn';
    btnDir.textContent = '选择…';
    btnDir.addEventListener('click', () => {
      void pickDir('选择父目录').then((d) => {
        if (d) inDir.value = d;
      });
    });
    line.append(inDir, btnDir);
    rDir.appendChild(line);

    const rTpl = document.createElement('div');
    rTpl.className = 'mrow';
    rTpl.appendChild(document.createElement('label')).textContent = '模板';
    const sel = document.createElement('select');
    for (const t of PROJECT_TEMPLATES) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `${t.name} —— ${t.desc}`;
      sel.appendChild(opt);
    }
    rTpl.appendChild(sel);

    const foot = document.createElement('div');
    foot.className = 'm-foot';
    const cancel = document.createElement('button');
    cancel.className = 'mbtn';
    cancel.textContent = '取消';
    const ok = document.createElement('button');
    ok.className = 'mbtn primary';
    ok.textContent = '创建';
    cancel.addEventListener('click', () => close());
    ok.addEventListener('click', () => close({ name: inName.value.trim(), dir: inDir.value.trim(), tpl: sel.value }));
    foot.append(cancel, ok);

    body.append(rName, rDir, rTpl, foot);
    inName.focus();
  }).then(async (result) => {
    const r = result as { name?: string; dir?: string; tpl?: string } | undefined;
    if (!r || !r.name || !r.dir || !r.tpl) return;
    try {
      const created = await createProject(r.dir, r.name, r.tpl);
      showToast(`工程已创建:${created}`, 'ok');
      await openWorkspace(created);
    } catch (err) {
      showToast(`创建工程失败: ${String(err)}`, 'err');
    }
  });
}

// ---- 设置 ----
function settingsModal(): Promise<void> {
  const s = getSettings();
  return showCustomModal('设置 —— 工具链路径(留空自动按 PATH 探测)', (body, close) => {
    const rows: Array<{ key: string; label: string; probe: string; value: string }> = [
      { key: 'lsp', label: 'xt_lsp.exe(LSP 服务器)', probe: 'xt_lsp', value: s.lspServerPath },
      { key: 'xtc', label: 'xtc.exe(编译器)', probe: 'xtc', value: s.xtcPath },
      { key: 'tiepm', label: 'tiepm.exe(铁铺包管理器)', probe: 'tiepm', value: s.tiepmPath },
    ];
    const inputs = new Map<string, HTMLInputElement>();
    for (const row of rows) {
      const r = document.createElement('div');
      r.className = 'mrow';
      r.appendChild(document.createElement('label')).textContent = row.label;
      const line = document.createElement('div');
      line.className = 'rowline';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = row.value;
      input.placeholder = '自动探测';
      inputs.set(row.key, input);
      const btnProbe = document.createElement('button');
      btnProbe.className = 'mbtn';
      btnProbe.textContent = '探测';
      btnProbe.addEventListener('click', () => {
        backend
          .toolLocate(row.probe)
          .then((p) => {
            input.value = p;
            showToast(`在 PATH 找到:${p}`, 'ok');
          })
          .catch((err: unknown) => showToast(`PATH 里没有 ${row.probe}: ${String(err)}`, 'err'));
      });
      const btnPick = document.createElement('button');
      btnPick.className = 'mbtn';
      btnPick.textContent = '选…';
      btnPick.addEventListener('click', () => {
        void pickFile(`选择 ${row.probe}.exe`).then((p) => {
          if (p) input.value = p;
        });
      });
      line.append(input, btnProbe, btnPick);
      r.appendChild(line);
      body.appendChild(r);
    }
    const foot = document.createElement('div');
    foot.className = 'm-foot';
    const cancel = document.createElement('button');
    cancel.className = 'mbtn';
    cancel.textContent = '取消';
    const ok = document.createElement('button');
    ok.className = 'mbtn primary';
    ok.textContent = '保存';
    cancel.addEventListener('click', () => close());
    ok.addEventListener('click', () => {
      close({
        lsp: inputs.get('lsp')?.value.trim() ?? '',
        xtc: inputs.get('xtc')?.value.trim() ?? '',
        tiepm: inputs.get('tiepm')?.value.trim() ?? '',
      });
    });
    foot.append(cancel, ok);
    body.appendChild(foot);
  }).then(async (result) => {
    const r = result as { lsp?: string; xtc?: string; tiepm?: string } | undefined;
    if (!r) return;
    try {
      await saveSettings({
        ...getSettings(),
        lspServerPath: r.lsp ?? '',
        xtcPath: r.xtc ?? '',
        tiepmPath: r.tiepm ?? '',
      });
      showToast('设置已保存', 'ok');
      if (workspace) await startLsp();
    } catch (err) {
      showToast(`保存设置失败: ${String(err)}`, 'err');
    }
  });
}

// ---- 运行 / 保存 ----
async function saveActive(): Promise<void> {
  const p = tabs.getActivePath();
  if (!p) return;
  try {
    await tabs.save(p);
  } catch (err) {
    showToast(`保存失败: ${String(err)}`, 'err');
  }
}

async function runActive(): Promise<void> {
  const p = tabs.getActivePath();
  if (!p) {
    showToast('没有打开的 .xt 文件', 'err');
    return;
  }
  if (!p.toLowerCase().endsWith('.xt')) {
    showToast('一键运行只支持 .xt 文件', 'err');
    return;
  }
  if (workspace && !p.startsWith(workspace)) {
    showToast('当前文件不在工程目录内', 'err');
    return;
  }
  try {
    await tabs.saveAll();
    setBottomVisible(true);
    setBottomTab('term');
    await runner.runFile(p);
  } catch (err) {
    showToast(String(err), 'err');
  }
}

// ---- 工具栏 / 快捷键 ----
function bindUi(): void {
  const openFolder = (): void => {
    void pickDir('选择玄铁工程文件夹').then((d) => {
      if (d) void openWorkspace(d);
    });
  };
  byId('btn-open').addEventListener('click', openFolder);
  byId('wl-open').addEventListener('click', openFolder);
  byId('btn-new').addEventListener('click', () => void newProjectModal());
  byId('wl-new').addEventListener('click', () => void newProjectModal());
  byId('btn-run').addEventListener('click', () => void runActive());
  byId('btn-stop').addEventListener('click', () => {
    if (!term.stopRun()) showToast('没有正在运行的会话');
  });
  L.btnRefreshTree.addEventListener('click', () => void reloadTree());
  byId('btn-settings').addEventListener('click', () => void settingsModal());
  L.btabTerm.addEventListener('click', () => setBottomTab('term'));
  L.btabProblems.addEventListener('click', () => setBottomTab('problems'));

  for (const item of Array.from(byId('menu-tiepm').querySelectorAll('.dd-item'))) {
    item.addEventListener('click', () => {
      const act = (item as HTMLElement).dataset.act ?? '';
      const run = (p: Promise<void>): void => {
        setBottomVisible(true);
        setBottomTab('term');
        p.catch((err: unknown) => showToast(String(err), 'err'));
      };
      if (act === 'install') {
        void promptText('铁铺 · 安装包', '包名').then((name) => {
          if (name) run(tiepm.install(name));
        });
      } else if (act === 'search') {
        void promptText('铁铺 · 搜索', '关键词').then((kw) => {
          if (kw) run(tiepm.search(kw));
        });
      } else if (act === 'list') {
        run(tiepm.list());
      } else if (act === 'clean') {
        run(tiepm.clean());
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyS') {
      e.preventDefault();
      void saveActive();
    } else if (e.ctrlKey && e.code === 'Backquote') {
      e.preventDefault();
      setBottomVisible(L.bottomPanel.classList.contains('hidden'));
    } else if (e.code === 'F5') {
      e.preventDefault();
      void runActive();
    }
  });

  window.addEventListener('beforeunload', () => {
    term.disposeAll();
    void lsp.stop();
  });
}

async function boot(): Promise<void> {
  await loadSettings();
  const s = getSettings();
  if (s.lastWorkspace) {
    L.welcomeRec.textContent = `最近打开:${s.lastWorkspace}`;
    L.welcomeRec.addEventListener('click', () => void openWorkspace(s.lastWorkspace));
    if (await backend.fsExists(s.lastWorkspace)) {
      await openWorkspace(s.lastWorkspace);
    }
  }
}

bindUi();
void boot();
