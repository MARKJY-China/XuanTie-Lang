// 玄铁铸造厂 v0.1 —— 主胶水层:装配布局/编辑器/LSP/终端/运行/铁铺/文件树
// v0.1 作用域纪律见 ide/AGENTS.md(调试器 UI / 插件系统 / Git 界面 / 控件设计器 = 禁区)
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { open as pickDialog } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow, PhysicalSize } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getVersion } from '@tauri-apps/api/app';
import '@vscode/codicons/dist/codicon.css';
import { registerXtLanguage } from './lang/xt';
import * as backend from './backend';
import {
  getSettings,
  loadSettings,
  resolveLspServer,
  resolveTiepm,
  resolveXtc,
  saveSettings,
} from './settings';
import { XtLspClient, type LspStatus } from './lsp/client';
import { attachLspFeatures } from './lsp/features';
import { buildLayout, initMenus, initSplitters, initWindowControls } from './ui/layout';
import { TabManager } from './ui/tabs';
import { FileTree } from './ui/filetree';
import { ProblemsPanel } from './ui/problems';
import { SelectionTools } from './ui/selection-tools';
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
import { ENCODINGS, defaultSettings, type AccountState, type FileNode, type TreeDisplay } from './types';
import * as accountApi from './account/account';
import { AiChatPanel, type ChatMsg } from './ai/aichat';
import { checkAndFetchDocs } from './ai/docs';
import { setAiLogEnabled, installGlobalErrorHooks } from './ai/log-bus';
import type { AiProvider } from './types';

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
initSplitters(L, {
  onAiWidth: (w) => {
    void saveSettings({ ...getSettings(), ai: { ...getSettings().ai, dockWidth: w } });
  },
});

// AI 面板宽度恢复。必须在 boot() 的 loadSettings 之后执行——
// 模块作用域时设置文件尚未读入,getSettings() 只有默认值,恢复永远不会命中。
function restoreAiDockWidth(): void {
  const saved = getSettings().ai.dockWidth;
  if (typeof saved === 'number' && Number.isFinite(saved)) {
    const w = Math.min(800, Math.max(260, Math.round(saved)));
    document.documentElement.style.setProperty('--ai-w', w + 'px');
  }
}

// 全局错误陷阱:任何未捕获错误立即可见(不再静默死掉整个界面)
window.addEventListener('error', (e) => {
  showToast(`脚本错误: ${e.message}`, 'err');
});
window.addEventListener('unhandledrejection', (e) => {
  showToast(`异步错误: ${String(e.reason)}`, 'err');
});
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
      renderProblemsBadge();
    },
    onActivate: () => updateEncodingDisplay(),
  },
  (p) => confirmBox('关闭未保存', `${basename(p)} 有未保存的更改,放弃并关闭?`),
);
const term = new TerminalPane(L.termHost, L.termSessionBar, L.buildHost);
const runner = new Runner(term, () => workspace);
const tiepm = new Tiepm(term, () => workspace);

// ---- 智器对话(右侧 dock,Trae 式全高;会话按工程区持久化) ----
let aiDockOpen = false;
let aiSessionId: string | null = null;
const AI_HISTORY_REL = '.foundry\\sessions.json';

interface AiSession {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMsg[];
}

async function loadAiSessions(): Promise<AiSession[]> {
  if (!workspace) return [];
  try {
    const r = await backend.fsReadFile(backend.joinPath(workspace, AI_HISTORY_REL));
    const j = JSON.parse(r.text) as { sessions?: AiSession[] };
    return Array.isArray(j.sessions) ? j.sessions : [];
  } catch {
    return [];
  }
}

async function persistAiConversation(
  msgs: ChatMsg[],
): Promise<void> {
  if (!workspace || msgs.length === 0) return;
  // 会话存储目录必须先建:fs_write_file 有父目录守卫,不建则永远写失败
  const dir = backend.joinPath(workspace, '.foundry');
  if (!(await backend.fsExists(dir))) await backend.fsCreateDir(dir);
  const sessions = await loadAiSessions();
  if (!aiSessionId) aiSessionId = `s-${Date.now()}`;
  const title = (msgs.find((m) => m.role === 'user')?.content ?? '会话').slice(0, 24);
  const rec: AiSession = { id: aiSessionId, title, updatedAt: Date.now(), messages: msgs };
  const i = sessions.findIndex((s) => s.id === aiSessionId);
  if (i >= 0) sessions[i] = rec;
  else sessions.unshift(rec);
  await backend.fsWriteFile(backend.joinPath(workspace, AI_HISTORY_REL), JSON.stringify({ sessions }, null, 2));
}

function setAiDock(open: boolean): void {
  aiDockOpen = open;
  L.aiDock.classList.toggle('open', open);
  // 兄弟节点选择器够不着,显式切分割条可见性(拖拽入口)
  L.aiSplit.style.display = open ? 'block' : 'none';
  if (open) {
    void runCloudCheck(false).then(() => updateAiGate());
    void refreshAiConfig();
    aiPanel.focus();
  }
  updateAiGate();
  if (getSettings().ui.aiDock !== open) {
    void saveSettings({ ...getSettings(), ui: { ...getSettings().ui, aiDock: open } }).catch(() => undefined);
  }
}

// 官方 AI 前端展示配置(名称/思考档位),来自社区 /api/ai/config,失败回落默认
let aiCfg = { name: '玄铁AI', thinking: ['off', 'low', 'high', 'max'], vision: false, video: false };

async function refreshAiConfig(): Promise<void> {
  const base = getSettings().account.baseUrl.replace(/\/+$/, '');
  if (!base) return;
  try {
    const r = await backend.httpJson('GET', base + '/api/ai/config', null);
    const j = JSON.parse(r.body) as {
      ok?: boolean;
      data?: { name?: string; thinking?: string[]; vision?: boolean; video?: boolean };
    };
    if (j.ok && j.data) {
      aiCfg = {
        name: j.data.name || '玄铁AI',
        thinking: Array.isArray(j.data.thinking) && j.data.thinking.length > 0 ? j.data.thinking : aiCfg.thinking,
        vision: j.data.vision === true,
        video: j.data.video === true,
      };
      aiPanel.refreshModelLabel();
      aiPanel.refreshThinkLabel();
    }
  } catch {
    // 离线/旧服务端:保持默认
  }
}

// Phase-2 DSH agent 内核:动态 import 入口。首次调用才加载 665KB 内核 chunk(独立分包,
// 不进主 chunk);Phase-3 面板接线时经 window.__xtDshLoadRuntime() 取得 runtime 模块。
// 挂 window 是刻意的集成缝:app 构建会 tree-shake 未被引用的 entry 导出,不挂就被整个摇掉。
export function loadDshRuntime(): Promise<typeof import('./ai/dsh/runtime')> {
  return import('./ai/dsh/runtime');
}
(window as unknown as Record<string, unknown>).__xtDshLoadRuntime = loadDshRuntime;

const aiPanel = new AiChatPanel(
  {
    msgs: L.aiMsgs,
    refChips: L.aiRefChips,
    attachBar: L.aiAttachBar,
    btnAttach: L.btnAiAttach,
    statsBar: L.aiStatsBar,
    statTurn: L.aiStatTurn,
    statUsage: L.aiStatUsage,
    statCtx: L.aiStatCtx,
    dock: L.aiDock,
    scrollBtn: L.aiScrollBottom,
    outline: L.aiOutline,
    input: L.aiInput,
    btnSend: L.btnAiSend,
    btnNew: L.btnAiNew,
    btnHistory: L.btnAiHistory,
    outlineBtn: L.btnAiOutline,
    btnSettings: L.btnAiSettings,
    btnClose: L.btnAiClose,
    modelBtn: L.aiModelBtn,
    agentBtn: L.aiAgentBtn,
    modeBtn: L.aiModeBtn,
    approvalsEl: L.aiApprovals,
    drag: L.aiDrag,
  },
  {
    listTargets: () => [
      { id: '官方', label: `${aiCfg.name}(官方)` },
      ...getSettings().ai.providers.map((p) => ({ id: p.name, label: `${p.name} · ${p.model}` })),
    ],
    getTarget: () => {
      const ai = getSettings().ai;
      const p = ai.providers.find((x) => x.name === ai.active);
      return p ? { kind: 'custom', provider: p } : { kind: 'official' };
    },
    setTarget: (id) => {
      void saveSettings({ ...getSettings(), ai: { ...getSettings().ai, active: id } }).then(() =>
        aiPanel.refreshModelLabel(),
      );
    },
    getThinking: () => getSettings().ai.thinking ?? 'off',
    setThinking: (v) => {
      void saveSettings({ ...getSettings(), ai: { ...getSettings().ai, thinking: v } });
    },
    listThinking: () => aiCfg.thinking,
    officialName: () => aiCfg.name,
    getAccount: () => getSettings().account,
    getOfficialMediaCaps: () => ({ vision: aiCfg.vision, video: aiCfg.video }),
    openFileInEditor: (p) => {
      const abs = /^[A-Za-z]:[\\/]/.test(p) ? p : backend.joinPath(workspace, p);
      void tabs
        .openFile(abs)
        .catch((err: unknown) => showToast(`打开失败: ${String(err)}`, 'err'));
    },
    getSessionId: () => {
      if (!aiSessionId) aiSessionId = `s-${Date.now()}`;
      return aiSessionId;
    },
    getWorkspace: () => workspace,
    getAgentMode: () => {
      const m = getSettings().ai.agentMode;
      return m === 'auto-edit' || m === 'full-control' ? m : 'confirm';
    },
    setAgentMode: (v) => {
      void saveSettings({ ...getSettings(), ai: { ...getSettings().ai, agentMode: v } });
    },
    getCmdWhitelist: () => getSettings().ai.cmdWhitelist ?? [],
    onFileWritten: (absPath) => {
      void reloadTree();
      void tabs.reloadIfClean(absPath).then((r) => {
        if (r === 'dirty') console.warn(`[AI 写文件] ${absPath} 缓冲区有未保存修改,未覆盖`);
      });
    },
    addCmdToken: (token) => {
      const ai = getSettings().ai;
      const list = ai.cmdWhitelist ?? [];
      if (list.some((w) => w.toLowerCase() === token.toLowerCase())) return;
      void saveSettings({ ...getSettings(), ai: { ...ai, cmdWhitelist: [...list, token] } });
    },
    onNewSession: () => {
      aiSessionId = null;
    },
    onConversationChange: (msgs) => {
      void persistAiConversation(msgs).catch((err: unknown) =>
        console.error('AI 会话保存失败', err),
      );
    },
    onOpenHistory: () => void aiHistoryModal(),
    onToggleOutline: () => aiPanel.toggleOutline(),
    onOpenProviders: () => void aiProvidersModal(),
    onClose: () => setAiDock(false),
  },
);
aiPanel.refreshModelLabel();

async function aiHistoryModal(): Promise<unknown> {
  if (!workspace) {
    showToast('先打开工程文件夹(会话历史按工程区存储)', 'err');
    return;
  }
  const sessions = await loadAiSessions();
  await showCustomModal(
    '会话历史',
    (body, close) => {
      if (sessions.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'pkg-empty';
        empty.textContent = '当前工程还没有会话记录';
        body.appendChild(empty);
      }
      for (const s of sessions) {
        const row = document.createElement('div');
        row.className = 'pkg-row';
        const nm = document.createElement('span');
        nm.className = 'pkg-name';
        nm.textContent = s.title;
        const info = document.createElement('span');
        info.style.cssText = 'color:var(--fg-dim);font-size:11.5px;margin-left:auto;';
        info.textContent = `${s.messages.length} 条 · ${new Date(s.updatedAt).toLocaleString()}`;
        row.append(nm, info);
        row.addEventListener('click', () => {
          aiSessionId = s.id;
          aiPanel.setMessages(s.messages);
          close();
        });
        body.appendChild(row);
      }
      const foot = document.createElement('div');
      foot.className = 'm-foot';
      const btnClose = document.createElement('button');
      btnClose.className = 'mbtn primary';
      btnClose.textContent = '关闭';
      btnClose.addEventListener('click', () => close());
      foot.appendChild(btnClose);
      body.appendChild(foot);
    },
    '会话按工程区存储于 工程\\.foundry\\sessions.json',
  );
}

// AI 提供商管理:列表 + 添加/编辑表单(OpenAI 兼容;Key 存本地 settings.json)
function aiProvidersModal(): Promise<unknown> {
  return showCustomModal('管理 AI 提供商', (body, close) => {
    // ---- 分区 1:自定义提供商 ----
    const sec1 = document.createElement('div');
    sec1.className = 'm-section';
    const sec1Title = document.createElement('div');
    sec1Title.className = 'm-sec-title';
    sec1Title.textContent = '自定义提供商';
    const sec1Hint = document.createElement('div');
    sec1Hint.className = 'm-sec-hint';
    sec1Hint.textContent = 'OpenAI 兼容端点;不配置时默认使用玄铁官方通道';
    sec1.append(sec1Title, sec1Hint);

    const listEl = document.createElement('div');
    listEl.className = 'pkg-list';
    sec1.appendChild(listEl);

    let editing: string | null = null; // 正在编辑的原名称(null = 添加模式)
    const form = document.createElement('div');
    form.className = 'm-section-form';

    const inName = document.createElement('input');
    inName.type = 'text';
    inName.placeholder = '如:DeepSeek';
    const inBase = document.createElement('input');
    inBase.type = 'text';
    inBase.placeholder = '如 https://api.deepseek.com/v1';
    const inKey = document.createElement('input');
    inKey.type = 'password';
    inKey.placeholder = '本地模型可留空';
    const inModel = document.createElement('input');
    inModel.type = 'text';
    inModel.placeholder = '如 deepseek-chat';
    const mkField = (label: string, input: HTMLInputElement): void => {
      const r = document.createElement('div');
      r.className = 'mrow';
      r.appendChild(document.createElement('label')).textContent = label;
      r.appendChild(input);
      form.appendChild(r);
    };
    mkField('名称', inName);
    mkField('接口地址(OpenAI 兼容,含 /v1)', inBase);
    mkField('API Key', inKey);
    mkField('模型名', inModel);
    // 多模态能力(用户自报;发送图片/视频前据此校验)
    const mkCheck = (label: string): HTMLInputElement => {
      const r = document.createElement('div');
      r.className = 'mrow';
      const lab = document.createElement('label');
      lab.className = 'checkline';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      const span = document.createElement('span');
      span.textContent = label;
      lab.append(cb, span);
      r.appendChild(lab);
      form.appendChild(r);
      return cb;
    };
    const cbVision = mkCheck('支持图片输入(多模态)');
    const cbVideo = mkCheck('支持视频输入(多模态)');
    const msg = document.createElement('div');
    msg.className = 'm-msg';
    const btnSave = document.createElement('button');
    btnSave.className = 'mbtn';
    btnSave.textContent = '保存提供商';
    btnSave.addEventListener('click', () => {
      msg.textContent = '';
      const name = inName.value.trim();
      const baseUrl = inBase.value.trim();
      const model = inModel.value.trim();
      if (!name || !baseUrl || !model) {
        msg.textContent = '名称、接口地址、模型名必填';
        return;
      }
      const ai = getSettings().ai;
      const provider: AiProvider = {
        name,
        baseUrl,
        apiKey: inKey.value.trim(),
        model,
        supportsVision: cbVision.checked,
        supportsVideo: cbVideo.checked,
      };
      const providers = ai.providers.filter((x) => x.name !== (editing ?? name));
      providers.push(provider);
      const active = ai.active === editing ? name : ai.active;
      void saveSettings({ ...getSettings(), ai: { ...getSettings().ai, providers, active } })
        .then(() => {
          aiPanel.refreshModelLabel();
          editing = null;
          refreshList();
          inName.value = inBase.value = inKey.value = inModel.value = '';
          cbVision.checked = false;
          cbVideo.checked = false;
        })
        .catch((err: unknown) => {
          msg.textContent = String(err);
        });
    });
    const formFoot = document.createElement('div');
    formFoot.className = 'm-form-foot';
    formFoot.append(msg, btnSave);
    form.appendChild(formFoot);

    const refreshList = (): void => {
      listEl.innerHTML = '';
      const ai = getSettings().ai;
      if (ai.providers.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'pkg-empty';
        empty.textContent = '暂无自定义提供商(默认使用玄铁官方)';
        listEl.appendChild(empty);
      }
      for (const p of ai.providers) {
        const row = document.createElement('div');
        row.className = 'pkg-row';
        const nm = document.createElement('span');
        nm.className = 'pkg-name';
        nm.textContent = p.name;
        const info = document.createElement('span');
        info.className = 'pkg-info';
        info.textContent = `${p.model} · ${p.baseUrl}`;
        const btnEdit = document.createElement('button');
        btnEdit.className = 'mbtn mbtn-sm';
        btnEdit.textContent = '编辑';
        btnEdit.addEventListener('click', () => {
          editing = p.name;
          inName.value = p.name;
          inBase.value = p.baseUrl;
          inKey.value = p.apiKey;
          inModel.value = p.model;
          cbVision.checked = p.supportsVision === true;
          cbVideo.checked = p.supportsVideo === true;
        });
        const btnDel = document.createElement('button');
        btnDel.className = 'mbtn mbtn-sm';
        btnDel.textContent = '删除';
        btnDel.addEventListener('click', () => {
          void confirmBox('删除提供商', `删除「${p.name}」?`).then((ok) => {
            if (!ok) return;
            const aiNow = getSettings().ai;
            const providers = aiNow.providers.filter((x) => x.name !== p.name);
            const active = aiNow.active === p.name ? '玄铁官方' : aiNow.active;
            void saveSettings({ ...getSettings(), ai: { ...getSettings().ai, providers, active } }).then(() => {
              aiPanel.refreshModelLabel();
              refreshList();
            });
          });
        });
        row.append(nm, info, btnEdit, btnDel);
        listEl.appendChild(row);
      }
    };
    refreshList();
    sec1.appendChild(form);

    // ---- 分区 2:Shell 指令白名单 ----
    const sec2 = document.createElement('div');
    sec2.className = 'm-section';
    const sec2Title = document.createElement('div');
    sec2Title.className = 'm-sec-title';
    sec2Title.textContent = 'Shell 指令白名单';
    const sec2Hint = document.createElement('div');
    sec2Hint.className = 'm-sec-hint';
    sec2Hint.textContent = 'Agent 的 run_command 命中命令首 token 即免审批(如 dir / xtc / git)';
    sec2.append(sec2Title, sec2Hint);

    const wlList = document.createElement('div');
    wlList.className = 'pkg-list';
    const wlMsg = document.createElement('div');
    wlMsg.className = 'm-msg';
    const wlInput = document.createElement('input');
    wlInput.type = 'text';
    wlInput.placeholder = '输入命令首 token,如 dir';
    const btnWlAdd = document.createElement('button');
    btnWlAdd.className = 'mbtn';
    btnWlAdd.textContent = '添加';
    const wlInputRow = document.createElement('div');
    wlInputRow.className = 'mrow';
    wlInputRow.appendChild(document.createElement('label')).textContent = '添加白名单指令';
    const wlLine = document.createElement('div');
    wlLine.className = 'rowline';
    wlLine.append(wlInput, btnWlAdd);
    wlInputRow.appendChild(wlLine);

    const refreshWhitelist = (): void => {
      wlList.innerHTML = '';
      const list = getSettings().ai.cmdWhitelist ?? [];
      if (list.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'pkg-empty';
        empty.textContent = '白名单为空(一切命令都需逐次批准)';
        wlList.appendChild(empty);
      }
      for (const token of list) {
        const row = document.createElement('div');
        row.className = 'pkg-row';
        const nm = document.createElement('span');
        nm.className = 'pkg-name pkg-mono';
        nm.textContent = token;
        const btnDel = document.createElement('button');
        btnDel.className = 'ibtn';
        btnDel.title = `删除 ${token}`;
        btnDel.innerHTML = '<i class="codicon codicon-close"></i>';
        btnDel.addEventListener('click', () => {
          saveWhitelist((getSettings().ai.cmdWhitelist ?? []).filter((w) => w !== token));
        });
        row.append(nm, btnDel);
        wlList.appendChild(row);
      }
    };
    const saveWhitelist = (list: string[]): void => {
      void saveSettings({ ...getSettings(), ai: { ...getSettings().ai, cmdWhitelist: list } })
        .then(() => refreshWhitelist())
        .catch((err: unknown) => {
          wlMsg.textContent = String(err);
        });
    };
    btnWlAdd.addEventListener('click', () => {
      wlMsg.textContent = '';
      const token = wlInput.value.trim().split(/\s+/)[0] ?? '';
      if (!token) {
        wlMsg.textContent = '请输入命令首 token';
        return;
      }
      const list = getSettings().ai.cmdWhitelist ?? [];
      if (list.some((w) => w.toLowerCase() === token.toLowerCase())) {
        wlMsg.textContent = `「${token}」已在白名单`;
        return;
      }
      wlInput.value = '';
      saveWhitelist([...list, token]);
    });
    wlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') btnWlAdd.click();
    });
    refreshWhitelist();
    sec2.append(wlList, wlInputRow, wlMsg);

    body.append(sec1, sec2);
    const foot = document.createElement('div');
    foot.className = 'm-foot';
    const btnClose = document.createElement('button');
    btnClose.className = 'mbtn primary';
    btnClose.textContent = '完成';
    btnClose.addEventListener('click', () => close());
    foot.appendChild(btnClose);
    body.appendChild(foot);
  }, '官方通道无需配置;自定义提供商与 Agent 白名单在此管理');
}

lsp.onStatus(updateLspStatus);
attachLspFeatures(lsp, editor, {
  openAt: (p, line, column) => {
    void tabs.openFile(p, { line, column });
  },
  onDiagnostics: (p, diags) => {
    problems.update(p, diags);
    renderProblemsBadge();
  },
});

// ---- 云连接状态(未连接:状态栏红字 + AI dock 遮罩) ----
type CloudState = 'unknown' | 'ok' | 'offline';
let cloudState: CloudState = 'unknown';

function setCloudState(st: CloudState): void {
  cloudState = st;
  const item = byId('sb-cloud');
  item.style.display = st === 'offline' ? '' : 'none';
  if (st !== 'offline') setAiMask(null);
  updateAiGate();
}

async function checkCloud(): Promise<boolean> {
  const base = getSettings().account.baseUrl.replace(/\/+$/, '');
  if (!base) return false;
  try {
    const r = await backend.httpJson('GET', base + '/api/ai/config', null, undefined, undefined, 8);
    const j = JSON.parse(r.body) as { ok?: boolean };
    return j.ok === true;
  } catch {
    return false;
  }
}

async function runCloudCheck(notifyOnOk: boolean): Promise<boolean> {
  const ok = await checkCloud();
  setCloudState(ok ? 'ok' : 'offline');
  if (ok && notifyOnOk) showToast('已连接玄铁服务器', 'ok');
  return ok;
}

async function reconnectFlow(): Promise<void> {
  setAiMask('connecting', 0);
  for (let i = 1; i <= 10; i++) {
    setAiMask('connecting', i);
    if (await checkCloud()) {
      setCloudState('ok');
      showToast('已重新连接玄铁服务器', 'ok');
      return;
    }
  }
  setAiMask('offline-failed', 0);
}

// AI dock 遮罩:离线 > 未登录 > 无
function updateAiGate(): void {
  if (!aiDockOpen) return;
  if (cloudState === 'offline') {
    setAiMask('offline', 0);
    return;
  }
  const acc = getSettings().account;
  if (!acc.username || !acc.cookie) {
    setAiMask('nologin', 0);
    return;
  }
  setAiMask(null);
}

function setAiMask(
  mode: 'offline' | 'connecting' | 'nologin' | 'offline-failed' | null,
  attempt = 0,
): void {
  const mask = byId('ai-mask');
  const text = byId('ai-mask-text');
  const btn = byId('ai-mask-btn');
  if (mode === null) {
    mask.style.display = 'none';
    return;
  }
  mask.style.display = 'flex';
  const icon = byId('ai-mask-icon');
  icon.style.display = mode === 'nologin' ? '' : 'none';
  btn.style.display = 'none';
  text.className = '';
  if (mode === 'offline') {
    text.textContent = '未连接服务端，无法使用';
    text.style.color = '#fff';
    btn.style.display = '';
    btn.textContent = '重新连接';
  } else if (mode === 'connecting') {
    text.textContent = `连接中…(第 ${attempt}/10 次)`;
    text.style.color = '#fff';
  } else if (mode === 'offline-failed') {
    text.textContent = '无法连接服务端';
    text.style.color = '#fff';
    btn.style.display = '';
    btn.textContent = '重新连接';
  } else if (mode === 'nologin') {
    text.textContent = '登录玄铁账户后即可使用智器对话';
    text.style.color = '#fff';
    btn.style.display = '';
    btn.textContent = '登录';
  }
}

// ---- 构建徽标(三态:running 黄呼吸灯 / success 绿点[点开隐藏] / failed 红底白叹号)与问题计数 ----
type BuildBadgeState = 'idle' | 'running' | 'success' | 'failed';
let buildBadge: BuildBadgeState = 'idle';

function renderBuildBadge(): void {
  const b = L.badgeBuild;
  if (buildBadge === 'idle') {
    b.style.display = 'none';
    return;
  }
  b.style.display = 'inline-flex';
  b.className = 'badge dot ' + (buildBadge === 'running' ? 'run' : buildBadge === 'success' ? 'ok' : 'fail');
}

function renderProblemsBadge(): void {
  const b = L.badgeProblems;
  const n = problems.count();
  if (n <= 0) {
    b.style.display = 'none';
    return;
  }
  b.style.display = 'inline-flex';
  b.className = 'badge count';
  b.textContent = n > 9 ? '9+' : String(n);
}

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

function setBottomTab(which: 'term' | 'build' | 'problems'): void {
  L.btabTerm.classList.toggle('active', which === 'term');
  L.btabBuild.classList.toggle('active', which === 'build');
  L.btabProblems.classList.toggle('active', which === 'problems');
  L.termHost.style.display = which === 'term' ? 'block' : 'none';
  L.buildHost.classList.toggle('active', which === 'build');
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
    showToast(detail + '。可在设置里手工指定。', 'err');
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
  // 切工程前:旧工程会话落盘,会话指针重置(会话按工程区隔离)
  try {
    const old = aiPanel.getMessages();
    if (old.length > 0) await persistAiConversation(old);
  } catch {
    // 保存失败不阻塞打开
  }
  aiSessionId = null;
  aiPanel.clear();  try {
    fileTree.setTree(await backend.fsListTree(dir), dir);
  } catch (err) {
    showToast(`读取目录失败: ${String(err)}`, 'err');
    return;
  }
  workspace = dir;
  entryFile = '';
  try {
    const cfg = (await backend.fsReadFile(backend.joinPath(dir, '玄铁.配置.toml'))).text;
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
  // 恢复该工程最近一次 AI 会话(上次关 IDE 时的对话)
  try {
    const sessions = await loadAiSessions();
    if (sessions.length > 0) {
      const last = sessions[0];
      aiSessionId = last.id;
      aiPanel.setMessages(last.messages);
    }
  } catch (err) {
    console.error('AI 会话恢复失败', err);
  }
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
      // 外观:编辑器字号/字体、整窗缩放、主题
      const rLook = document.createElement('div');
      rLook.className = 'mrow';
      rLook.appendChild(document.createElement('label')).textContent = '外观';
      const look = document.createElement('div');
      look.className = 'grid2';
      look.style.display = 'grid';
      look.style.gridTemplateColumns = '1fr 1fr';
      look.style.gap = '8px';
      const mkSel = (label: string): { row: HTMLElement; sel: HTMLSelectElement } => {
        const row = document.createElement('div');
        row.className = 'mrow';
        row.appendChild(document.createElement('label')).textContent = label;
        const sel = document.createElement('select');
        row.appendChild(sel);
        return { row, sel };
      };
      const mkIn = (label: string, input: HTMLInputElement): HTMLElement => {
        const row = document.createElement('div');
        row.className = 'mrow';
        row.appendChild(document.createElement('label')).textContent = label;
        row.appendChild(input);
        return row;
      };
      const fSize = document.createElement('input');
      fSize.type = 'number';
      fSize.min = '10';
      fSize.max = '28';
      fSize.value = String(s.editor?.fontSize ?? 14);
      const fFont = document.createElement('input');
      fFont.type = 'text';
      fFont.value = s.editor?.fontFamily ?? '';
      fFont.placeholder = '默认 Cascadia Mono';
      const zSel = mkSel('整窗缩放');
      for (const z of [80, 90, 100, 110, 125, 150]) {
        const o = document.createElement('option');
        o.value = String(z / 100);
        o.textContent = `${z}%`;
        if ((s.zoom ?? 1) === z / 100) o.selected = true;
        zSel.sel.appendChild(o);
      }
      const tSel = mkSel('主题');
      for (const [v, label] of [['dark', '暗色'], ['light', '亮色']] as const) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        if ((s.theme ?? 'dark') === v) o.selected = true;
        tSel.sel.appendChild(o);
      }
      look.append(mkIn('字号', fSize), mkIn('字体', fFont), zSel.row, tSel.row);
      rLook.appendChild(look);
      body.appendChild(rLook);

      // 启动时自动检查铁器更新
      const rAuto = document.createElement('div');
      rAuto.className = 'mrow';
      const check = document.createElement('label');
      check.className = 'checkline';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = s.autoCheckTiepmUpdates;
      const txt = document.createElement('span');
      txt.textContent = '启动铸造厂时自动检查铁器更新';
      check.append(cb, txt);
      rAuto.appendChild(check);
      body.appendChild(rAuto);
      // 玄铁文档(启动自动比对服务端版本,有更新则拉取;此处可手动触发)
      const rDocs = document.createElement('div');
      rDocs.className = 'mrow';
      rDocs.appendChild(document.createElement('label')).textContent =
        `玄铁文档(当前版本:${getSettings().docsVersion ?? '未拉取'})`;
      const lineDocs = document.createElement('div');
      lineDocs.className = 'rowline';
      const btnDocs = document.createElement('button');
      btnDocs.className = 'mbtn';
      btnDocs.textContent = '立即检查更新';
      btnDocs.addEventListener('click', () => {
        btnDocs.disabled = true;
        btnDocs.textContent = '检查中…';
        void checkAndFetchDocs().then((r) => {
          showToast(
            r ? `文档已更新(${r.version},共 ${r.count} 篇)` : '文档已是最新,或服务暂不可达',
            r ? 'ok' : '',
          );
          btnDocs.disabled = false;
          btnDocs.textContent = '立即检查更新';
        });
      });
      lineDocs.appendChild(btnDocs);
      rDocs.appendChild(lineDocs);
      body.appendChild(rDocs);
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

      // 开发者分区:AI 链路日志控制台
      const rDev = document.createElement('div');
      rDev.className = 'mrow';
      const devCheck = document.createElement('label');
      devCheck.className = 'checkline';
      const devCb = document.createElement('input');
      devCb.type = 'checkbox';
      devCb.checked = s.devMode ?? false;
      const devTxt = document.createElement('span');
      devTxt.textContent = '开发者模式';
      devCheck.append(devCb, devTxt);
      rDev.appendChild(devCheck);
      const devHint = document.createElement('div');
      devHint.className = 'm-subtitle';
      devHint.style.padding = '2px 0 0';
      devHint.textContent = '开启后智器对话工具栏出现控制台按钮,实时查看 AI 链路日志';
      rDev.appendChild(devHint);
      body.appendChild(rDev);

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
          autoCheckTiepmUpdates: cb.checked,
          devMode: devCb.checked,
          editor: { fontSize: Math.max(10, Math.min(28, Number(fSize.value) || 14)), fontFamily: fFont.value.trim() },
          zoom: Number(zSel.sel.value) || 1,
          theme: (tSel.sel.value === 'light' ? 'light' : 'dark') as 'dark' | 'light',
        });
      });
      foot.append(cancel, ok);
      body.appendChild(foot);
    },
    '工具链路径留空则按 PATH 自动探测',
  ).then(async (result) => {
    const r = result as
      | {
          lsp?: string; xtc?: string; tiepm?: string; buildDir?: string;
          autoCheckTiepmUpdates?: boolean;
          devMode?: boolean;
          editor?: { fontSize: number; fontFamily: string };
          zoom?: number;
          theme?: 'dark' | 'light';
        }
      | undefined;
    if (!r) return;
    try {
      await saveSettings({
        ...getSettings(),
        lspServerPath: r.lsp ?? '',
        xtcPath: r.xtc ?? '',
        tiepmPath: r.tiepm ?? '',
        buildDir: r.buildDir ?? '',
        autoCheckTiepmUpdates: r.autoCheckTiepmUpdates ?? false,
        devMode: r.devMode ?? false,
        editor: r.editor ?? getSettings().editor,
        zoom: r.zoom ?? getSettings().zoom,
        theme: r.theme ?? getSettings().theme,
      });
      applyEditorPrefs();
      applyTheme();
      void applyZoom();
      applyDevMode();
      showToast('设置已保存', 'ok');
      if (workspace) await startLsp();
    } catch (err) {
      showToast(`保存设置失败: ${String(err)}`, 'err');
    }
  });
}

// ---- 运行 / 保存 ----
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

async function compileTo(xtc: string, src: string, out: string): Promise<void> {
  await tabs.saveAll();
  // 编译输出独立「构建」Tab:开始即打提示,消除"清屏后几秒无反应"的黑箱感
  setBottomVisible(true);
  setBottomTab('build');
  buildBadge = 'running';
  renderBuildBadge();
  term.clearBuild();
  term.writeBuild(`\x1b[90m[铸造厂] 编译已开始:${basename(src)}\x1b[0m\r\n`);
  term.writeBuild(`\x1b[90m[铸造厂] 产物:${out}\x1b[0m\r\n`);
  term.writeBuild(`\x1b[90m[铸造厂] 正在处理,详细编译日志如下\x1b[0m\r\n\r\n`);
  await term.runBuild(workspace, xtc, ['tie', src, '-sc', out, '-rz'], (code) => {
    buildBadge = code === 0 ? 'success' : 'failed';
    renderBuildBadge();
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
  await compileTo(xtc, p, backend.joinPath(dir, `${base}.exe`));
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
  await compileTo(xtc, entryPath, backend.joinPath(dir, `${base}.exe`));
}

// ---- 查看(底部面板/侧栏开关) ----
let sidebarVisible = true;

function setSidebarVisible(v: boolean): void {
  sidebarVisible = v;
  L.sidebar.style.display = v ? '' : 'none';
  L.sidebarSplit.style.display = v ? '' : 'none';
}

// ---- 编码 / 管理员模式(状态栏右下角) ----
function updateEncodingDisplay(): void {
  const p = tabs.getActivePath();
  byId('sb-encoding').textContent = p ? (tabs.getEncoding(p) ?? 'UTF-8') : '';
}

async function saveActive(): Promise<void> {
  const p = tabs.getActivePath();
  if (!p) return;
  try {
    await tabs.save(p);
  } catch (err) {
    const msg = String(err);
    if (msg.startsWith('ELEVATE:')) {
      // 权限不足:给出以管理员身份重启的通路(UAC 由用户确认)
      const ok = await confirmBox(
        '权限不足',
        `${basename(msg.slice('ELEVATE:'.length))} 写入被拒绝(需要管理员权限,或文件为只读)。\n以管理员身份重启铸造厂?`,
      );
      if (ok) {
        try {
          await backend.relaunchAsAdmin();
        } catch (relaunchErr) {
          showToast(String(relaunchErr), 'err');
        }
      }
      return;
    }
    showToast(`保存失败: ${msg}`, 'err');
  }
}

function encodingModal(): Promise<void> {
  const p = tabs.getActivePath();
  if (!p) return Promise.resolve();
  const current = tabs.getEncoding(p) ?? 'UTF-8';
  return showCustomModal(
    '文件编码',
    (body, close) => {
      const rCur = document.createElement('div');
      rCur.className = 'mrow';
      rCur.appendChild(document.createElement('label')).textContent = `当前编码:${current} · ${basename(p)}`;
      const rSel = document.createElement('div');
      rSel.className = 'mrow';
      rSel.appendChild(document.createElement('label')).textContent = '目标编码';
      const sel = document.createElement('select');
      for (const enc of ENCODINGS) {
        const opt = document.createElement('option');
        opt.value = enc;
        opt.textContent = enc;
        if (enc === current) opt.selected = true;
        sel.appendChild(opt);
      }
      rSel.appendChild(sel);
      body.append(rCur, rSel);
      const foot = document.createElement('div');
      foot.className = 'm-foot';
      const btnCancel = document.createElement('button');
      btnCancel.className = 'mbtn';
      btnCancel.textContent = '取消';
      const btnReopen = document.createElement('button');
      btnReopen.className = 'mbtn';
      btnReopen.textContent = '以此编码重新打开';
      const btnSave = document.createElement('button');
      btnSave.className = 'mbtn primary';
      btnSave.textContent = '以此编码保存';
      btnCancel.addEventListener('click', () => close());
      btnReopen.addEventListener('click', () => close({ mode: 'reopen', enc: sel.value }));
      btnSave.addEventListener('click', () => close({ mode: 'save', enc: sel.value }));
      foot.append(btnCancel, btnReopen, btnSave);
      body.appendChild(foot);
    },
    '重新打开会丢弃未保存的更改;保存会立即把当前内容写盘',
  ).then(async (result) => {
    const r = result as { mode?: string; enc?: string } | undefined;
    if (!r || !r.enc) return;
    try {
      if (r.mode === 'reopen') {
        await tabs.reopenWith(p, r.enc);
        showToast(`已以 ${r.enc} 重新打开`, 'ok');
      } else if (r.mode === 'save') {
        await tabs.saveWithEncoding(p, r.enc);
        showToast(`已按 ${r.enc} 保存`, 'ok');
      }
      updateEncodingDisplay();
    } catch (err) {
      showToast(String(err), 'err');
    }
  });
}

// ---- 账号(社区账号体系,HTTP 走 Rust 侧) ----
function updateAccountLabel(): void {
  L.accountLabel.textContent = getSettings().account.username || '账号';
}

async function saveAccount(next: Partial<AccountState>): Promise<void> {
  await saveSettings({ ...getSettings(), account: { ...getSettings().account, ...next } });
  updateAccountLabel();
}

async function aiPlansModal(): Promise<unknown> {
  const acc = getSettings().account;
  const base = acc.baseUrl.replace(/\/+$/, '');
  return showCustomModal(
    '订阅计划',
    (body, close) => {
      const list = document.createElement('div');
      list.style.display = 'flex';
      list.style.flexDirection = 'column';
      list.style.gap = '10px';
      body.appendChild(list);
      const status = document.createElement('div');
      status.className = 'pkg-empty';
      status.textContent = '读取中…';
      list.appendChild(status);
      backend
        .httpJson('GET', base + '/api/ai/plans', null, `xt_session=${acc.cookie}`)
        .then((res) => {
          status.remove();
          const j = JSON.parse(res.body) as {
            ok?: boolean; error?: string;
            data?: { plans?: { id: string; name: string; price: string; credits: number }[] };
          };
          if (!j.ok || !j.data?.plans) throw new Error(j.error ?? `HTTP ${res.status}`);
          for (const p of j.data.plans) {
            const row = document.createElement('div');
            row.className = 'pkg-row';
            const nm = document.createElement('span');
            nm.className = 'pkg-name';
            nm.textContent = p.name;
            const cr = document.createElement('span');
            cr.className = 'pkg-ver';
            const fmtCredits =
              p.credits >= 100000000 ? `${p.credits / 100000000} 亿积分` : `${p.credits / 10000} 万积分`;
            cr.textContent = fmtCredits;
            const buy = document.createElement('button');
            buy.className = 'mbtn';
            buy.textContent = `￥${p.price}/月`;
            buy.addEventListener('click', () => {
              backend
                .httpJson('POST', base + '/api/ai/subscribe', { planId: p.id }, `xt_session=${acc.cookie}`)
                .then((r2) => {
                  const j2 = JSON.parse(r2.body) as { ok?: boolean; error?: string };
                  showToast(j2.error ?? '已提交', j2.ok ? 'ok' : 'err');
                })
                .catch((err: unknown) => showToast(String(err), 'err'));
            });
            row.append(nm, cr, buy);
            list.appendChild(row);
          }
          const note = document.createElement('div');
          note.className = 'pkg-empty';
          note.textContent = '积分 = Token × 后台倍率;订阅额度在每日免费额度耗尽后自动兜底。';
          list.appendChild(note);
        })
        .catch((err: unknown) => {
          status.textContent = String(err);
        });
      const foot = document.createElement('div');
      foot.className = 'm-foot';
      const btnClose = document.createElement('button');
      btnClose.className = 'mbtn primary';
      btnClose.textContent = '关闭';
      btnClose.addEventListener('click', () => close());
      foot.appendChild(btnClose);
      body.appendChild(foot);
    },
    '订阅额度在每日免费额度耗尽后自动兜底',
  );
}

// 云异常说明弹窗(状态栏红字点击)
function showCloudIssueModal(): Promise<unknown> {
  return showCustomModal('未连接玄铁服务器', (body, close) => {
    const box = document.createElement('div');
    box.className = 'mrow';
    box.style.whiteSpace = 'pre-line';
    box.style.lineHeight = '1.8';
    box.textContent =
      '无法连接玄铁官方云服务,可能的原因如下:\n' +
      '1. 当前设备未连接互联网;\n' +
      '2. 玄铁服务器正在维护或临时故障;\n' +
      '3. 本地网络防火墙或代理拦截了连接;\n' +
      '4. 账号服务地址配置有误(可在设置中检查)。';
    body.appendChild(box);
    const foot = document.createElement('div');
    foot.className = 'm-foot';
    const btnRetry = document.createElement('button');
    btnRetry.className = 'mbtn primary';
    btnRetry.textContent = '重新连接';
    btnRetry.addEventListener('click', () => {
      btnRetry.disabled = true;
      btnRetry.textContent = '连接中…';
      void reconnectFlow().finally(() => close());
    });
    const btnOk = document.createElement('button');
    btnOk.className = 'mbtn';
    btnOk.textContent = '确定';
    btnOk.addEventListener('click', () => close());
    foot.append(btnRetry, btnOk);
    body.appendChild(foot);
  });
}

function accountModal(): Promise<void> {
  const acc = getSettings().account;
  const setHead = (title: string): void => {
    const head = document.querySelector('#modal-root .m-head');
    if (head) head.textContent = title;
  };
  if (acc.username && acc.cookie) {
    return showCustomModal(
      '玄铁账户',
      (body, close) => {
        const rName = document.createElement('div');
        rName.className = 'mrow';
        rName.appendChild(document.createElement('label')).textContent = '用户名';
        const name = document.createElement('span');
        name.textContent = acc.username;
        rName.appendChild(name);
        const rSrv = document.createElement('div');
        rSrv.className = 'mrow';
        rSrv.appendChild(document.createElement('label')).textContent = '账号服务';
        const srv = document.createElement('span');
        srv.textContent = acc.baseUrl;
        srv.className = 'linkish';
        srv.addEventListener('click', () => {
          void openUrl(acc.baseUrl);
        });
        rSrv.appendChild(srv);
        body.append(rName, rSrv);

        // AI 用量(登录后拉取)
        const rUsage = document.createElement('div');
        rUsage.className = 'mrow';
        rUsage.appendChild(document.createElement('label')).textContent = 'AI 用量(今日)';
        const usageText = document.createElement('span');
        usageText.textContent = '读取中…';
        usageText.className = 'mono';
        rUsage.appendChild(usageText);
        body.appendChild(rUsage);
        const usageBarWrap = document.createElement('div');
        usageBarWrap.style.height = '6px';
        usageBarWrap.style.borderRadius = '3px';
        usageBarWrap.style.background = 'var(--bg-deep)';
        usageBarWrap.style.overflow = 'hidden';
        const usageBar = document.createElement('div');
        usageBar.style.cssText = 'height:100%;width:0;background:var(--accent);transition:width .3s;';
        usageBarWrap.appendChild(usageBar);
        body.appendChild(usageBarWrap);
        const usageBase = acc.baseUrl.replace(/\/+$/, '');
        backend
          .httpJson('GET', usageBase + '/api/ai/usage', null, `xt_session=${acc.cookie}`)
          .then((res) => {
            const j = JSON.parse(res.body) as {
              ok?: boolean; error?: string;
              data?: { used?: number; dailyLimit?: number; bonus?: number; remaining?: number };
            };
            if (!j.ok || !j.data) throw new Error(j.error ?? `HTTP ${res.status}`);
            const d = j.data;
            const used = d.used ?? 0;
            const total = (d.dailyLimit ?? 0) + (d.bonus ?? 0);
            usageText.textContent = `已用 ${used} / ${total} 积分(今日额度 ${d.dailyLimit ?? 0} + 赠送 ${d.bonus ?? 0},剩余 ${d.remaining ?? 0})`;
            usageBar.style.width = total > 0 ? Math.min(100, (used / total) * 100).toFixed(1) + '%' : '0';
          })
          .catch((err: unknown) => {
            usageText.textContent = `读取失败: ${String(err)}`;
            usageText.style.color = 'var(--err)';
          });

        const foot = document.createElement('div');
        foot.className = 'm-foot';
        const btnPlans = document.createElement('button');
        btnPlans.className = 'mbtn';
        btnPlans.textContent = '订阅计划';
        btnPlans.addEventListener('click', () => {
          close();
          void aiPlansModal();
        });
        const btnOut = document.createElement('button');
        btnOut.className = 'mbtn';
        btnOut.textContent = '退出登录';
        const btnClose = document.createElement('button');
        btnClose.className = 'mbtn primary';
        btnClose.textContent = '关闭';
        btnOut.addEventListener('click', () => close({ mode: 'logout' }));
        btnClose.addEventListener('click', () => close());
        foot.append(btnPlans, btnOut, btnClose);
        body.appendChild(foot);
      },
      '玄铁账户与官方社区、铁铺一号互通',
    ).then(async (result) => {
      if ((result as { mode?: string } | undefined)?.mode !== 'logout') return;
      await accountApi.logout(acc.baseUrl, acc.cookie);
      await saveAccount({ cookie: '', username: '' });
      showToast('已退出登录', 'ok');
    });
  }

  return showCustomModal(
    '登录 玄铁账户',
    (body, close) => {
      // 分段式 Tab(登录/注册),标题随 Tab 切换
      const seg = document.createElement('div');
      seg.className = 'seg';
      const btnLogin = document.createElement('button');
      btnLogin.textContent = '登录';
      const btnReg = document.createElement('button');
      btnReg.textContent = '注册';
      seg.append(btnLogin, btnReg);

      const note = document.createElement('div');
      note.className = 'm-note';

      const form = document.createElement('div');
      form.className = 'mrow';

      const msg = document.createElement('div');
      msg.className = 'm-msg';

      const rSrv = document.createElement('div');
      rSrv.className = 'mrow srv-row';
      rSrv.appendChild(document.createElement('label')).textContent = '社区服务(一般无需修改)';
      const inBase = document.createElement('input');
      inBase.type = 'text';
      inBase.value = acc.baseUrl;
      inBase.placeholder = 'https://bbs.xt.markjy.com';
      rSrv.appendChild(inBase);

      const showLogin = (): void => {
        btnLogin.classList.add('active');
        btnReg.classList.remove('active');
        setHead('登录 玄铁账户');
        note.textContent = '';
        form.innerHTML = '';
        const rA = document.createElement('div');
        rA.className = 'mrow';
        rA.appendChild(document.createElement('label')).textContent = '用户名或邮箱';
        const inA = document.createElement('input');
        inA.type = 'text';
        inA.autocomplete = 'username';
        rA.appendChild(inA);
        const rP = document.createElement('div');
        rP.className = 'mrow';
        rP.appendChild(document.createElement('label')).textContent = '密码';
        const inP = document.createElement('input');
        inP.type = 'password';
        inP.autocomplete = 'current-password';
        inP.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') btnDo.click();
        });
        rP.appendChild(inP);
        const btnDo = document.createElement('button');
        btnDo.className = 'mbtn primary wide';
        btnDo.textContent = '登录';
        btnDo.addEventListener('click', () => {
          msg.textContent = '';
          const base = inBase.value.trim();
          if (!base || !inA.value.trim() || !inP.value) {
            msg.textContent = '请填写账号与密码';
            return;
          }
          btnDo.disabled = true;
          btnDo.textContent = '登录中…';
          accountApi
            .login(base, inA.value.trim(), inP.value)
            .then(({ cookie, username }) => close({ mode: 'login', base, cookie, username }))
            .catch((err: unknown) => {
              msg.textContent = String(err);
              btnDo.disabled = false;
              btnDo.textContent = '登录';
            });
        });
        form.append(rA, rP, btnDo);
        window.setTimeout(() => inA.focus(), 0);
      };

      const showRegister = (): void => {
        btnReg.classList.add('active');
        btnLogin.classList.remove('active');
        setHead('注册 玄铁账户');
        note.textContent = '注册完成后,可直接用这个账号登录官方社区';
        form.innerHTML = '';
        const rE = document.createElement('div');
        rE.className = 'mrow';
        rE.appendChild(document.createElement('label')).textContent = '邮箱';
        const lineE = document.createElement('div');
        lineE.className = 'rowline';
        const inE = document.createElement('input');
        inE.type = 'text';
        const btnCode = document.createElement('button');
        btnCode.className = 'mbtn';
        btnCode.textContent = '发送验证码';
        btnCode.addEventListener('click', () => {
          msg.textContent = '';
          const base = inBase.value.trim();
          if (!base || !inE.value.trim()) {
            msg.textContent = '请先填写邮箱';
            return;
          }
          btnCode.disabled = true;
          btnCode.textContent = '发送中…';
          accountApi
            .sendCode(base, inE.value.trim())
            .then(() => {
              msg.className = 'm-msg ok';
              msg.textContent = '验证码已发送到邮箱';
            })
            .catch((err: unknown) => {
              msg.textContent = String(err);
            })
            .finally(() => {
              btnCode.disabled = false;
              btnCode.textContent = '发送验证码';
            });
        });
        lineE.append(inE, btnCode);
        rE.appendChild(lineE);
        const rC = document.createElement('div');
        rC.className = 'mrow';
        rC.appendChild(document.createElement('label')).textContent = '邮箱验证码';
        const inC = document.createElement('input');
        inC.type = 'text';
        inC.maxLength = 6;
        rC.appendChild(inC);
        const rU = document.createElement('div');
        rU.className = 'mrow';
        rU.appendChild(document.createElement('label')).textContent = '用户名';
        const inU = document.createElement('input');
        inU.type = 'text';
        rU.appendChild(inU);
        const rP = document.createElement('div');
        rP.className = 'mrow';
        rP.appendChild(document.createElement('label')).textContent = '密码';
        const inP = document.createElement('input');
        inP.type = 'password';
        rP.appendChild(inP);
        const rI = document.createElement('div');
        rI.className = 'mrow';
        rI.appendChild(document.createElement('label')).textContent = '邀请码(可选)';
        const inI = document.createElement('input');
        inI.type = 'text';
        rI.appendChild(inI);
        const btnDo = document.createElement('button');
        btnDo.className = 'mbtn primary wide';
        btnDo.textContent = '注册';
        btnDo.addEventListener('click', () => {
          msg.className = 'm-msg';
          msg.textContent = '';
          const base = inBase.value.trim();
          if (!base || !inE.value.trim() || !inC.value.trim() || !inU.value.trim() || !inP.value) {
            msg.textContent = '请填写完整注册信息';
            return;
          }
          btnDo.disabled = true;
          btnDo.textContent = '注册中…';
          accountApi
            .register(base, inE.value.trim(), inC.value.trim(), inU.value.trim(), inP.value, inI.value.trim())
            .then(() => {
              msg.className = 'm-msg ok';
              msg.textContent = '注册成功,请登录';
              showLogin();
              const inA = form.querySelector('input');
              if (inA) inA.value = inU.value.trim();
            })
            .catch((err: unknown) => {
              msg.textContent = String(err);
              btnDo.disabled = false;
              btnDo.textContent = '注册';
            });
        });
        form.append(rE, rC, rU, rP, rI, btnDo);
      };

      btnLogin.addEventListener('click', () => {
        msg.className = 'm-msg';
        msg.textContent = '';
        showLogin();
      });
      btnReg.addEventListener('click', () => {
        msg.className = 'm-msg';
        msg.textContent = '';
        showRegister();
      });
      showLogin();
      body.append(seg, note, form, msg, rSrv);
    },
    '玄铁账户与官方社区、铁铺一号互通',
  ).then(async (result) => {
    const r = result as
      | { mode?: string; base?: string; cookie?: string; username?: string }
      | undefined;
    if (r?.mode === 'login' && r.base && r.cookie && r.username) {
      await saveAccount({ baseUrl: r.base, cookie: r.cookie, username: r.username, loginAt: Date.now() });
      showToast(`已登录:${r.username}`, 'ok');
    }
  });
}

// ---- 铁铺(列表走 UI,清理走 Toast;安装/搜索保留终端) ----
// ---- 铁铺更新检查(远程索引为 {包名:{版本:{…}}} 两层字典;最新版按 3 段数字取最大) ----
const TIEPM_INDEX_URL = 'https://tiepm.xt.markjy.com/api/index';

function cmpVer(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const n1 = pa[i] ?? 0;
    const n2 = pb[i] ?? 0;
    if (n1 > n2) return 1;
    if (n1 < n2) return -1;
  }
  return 0;
}

async function fetchLatestVersions(): Promise<Record<string, string>> {
  const r = await backend.httpJson('GET', TIEPM_INDEX_URL, null);
  let idx: Record<string, Record<string, unknown>> = {};
  try {
    idx = JSON.parse(r.body) as Record<string, Record<string, unknown>>;
  } catch {
    throw new Error(`索引响应不是合法 JSON(HTTP ${r.status})`);
  }
  const latest: Record<string, string> = {};
  for (const [name, versions] of Object.entries(idx)) {
    let best = '';
    for (const v of Object.keys(versions)) {
      if (!best || cmpVer(v, best) > 0) best = v;
    }
    latest[name] = best;
  }
  return latest;
}

async function checkTiepmUpdates(tiepm: string): Promise<number> {
  const [pkgs, latest] = await Promise.all([backend.tiepmPackages(tiepm), fetchLatestVersions()]);
  let count = 0;
  for (const p of pkgs) {
    if (p.builtin || p.version === '?') continue;
    const up = latest[p.name];
    if (up && cmpVer(up, p.version) > 0) {
      count++;
      markPkgUpdate(p.name, up);
    }
  }
  return count;
}

function tiepmListModal(): Promise<unknown> {
  return showCustomModal(
    '铁铺 · 已安装铁器',
    (body, close) => {
      const status = document.createElement('div');
      status.className = 'pkg-empty';
      status.textContent = '正在读取…';
      const content = document.createElement('div');
      content.style.display = 'flex';
      content.style.flexDirection = 'column';
      content.style.gap = '10px';

      const load = (): void => {
        status.textContent = '正在读取…';
        status.style.display = '';
        content.innerHTML = '';
        resolveTiepm()
          .then((tiepm) => {
            if (!tiepm) {
              status.textContent = '未找到 tiepm:请在设置里配置,或把它加入 PATH';
              return;
            }
            backend
              .tiepmPackages(tiepm)
              .then((pkgs) => {
                status.style.display = 'none';
                const installed = pkgs.filter((p) => !p.builtin);
                const builtin = pkgs.filter((p) => p.builtin);
                const section = (label: string, list: backend.TiepmPkg[], emptyText: string): void => {
                  const head = document.createElement('div');
                  head.className = 'pkg-section';
                  head.textContent = `${label} (${list.length})`;
                  content.appendChild(head);
                  if (list.length === 0) {
                    const empty = document.createElement('div');
                    empty.className = 'pkg-empty';
                    empty.textContent = emptyText;
                    content.appendChild(empty);
                    return;
                  }
                  const listEl = document.createElement('div');
                  listEl.className = 'pkg-list';
                  for (const p of list) {
                    const row = document.createElement('div');
                    row.className = 'pkg-row' + (p.builtin ? ' pkg-builtin' : '');
                    if (!p.builtin) row.dataset.pkg = p.name;
                    const nm = document.createElement('span');
                    nm.className = 'pkg-name';
                    nm.textContent = p.name;
                    const ver = document.createElement('span');
                    ver.className = 'pkg-ver';
                    ver.textContent = p.version === '?' ? '版本未知' : `v${p.version}`;
                    row.append(nm, ver);
                    listEl.appendChild(row);
                  }
                  content.appendChild(listEl);
                };
                section('外置已安装', installed, '未安装任何铁铺包 —— 用「铁铺 → 安装包…」装一个试试');
                section('随玄铁内置', builtin, '未检测到内置库目录');
              })
              .catch((err: unknown) => {
                status.textContent = String(err);
              });
          })
          .catch((err: unknown) => {
            status.textContent = String(err);
          });
      };

      const foot = document.createElement('div');
      foot.className = 'm-foot';
      const btnCheck = document.createElement('button');
      btnCheck.className = 'mbtn';
      btnCheck.textContent = '检查更新';
      btnCheck.addEventListener('click', () => {
        status.className = 'pkg-empty';
        status.style.display = '';
        status.textContent = '正在检查更新(读取远程索引)…';
        void resolveTiepm()
          .then((tiepm) => {
            if (!tiepm) throw new Error('未找到 tiepm:请在设置里配置,或加入 PATH');
            return checkTiepmUpdates(tiepm);
          })
          .then((n) => {
            status.textContent =
              n > 0 ? `检查完成:${n} 个铁器可更新(见行内橙色标记)` : '检查完成:全部已是最新';
          })
          .catch((err: unknown) => {
            status.textContent = `检查失败: ${String(err)}`;
          });
      });
      const btnRefresh = document.createElement('button');
      btnRefresh.className = 'mbtn';
      btnRefresh.textContent = '刷新';
      btnRefresh.addEventListener('click', load);
      const btnClose = document.createElement('button');
      btnClose.className = 'mbtn primary';
      btnClose.textContent = '关闭';
      btnClose.addEventListener('click', () => close());
      foot.append(btnCheck, btnRefresh, btnClose);
      body.append(status, content, foot);
      load();
    },
    '外置包安装于 %USERPROFILE%\\.tiepm;内置库随发行包自带,同名包安装版优先',
  );
}

async function tiepmCleanAction(): Promise<void> {
  try {
    const tiepm = await resolveTiepm();
    if (!tiepm) {
      showToast('未找到 tiepm:请在设置里配置,或把它加入 PATH', 'err');
      return;
    }
    const msg = await backend.tiepmClean();
    showToast(msg, 'ok');
  } catch (err) {
    showToast(`清理失败: ${String(err)}`, 'err');
  }
}

// 标记某包可更新:在对应行追加橙色「可更新 → v最新版」徽标
function markPkgUpdate(name: string, latest: string): void {
  const row = document.querySelector(`#modal-root .pkg-row[data-pkg="${CSS.escape(name)}"]`);
  if (!row || row.querySelector('.pkg-upd')) return;
  const chip = document.createElement('span');
  chip.className = 'pkg-upd';
  chip.textContent = `可更新 → v${latest}`;
  chip.title = `用「铁铺 → 安装包…」输入 ${name} 即可升级`;
  row.appendChild(chip);
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

  // 编辑器选中浮层(Trae 式):选中代码浮出「编辑 / 添加到对话」(Ctrl+I / Ctrl+U)
  const selTools = new SelectionTools(editor, L.editorHost, {
    onEdit: (ref, instruction) => {
      setAiDock(true);
      aiPanel.sendSelectionEdit(ref, instruction);
    },
    onAddToChat: (ref) => {
      setAiDock(true);
      aiPanel.addSelectionRef(ref);
    },
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, () => selTools.triggerEdit());
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyU, () => selTools.triggerAdd());

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
          { act: 'view-ai', label: '切换智器对话' },
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
      } else if (act === 'view-ai') {
        setAiDock(!aiDockOpen);
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
  byId('sb-cloud').addEventListener('click', () => {
    void showCloudIssueModal();
  });
  L.btabBuild.addEventListener('click', () => {
    setBottomTab('build');
    term.fitBuild();
    // 成功绿点被用户看过即隐藏;失败红叹号保留至下次编译
    if (buildBadge === 'success') {
      buildBadge = 'idle';
      renderBuildBadge();
    }
  });
  L.btabProblems.addEventListener('click', () => setBottomTab('problems'));
  byId('sb-encoding').addEventListener('click', () => void encodingModal());
  L.btnAccount.addEventListener('click', () => void accountModal());
  // 账号状态变化后面板无需重建:getAccount 每次发送时实时读取设置

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
        void tiepmListModal();
      } else if (act === 'clean') {
        void tiepmCleanAction();
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

function applyTheme(): void {
  const light = getSettings().theme === 'light';
  document.body.classList.toggle('light', light);
  monaco.editor.setTheme(light ? 'xuantie-light' : 'xuantie-dark');
}

// 开发者模式:控制台按钮显隐 + 日志采集开关(TS 总线与 Rust 中枢同步)
function applyDevMode(): void {
  const on = getSettings().devMode === true;
  L.aiConsoleBtn.style.display = on ? '' : 'none';
  setAiLogEnabled(on, (v) => void backend.aiLogSetEnabled(v).catch(() => undefined));
}

function applyEditorPrefs(): void {
  const e = getSettings().editor;
  editor.updateOptions({
    fontSize: e.fontSize ?? 14,
    fontFamily: e.fontFamily || undefined,
  });
}

async function applyZoom(): Promise<void> {
  const z = getSettings().zoom ?? 1;
  try {
    await getCurrentWebview().setZoom(z);
  } catch {
    // 缩放失败不阻塞
  }
}

async function boot(): Promise<void> {
  await loadSettings();
  restoreAiDockWidth();
  // aiPanel 构造早于 loadSettings:设置驱动的按钮标签在 boot 里统一补一次刷新
  // (modeBtn 审批模式 / thinkBtn 思考档位 / modelBtn 模型标签,取数链与菜单同源)
  aiPanel.refreshModeLabel();
  aiPanel.refreshThinkLabel();
  aiPanel.refreshModelLabel();
  fileTree.setDisplay(getSettings().treeDisplay ?? defaultSettings().treeDisplay);
  applyEye();
  // 恢复上一次的界面布局(AI dock 开关 + 窗口尺寸 + 缩放 + 主题)
  const uiPrev = getSettings().ui;
  if (uiPrev?.w && uiPrev?.h) {
    void getCurrentWindow().setSize(new PhysicalSize(uiPrev.w, uiPrev.h)).catch(() => undefined);
  }
  if (getSettings().zoom) void applyZoom();
  applyTheme();
  applyEditorPrefs();
  applyDevMode();
  installGlobalErrorHooks();
  if (getSettings().ui?.aiDock) setAiDock(true);
  L.aiConsoleBtn.addEventListener('click', () => {
    void backend.openAiConsole().catch((err: unknown) => showToast(`打开控制台失败: ${String(err)}`, 'err'));
  });
  // 窗口尺寸记忆(防抖;最大化时不记)
  let sizeTimer: number | undefined;
  getCurrentWindow().onResized((e) => {
    window.clearTimeout(sizeTimer);
    sizeTimer = window.setTimeout(() => {
      void getCurrentWindow().isMaximized().then((maxed) => {
        if (maxed) return;
        const { width, height } = e.payload as unknown as { width: number; height: number };
        void saveSettings({
          ...getSettings(),
          ui: { ...getSettings().ui, w: width, h: height },
        }).catch(() => undefined);
      });
    }, 800);
  });
  // 管理员模式标识(普通模式不显示文字)
  backend
    .isElevated()
    .then((elevated) => {
      if (elevated) byId('sb-mode').style.display = '';
    })
    .catch(() => undefined);
  // 账号:7 天强制过期;未过期则静默校验会话,失效即清理
  const acc = getSettings().account;
  const LOGIN_TTL = 7 * 24 * 60 * 60 * 1000;
  if (acc.cookie && acc.baseUrl) {
    if (acc.loginAt && Date.now() - acc.loginAt > LOGIN_TTL) {
      void saveAccount({ cookie: '', username: '', loginAt: 0 });
      showToast('登录已过期(7 天),请重新登录', 'err');
    } else {
      accountApi.verify(acc.baseUrl, acc.cookie).then((name) => {
        if (name) {
          if (name !== acc.username) void saveAccount({ username: name });
        } else {
          void saveAccount({ cookie: '', username: '', loginAt: 0 });
        }
      });
    }
  }
  // 启动自动检查铁器更新(设置开启时)
  if (getSettings().autoCheckTiepmUpdates) {
    void (async () => {
      const tiepm = await resolveTiepm();
      if (!tiepm) return;
      const n = await checkTiepmUpdates(tiepm).catch(() => -1);
      if (n > 0) showToast(`铁铺更新:${n} 个铁器有新版本,列表页可查看`, 'ok');
    })();
  }
  // 启动自动检查玄铁文档(服务端版本号比对;有更新则拉取到本地供 AI 按需阅读)
  void checkAndFetchDocs().then((r) => {
    if (r) showToast(`玄铁文档已更新(版本 ${r.version},共 ${r.count} 篇)`, 'ok');
  });
  updateAccountLabel();
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
