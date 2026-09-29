// 玄铁铸造厂 v0.1 —— 主胶水层:装配布局/编辑器/LSP/终端/运行/铁铺/文件树
// v0.1 作用域纪律见 ide/AGENTS.md(调试器 UI / 插件系统 / Git 界面 / 控件设计器 = 禁区)
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { open as pickDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getVersion } from '@tauri-apps/api/app';
import '@vscode/codicons/dist/codicon.css';
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
import { buildLayout, initMenus, initSplitters, initWindowControls } from './ui/layout';
import { TabManager } from './ui/tabs';
import { FileTree } from './ui/filetree';
import { ProblemsPanel } from './ui/problems';
import {
  confirmBox,
  CONTEXT_SEP,
  promptText,
  showContextMenu,
  showCustomModal,
  showToast,
  type ContextMenuEntry,
} from './ui/dialogs';
import { TerminalPane } from './term/terminal';
import { Runner } from './run/run';
import { Tiepm } from './tiepm/tiepm';
import { PROJECT_TEMPLATES, createProject } from './templates';
import { basename, copyText, dirname, relativeTo } from './util';
import { defaultSettings, type FileNode, type TreeDisplay } from './types';

// 眼睛按钮三态:循环顺序 完全显示 → 半显示 → 不显示
const EYE_ORDER: TreeDisplay[] = ['all', 'dim', 'hide'];
const EYE_META: Record<TreeDisplay, { icon: string; title: string }> = {
  all: { icon: 'codicon-eye', title: '文件树显示:完全显示(点击切换为半显示)' },
  dim: { icon: 'codicon-preview', title: '文件树显示:半显示,其余文件淡化并置尾(点击切换为不显示)' },
  hide: { icon: 'codicon-eye-closed', title: '文件树显示:仅认准文件(点击切换为完全显示)' },
};

function applyEye(): void {
  const meta = EYE_META[getSettings().treeDisplay ?? defaultSettings().treeDisplay];
  L.eyeIco.className = 'codicon ' + meta.icon;
  L.btnEye.title = meta.title;
}

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

registerXtLanguage();

const L = buildLayout(document.getElementById('app') as HTMLElement);
initSplitters(L);
initWindowControls(L);

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
    fileTree.setTree(await backend.fsListTree(workspace), workspace);
  } catch (err) {
    showToast(`刷新文件树失败: ${String(err)}`, 'err');
  }
}

async function openWorkspace(dir: string): Promise<void> {
  try {
    fileTree.setTree(await backend.fsListTree(dir), dir);
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

// ---- 文件树右键(node 为 null = 空白区域,对工程根操作) ----
function showTreeMenu(e: MouseEvent, node: FileNode | null): void {
  if (!node) {
    const items: ContextMenuEntry[] = [
      { label: '新建文件', action: () => void newFileIn(workspace) },
      { label: '新建文件夹', action: () => void newDirIn(workspace) },
      CONTEXT_SEP,
      { label: '刷新', action: () => void reloadTree() },
    ];
    showContextMenu(e.clientX, e.clientY, items);
    return;
  }
  const items: ContextMenuEntry[] = [];
  if (node.isDir) {
    items.push({ label: '新建文件', action: () => void newFileIn(node.path) });
    items.push({ label: '新建文件夹', action: () => void newDirIn(node.path) });
    items.push(CONTEXT_SEP);
  }
  items.push({
    label: '复制相对路径',
    action: () => {
      void copyText(relativeTo(workspace, node.path)).then((ok) => {
        showToast(ok ? '已复制相对路径' : '复制失败', ok ? 'ok' : 'err');
      });
    },
  });
  items.push({
    label: '复制完整路径',
    action: () => {
      void copyText(node.path).then((ok) => {
        showToast(ok ? '已复制完整路径' : '复制失败', ok ? 'ok' : 'err');
      });
    },
  });
  items.push(CONTEXT_SEP);
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
  return showCustomModal(
    '设置',
    (body, close) => {
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

      // 文件树显示由侧栏眼睛按钮控制并持久化,设置弹窗不再重复
      // 编译产物目录(「编译」菜单用)
      const rBuild = document.createElement('div');
      rBuild.className = 'mrow';
      rBuild.appendChild(document.createElement('label')).textContent = '编译产物目录(留空 = 工程文件夹\\build)';
      const lineBuild = document.createElement('div');
      lineBuild.className = 'rowline';
      const inBuild = document.createElement('input');
      inBuild.type = 'text';
      inBuild.value = s.buildDir;
      inBuild.placeholder = '留空 = 工程文件夹\\build';
      inputs.set('buildDir', inBuild);
      const btnBuildPick = document.createElement('button');
      btnBuildPick.className = 'mbtn';
      btnBuildPick.textContent = '选…';
      btnBuildPick.addEventListener('click', () => {
        void pickDir('选择编译产物目录').then((d) => {
          if (d) inBuild.value = d;
        });
      });
      lineBuild.append(inBuild, btnBuildPick);
      rBuild.appendChild(lineBuild);
      body.appendChild(rBuild);

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
          buildDir: inputs.get('buildDir')?.value.trim() ?? '',
        });
      });
      foot.append(cancel, ok);
      body.appendChild(foot);
    },
    '工具链路径留空则按 PATH 自动探测',
  ).then(async (result) => {
    const r = result as { lsp?: string; xtc?: string; tiepm?: string; buildDir?: string } | undefined;
    if (!r) return;
    try {
      await saveSettings({
        ...getSettings(),
        lspServerPath: r.lsp ?? '',
        xtcPath: r.xtc ?? '',
        tiepmPath: r.tiepm ?? '',
        buildDir: r.buildDir ?? '',
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

// ---- 编译(「编译」菜单:产物入 工程build 目录,位置可在设置自定义) ----
async function ensureBuildDir(): Promise<string | null> {
  if (!workspace) {
    showToast('先打开工程文件夹', 'err');
    return null;
  }
  const s = getSettings();
  const dir = s.buildDir && s.buildDir.trim() ? s.buildDir.trim() : backend.joinPath(workspace, 'build');
  try {
    if (!(await backend.fsExists(dir))) await backend.fsCreateDir(dir);
  } catch (err) {
    showToast(`创建编译目录失败: ${String(err)}`, 'err');
    return null;
  }
  return dir;
}

async function compileTo(xtc: string, src: string, out: string, title: string): Promise<void> {
  await tabs.saveAll();
  setBottomVisible(true);
  setBottomTab('term');
  await term.runCommand(title, workspace, xtc, ['tie', src, '-sc', out], () => {
    // 编译进程退出即刷新文件树:build 目录里的新产物立即可见
    void reloadTree();
  });
}

async function buildCurrent(): Promise<void> {
  const p = tabs.getActivePath();
  if (!p || !p.toLowerCase().endsWith('.xt')) {
    showToast('没有打开的 .xt 文件', 'err');
    return;
  }
  if (workspace && !p.startsWith(workspace)) {
    showToast('当前文件不在工程目录内', 'err');
    return;
  }
  const dir = await ensureBuildDir();
  if (!dir) return;
  const xtc = await resolveXtc();
  if (!xtc) {
    showToast('未找到 xtc:请在设置里配置,或加入 PATH', 'err');
    return;
  }
  const base = basename(p).replace(/\.xt$/i, '');
  await compileTo(xtc, p, backend.joinPath(dir, `${base}.exe`), `编译 · ${basename(p)}`);
}

async function buildProject(): Promise<void> {
  if (!workspace) {
    showToast('先打开工程文件夹', 'err');
    return;
  }
  if (!entryFile) {
    showToast('未在 玄铁.配置.toml 找到 [项目] 入口,无法编译整个项目', 'err');
    return;
  }
  const dir = await ensureBuildDir();
  if (!dir) return;
  const xtc = await resolveXtc();
  if (!xtc) {
    showToast('未找到 xtc:请在设置里配置,或加入 PATH', 'err');
    return;
  }
  const entryPath = backend.joinPath(workspace, entryFile);
  if (!(await backend.fsExists(entryPath))) {
    showToast(`入口文件不存在: ${entryFile}`, 'err');
    return;
  }
  const base = basename(entryFile).replace(/\.xt$/i, '');
  await compileTo(xtc, entryPath, backend.joinPath(dir, `${base}.exe`), `编译 · 工程 ${basename(workspace)}`);
}

// ---- 查看(底部面板/侧栏开关) ----
let sidebarVisible = true;

function setSidebarVisible(v: boolean): void {
  sidebarVisible = v;
  L.sidebar.style.display = v ? '' : 'none';
  L.sidebarSplit.style.display = v ? '' : 'none';
}

// ---- 帮助 / 关于 ----
async function aboutModal(): Promise<void> {
  let ver = '';
  try {
    ver = await getVersion();
  } catch {
    ver = '未知';
  }
  const xtc = await resolveXtc();
  let xtcLine: string;
  if (!xtc) {
    xtcLine = '未找到 xtc(可在设置里指定)';
  } else {
    try {
      xtcLine = await backend.toolVersion(xtc);
    } catch (err) {
      xtcLine = `读取失败: ${String(err)}`;
    }
  }
  await showCustomModal(
    '关于',
    (body, close) => {
      const add = (label: string, value: string | HTMLElement): void => {
        const r = document.createElement('div');
        r.className = 'mrow';
        r.appendChild(document.createElement('label')).textContent = label;
        if (typeof value === 'string') {
          const span = document.createElement('span');
          span.textContent = value;
          r.appendChild(span);
        } else {
          r.appendChild(value);
        }
        body.appendChild(r);
      };
      add('版本', `v${ver || '?'}`);
      add('版权', '© 2026 MARKJY · 玄铁铸造厂');
      const repo = document.createElement('span');
      repo.className = 'linkish';
      repo.textContent = 'github.com/MARKJY-China/XuanTie-Lang';
      repo.addEventListener('click', () => {
        void openUrl('https://github.com/MARKJY-China/XuanTie-Lang');
      });
      add('开源仓库', repo);
      add('官方文档', 'xt.markjy.com');
      add('当前编译器', xtcLine);
      const foot = document.createElement('div');
      foot.className = 'm-foot';
      const ok = document.createElement('button');
      ok.className = 'mbtn primary';
      ok.textContent = '确定';
      ok.addEventListener('click', () => close());
      foot.appendChild(ok);
      body.appendChild(foot);
    },
    '玄铁语言官方 IDE(Tauri 2 + Monaco 过渡壳)',
  );
}

// ---- 工具栏 / 菜单栏 / 快捷键 ----
function bindUi(): void {
  // WebView2 原生右键菜单是英文:除编辑器(Monaco 自带中文菜单)与输入框外一律禁用。
  // Monaco 在自己的节点上已 preventDefault,这里只兜其余区域。
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea')) return;
    e.preventDefault();
  });

  const openFolder = (): void => {
    void pickDir('选择玄铁工程文件夹').then((d) => {
      if (d) void openWorkspace(d);
    });
  };

  // VSCode 式菜单栏:只放铸造厂支持的功能
  initMenus(
    [
      {
        btn: L.menubarFileBtn,
        items: [
          { act: 'open-folder', label: '打开文件夹…' },
          { act: 'new-project', label: '新建工程…' },
          { act: 'sep', label: '' },
          { act: 'save', label: '保存', shortcut: 'Ctrl+S' },
          { act: 'save-all', label: '全部保存' },
          { act: 'sep', label: '' },
          { act: 'refresh-tree', label: '刷新文件树' },
        ],
      },
      {
        btn: L.menubarEditBtn,
        items: [
          { act: 'undo', label: '撤销', shortcut: 'Ctrl+Z' },
          { act: 'redo', label: '重做', shortcut: 'Ctrl+Y' },
          { act: 'sep', label: '' },
          { act: 'find', label: '查找', shortcut: 'Ctrl+F' },
          { act: 'replace', label: '替换', shortcut: 'Ctrl+H' },
          { act: 'sep', label: '' },
          { act: 'comment', label: '切换行注释', shortcut: 'Ctrl+/' },
        ],
      },
      {
        btn: L.menubarViewBtn,
        items: [
          { act: 'view-bottom', label: '切换终端面板', shortcut: 'Ctrl+`' },
          { act: 'view-sidebar', label: '切换文件树侧栏' },
        ],
      },
      {
        btn: L.menubarBuildBtn,
        items: [
          { act: 'build-file', label: '编译当前文件', shortcut: 'Ctrl+Shift+B' },
          { act: 'build-project', label: '编译整个项目' },
        ],
      },
      {
        btn: L.menubarTermBtn,
        items: [
          { act: 'term-new', label: '新建终端', shortcut: 'Ctrl+Shift+`' },
          { act: 'term-clear', label: '清空当前终端' },
          { act: 'term-close', label: '关闭当前会话' },
        ],
      },
      {
        btn: L.menubarHelpBtn,
        items: [
          { act: 'help-docs', label: '官方文档 (xt.markjy.com)' },
          { act: 'sep', label: '' },
          { act: 'help-about', label: '关于铸造厂…' },
        ],
      },
    ],
    (act) => {
      if (act === 'open-folder') openFolder();
      else if (act === 'new-project') void newProjectModal();
      else if (act === 'save') void saveActive();
      else if (act === 'save-all') void tabs.saveAll().catch((err: unknown) => showToast(`保存失败: ${String(err)}`, 'err'));
      else if (act === 'refresh-tree') void reloadTree();
      else if (act === 'undo') editor.trigger('menubar', 'undo', null);
      else if (act === 'redo') editor.trigger('menubar', 'redo', null);
      else if (act === 'find') {
        editor.focus();
        editor.trigger('menubar', 'actions.find', null);
      } else if (act === 'replace') {
        editor.focus();
        editor.trigger('menubar', 'editor.action.startFindReplaceAction', null);
      } else if (act === 'comment') editor.trigger('menubar', 'editor.action.commentLine', null);
      else if (act === 'view-bottom') {
        setBottomVisible(L.bottomPanel.classList.contains('hidden'));
      } else if (act === 'view-sidebar') {
        setSidebarVisible(!sidebarVisible);
      } else if (act === 'build-file') {
        void buildCurrent();
      } else if (act === 'build-project') {
        void buildProject();
      } else if (act === 'term-new') {
        if (!workspace) {
          showToast('先打开工程文件夹再新建终端', 'err');
          return;
        }
        setBottomVisible(true);
        setBottomTab('term');
        void term.newSession(workspace);
      } else if (act === 'term-clear') {
        term.clearActive();
      } else if (act === 'term-close') {
        void term.closeActive();
      } else if (act === 'help-docs') {
        void openUrl('https://xt.markjy.com');
      } else if (act === 'help-about') {
        void aboutModal();
      }
    },
  );

  byId('wl-open').addEventListener('click', openFolder);
  byId('wl-new').addEventListener('click', () => void newProjectModal());
  byId('btn-run').addEventListener('click', () => void runActive());
  byId('btn-stop').addEventListener('click', () => {
    if (!term.stopRun()) showToast('没有正在运行的会话');
  });
  L.btnRefreshTree.addEventListener('click', () => void reloadTree());
  L.btnEye.addEventListener('click', () => {
    const cur = getSettings().treeDisplay ?? defaultSettings().treeDisplay;
    const next = EYE_ORDER[(EYE_ORDER.indexOf(cur) + 1) % EYE_ORDER.length];
    fileTree.setDisplay(next);
    void saveSettings({ ...getSettings(), treeDisplay: next })
      .then(applyEye)
      .catch(() => applyEye());
  });
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
    } else if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyB') {
      e.preventDefault();
      void buildCurrent();
    } else if (e.ctrlKey && e.shiftKey && e.code === 'Backquote') {
      e.preventDefault();
      if (!workspace) {
        showToast('先打开工程文件夹再新建终端', 'err');
        return;
      }
      setBottomVisible(true);
      setBottomTab('term');
      void term.newSession(workspace);
    } else if (e.ctrlKey && !e.shiftKey && e.code === 'Backquote') {
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
  fileTree.setDisplay(getSettings().treeDisplay ?? defaultSettings().treeDisplay);
  applyEye();
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
