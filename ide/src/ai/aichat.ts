// 智器对话面板:官方(社区代理,SSE 流式)/自定义(OpenAI 兼容流式)双通道
// 实时输出 + Thinking 折叠块 + Token 计数 + 消息悬浮操作(复制/回退) + 联网开关(官方)
// 会话按工程区持久化(经 main 的 onConversationChange);不提供 Harness/工具调用
import { listen } from '@tauri-apps/api/event';
import * as backend from '../backend';
import { showDropupMenu, showToast, CONTEXT_SEP, type ContextMenuEntry } from '../ui/dialogs';
import type { SelectionRef } from '../ui/selection-tools';
import { marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';
import { openUrl, openPath } from '@tauri-apps/plugin-opener';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

// 数学公式($内联/$$块级),KaTeX 输出再过净化
// 顶层注册包护栏:扩展互操作若崩,只损失公式渲染,不拖死整个前端模块
try {
  marked.use(markedKatex({ throwOnError: false }) as never);
} catch (e) {
  console.error('[智器对话] KaTeX 扩展注册失败', e);
}
// 锚点链接(#fn1 等)移除 href 防止 WebView 导航(表现为整个界面重启);外链交给 opener
try {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? '';
      if (href.startsWith('#')) {
        node.removeAttribute('href');
        node.classList.add('dead-link');
      } else if (href.startsWith('http')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
  });
} catch (e) {
  console.error('[智器对话] 净化钩子注册失败', e);
}
import { copyText, dirname } from '../util';
import { getSettings, resolveTiepm, resolveXtc } from '../settings';
import type { AccountState, AiProvider } from '../types';
import type { AgentMode, AgentTurnUI, ToolCardStatus, AgentApprovalMode } from './dsh/agent-mode';
import type { TurnAttachment } from './dsh/adapter-openai';
import { ApprovalLane } from './dsh/approval';
import { formatToolArgs } from './dsh/tools';
import { SmoothTyper } from './smooth-typer';
import { ActivityTracker, fmtDur } from './activity';
import { TurnParts, type TurnPart, type ToolRecord } from './turn-parts';
import { aiLog, exportLogText } from './log-bus';
import { XUANTIE_PRIMER } from './xuantie-primer';

export type { TurnPart, ToolRecord };
export type MsgPart = TurnPart;

export type AiTarget = { kind: 'official' } | { kind: 'custom'; provider: AiProvider };

/** 玄铁环境自检:打开工程后台运行;结果注入环境快照(免 AI 自写冒烟/探针测试) */
export interface PreflightState {
  running: boolean;
  promise: Promise<void>;
  result: { ok: boolean; items: { key: string; value: string }[]; detail: string; ms: number } | null;
}

export interface AiChatDeps {
  listTargets(): { id: string; label: string }[];
  getTarget(): AiTarget;
  setTarget(id: string): void;
  getThinking(): string;
  setThinking(v: string): void;
  listThinking(): string[];
  officialName(): string;
  getAccount(): AccountState;
  /** 官方模型媒体能力(来自服务端 /api/ai/config;未连服务端时缺省 false) */
  getOfficialMediaCaps(): { vision: boolean; video: boolean };
  /** 当前模型上下文配置(压缩阈值依据;0 = 未配置,回落到默认阈值) */
  getModelContext(): { input: number; output: number };
  /** 作者联系方式(社区后台 ailm_contact_* 经 /api/ai/config 下发;未配置时为空串) */
  getSupportContact(): { name: string; value: string };
  /** 玄铁基础认知块:本地缓存优先(后台版本),无则内置;未实现时用内置常量 */
  getPrimer?(): Promise<string>;
  /** 工程外访问策略(设置项「允许AI访问工程目录外的文件」;缺省 deny) */
  getFsAccess?(): 'deny' | 'ask' | 'allow';
  /** xtc 路径(校验工具用) */
  getXtcPath?(): Promise<string | null>;
  /** 玄铁环境自检状态(打开工程后台运行;轮次开始若未完,状态行先显示"正在校验本地玄铁环境") */
  getPreflight?(): PreflightState | null;
  /** 在编辑器打开文件(工具卡片点击标题;相对路径由 main 侧对工程根解析) */
  openFileInEditor(path: string): void;
  // 当前会话 ID(服务端归档键,工程区内唯一)
  getSessionId(): string;
  // 当前工程根绝对路径(Agent 模式工具桥的作用域);未打开工程时为空串
  getWorkspace(): string;
  // Agent 审批模式(confirm/auto-edit/full-control)与 run_command 白名单
  getAgentMode(): AgentApprovalMode;
  setAgentMode(v: AgentApprovalMode): void;
  getCmdWhitelist(): string[];
  addCmdToken(token: string): void;
  // AI 写文件成功后的刷新通知(绝对路径):文件树 + 未脏编辑器重载
  onFileWritten(absPath: string): void;
  onNewSession(): void;
  onConversationChange(msgs: ChatMsg[]): void;
  onOpenHistory(): void;
  onToggleOutline(): void;
  onOpenProviders(): void;
  onClose(): void;
}

import { citeBadgesHtml, type CiteSource } from './cite';

export type { CiteSource };

/** 待发送附件(图片/视频):dataUrl 供多模态发送;objectUrl 供预览;thumb 小图供历史持久化 */
export interface Attachment {
  id: string;
  idx: number; // 显示编号(图片N/视频N 的 N;按添加序)
  kind: 'image' | 'video';
  name: string;
  mime: string;
  dataUrl: string;
  sizeBytes: number;
  objectUrl?: string; // 图片:blob 预览(内存)
  sourcePath?: string; // 视频:磁盘原路径(系统播放器直接打开)
  thumb?: string; // 小缩略图(dataURL,~96px JPEG;随消息持久化)
}

/** 历史消息中保留的附件元数据(字节不持久化,重发需重新附加) */
export interface AttachMeta {
  kind: 'image' | 'video';
  name: string;
  thumb?: string;
}

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  /** 本条消息的联网搜索引用源(随会话持久化,历史恢复可用) */
  sources?: CiteSource[];
  /** 全部 reasoning 拼接(老会话无此字段时按无思考渲染;agent 消息的思考段同时在 parts 里) */
  thinking?: string;
  /** 按真实发生顺序交错的 text/think/tool 段(老会话无此字段时只渲染 content) */
  parts?: MsgPart[];
  /** 本轮随系统提示词携带的工程指令文件名(AGENTS.md/XuanTieAI.md);历史恢复后重放引用提示 */
  instrNames?: string[];
  /** 本轮携带的玄铁文档索引条数(历史恢复后重放引用提示) */
  docsCount?: number;
  /** 用户消息附件元数据(图片/视频;字节不持久化,仅小缩略图+文件名) */
  attachments?: AttachMeta[];
  /** 上下文自动压缩生成的摘要消息(渲染为压缩提示+折叠摘要,不作为普通回答) */
  compressed?: boolean;
  /** 系统提示行(如 /compact 的「上下文正在压缩…」;渲染为居中分割提示,非对话内容) */
  notice?: boolean;
  /** 流中断/传输错误消息(随会话持久化:重启后仍可见、仍可「继续」) */
  error?: boolean;
  /** 「继续」所需的已收部分内容(截断存储) */
  errPartial?: string;
  /** 是否附作者联系方式与反馈入口(直播时按会话中断计数决定并随消息持久化) */
  errFeedback?: boolean;
}

/** 引用 chip 类型:编辑器代码 / 终端输出 / 构建输出 / 问题项 / 工程内路径 */
export interface ChatRef {
  kind: 'code' | 'terminal' | 'build' | 'problem' | 'path';
  /** code: 文件路径;path: 文件/目录路径;其余为来源标签(终端输出/构建输出/问题项) */
  path: string;
  startLine?: number;
  endLine?: number;
  text: string;
}

const THINK_LABEL: Record<string, string> = {
  off: '关', none: '无', minimal: '极低', low: '低',
  medium: '中', mid: '中', high: '高', xhigh: '极高', max: '最高',
};

interface StreamChunk {
  type: 'text' | 'thinking' | 'usage' | 'error' | 'aborted' | 'done' | 'status' | 'sources';
  text?: string;
  message?: string;
  tokens?: number;
  status?: number;
  items?: CiteSource[];
}

export class AiChatPanel {
  private msgs: ChatMsg[] = [];
  private busy = false;
  private streamId: string | null = null;
  private inputMax = 220;
  webSearch = true; // 恒开(2026-10-04 用户要求:不再手动切换);仅官方通道生效,自定义通道发送时有明确提示
  // ---- Agent 模式(Phase-3 DSH):开关状态与懒加载控制器,逻辑全部在文件底部「Agent 模式」区 ----
  private agentModeOn = true; // 默认开启(2026-10-04 用户要求);内核懒加载,首次发送时才 import
  private agentCtl: AgentMode | undefined;
  /** 审批内嵌卡片队列(输入区上方;关面板/清会话 dismissAll fail-closed) */
  private approvalLane: ApprovalLane;
  /** 直播中的 turn 现场(write_file diff 回调落点);turn 结束清空 */
  private liveParts: TurnParts | undefined;
  private liveSegs: HTMLElement | undefined;
  /** 滚动跟随脱离标:用户上滚即 true(流式不再吸底),滚回近底部重新挂上 */
  private userDetached = false;
  private userScrollIntent = false;

  constructor(
    private els: {
      msgs: HTMLElement;
      refChips: HTMLElement;
      attachBar: HTMLElement;
      btnAttach: HTMLElement;
      dock: HTMLElement;
      scrollBtn: HTMLElement;
      outline: HTMLElement;
      input: HTMLTextAreaElement;
      btnSend: HTMLElement;
      btnNew: HTMLElement;
      btnHistory: HTMLElement;
      outlineBtn?: HTMLElement;
      btnSettings: HTMLElement;
      btnClose: HTMLElement;
      modelBtn: HTMLElement;
      statsBar: HTMLElement;
      statTurn: HTMLElement;
      statUsage: HTMLElement;
      statCtx: HTMLElement;
      agentBtn: HTMLElement;
      modeBtn: HTMLElement;
      approvalsEl: HTMLElement;
      drag: HTMLElement;
    },
    private deps: AiChatDeps,
  ) {
    this.approvalLane = new ApprovalLane(els.approvalsEl);
    this.els.btnNew.addEventListener('click', () => {
      if (this.busy) {
        this.abort();
        return;
      }
      this.deps.onNewSession();
      this.clear();
    });
    this.els.btnHistory.addEventListener('click', () => this.deps.onOpenHistory());
    this.els.outlineBtn?.addEventListener('click', () => this.deps.onToggleOutline());
    this.els.btnSettings.addEventListener('click', () => this.deps.onOpenProviders());
    this.els.btnClose.addEventListener('click', () => {
      this.disposeAgent();
      this.deps.onClose();
    });
    // 融合下拉(模型 · 推理等级):分组标题 + 当前项右侧打勾(KIMICODE 式,不加行内前缀)
    this.els.modelBtn.addEventListener('click', () => {
      const items: ContextMenuEntry[] = [{ label: '模型', header: true }];
      for (const t of this.deps.listTargets()) {
        items.push({
          label: t.label,
          checked: this.currentTargetId() === t.id,
          action: () => {
            this.deps.setTarget(t.id);
            this.refreshModelLabel();
          },
        });
      }
      items.push(CONTEXT_SEP as never);
      items.push({ label: '推理等级', header: true });
      const curThink = this.deps.getThinking();
      for (const v of this.deps.listThinking()) {
        items.push({
          label: THINK_LABEL[v] ?? v,
          checked: curThink === v,
          action: () => {
            this.deps.setThinking(v);
            this.refreshModelLabel();
          },
        });
      }
      showDropupMenu(this.els.modelBtn, items);
    });
    // Agent 开关:只影响下一次发送的路由,不打断进行中的 turn
    this.els.agentBtn.addEventListener('click', () => {
      this.agentModeOn = !this.agentModeOn;
      this.syncAgentBtn();
    });
    this.syncAgentBtn();
    // 审批模式三态(变更前确认/自动编辑/完全控制):切换对下一次发送生效,不打断进行中的 turn
    this.els.modeBtn.addEventListener('click', () => {
      const cur = this.deps.getAgentMode();
      const MODES: AgentApprovalMode[] = ['confirm', 'auto-edit', 'full-control'];
      const items = MODES.map((v) => ({
        label: (cur === v ? '● ' : '') + AiChatPanel.MODE_LABEL[v],
        action: () => {
          this.deps.setAgentMode(v);
          this.refreshModeLabel();
        },
      }));
      showDropupMenu(this.els.modeBtn, items);
    });
    this.els.btnSend.addEventListener('click', () => {
      if (this.busy) {
        this.abort();
        return;
      }
      void this.send();
    });
    this.els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!this.busy) void this.send();
      }
    });
    this.els.statsBar.addEventListener('click', () => this.toggleStatsPop());
    // 附件入口:点"+"选文件(图片/视频);粘贴图片
    this.els.btnAttach.addEventListener('click', () => {
      void (async () => {
        try {
          const picked = await openDialog({
            multiple: true,
            title: '选择图片或视频',
            filters: [
              {
                name: '图片/视频',
                extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'mp4', 'webm', 'mov', 'avi', 'mkv'],
              },
            ],
          });
          const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
          for (const path of paths) await this.attachFromPath(path);
        } catch (err) {
          showToast(String(err), 'err');
        }
      })();
    });
    this.els.input.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items || items.length === 0) return;
      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length === 0) return; // 纯文本粘贴走默认
      e.preventDefault();
      void (async () => {
        for (const f of files) {
          const name = f.name || (f.type.startsWith('video/') ? '粘贴视频' : '粘贴图片');
          await this.attachFromBlob(f, name);
        }
      })();
    });
    this.els.msgs.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      const badge = target?.closest('.ai-cite') as HTMLElement | null;
      if (badge) {
        const wrap = badge.closest('.ai-wrap') as HTMLElement | null;
        const src = (wrap ? this.citeMap.get(wrap) : undefined)?.find((x) => x.i === Number(badge.dataset.i));
        if (src) void openUrl(src.url);
        return;
      }
      const a = target?.closest('a');
      if (!a) return;
      const href = a.getAttribute('href');
      if (href && href.startsWith('http')) {
        e.preventDefault();
        void openUrl(href);
      }
    });
    this.els.msgs.addEventListener('mouseover', (e) => {
      const badge = (e.target as HTMLElement | null)?.closest('.ai-cite') as HTMLElement | null;
      if (!badge) return;
      const wrap = badge.closest('.ai-wrap') as HTMLElement | null;
      const src = (wrap ? this.citeMap.get(wrap) : undefined)?.find((x) => x.i === Number(badge.dataset.i));
      if (src) this.showCitePopover(badge, src);
    });
    this.els.msgs.addEventListener('mouseout', (e) => {
      if ((e.target as HTMLElement | null)?.closest('.ai-cite')) this.hideCitePopover();
    });
    this.els.input.addEventListener('input', () => this.autoresize());
    // 回到底部悬浮按钮:离开底部才浮现
    // 滚动跟随可脱离/回吸:wheel/touch 记用户意图;上滚脱离、滚回近底部重新挂上
    this.els.msgs.addEventListener('wheel', () => {
      this.userScrollIntent = true;
    }, { passive: true });
    this.els.msgs.addEventListener('touchmove', () => {
      this.userScrollIntent = true;
    }, { passive: true });
    this.els.msgs.addEventListener('scroll', () => {
      const el = this.els.msgs;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      if (nearBottom) this.userDetached = false;
      else if (this.userScrollIntent) this.userDetached = true;
      this.userScrollIntent = false;
      this.els.scrollBtn.style.display = nearBottom ? 'none' : 'inline-flex';
    });
    this.els.scrollBtn.addEventListener('click', () => {
      this.userDetached = false;
      this.els.msgs.scrollTop = this.els.msgs.scrollHeight;
    });
    // 对话大纲:点击回退到对应消息位置
    this.els.outline.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement | null)?.closest('[data-oidx]');
      if (!row) return;
      this.toggleOutline(false);
      const idx = row.getAttribute('data-oidx');
      const target = this.els.msgs.querySelector(`[data-idx="${idx}"]`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        (target as HTMLElement).style.transition = 'box-shadow 0.3s';
        (target as HTMLElement).style.boxShadow = '0 0 0 2px var(--accent-dim)';
        window.setTimeout(() => {
          (target as HTMLElement).style.boxShadow = '';
        }, 1200);
      }
    });
    // 顶边拖拽:调输入栏最大高度(自适应的上限随之改变)
    this.els.drag.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startMax = this.inputMax;
      const move = (ev: MouseEvent): void => {
        this.inputMax = Math.min(400, Math.max(100, startMax + (startY - ev.clientY)));
        this.autoresize();
      };
      const up = (): void => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    this.refreshModelLabel();
    this.refreshThinkLabel();
    this.refreshModeLabel();
    this.clear();
  }

  /** 审批模式短标签(按钮上);菜单里用同一文案全称。 */
  private static readonly MODE_LABEL: Record<AgentApprovalMode, string> = {
    'confirm': '变更前确认',
    'auto-edit': '自动编辑',
    'full-control': '完全控制',
  };

  refreshModeLabel(): void {
    const v = this.deps.getAgentMode();
    this.els.modeBtn.textContent = AiChatPanel.MODE_LABEL[v] ?? v;
    const chev = document.createElement('i');
    chev.className = 'codicon codicon-chevron-down';
    this.els.modeBtn.appendChild(chev);
  }

  /** 当前选中的目标 id(listTargets 口径):'官方' 或提供商名 */
  private currentTargetId(): string {
    const t = this.deps.getTarget();
    return t.kind === 'official' ? '官方' : t.provider.name;
  }

  /** 融合按钮渲染:模型名(白) · 思考档位(蓝) ▽(KIMICODE 式) */
  refreshModelLabel(): void {
    const t = this.deps.getTarget();
    const modelLabel = t.kind === 'official' ? this.deps.officialName() : `${t.provider.name} · ${t.provider.model}`;
    const think = this.deps.getThinking();
    const btn = this.els.modelBtn;
    btn.textContent = '';
    btn.append(document.createTextNode(modelLabel));
    if (think && think !== 'off' && think !== 'none') {
      const dot = document.createElement('span');
      dot.className = 'think-dot';
      dot.textContent = ' · ';
      const tp = document.createElement('span');
      tp.className = 'think-part';
      tp.textContent = THINK_LABEL[think] ?? think;
      btn.append(dot, tp);
    }
    const chev = document.createElement('i');
    chev.className = 'codicon codicon-chevron-down';
    btn.appendChild(chev);
  }

  /** 兼容旧调用:思考变更同走融合按钮渲染 */
  refreshThinkLabel(): void {
    this.refreshModelLabel();
  }

  focus(): void {
    this.els.input.focus();
  }

  toggleOutline(force?: boolean): void {
    const show = force ?? this.els.outline.style.display === 'none';
    this.els.outline.style.display = show ? 'block' : 'none';
    if (!show) return;
    this.els.outline.innerHTML = '';
    let count = 0;
    for (let i = 0; i < this.msgs.length; i++) {
      const m = this.msgs[i];
      if (m.role !== 'user') continue;
      count++;
      const row = document.createElement('div');
      row.className = 'outline-row';
      row.setAttribute('data-oidx', String(i));
      row.textContent = m.content;
      row.title = m.content;
      this.els.outline.appendChild(row);
    }
    if (count === 0) {
      const empty = document.createElement('div');
      empty.className = 'outline-row';
      empty.style.color = 'var(--fg-dim)';
      empty.textContent = '还没有用户消息';
      this.els.outline.appendChild(empty);
    }
  }

  // Markdown 渲染(净化;AI 回复用,用户消息保持纯文本)
  private md(text: string): string {
    try {
      return DOMPurify.sanitize(marked.parse(text, { async: false, breaks: true }) as string);
    } catch {
      return '';
    }
  }

  /** 〔N〕引用徽章后处理:md() 输出上统一做(定稿/历史恢复同路);纯函数实现见 cite.ts。 */
  private citeBadges(html: string, sources: CiteSource[] | undefined): string {
    return citeBadgesHtml(html, sources);
  }

  /** 引用浮层(单例):悬浮显示 title + snippet 前 160 字 + url。 */
  private citePop: HTMLElement | undefined;
  private citeMap = new WeakMap<HTMLElement, CiteSource[]>();

  private showCitePopover(anchor: HTMLElement, src: CiteSource): void {
    this.hideCitePopover();
    const pop = document.createElement('div');
    pop.className = 'ai-cite-pop';
    const title = document.createElement('div');
    title.className = 'ai-cite-pop-title';
    title.textContent = src.title;
    const snippet = document.createElement('div');
    snippet.className = 'ai-cite-pop-snippet';
    snippet.textContent = src.snippet.length > 160 ? `${src.snippet.slice(0, 160)}…` : src.snippet;
    const url = document.createElement('div');
    url.className = 'ai-cite-pop-url';
    url.textContent = src.url;
    pop.append(title, snippet, url);
    document.body.appendChild(pop);
    const a = anchor.getBoundingClientRect();
    const rect = pop.getBoundingClientRect();
    pop.style.left = `${Math.min(a.left, window.innerWidth - rect.width - 8)}px`;
    pop.style.top = `${Math.max(8, a.top - rect.height - 6)}px`;
    this.citePop = pop;
  }

  private hideCitePopover(): void {
    this.citePop?.remove();
    this.citePop = undefined;
  }

  private autoresize(): void {
    const el = this.els.input;
    el.style.height = 'auto';
    el.style.height = Math.max(54, Math.min(el.scrollHeight, this.inputMax)) + 'px';
    el.style.overflowY = el.scrollHeight > this.inputMax ? 'auto' : 'hidden';
  }

  clear(): void {
    this.disposeAgent();
    this.clearRefs();
    this.truncCount = 0; // 新会话:流中断计数归零
    this.agentContextExtra = ''; // 新会话:压缩摘要留存清空
    this.msgs = [];
    this.renderAll();
  }

  setMessages(msgs: ChatMsg[]): void {
    // 保留 thinking/parts 富字段:历史会话恢复时思考段与工具卡现场必须完整重现
    // (旧会话无这些字段时按纯文本渲染,向后兼容)。
    this.truncCount = 0; // 历史恢复:流中断计数按新会话起算
    this.msgs = msgs.map((m) => ({
      role: m.role,
      content: m.content,
      // sources 必须同搬:漏掉它 → 重启恢复后〔N〕引用徽章无法重放,退化为纯文本(实测踩到)
      ...(m.sources && m.sources.length > 0 ? { sources: m.sources } : {}),
      ...(m.thinking ? { thinking: m.thinking } : {}),
      ...(m.parts && m.parts.length > 0 ? { parts: m.parts } : {}),
      ...(m.instrNames && m.instrNames.length > 0 ? { instrNames: m.instrNames } : {}),
      ...(m.docsCount && m.docsCount > 0 ? { docsCount: m.docsCount } : {}),
      ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
      ...(m.compressed ? { compressed: true } : {}),
      ...(m.notice ? { notice: true } : {}),
      ...(m.error ? { error: true } : {}),
      ...(m.errPartial ? { errPartial: m.errPartial } : {}),
      ...(m.errFeedback ? { errFeedback: true } : {}),
    }));
    this.renderAll();
  }

  /** 服务端请求体用:仅 {role, content}(thinking/parts 是本地富数据,不外发)。 */
  getMessages(): ChatMsg[] {
    return this.msgs.map((m) => ({ role: m.role, content: m.content }));
  }

  // 全量重绘(初始化/历史恢复/回退后)
  private renderAll(): void {
    this.els.msgs.innerHTML = '';
    const hint = document.createElement('div');
    hint.className = 'ai-msg bot';
    hint.textContent = '你好,我是玄铁铸造厂的 AI 助手。有什么可以帮你?';
    this.els.msgs.appendChild(hint);
    for (let i = 0; i < this.msgs.length; i++) {
      this.els.msgs.appendChild(this.buildWrap(this.msgs[i], i));
    }
    this.els.msgs.scrollTop = this.els.msgs.scrollHeight;
  }

  // 消息外壳(Trae 式):气泡下方右对齐操作条,悬停显隐
  // AI 消息:赞/踩/复制/重新生成;用户消息:复制/回退(回到本轮对话发起前)
  private buildWrap(m: ChatMsg, index: number): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'ai-wrap' + (m.role === 'user' ? ' user' : '');

    wrap.dataset.idx = String(index);
    // 系统提示行(/compact 等):居中分割提示,不是对话内容
    if (m.notice) {
      wrap.classList.add('notice');
      const div = document.createElement('div');
      div.className = 'ai-notice';
      const ic = document.createElement('i');
      ic.className = 'codicon codicon-collapse-all';
      div.append(ic, document.createTextNode(m.content));
      wrap.appendChild(div);
      return wrap;
    }
    // 错误消息(流中断/传输错误):重建带操作栏的气泡(直播与历史恢复共用)
    if (m.error) {
      wrap.appendChild(this.buildErrEl(m));
      return wrap;
    }
    // 思考:有 think 段的消息在 parts 里原位渲染;否则回落顶部单块(简单对话/老数据)
    const hasThinkPart = m.parts?.some((p) => p.kind === 'think') === true;
    if (m.instrNames && m.instrNames.length > 0) {
      const ref = document.createElement('div');
      ref.className = 'ai-instr-ref';
      const ic = document.createElement('i');
      ic.className = 'codicon codicon-checklist';
      ref.append(ic, document.createTextNode(`已加载工程指令: ${m.instrNames.join('、')}`));
      ref.title = '该文件已作为系统提示词随本会话发送(修改后新开会话生效)';
      wrap.appendChild(ref);
    }
    if (m.docsCount && m.docsCount > 0) {
      const ref = document.createElement('div');
      ref.className = 'ai-instr-ref';
      const ic = document.createElement('i');
      ic.className = 'codicon codicon-book';
      ref.append(ic, document.createTextNode(`已加载玄铁文档索引(${m.docsCount} 条)`));
      ref.title = '官方文档已下载到本地;AI 会按需用 read_file 阅读对应文档';
      wrap.appendChild(ref);
    }
    if (m.compressed) {
      const ref = document.createElement('div');
      ref.className = 'ai-instr-ref';
      const ic = document.createElement('i');
      ic.className = 'codicon codicon-collapse-all';
      ref.append(ic, document.createTextNode('历史上下文已自动压缩'));
      ref.title = '较早前对话已被 IDE 自动压缩为摘要;摘要随系统提示词携带,继续任务时为准';
      wrap.appendChild(ref);
      wrap.appendChild(this.buildThinkBlock(m.content, '历史摘要(点击展开)'));
    }
    if (m.thinking && !hasThinkPart) wrap.appendChild(this.buildThinkBlock(m.thinking));
    const msg = document.createElement('div');
    msg.className = 'ai-msg ' + m.role;
    if (m.role === 'assistant') {
      if (m.compressed) {
        // 摘要已在折叠块内渲染,正文不再重复
      } else if (m.parts && m.parts.length > 0) {
        // 结构化消息:按发生顺序渲染 text/think/tool 段;连续 ≥3 个同名工具收成分组行
        const segs = document.createElement('div');
        segs.className = 'ai-segs';
        let runName = '';
        let runTools: ToolRecord[] = [];
        const flushRun = (): void => {
          if (runTools.length >= 3) {
            const group = this.buildToolGroup();
            for (const tool of runTools) group.list.appendChild(this.buildToolCardFromRecord(tool));
            this.updateGroupHead(group.head, runName, runTools);
            segs.appendChild(group.el);
          } else {
            for (const tool of runTools) segs.appendChild(this.buildToolCardFromRecord(tool));
          }
          runTools = [];
          runName = '';
        };
        for (const part of m.parts) {
          if (part.kind === 'text') {
            flushRun();
            segs.appendChild(this.buildTextSeg(part.text, m.sources));
          } else if (part.kind === 'think') {
            flushRun();
            segs.appendChild(this.buildThinkSegFromRecord(part));
          } else {
            if (runName === part.tool.name) {
              runTools.push(part.tool);
            } else {
              flushRun();
              runName = part.tool.name;
              runTools = [part.tool];
            }
          }
        }
        flushRun();
        msg.appendChild(segs);
      } else {
        msg.classList.add('md');
        msg.innerHTML = this.citeBadges(this.md(m.content), m.sources);
      }
    } else {
      msg.textContent = m.content;
      // 附件缩略图行(历史/新发均显示;点击放大,原图字节不持久化故用缩略图)
      if (m.attachments && m.attachments.length > 0) {
        const row = document.createElement('div');
        row.className = 'ai-attach-history';
        for (const meta of m.attachments) {
          const chip = document.createElement('div');
          chip.className = 'ai-attach-thumb';
          chip.title = meta.name;
          if (meta.thumb) {
            const img = document.createElement('img');
            img.src = meta.thumb;
            chip.appendChild(img);
          } else {
            const ic = document.createElement('i');
            ic.className = 'codicon ' + (meta.kind === 'video' ? 'codicon-play-circle' : 'codicon-file-media');
            chip.appendChild(ic);
          }
          chip.addEventListener('click', () => {
            if (!meta.thumb) {
              showToast('原图未保留(仅缩略图随历史保存)', 'err');
              return;
            }
            this.openThumbLightbox(meta.thumb, meta.name);
          });
          row.appendChild(chip);
        }
        msg.appendChild(row);
      }
    }
    if (m.sources && m.sources.length > 0) this.citeMap.set(wrap, m.sources);
    wrap.appendChild(msg);
    wrap.appendChild(this.buildActionsBar(m, index));
    return wrap;
  }

  /** 已完成的思考折叠块(默认收起,用户自己控制展开)。 */
  private buildThinkBlock(thinking: string, title = '思考过程(点击展开)'): HTMLElement {
    const det = document.createElement('div');
    det.className = 'ai-think done';
    const head = document.createElement('div');
    head.className = 'ai-think-head';
    head.textContent = title;
    const bd = document.createElement('div');
    bd.className = 'ai-think-body';
    bd.textContent = thinking;
    det.append(head, bd);
    head.addEventListener('click', () => det.classList.toggle('open'));
    return det;
  }

  /** 按 think 段记录重建(折叠态单行「思考过程 · Xs」,点击展开回看)。 */
  private buildThinkSegFromRecord(part: Extract<MsgPart, { kind: 'think' }>): HTMLElement {
    const det = document.createElement('div');
    det.className = 'ai-think';
    const head = document.createElement('div');
    head.className = 'ai-think-head';
    head.textContent = part.elapsedMs !== undefined ? `思考过程 · ${fmtDur(part.elapsedMs)}` : '思考过程';
    const bd = document.createElement('div');
    bd.className = 'ai-think-body';
    bd.textContent = part.text;
    det.append(head, bd);
    head.addEventListener('click', () => det.classList.toggle('open'));
    return det;
  }

  /** 渲染好的 markdown 文本段(直播 step 定稿与历史恢复共用)。 */
  private buildTextSeg(text: string, sources?: CiteSource[]): HTMLElement {
    const seg = document.createElement('div');
    seg.className = 'md';
    seg.innerHTML = this.citeBadges(this.md(text), sources);
    return seg;
  }

  /** 按持久记录重建一张工具卡片(终态、折叠;徽章带耗时,标题/参数走展示格式化)。 */
  private buildToolCardFromRecord(tool: ToolRecord): HTMLElement {
    const card = this.buildToolCard(tool.callId, tool.name, tool.args, tool);
    card.className = `ai-tool-card ${tool.status} collapsed`;
    const badge = card.querySelector('.ai-tool-status');
    if (badge) {
      const label = AiChatPanel.TOOL_STATUS_LABEL[tool.status];
      badge.textContent = tool.elapsedMs !== undefined ? `${label} · ${fmtDur(tool.elapsedMs)}` : label;
    }
    const icon = card.querySelector('.ai-tool-ico') as HTMLElement | null;
    if (icon) {
      const v = AiChatPanel.toolVisual(tool.name);
      icon.className = `codicon ${v.icon} ai-tool-ico`;
    }
    if (tool.result) {
      const result = card.querySelector('.ai-tool-result') as HTMLElement;
      result.textContent = tool.result;
    }
    return card;
  }

  /** 气泡操作条(复制/回退/赞踩/重新生成),直播定稿与 buildWrap 共用。 */
  private buildActionsBar(m: ChatMsg, index: number): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'ai-msg-actions';
    const mkBtn = (icon: string, title: string, onClick: () => void): void => {
      const b = document.createElement('button');
      b.className = 'ibtn';
      b.title = title;
      b.innerHTML = `<i class="codicon codicon-${icon}"></i>`;
      b.addEventListener('click', onClick);
      actions.appendChild(b);
    };
    mkBtn('copy', '复制', () => {
      void copyText(m.content).then((ok) => {
        if (!ok) return;
        const b = actions.firstElementChild as HTMLElement;
        b.innerHTML = '<i class="codicon codicon-check"></i>';
        window.setTimeout(() => {
          b.innerHTML = '<i class="codicon codicon-copy"></i>';
        }, 1200);
      });
    });
    if (m.role === 'user') {
      mkBtn('arrow-left', '回退到本轮对话发起前', () => this.rollback(index));
    } else {
      mkBtn('thumbsup', '赞', () => undefined);
      mkBtn('thumbsdown', '踩', () => undefined);
      mkBtn('refresh', '重新生成', () => this.regenerate(index));
    }
    return actions;
  }

  /** 滚动跟随节流:rAF 合并,长文流式不逐 delta 强制 reflow。 */
  private scrollPending = false;
  private scheduleScroll(): void {
    // 用户上滚脱离期间不吸底(回吸由 scroll 监听负责)
    if (this.userDetached || this.scrollPending) return;
    this.scrollPending = true;
    requestAnimationFrame(() => {
      this.scrollPending = false;
      this.els.msgs.scrollTop = this.els.msgs.scrollHeight;
    });
  }

  /** 持久化用的富消息快照(content + thinking + parts 全带)。 */
  private richMessages(): ChatMsg[] {
    return this.msgs.map((m) => ({ ...m }));
  }

  private rollback(index: number): void {
    if (this.els.input.value.trim()) {
      showToast('请先清空输入栏再回退', 'err');
      return;
    }
    const m = this.msgs[index];
    if (!m) return;
    if (m.compressed) {
      showToast('该条为自动压缩生成的摘要,不支持回退', 'err');
      return;
    }
    if (m.attachments && m.attachments.length > 0) {
      // 附件字节不随历史持久化,回退只能还原文本
      showToast('该消息含附件:仅文本已回填,图片/视频需重新附加', 'err');
    }
    this.els.input.value = m.content;
    this.msgs = this.msgs.slice(0, index);
    this.renderAll();
    // Agent 模式:被回退的消息仍在 DSH 会话上下文里 —— 必须同步丢弃会话,否则"回退"只是
    // 界面假象(下次发送模型仍看得到被回退的内容)。dropSession 内部先同步清引用再异步销毁。
    if (this.agentModeOn && this.agentCtl) {
      // 回退触发会话重建:必须把回退点之前的历史作为回放注入,否则下次发送模型失忆
      const replay = this.replayExcludingPending();
      void this.agentCtl.injectContext(this.composeAgentNote(replay)).catch((err: unknown) => {
        aiLog('warn', 'aichat', `回退时重建 Agent 会话失败: ${String(err)}`);
      });
    }
    if (this.msgs.length > 0) this.deps.onConversationChange(this.richMessages());
    this.els.input.focus();
  }

  // 重新生成:丢弃该 AI 回复及其后所有消息,基于其前的用户消息重发
  private regenerate(index: number): void {
    if (this.busy) return;
    if (index <= 0 || this.msgs[index - 1]?.role !== 'user') return;
    if (this.msgs[index]?.compressed) {
      showToast('该条为自动压缩生成的摘要,不支持重新生成', 'err');
      return;
    }
    this.msgs = this.msgs.slice(0, index);
    this.renderAll();
    // Agent 模式:同回退——被丢弃的轮次必须从 DSH 会话上下文里移除,再按 Agent 路径重发
    // (此前无条件走 runStream,Agent 模式点"重新生成"会错走简单对话通道,一并修正)
    if (this.agentModeOn) {
      if (!this.deps.getWorkspace()) {
        this.addBubble('err', 'Agent 模式需要先打开工程文件夹(工具桥以工程根为作用域)');
        return;
      }
      void (async () => {
        // 重建会话必须带回放(排除最后一条=即将重发的用户消息,避免与本次 user 消息重复),
        // 否则新会话里模型只见一条孤立消息(实测:重新生成后回复"这是会话的第一条消息")
        const replay = this.replayExcludingPending();
        if (this.agentCtl) await this.agentCtl.injectContext(this.composeAgentNote(replay));
        await this.runAgentTurn().finally(() => this.setBusy(false));
      })().catch((err: unknown) => {
        this.addBubble('err', `重新生成失败: ${String(err)}`);
      });
      return;
    }
    void this.runStream();
  }

  private addBubble(role: 'user' | 'assistant' | 'err', content: string, index?: number): HTMLElement {
    const wrap = this.buildWrap({ role: role === 'err' ? 'assistant' : role, content }, index ?? this.msgs.length);
    if (role === 'err') {
      const msg = wrap.querySelector('.ai-msg') as HTMLElement;
      msg.className = 'ai-msg err';
    }
    this.els.msgs.appendChild(wrap);
    this.els.msgs.scrollTop = this.els.msgs.scrollHeight;
    return wrap;
  }

  /** Agent 按钮状态同步(默认开启需在构造时刷一次) */
  private syncAgentBtn(): void {
    this.els.agentBtn.classList.toggle('active', this.agentModeOn);
    this.els.agentBtn.title = this.agentModeOn
      ? 'Agent 模式:开(可读写文件、执行命令,危险操作逐次审批;首次发送时加载内核)'
      : 'Agent 模式:关(点击开启;开启后可读写文件、执行命令,危险操作逐次审批)';
  }

  /** busy 唯一入口:同步发送按钮形态(进行中 = 红色终止按钮,再点即中止) */
  private setBusy(v: boolean): void {
    this.busy = v;
    this.els.btnSend.classList.toggle('sending', v);
    this.els.btnSend.title = v ? '终止当前输出' : '发送';
    this.els.btnSend.innerHTML = v
      ? '<i class="codicon codicon-primitive-square"></i>'
      : '<i class="codicon codicon-send"></i>';
  }

  private abort(): void {
    aiLog('info', 'aichat', '用户取消(stream/agent turn)');
    if (this.streamId) void backend.httpStreamAbort(this.streamId);
    // 强杀正在执行的 run_command 进程树:否则 DSH 的 cancel 只会等工具自己结束,
    // 长命令(下载/编译)期间终止按钮形同虚设(实测反馈)
    void backend
      .killAllExec()
      .then((count) => {
        if (count > 0) aiLog('info', 'aichat', `已强杀 ${count} 个命令进程`);
      })
      .catch((err: unknown) => aiLog('warn', 'aichat', `强杀命令进程失败: ${String(err)}`));
    if (this.agentCtl) void this.agentCtl.cancel();
  }

  /** 发送前媒体能力检查(官方=后台配置,自定义=提供商自报);不通过时保留附件并说明原因 */
  private checkMediaCapability(): string | null {
    if (this.attachments.length === 0) return null;
    const hasImg = this.attachments.some((a) => a.kind === 'image');
    const hasVid = this.attachments.some((a) => a.kind === 'video');
    // Agent 模式同样支持媒体:附件经 adapter 注入最后一条 user 消息(见 TurnAttachment);
    // 能力检查对两种模式一致(官方=后台开关,自定义=提供商自报)
    const t = this.deps.getTarget();
    if (t.kind === 'official') {
      const caps = this.deps.getOfficialMediaCaps();
      if (hasImg && !caps.vision) return '当前官方模型未开启图片输入(可在社区后台「铸造厂」开启,或移除图片)';
      if (hasVid && !caps.video) return '当前官方模型未开启视频输入(可在社区后台「铸造厂」开启,或移除视频)';
    } else {
      if (hasImg && !t.provider.supportsVision)
        return `提供商「${t.provider.name}」未开启图片支持(在「管理 AI 提供商」中勾选,或移除图片)`;
      if (hasVid && !t.provider.supportsVideo)
        return `提供商「${t.provider.name}」未开启视频支持(在「管理 AI 提供商」中勾选,或移除视频)`;
    }
    return null;
  }

  async send(): Promise<void> {
    if (this.busy) return;
    const raw = this.els.input.value.trim();
    // 斜杠命令:/compact 与 /压缩 手动触发上下文压缩(不进对话、不发送给 AI)
    if (raw === '/compact' || raw === '/压缩') {
      this.els.input.value = '';
      this.autoresize();
      void this.manualCompact();
      return;
    }
    const body = raw;
    if (!body && this.refs.length === 0 && this.attachments.length === 0) return;
    // 媒体能力检查:不通过则保留附件与输入,明确报错(不静默丢弃、不半发)
    const capErr = this.checkMediaCapability();
    if (capErr) {
      this.addBubble('err', capErr);
      return;
    }
    const text = this.composeWithRefs(body);
    // 取出附件(清 UI,数据随本次发送流转;objectUrl 预览使命结束)
    const atts = this.attachments;
    this.attachments = [];
    this.renderAttachments();
    for (const a of atts) {
      if (a.objectUrl) URL.revokeObjectURL(a.objectUrl);
    }
    this.els.input.value = '';
    this.clearRefs();
    this.autoresize();
    await this.dispatch(text, atts);
  }

  /** 附件 → 历史消息元数据(小缩略图随消息持久化,字节不持久化) */
  private static toAttachMetas(atts: Attachment[]): AttachMeta[] {
    return atts.map((a) => ({
      kind: a.kind,
      name: a.name,
      ...(a.thumb ? { thumb: a.thumb } : {}),
    }));
  }

  /** 外发消息组装:末条 user 若有附件,content 转 OpenAI 多模态数组 */
  private buildOutgoingMessages(atts: Attachment[]): unknown[] {
    const base = this.getMessages();
    if (atts.length === 0) return base;
    const last = base[base.length - 1];
    if (!last || last.role !== 'user') return base;
    const content: unknown[] = [{ type: 'text', text: last.content }];
    for (const a of atts) {
      content.push(
        a.kind === 'image'
          ? { type: 'image_url', image_url: { url: a.dataUrl } }
          : { type: 'video_url', video_url: { url: a.dataUrl } },
      );
    }
    return [...base.slice(0, -1), { role: 'user', content }];
  }

  /** 「编辑」提交(编辑器选中浮层):指令 + 代码引用块直接走发送路由 */
  sendSelectionEdit(ref: SelectionRef, instruction: string): void {
    if (this.busy) {
      showToast('正在生成中,请等当前回复结束后再试', 'err');
      return;
    }
    const text = `${instruction}\n\n引用 ${ref.path}:${ref.startLine}-${ref.endLine}:\n\`\`\`xt\n${ref.text}\n\`\`\``;
    void this.dispatch(text);
  }

  /** 发送路由(Agent / 简单对话):text 为最终消息全文(可能含引用块);atts 为本次附件 */
  private async dispatch(text: string, atts: Attachment[] = []): Promise<void> {
    if (this.compressing) {
      showToast('正在压缩历史上下文,请稍候再发送', 'err');
      return;
    }
    if (this.webSearch && this.deps.getTarget().kind !== 'official' && atts.length === 0) {
      // 联网增强在社区代理侧实现,自定义直连没有这个能力
      this.addBubble('err', '联网搜索仅官方通道可用:请先关闭联网,或切换到官方通道');
      return;
    }
    if (this.agentModeOn) {
      if (!this.deps.getWorkspace()) {
        this.addBubble('err', 'Agent 模式需要先打开工程文件夹(工具桥以工程根为作用域)');
        return;
      }
      // 本轮附件:交给 adapter 注入最后一条 user 消息(DSH 会话历史仍只存文本);
      // turn 结束清空——同 turn 内所有请求(含截断恢复的重发)都带
      this.pendingTurnMedia = atts.map((a) => ({ kind: a.kind, mime: a.mime, dataUrl: a.dataUrl, name: a.name }));
      await this.maybeCompress();
      const metas = AiChatPanel.toAttachMetas(atts);
      const userMsg: ChatMsg = { role: 'user', content: text, ...(metas.length > 0 ? { attachments: metas } : {}) };
      this.msgs.push(userMsg);
      this.els.msgs.appendChild(this.buildWrap(userMsg, this.msgs.length - 1));
      this.els.msgs.scrollTop = this.els.msgs.scrollHeight;
      // finally 兜底复位 busy:turn 内任何悬挂/异常都不许把发送闸卡死;一并清空本轮媒体
      void this.runAgentTurn().finally(() => {
        this.pendingTurnMedia = [];
        this.setBusy(false);
      });
      return;
    }
    await this.maybeCompress();
    const metas = AiChatPanel.toAttachMetas(atts);
    const userMsg: ChatMsg = {
      role: 'user',
      content: text,
      ...(metas.length > 0 ? { attachments: metas } : {}),
    };
    this.msgs.push(userMsg);
    this.els.msgs.appendChild(this.buildWrap(userMsg, this.msgs.length - 1));
    this.els.msgs.scrollTop = this.els.msgs.scrollHeight;
    void this.runStream(atts);
  }

  // ---- 本轮待发附件(Agent 媒体注入;turn 结束清空,不随历史持久化) ----
  private pendingTurnMedia: TurnAttachment[] = [];

  // ---- 引用 chip(编辑器代码 / 终端输出 / 构建输出 / 问题项 / 文件路径;仅内存不持久化) ----
  private refs: ChatRef[] = [];

  // ---- 附件(图片/视频;kimiCode 式:输入区上方卡片 + 编号徽章,N 供文本提及) ----
  private attachments: Attachment[] = [];
  private attachSeq = 0;

  // ---- 会话用量统计(输入区下方展示行;全部来自实际事件,不估算未提供的量) ----
  private usage = {
    turns: 0,
    steps: 0,
    lastInputTokens: 0,
    totalTokens: 0,
    outTokens: 0,
    cacheRead: 0,
    cacheMiss: 0,
    genMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftCount: 0,
  };
  private toolMsCounted = new Set<string>();
  private statsPop: HTMLElement | undefined;

  private static fmtTok(n: number): string {
    if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e4) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  private absorbUsage(u: {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheMissTokens?: number;
  }): void {
    this.usage.lastInputTokens = u.inputTokens;
    this.usage.outTokens += u.outputTokens;
    this.usage.totalTokens += u.totalTokens ?? u.inputTokens + u.outputTokens;
    if (typeof u.cacheReadTokens === 'number') this.usage.cacheRead += u.cacheReadTokens;
    if (typeof u.cacheMissTokens === 'number') this.usage.cacheMiss += u.cacheMissTokens;
    this.renderStats();
  }

  /** 渲染输入区下方用量行:轮/步/速度 · 累计 tok/缓存命中 · 上下文近似占用 */
  private renderStats(): void {
    const u = this.usage;
    const bar = this.els.statsBar;
    if (u.turns === 0 && u.steps === 0 && u.totalTokens === 0) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'flex';
    const tps = u.genMs > 0 ? (u.outTokens / (u.genMs / 1000)).toFixed(1) + ' tok/s' : '';
    this.els.statTurn.textContent = `${u.turns} 轮 · ${u.steps} 步${tps ? ' · ' + tps : ''}`;
    const cacheBase = u.cacheRead + u.cacheMiss;
    const cachePct = cacheBase > 0 ? Math.round((u.cacheRead / cacheBase) * 100) : undefined;
    this.els.statUsage.textContent =
      `${AiChatPanel.fmtTok(u.totalTokens)} tok` + (cachePct !== undefined ? ` · 缓存命中 ${cachePct}%` : '');
    this.els.statCtx.textContent = `上下文 ≈ ${AiChatPanel.fmtTok(u.lastInputTokens)} tok`;
  }

  // ---- 流中断(SSE 截断)恢复:继续按钮 + 联系作者/反馈 ----
  /** 本会话流中断计数(达阈值展示作者联系方式与反馈入口) */
  private truncCount = 0;
  /** 达到该次数后展示作者联系方式与「反馈」入口(用户要求:5 次) */
  private static readonly TRUNC_FEEDBACK_AT = 5;
  /** 环境快照探测到的官方库根(只读白名单;空串 = 未探测到) */
  private detectedLibDir = '';
  /** 上下文压缩摘要留存(会话重建时与新回放组合注入;新会话清空) */
  private agentContextExtra = '';

  // ---- 会话实时持久化:思考完/工具完即保存一次(此前只在整轮结束才落盘) ----
  private lastPersistAt = 0;

  /** 按节流把「当前直播内容」并入持久化快照:思考段结束/工具终态触发;
   *  turn 结束仍走原有全量保存。live 为直播中的临时 assistant 消息(可空)。 */
  private persistLive(live: ChatMsg | null): void {
    const nowTs = Date.now();
    if (nowTs - this.lastPersistAt < 500) return;
    this.lastPersistAt = nowTs;
    const base = this.richMessages();
    this.deps.onConversationChange(live ? [...base, live] : base);
  }

  /** 直播中的 Agent turn → 临时 assistant 消息(实时快照用);无内容返回 null。 */
  private liveTurnMsg(): ChatMsg | null {
    const tp = this.liveParts;
    if (!tp) return null;
    const parts = tp.getParts();
    const content = tp.contentText();
    const thinking = tp.thinkingText();
    if (!content && parts.length === 0 && !thinking) return null;
    return {
      role: 'assistant',
      content,
      ...(thinking ? { thinking } : {}),
      ...(parts.length > 0 ? { parts } : {}),
    };
  }

  /** 简单对话直播 → 临时 assistant 消息(思考折叠/进行中落盘用)。 */
  private liveStreamMsg(content: string, thinking: string): ChatMsg | null {
    if (!content && !thinking) return null;
    return { role: 'assistant', content, ...(thinking ? { thinking } : {}) };
  }

  // ---- 上下文自动压缩(面板层):接近模型窗口时把早前历史压成摘要 ----
  /** 未配置模型上下文时的默认触发阈值 */
  private static readonly COMPRESS_AT_TOKENS = 90000;
  /** 模型未配输出上限时的输出预留 */
  private static readonly DEFAULT_OUTPUT_TOKENS = 8192;
  /** 压缩请求自身与系统块的机动余量 */
  private static readonly COMPRESS_RESERVE_TOKENS = 8192;
  private compressing = false;

  /** 压缩触发阈值 = 输入上限 − 输出预留 − 机动余量;未配置输入上限时回落默认 90K。
   *  留余量是为了让压缩请求(输入 ≈ 当前上下文)与后续回复输出都顶不爆模型窗口。 */
  private compressTriggerTokens(): number {
    const cap = this.deps.getModelContext();
    if (cap.input > 0) {
      const out = cap.output > 0 ? cap.output : AiChatPanel.DEFAULT_OUTPUT_TOKENS;
      return Math.max(cap.input - out - AiChatPanel.COMPRESS_RESERVE_TOKENS, 4096);
    }
    return AiChatPanel.COMPRESS_AT_TOKENS;
  }

  /** 上下文粗估(token):中文为主 ~0.7 tok/字符;仅无实测输入 token 时兜底 */
  private estimateContextTokens(): number {
    let chars = 0;
    for (const m of this.msgs) chars += m.content.length;
    return Math.round(chars / 1.4);
  }

  /** 接近上限时压缩:较早历史 → 摘要(1 条压缩消息)+ 最近 6 条(消息少时 2 条)原文。
   *  Agent 模式重建 DSH 会话并把摘要注入系统提示词(重携环境快照/工程指令/文档索引)。 */
  private async maybeCompress(force = false): Promise<boolean> {
    if (this.compressing) return false;
    const est = this.estimateContextTokens();
    const used = this.usage.lastInputTokens > 0 ? this.usage.lastInputTokens : est;
    const trigger = this.compressTriggerTokens();
    if (!force && used < trigger) return false;
    // 保留窗口:自动触发时长会话保 6 条、消息少保 2 条;手动 /compact 一律保 2 条(压得更彻底)
    const keep = force ? 2 : this.msgs.length > 8 ? 6 : 2;
    const cut = this.msgs.length - keep;
    if (cut < 2) return false;
    this.compressing = true;
    const t0 = Date.now();
    showToast('上下文接近模型上限,正在自动压缩较早历史…');
    try {
      const summary = await this.summarizeHistory(this.msgs.slice(0, cut).filter((m) => !m.notice && !m.error));
      if (!summary.trim()) throw new Error('摘要为空');
      const cap = `【历史对话摘要】较早前 ${cut} 条消息已由 IDE 自动压缩为下述要点,继续任务时以此为准;需要细节时重新读取文件或重新执行命令核实。\n\n${summary.trim()}`;
      const kept = this.msgs.slice(cut);
      this.msgs = [{ role: 'assistant', content: cap, compressed: true }, ...kept];
      this.usage.lastInputTokens = this.estimateContextTokens();
      if (this.agentModeOn) {
        // Agent 模式重建 DSH 会话后模型上下文归零:摘要 + 最近消息回放必须随系统提示词携带,
        // 否则保留的最近几条也在模型视野里消失(会话历史不可注入,回放是唯一连续通道)
        const replay = kept
          .filter((m) => m.content.trim())
          .map((m) => {
            const text = m.content.length > 1500 ? m.content.slice(0, 1500) + '…' : m.content;
            return `【${m.role === 'user' ? '用户' : '助手'}】${text}`;
          })
          .join('\n\n');
        const note = cap + (replay ? `\n\n【此前对话回放 压缩前最后 ${kept.length} 条原文节选】\n${replay}` : '');
        const ctl = await this.ensureAgentCtl().catch(() => undefined);
        this.agentContextExtra = cap;
        await ctl?.injectContext(note).catch((err: unknown) => {
          aiLog('warn', 'aichat', `压缩后重建 Agent 会话失败: ${String(err)}`);
        });
      }
      this.renderAll();
      this.renderStats();
      this.deps.onConversationChange(this.richMessages());
      aiLog('info', 'aichat', `上下文已压缩: ${cut} 条历史 → 摘要 ${summary.length} 字符(触发阈值 ${trigger} tok,用时 ${fmtDur(Date.now() - t0)})`);
      return true;
    } catch (error) {
      aiLog('warn', 'aichat', `上下文压缩失败(按原样继续): ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      this.compressing = false;
    }
  }

  /** 摘要请求(压缩专用):走当前通道的流式接口收集正文;不进 msgs、不计入用量统计 */
  private async summarizeHistory(parts: ChatMsg[]): Promise<string> {
    const target = this.deps.getTarget();
    const official = target.kind === 'official';
    const sid = `ai-compress-${Date.now()}`;
    let buf = '';
    const un = await listen<string>(`ai-stream-${sid}`, (e) => {
      try {
        const c = JSON.parse(e.payload) as StreamChunk;
        if (c.type === 'text' && c.text) buf += c.text;
      } catch {
        // 单块解析失败忽略
      }
    });
    const prompt =
      '你是对话上下文压缩器。把下面的对话历史压缩成一段参考摘要,供后续对话继续工作使用。要求:\n' +
      '1. 保留:用户目标与要求、已达成的结论与事实、涉及的文件路径、已做的修改、未决问题与下一步。\n' +
      '2. 丢弃:寒暄、重复表述、中间过程与工具输出细节。\n' +
      '3. 直接输出摘要正文(中文,600 字以内),不加任何前后缀。\n\n' +
      parts.map((m) => `【${m.role === 'user' ? '用户' : '助手'}】${m.content}`).join('\n\n');
    const url =
      official
        ? this.deps.getAccount().baseUrl.replace(/\/+$/, '') + '/api/ai/chat'
        : target.provider.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content: prompt }],
      thinking: 'off',
      stream: true,
      session_id: this.deps.getSessionId(),
    };
    if (!official) body.model = target.provider.model;
    try {
      await backend.httpStream(
        sid,
        'POST',
        url,
        body,
        official ? `xt_session=${this.deps.getAccount().cookie}` : undefined,
        official ? undefined : target.provider.apiKey ? `Bearer ${target.provider.apiKey}` : undefined,
        official ? 'community' : 'openai',
      );
    } finally {
      void un();
    }
    return buf;
  }

  /** 构造 Agent 会话重建的注入记录(既有压缩摘要 + 本次历史回放)。 */
  private composeAgentNote(replay: string): string {
    return [this.agentContextExtra.trim(), replay.trim()].filter((x) => x.length > 0).join('\n\n');
  }

  /** Agent 会话重建的历史回放:msgs 节选(单条截断、总量受限、最近优先,头部保留最早 2 条)。
   *  DSH 会话历史不可注入,重建(重新生成/回退/换模型/压缩)后模型只认系统提示词里的这块
   *  记录——不注入就会"这是会话的第一条消息"式失忆(实测反馈)。excludeTail 用于排除
   *  即将重发的那条用户消息(重新生成场景,避免与本次 user 消息重复)。 */
  private agentHistoryReplay(excludeTail: number): string {
    const msgs = this.msgs.filter((m) => m.content.trim().length > 0 && !m.notice && !m.error);
    const usable = excludeTail > 0 ? msgs.slice(0, Math.max(0, msgs.length - excludeTail)) : msgs;
    if (usable.length === 0) return '';
    const perMsg = 1200;
    const totalMax = 16000;
    const segs = usable.map((m) => {
      const text =
        m.content.length > perMsg ? m.content.slice(0, 700) + '\n…(中段省略)…\n' + m.content.slice(-400) : m.content;
      return `【${m.role === 'user' ? '用户' : '助手'}】${text}`;
    });
    const head = segs.slice(0, 2);
    let budget = totalMax - head.join('\n\n').length;
    const tail: string[] = [];
    for (let i = segs.length - 1; i >= 2 && budget > 0; i--) {
      if (segs[i].length > budget) break;
      tail.unshift(segs[i]);
      budget -= segs[i].length;
    }
    const omitted = segs.length - head.length - tail.length;
    const body = [...head, ...(omitted > 0 ? [`…(中间 ${omitted} 条消息省略)…`] : []), ...tail].join('\n\n');
    return `【此前对话回放 重建会话前的对话节选,继续任务时以此为准】\n${body}`;
  }

  /** 回放兜底口径:末条若是用户消息,必是"即将发送/重发"的那条,排除之避免重复。 */
  private replayExcludingPending(): string {
    const last = this.msgs[this.msgs.length - 1];
    return this.agentHistoryReplay(last && last.role === 'user' ? 1 : 0);
  }

  /** /compact 手动压缩:先落一条分割提示,压缩完成后更新文案(与自动压缩共用管线)。 */
  private async manualCompact(): Promise<void> {
    if (this.busy) {
      showToast('正在生成中,请等回复结束后再试', 'err');
      return;
    }
    if (this.compressing) return;
    const notice: ChatMsg = { role: 'assistant', content: '上下文正在压缩…', notice: true };
    this.msgs.push(notice);
    this.els.msgs.appendChild(this.buildWrap(notice, this.msgs.length - 1));
    this.els.msgs.scrollTop = this.els.msgs.scrollHeight;
    const ok = await this.maybeCompress(true);
    notice.content = ok ? '上下文已自动压缩' : '历史太短,暂无需压缩';
    this.renderAll();
    if (ok) this.deps.onConversationChange(this.richMessages());
    this.els.input.focus();
  }

  /** 环境自检未通过:插入黄色警告引用提示(瞬时提示,不随会话持久化)。 */
  showPreflightWarning(text: string): void {
    this.pendingPreflightWarn = text;
    this.renderPreflightWarn();
  }

  private pendingPreflightWarn = '';

  private renderPreflightWarn(): void {
    if (!this.pendingPreflightWarn) return;
    const div = document.createElement('div');
    div.className = 'ai-instr-ref warn';
    const ic = document.createElement('i');
    ic.className = 'codicon codicon-warning';
    div.append(ic, document.createTextNode(this.pendingPreflightWarn));
    div.title = '本地玄铁环境自检有未通过项:请检查设置中的编译器路径(或重装玄铁工具链)后重开工程重试';
    this.pendingPreflightWarn = '';
    this.els.msgs.appendChild(div);
    this.els.msgs.scrollTop = this.els.msgs.scrollHeight;
  }

  /** 流截断类错误判定(文案来自 adapter/DSH 归一化,含固定关键词)。 */
  private static isStreamTruncated(msg: string | undefined): boolean {
    return !!msg && (msg.includes('STREAM_TRUNCATED') || msg.includes('finish_reason'));
  }

  /** 统一错误出口:截断类计数并在气泡上提供「继续」;(达阈值时)展现联系作者与「反馈」。 */
  private showStreamError(errText: string, partial: string, prefix = ''): void {
    const trunc = AiChatPanel.isStreamTruncated(errText);
    if (trunc) this.truncCount++;
    const label = trunc ? `流中断:未收到结束标记(本会话第 ${this.truncCount} 次)` : `${prefix}${errText}`;
    const cut = AiChatPanel.truncatePartial(partial);
    // 错误消息入 msgs 持久化:重启后仍可见、仍可「继续」(此前只在 DOM 里,重启即丢——实测反馈)
    const msg: ChatMsg = {
      role: 'assistant',
      content: label,
      error: true,
      ...(cut ? { errPartial: cut } : {}),
      ...(trunc && this.truncCount >= AiChatPanel.TRUNC_FEEDBACK_AT ? { errFeedback: true } : {}),
    };
    this.msgs.push(msg);
    this.els.msgs.appendChild(this.buildWrap(msg, this.msgs.length - 1));
    this.els.msgs.scrollTop = this.els.msgs.scrollHeight;
    this.deps.onConversationChange(this.richMessages());
  }

  /** 「继续」引用块的部分内容截断(过长时留头留尾;持久化与继续共用同一口径)。 */
  private static truncatePartial(partial: string): string {
    const trimmed = partial.trim();
    if (trimmed.length <= 4000) return trimmed;
    return trimmed.slice(0, 2000) + '\n…(中部省略,避免重复占用上下文)…\n' + trimmed.slice(-1500);
  }

  /** 错误消息元素(流中断/传输错误):继续 / 复制诊断;errFeedback 时附作者联系方式与反馈入口。 */
  private buildErrEl(m: ChatMsg): HTMLElement {
    const msg = document.createElement('div');
    msg.className = 'ai-msg err';
    msg.textContent = m.content;
    const bar = document.createElement('div');
    bar.className = 'ai-err-actions';
    const btnContinue = document.createElement('button');
    btnContinue.className = 'mbtn mbtn-sm';
    btnContinue.textContent = '继续';
    btnContinue.title = '把已收到的内容作为开头,让 AI 从中断处接着写';
    btnContinue.addEventListener('click', () => {
      btnContinue.disabled = true;
      this.continueTurn(m.errPartial ?? '');
    });
    bar.appendChild(btnContinue);
    const btnDiag = document.createElement('button');
    btnDiag.className = 'mbtn mbtn-sm';
    btnDiag.textContent = '复制诊断';
    btnDiag.title = '复制最近的 AI 链路日志(含断流原因/流统计),便于排查或反馈';
    btnDiag.addEventListener('click', () => {
      void copyText(exportLogText()).then((ok) => showToast(ok ? '诊断信息已复制' : '复制失败', ok ? 'ok' : 'err'));
    });
    bar.appendChild(btnDiag);
    if (m.errFeedback) {
      const contact = this.deps.getSupportContact();
      if (contact.name && contact.value) {
        const c = document.createElement('span');
        c.className = 'ai-err-contact';
        c.textContent = `联系作者 —— ${contact.name}:${contact.value}`;
        bar.appendChild(c);
      }
      const btnFb = document.createElement('button');
      btnFb.className = 'mbtn mbtn-sm';
      btnFb.textContent = '反馈问题';
      btnFb.title = '把问题提交给社区(管理员后台可见,并邮件通知)';
      btnFb.addEventListener('click', () => this.openFeedbackDialog(m.content));
      bar.appendChild(btnFb);
    }
    msg.appendChild(bar);
    return msg;
  }

  /** 「继续」:把已收到的部分内容作为引用,让模型从中断处续写(不重复已输出部分)。 */
  private continueTurn(partial: string): void {
    if (this.busy) {
      showToast('正在生成中,请稍候再试', 'err');
      return;
    }
    const cut = AiChatPanel.truncatePartial(partial);
    const text = cut
      ? `上一条回复在传输中断,已收到的部分内容如下:\n\`\`\`\n${cut}\n\`\`\`\n请从中断处继续输出剩余内容:不要重复上述已输出部分,不要重新开头,直接接着写。`
      : '上一条回复在传输中断。请重发刚才的回复内容。';
    void this.dispatch(text);
  }

  /** 反馈弹窗(流中断多次后出现):内容提交到社区 /api/feedback,管理员后台可见并邮件通知。 */
  /** 帮助菜单入口:打开反馈弹窗(无错误上下文,通用反馈)。 */
  openFeedback(): void {
    this.openFeedbackDialog('');
  }

  private openFeedbackDialog(errText: string): void {
    if (document.getElementById('ai-fb-mask')) return;
    const mask = document.createElement('div');
    mask.id = 'ai-fb-mask';
    mask.className = 'ai-fb-mask';
    const card = document.createElement('div');
    card.className = 'ai-fb-card';
    const title = document.createElement('div');
    title.className = 'ai-fb-title';
    title.textContent = '反馈问题';
    const contact = this.deps.getSupportContact();
    const sub = document.createElement('div');
    sub.className = 'ai-fb-sub';
    const base = errText
      ? '已连续多次流中断。也可以直接联系作者 —— 或描述问题提交给开发者。'
      : '遇到问题或有建议?描述后提交,会送达开发者(社区后台可见,并邮件通知)。';
    sub.textContent =
      contact.name && contact.value ? `${base}直接联系作者 —— ${contact.name}:${contact.value}。` : base;
    const ta = document.createElement('textarea');
    ta.className = 'ai-fb-input';
    ta.rows = 5;
    ta.placeholder = '描述遇到的问题(在做什么、问了什么、从什么时候开始)…';
    const foot = document.createElement('div');
    foot.className = 'ai-fb-foot';
    const msgEl = document.createElement('div');
    msgEl.className = 'ai-fb-msg';
    const btnCancel = document.createElement('button');
    btnCancel.className = 'mbtn';
    btnCancel.textContent = '取消';
    btnCancel.addEventListener('click', () => mask.remove());
    const btnSend = document.createElement('button');
    btnSend.className = 'mbtn';
    btnSend.textContent = '发送反馈';
    btnSend.addEventListener('click', () => {
      const text = ta.value.trim();
      if (text.length < 5) {
        msgEl.textContent = '反馈内容至少 5 个字';
        return;
      }
      if (text.length > 3800) {
        msgEl.textContent = '反馈内容过长(请精简到 3800 字以内)';
        return;
      }
      btnSend.disabled = true;
      msgEl.textContent = '提交中…';
      void this.submitFeedback(text, errText)
        .then(() => {
          showToast('反馈已提交,感谢反馈', 'ok');
          mask.remove();
        })
        .catch((err: unknown) => {
          msgEl.textContent = err instanceof Error ? err.message : String(err);
          btnSend.disabled = false;
        });
    });
    foot.append(msgEl, btnCancel, btnSend);
    card.append(title, sub, ta, foot);
    mask.appendChild(card);
    mask.addEventListener('mousedown', (e) => {
      if (e.target === mask) mask.remove();
    });
    document.body.appendChild(mask);
    ta.focus();
  }

  /** 提交反馈:复用社区 /api/feedback(kind=bug;自动附模型/通道/错误/会话上下文)。 */
  private async submitFeedback(text: string, errText: string): Promise<void> {
    const acct = this.deps.getAccount();
    const base = acct.baseUrl.replace(/\/+$/, '');
    if (!base) throw new Error('未连接玄铁服务器,无法提交反馈');
    if (!acct.cookie) throw new Error('反馈需登录玄铁账号(右上角「账号」登录后重试)');
    const t = this.deps.getTarget();
    const ctxInfo = [
      `模型: ${t.kind === 'official' ? this.deps.officialName() : t.provider.model}`,
      `通道: ${t.kind === 'official' ? '官方' : '自定义'}`,
      ...(errText ? [`错误: ${errText}`] : []),
      `会话: ${this.deps.getSessionId()}`,
    ].join('\n');
    const r = await backend.httpJson(
      'POST',
      base + '/api/feedback',
      { kind: 'bug', content: `${text}\n\n———— 自动附加 ————\n${ctxInfo}` },
      `xt_session=${acct.cookie}`,
    );
    let j: { ok?: boolean; error?: string } = {};
    try {
      j = JSON.parse(r.body) as typeof j;
    } catch {
      // 非 JSON 响应按 HTTP 状态判定
    }
    if (r.status < 200 || r.status >= 300 || j.ok === false) {
      throw new Error(j.error || `提交失败(HTTP ${r.status})`);
    }
  }

  private hideStatsPop(): void {
    this.statsPop?.remove();
    this.statsPop = undefined;
  }

  /** 点击用量行:向上弹出明细(上下文 / Token 用量 / 会话统计) */
  private toggleStatsPop(): void {
    if (this.statsPop) {
      this.hideStatsPop();
      return;
    }
    const u = this.usage;
    const pop = document.createElement('div');
    pop.className = 'ai-stats-pop';
    const section = (title: string): HTMLElement => {
      const h = document.createElement('div');
      h.className = 'stats-sec';
      h.textContent = title;
      pop.appendChild(h);
      return h;
    };
    const row = (k: string, v: string): void => {
      const r = document.createElement('div');
      r.className = 'stats-row';
      const kk = document.createElement('span');
      kk.textContent = k;
      const vv = document.createElement('span');
      vv.className = 'stats-v';
      vv.textContent = v;
      r.append(kk, vv);
      pop.appendChild(r);
    };
    section('上下文');
    row('当前占用(最近一次输入)', '≈ ' + AiChatPanel.fmtTok(u.lastInputTokens) + ' tok');
    section('Token 用量');
    row('累计(输入+输出)', AiChatPanel.fmtTok(u.totalTokens) + ' tok');
    row('输出累计', AiChatPanel.fmtTok(u.outTokens) + ' tok');
    if (u.cacheRead > 0 || u.cacheMiss > 0) {
      row('缓存读取', AiChatPanel.fmtTok(u.cacheRead) + ' tok');
      row('缓存未命中', AiChatPanel.fmtTok(u.cacheMiss) + ' tok');
    }
    section('会话统计');
    row('轮数 / 步数', `${u.turns} / ${u.steps}`);
    row('模型生成用时', fmtDur(u.genMs));
    row('工具调用用时', fmtDur(u.toolMs));
    row('首 token 平均', u.ttftCount > 0 ? fmtDur(Math.round(u.ttftMs / u.ttftCount)) : '-');
    row('输出速度', u.genMs > 0 ? (u.outTokens / (u.genMs / 1000)).toFixed(1) + ' tok/s' : '-');
    this.els.dock.appendChild(pop);
    // 定位于用量行上方(fixed 定位,不参与 dock 布局)
    const rect = this.els.statsBar.getBoundingClientRect();
    pop.style.left = `${Math.max(8, rect.left + 8)}px`;
    pop.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    this.statsPop = pop;
    const onOutside = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      if (t && (pop.contains(t) || this.els.statsBar.contains(t))) return;
      document.removeEventListener('mousedown', onOutside, true);
      this.hideStatsPop();
    };
    document.addEventListener('mousedown', onOutside, true);
  }

  /** 「添加到对话」入口:引用 chip 进输入栏(打开 dock 由 main 侧负责) */
  addRef(ref: ChatRef): void {
    const dup = this.refs.some(
      (r) =>
        r.kind === ref.kind &&
        r.path === ref.path &&
        r.startLine === ref.startLine &&
        r.endLine === ref.endLine &&
        r.text === ref.text,
    );
    if (!dup) this.refs.push(ref);
    this.renderRefChips();
    this.els.input.focus();
  }

  /** 编辑器选中引用入口(SelectionRef 结构 × kind=code)。 */
  addSelectionRef(ref: SelectionRef): void {
    this.addRef({ kind: 'code', ...ref });
  }

  private clearRefs(): void {
    this.refs = [];
    this.renderRefChips();
  }

  private composeWithRefs(body: string): string {
    if (this.refs.length === 0) return body;
    const blocks = this.refs.map((r) => AiChatPanel.refBlock(r)).join('\n\n');
    return body ? `${body}\n\n${blocks}` : blocks;
  }

  /** 引用 chip → 发送时拼进的引用块(按来源措辞)。 */
  private static refBlock(r: ChatRef): string {
    if (r.kind === 'code') {
      return `引用 ${r.path}:${r.startLine}-${r.endLine}:\n\`\`\`xt\n${r.text}\n\`\`\``;
    }
    if (r.kind === 'path') return `引用工程内路径: ${r.path}${r.text ? `\n${r.text}` : ''}`;
    const label = r.kind === 'terminal' ? '终端输出' : r.kind === 'build' ? '构建输出' : '问题项';
    return `${label}引用:\n\`\`\`\n${r.text}\n\`\`\``;
  }

  // ---- 附件 UI 与生命周期 ----

  /** 添加附件(去重按 name+size;编号按添加序,移除不重排——已插入文本的'N'引用保持有效) */
  addAttachment(a: Omit<Attachment, 'id' | 'idx'>): boolean {
    const limit = a.kind === 'video' ? 20 * 1024 * 1024 : 10 * 1024 * 1024;
    if (a.sizeBytes > limit) {
      showToast(
        `${a.kind === 'video' ? '视频' : '图片'}过大(${(a.sizeBytes / 1024 / 1024).toFixed(1)}MB,上限 ${limit / 1024 / 1024}MB)`,
        'err',
      );
      return false;
    }
    const dup = this.attachments.some((x) => x.name === a.name && x.sizeBytes === a.sizeBytes);
    if (dup) return false;
    this.attachSeq += 1;
    this.attachments.push({ ...a, id: `att-${this.attachSeq}`, idx: this.attachSeq });
    this.renderAttachments();
    this.autoresize();
    return true;
  }

  /** 从磁盘路径添加(文件选择入口;读文件→base64 由 Rust 侧做) */
  private async attachFromPath(path: string): Promise<void> {
    try {
      const data = await backend.attachRead(path);
      const kind: 'image' | 'video' = data.mime.startsWith('video/') ? 'video' : 'image';
      const name = path.split(/[\\/]/).pop() ?? path;
      const ok = this.addAttachment({
        kind,
        name,
        mime: data.mime,
        dataUrl: data.dataUrl,
        sizeBytes: data.sizeBytes,
        ...(kind === 'video' ? { sourcePath: path } : {}),
      });
      if (!ok) return;
      void this.makeThumb(this.attachments[this.attachments.length - 1]);
    } catch (err) {
      showToast(String(err), 'err');
    }
  }

  /** 粘贴入口:剪贴板图片(视频走"+"选择文件) */
  private async attachFromBlob(blob: Blob, name: string): Promise<void> {
    const kind: 'image' | 'video' = blob.type.startsWith('video/') ? 'video' : 'image';
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const dataUrl = `data:${blob.type || (kind === 'video' ? 'video/mp4' : 'image/png')};base64,${btoa(bin)}`;
    const ok = this.addAttachment({
      kind,
      name,
      mime: blob.type || (kind === 'video' ? 'video/mp4' : 'image/png'),
      dataUrl,
      sizeBytes: blob.size,
      ...(kind === 'image' ? { objectUrl: URL.createObjectURL(blob) } : {}),
    });
    if (ok) void this.makeThumb(this.attachments[this.attachments.length - 1]);
  }

  /** 生成小缩略图(~96px JPEG):历史持久化不存原始字节,只存它 */
  private async makeThumb(a: Attachment): Promise<void> {
    try {
      if (a.kind === 'image') {
        const img = await this.loadImage(a.objectUrl ?? a.dataUrl);
        a.thumb = this.drawThumb(img, img.naturalWidth, img.naturalHeight);
      } else {
        const v = document.createElement('video');
        v.muted = true;
        v.src = a.dataUrl;
        await new Promise<void>((res, rej) => {
          v.onloadeddata = () => res();
          v.onerror = () => rej(new Error('视频解码失败'));
          window.setTimeout(() => rej(new Error('视频加载超时')), 8000);
        });
        v.currentTime = Math.min(0.1, (v.duration || 1) / 10);
        await new Promise<void>((res) => {
          v.onseeked = () => res();
          window.setTimeout(() => res(), 2000);
        });
        a.thumb = this.drawThumb(v, v.videoWidth, v.videoHeight);
      }
      this.renderAttachments();
    } catch {
      // 缩略图失败不影响发送(历史里显示占位图标)
    }
  }

  private loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('图片解码失败'));
      img.src = src;
    });
  }

  private drawThumb(src: HTMLImageElement | HTMLVideoElement, w: number, h: number): string {
    const size = 96;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    const scale = Math.max(size / (w || 1), size / (h || 1));
    const dw = (w || 1) * scale;
    const dh = (h || 1) * scale;
    ctx.drawImage(src, (size - dw) / 2, (size - dh) / 2, dw, dh);
    return canvas.toDataURL('image/jpeg', 0.62);
  }

  private removeAttachment(id: string): void {
    const a = this.attachments.find((x) => x.id === id);
    if (a?.objectUrl) URL.revokeObjectURL(a.objectUrl);
    this.attachments = this.attachments.filter((x) => x.id !== id);
    this.renderAttachments();
  }

  /** 「提及」:往输入框光标处插入 图片N/视频N(编号与卡片徽章一致) */
  private mentionAttachment(a: Attachment): void {
    const token = (a.kind === 'video' ? '视频' : '图片') + a.idx;
    const el = this.els.input;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.value = el.value.slice(0, start) + token + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start + token.length;
    el.focus();
    this.autoresize();
  }

  private openThumbLightbox(src: string, name: string): void {
    const overlay = document.createElement('div');
    overlay.className = 'ai-lightbox';
    const box = document.createElement('div');
    box.className = 'ai-lightbox-box';
    const img = document.createElement('img');
    img.src = src;
    const cap = document.createElement('div');
    cap.className = 'ai-lightbox-cap';
    cap.textContent = name;
    box.append(img, cap);
    overlay.appendChild(box);
    overlay.addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
  }

  /** 点击卡片:图片 → IDE 内放大预览;视频 → 系统默认播放器 */
  private openAttachment(a: Attachment): void {
    if (a.kind === 'video') {
      if (a.sourcePath) {
        void openPath(a.sourcePath).catch((err: unknown) => showToast(`打开视频失败: ${String(err)}`, 'err'));
      } else {
        showToast('该视频无磁盘路径,无法用系统播放器打开(仅图片支持内存预览)', 'err');
      }
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'ai-lightbox';
    const img = document.createElement('img');
    img.src = a.objectUrl ?? a.dataUrl;
    overlay.appendChild(img);
    overlay.addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
  }

  /** 附件卡片渲染(kimiCode 式:缩略图 + 右下编号徽章;悬浮出 提及/移除) */
  private renderAttachments(): void {
    const bar = this.els.attachBar;
    bar.innerHTML = '';
    bar.style.display = this.attachments.length > 0 ? 'flex' : 'none';
    for (const a of this.attachments) {
      const card = document.createElement('div');
      card.className = 'ai-attach-card';
      card.title = a.name;
      const media = document.createElement('div');
      media.className = 'ai-attach-media';
      if (a.kind === 'image') {
        const img = document.createElement('img');
        img.src = a.thumb || a.objectUrl || a.dataUrl;
        media.appendChild(img);
      } else {
        if (a.thumb) {
          const img = document.createElement('img');
          img.src = a.thumb;
          media.appendChild(img);
        }
        const play = document.createElement('i');
        play.className = 'codicon codicon-play-circle ai-attach-play';
        media.appendChild(play);
      }
      const badge = document.createElement('span');
      badge.className = 'ai-attach-badge';
      badge.textContent = String(a.idx);
      const ops = document.createElement('div');
      ops.className = 'ai-attach-ops';
      const btnMention = document.createElement('button');
      btnMention.className = 'ai-attach-op';
      btnMention.title = '提及(插入到输入框)';
      btnMention.innerHTML = '<i class="codicon codicon-mention"></i>';
      btnMention.addEventListener('click', (e) => {
        e.stopPropagation();
        this.mentionAttachment(a);
      });
      const btnRemove = document.createElement('button');
      btnRemove.className = 'ai-attach-op';
      btnRemove.title = '移除';
      btnRemove.innerHTML = '<i class="codicon codicon-trash"></i>';
      btnRemove.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeAttachment(a.id);
      });
      ops.append(btnMention, btnRemove);
      card.append(media, badge, ops);
      card.addEventListener('click', () => this.openAttachment(a));
      bar.appendChild(card);
    }
  }

  private renderRefChips(): void {
    const host = this.els.refChips;
    host.innerHTML = '';
    host.style.display = this.refs.length > 0 ? 'flex' : 'none';
    for (let i = 0; i < this.refs.length; i++) {
      const r = this.refs[i];
      const chip = document.createElement('span');
      chip.className = 'ai-ref-chip';
      const label = document.createElement('span');
      const base = r.path.split(/[\\/]/).pop() ?? r.path;
      label.textContent =
        r.kind === 'code'
          ? `${base} ${r.startLine}-${r.endLine}`
          : r.kind === 'terminal'
            ? '终端输出'
            : r.kind === 'build'
              ? '构建输出'
              : r.kind === 'problem'
                ? '问题项'
                : base;
      const rm = document.createElement('i');
      rm.className = 'codicon codicon-close';
      rm.title = '移除引用';
      rm.addEventListener('click', () => {
        this.refs.splice(i, 1);
        this.renderRefChips();
      });
      chip.append(label, rm);
      host.appendChild(chip);
    }
  }

  // 执行一轮流式对话(调用方保证 msgs 末尾是用户消息)
  private async runStream(atts: Attachment[] = []): Promise<void> {
    if (this.busy) return;
    const target = this.deps.getTarget();
    const official = target.kind === 'official';

    this.setBusy(true);
    const sid = `ai-${Date.now()}`;
    this.streamId = sid;
    const streamStart = Date.now();
    aiLog('info', 'aichat', `简单对话开始(${official ? '官方' : '自定义'}通道)`);
    const un = await listen<string>(`ai-stream-${sid}`, (e) => {
      let c: StreamChunk;
      try {
        c = JSON.parse(e.payload) as StreamChunk;
      } catch {
        return;
      }
      handleChunk(c);
    });

    // 直播气泡:思考折叠块 + 正文 + 状态脚注
    const wrap = document.createElement('div');
    wrap.className = 'ai-wrap';
    const msgEl = document.createElement('div');
    msgEl.className = 'ai-msg bot';
    const think = document.createElement('div');
    think.className = 'ai-think open';
    const thinkHead = document.createElement('div');
    thinkHead.className = 'ai-think-head';
    thinkHead.textContent = '思考中…';
    const thinkBody = document.createElement('div');
    thinkBody.className = 'ai-think-body';
    think.append(thinkHead, thinkBody);
    const textEl = document.createElement('div');
    textEl.className = 'ai-text md';
    const foot = document.createElement('div');
    foot.className = 'ai-tok';
    const statusEl = document.createElement('span');
    statusEl.className = 'ai-status';
    const spin = document.createElement('i');
    spin.className = 'codicon codicon-loading ai-spin';
    const statusText = document.createElement('span');
    statusEl.append(spin, statusText);
    foot.appendChild(statusEl);
    msgEl.append(think, textEl, foot);
    wrap.appendChild(msgEl);
    this.els.msgs.appendChild(wrap);
    this.els.msgs.scrollTop = this.els.msgs.scrollHeight;

    // 活动状态机(简单对话:连接中→思考中 Ns→撰写中)
    const tracker = new ActivityTracker();
    const updateStatus = (): void => {
      const v = tracker.view(Date.now());
      if (!v) {
        statusEl.remove();
        return;
      }
      statusText.textContent = v.text;
    };
    const ev = (e: Parameters<ActivityTracker['event']>[0]): void => {
      tracker.event(e, Date.now());
      updateStatus();
    };
    updateStatus();

    let thinkBuf = '';
    let textBuf = '';
    let tokens = 0;
    let gotUsage = false;
    let errMsg = '';
    let aborted = false;
    let sources: CiteSource[] = [];
    const thinkStart = Date.now();
    const thinkTimer = window.setInterval(() => {
      if (think.classList.contains('open')) {
        thinkHead.textContent = `思考中… ${Math.floor((Date.now() - thinkStart) / 1000)}s`;
      }
    }, 1000);
    const refresh = (): void => {
      // 思考块体是独立滚动容器:内容增长时跟随到底
      thinkBody.scrollTop = thinkBody.scrollHeight;
      if (gotUsage) foot.textContent = `Token: ${tokens}`;
      if (textBuf && think.classList.contains('open')) {
        window.clearInterval(thinkTimer);
        think.classList.remove('open');
        think.classList.add('done');
        thinkHead.textContent = `已完成思考(用时 ${Math.floor((Date.now() - thinkStart) / 1000)}s,点击展开)`;
        // 思考完成即落盘一次(实时恢复现场;后续正文增量由 turn 结束的全量保存收口)
        this.persistLive(this.liveStreamMsg(textBuf, thinkBuf));
      }
      this.scheduleScroll();
    };
    thinkHead.addEventListener('click', () => {
      think.classList.toggle('open');
      think.classList.toggle('done');
    });

    // 平滑吐字器:流式纯文本按 rAF 自适应速率淡出释放;定稿时统一 dispose(DOM 随气泡重建)
    const textTyper = new SmoothTyper((text) => {
      const span = document.createElement('span');
      span.className = 'ai-flow';
      span.textContent = text;
      textEl.appendChild(span);
    });
    const thinkTyper = new SmoothTyper((text) => {
      const span = document.createElement('span');
      span.className = 'ai-flow';
      span.textContent = text;
      thinkBody.appendChild(span);
    });

    const handleChunk = (c: StreamChunk): void => {
      if (c.type === 'thinking' && c.text) {
        thinkBuf += c.text;
        thinkTyper.push(c.text);
        ev({ type: 'reasoning' });
        refresh();
      } else if (c.type === 'text' && c.text) {
        textBuf += c.text;
        textTyper.push(c.text);
        ev({ type: 'text' });
        refresh();
      } else if (c.type === 'usage' && typeof c.tokens === 'number') {
        tokens = c.tokens;
        gotUsage = true;
        refresh();
        // 简单对话的服务端只回总量(无输入/输出细分),总量与轮数如实入账
        this.usage.totalTokens += tokens;
        this.renderStats();
      } else if (c.type === 'sources' && Array.isArray(c.items)) {
        // 联网搜索引用索引(文本 chunk 之前到达;模型随后用 〔N〕 标注)
        sources = c.items.filter((x) => typeof x?.i === 'number' && typeof x?.url === 'string');
        aiLog('info', 'aichat', `sources: ${sources.length} 条引用索引`);
      } else if (c.type === 'error') {
        errMsg = c.message ?? '未知错误';
        ev({ type: 'turn-end' });
      } else if (c.type === 'aborted') {
        aborted = true;
        ev({ type: 'turn-end' });
      }
    };

    const url =
      target.kind === 'official'
        ? this.deps.getAccount().baseUrl.replace(/\/+$/, '') + '/api/ai/chat'
        : target.provider.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const outgoing = this.buildOutgoingMessages(atts);
    // 认知块:后台版本(本地缓存)→ 内置常量;官方通道由服务端拼进系统提示词
    // (官方端点只允许 user/assistant 角色,客户端插 system 会被 400 拒绝,已核 ai.go)
    const primer = (await this.deps.getPrimer?.().catch(() => '')) || XUANTIE_PRIMER;
    const body: Record<string, unknown> = {
      messages: official ? outgoing : [{ role: 'system', content: primer }, ...outgoing],
      thinking: this.deps.getThinking(),
      stream: true,
      session_id: this.deps.getSessionId(),
    };
    if (official && this.webSearch) body.web = true;
    if (!official) {
      body.model = target.provider.model;
      const t = this.deps.getThinking();
      if (t !== 'off' && t !== 'none') body.reasoning_effort = t === 'mid' ? 'medium' : t;
    }

    try {
      await backend.httpStream(
        sid,
        'POST',
        url,
        body,
        official ? `xt_session=${this.deps.getAccount().cookie}` : undefined,
        official ? undefined : target.provider.apiKey ? `Bearer ${target.provider.apiKey}` : undefined,
        official ? 'community' : 'openai',
      );
    } catch (err) {
      errMsg = String(err);
    } finally {
      window.clearInterval(thinkTimer);
      textTyper.dispose();
      thinkTyper.dispose();
      void un();
      this.streamId = null;
      this.setBusy(false);
      // 简单对话的服务端只回总量:只入账总量与轮数;TTFT/生成时长/输出细分的口径仅
      // Agent 路径有真实数据(混入会稀释 tok/s),不估算、不伪造。
      this.usage.turns++;
      this.renderStats();
      aiLog(
        errMsg ? 'error' : 'info',
        'aichat',
        `简单对话结束(用时 ${fmtDur(Date.now() - streamStart)})${errMsg ? ` 错误: ${errMsg}` : ''}${aborted ? ' [已中止]' : ''}`,
      );
    }

    wrap.remove();
    if (errMsg && !textBuf) {
      if (aborted) this.addBubble('err', '已停止');
      else this.showStreamError(errMsg, '');
      return;
    }
    const content = textBuf || (aborted ? '(已停止,无输出)' : '');
    if (content) {
      // 定稿:buildWrap 一次性渲染 markdown;思考随消息持久化(老路径只进 DOM 不进数据)
      this.msgs.push({
        role: 'assistant',
        content,
        ...(thinkBuf ? { thinking: thinkBuf } : {}),
        ...(sources.length > 0 ? { sources } : {}),
      });
      this.els.msgs.appendChild(this.buildWrap(this.msgs[this.msgs.length - 1], this.msgs.length - 1));
      this.els.msgs.scrollTop = this.els.msgs.scrollHeight;
      this.deps.onConversationChange(this.richMessages());
    }
    if (errMsg) this.showStreamError(errMsg, textBuf, '流式结束后出错: ');
  }

  // ==================== Agent 模式(Phase-3 DSH;与上方简单对话逻辑分区,互不复用) ====================

  /** 销毁 Agent 控制器(新会话/关面板时):会话随面板生命周期,不做跨重启持久化;
   *  未裁决的审批卡片一律按拒绝结算(fail-closed)。 */
  private disposeAgent(): void {
    this.approvalLane.dismissAll();
    const ctl = this.agentCtl;
    this.agentCtl = undefined;
    if (ctl) void ctl.dispose();
  }

  /** 懒加载 Agent 控制器:首次开启 Agent 发送时才 import 内核 chunk(665KB)。 */
  private async ensureAgentCtl(): Promise<AgentMode> {
    if (this.agentCtl) return this.agentCtl;
    const [{ AgentMode: Ctl }, { officialChannel, customChannel }] = await Promise.all([
      import('./dsh/agent-mode'),
      import('./dsh/adapter-openai'),
    ]);
    this.agentCtl = new Ctl({
      getChannel: () => {
        const t = this.deps.getTarget();
        return t.kind === 'official'
          ? officialChannel(this.deps.getAccount().baseUrl, this.deps.getAccount().cookie)
          : customChannel(t.provider.baseUrl, t.provider.apiKey);
      },
      getModel: () => {
        const t = this.deps.getTarget();
        return t.kind === 'official' ? this.deps.officialName() : t.provider.model;
      },
      getWorkspace: () => this.deps.getWorkspace(),
      getThinking: () => this.deps.getThinking(),
      getAgentMode: () => this.deps.getAgentMode(),
      getCmdWhitelist: () => this.deps.getCmdWhitelist(),
      addCmdToken: (token) => this.deps.addCmdToken(token),
      requestApproval: (prompt) => this.approvalLane.request(prompt),
      onFileWritten: (absPath) => this.deps.onFileWritten(absPath),
      onWriteDiff: this.handleWriteDiff,
      loadProjectInstructions: () => {
        const ws = this.deps.getWorkspace();
        if (!ws) return Promise.resolve([]);
        return backend
          .projectInstructions(ws)
          .then((list) => list.map((f) => ({ name: f.name, content: f.content })))
          .catch(() => []);
      },
      loadDocsIndex: () => backend.docsIndex().catch(() => null),
      getEnvSnapshot: () => this.buildEnvSnapshot(),
      getLibDir: () => this.detectedLibDir || undefined,
      getHistoryReplay: () => this.replayExcludingPending(),
      getPrimer: async () => {
        try {
          const local = await backend.primerRead();
          if (local && local.trim()) return local;
        } catch {
          // 读缓存失败回落内置
        }
        return XUANTIE_PRIMER;
      },
      getFsAccess: () => getSettings().ai.fsAccess ?? 'deny',
      getXtcPath: () => resolveXtc(),
      getTurnAttachments: () => this.pendingTurnMedia,
      requestOutOfScope: async (path, op) => {
        // 越界访问审批:复用内嵌审批卡片;「允许一次」放行,拒绝/关面板一律拒绝(fail-closed)
        const v = await this.approvalLane.request({
          toolName: 'fs-access',
          kindLabel: '访问工作区外',
          summary: `AI 请求${op}工程目录外的路径(设置「允许AI访问工程目录外的文件」当前为“询问”)`,
          detail: path,
        });
        return v !== 'deny';
      },
    });
    return this.agentCtl;
  }

  /** 开发环境快照(会话级事实:工具链路径/版本、官方库目录、工程入口):
   *  注入系统提示词,消除 AI 用 dir/where 全盘探测的开销。全部来自 IDE 实测,读不到的项如实省略。 */
  private async buildEnvSnapshot(): Promise<string> {
    const lines: string[] = [];
    const ws = this.deps.getWorkspace();
    lines.push(`- 工程根目录: ${ws || '(未打开工程)'}`);
    // 注:不放"工程内顶层 .xt 文件"列表——系统提示词前缀必须字节稳定(前缀随文件变化会
    // 击穿提示词缓存),文件清单交给 list_files 工具按需获取。
    const xtc = await resolveXtc();
    if (xtc) {
      let ver = '';
      try {
        ver = (await backend.toolVersion(xtc)).trim();
      } catch {
        ver = '';
      }
      lines.push(`- 编译器 xtc: ${xtc}${ver ? `(版本: ${ver})` : ''}`);
      // 官方库定位:xtc 目录 / 上 1 级 / 上 2 级 / 工程根 的 lib(以 数组\数组.xt 为标记)
      const dir = dirname(xtc);
      const cands = [
        backend.joinPath(dir, 'lib'),
        backend.joinPath(dirname(dir), 'lib'),
        backend.joinPath(dirname(dirname(dir)), 'lib'),
      ];
      if (ws) cands.push(backend.joinPath(ws, 'lib'));
      for (const cand of cands) {
        try {
          if (!(await backend.fsExists(backend.joinPath(cand, '数组\\数组.xt')))) continue;
          const subs = (await backend.fsListDir(cand)).filter((n) => n.endsWith('/')).slice(0, 40);
          lines.push(
            `- 官方库目录: ${cand}` +
              (subs.length > 0
                ? `(子库: ${subs.map((d) => d.slice(0, -1)).join('、')};每个子库含 tiepm.toml 与 <库名>.xt)`
                : ''),
          );
          // 缓存给 read_file/list_files 只读白名单(AI 可直接读库源码查证 API)
          this.detectedLibDir = cand;
          break;
        } catch {
          // 探测失败继续下一候选
        }
      }
    } else {
      lines.push('- 编译器 xtc: 未找到(无法编译/运行;涉及编译的需求如实告知用户)');
    }
    const tiepm = await resolveTiepm();
    lines.push(tiepm ? `- 包管理器 tiepm: ${tiepm}` : '- 包管理器 tiepm: 未找到');
    // 编译/运行命令与可写范围(实测反馈:AI 花十几次调用在问"这台机器的工具链长什么样")
    lines.push(
      '- 编译与运行命令: 编译 `xtc tie <源.xt> [-sc 输出.exe]`;编译并运行 `xtc pao <源.xt>`(产物自动清理);' +
        '仅检查 `xtc tie <源.xt> -jc`(约 0.5 秒,写文件后 IDE 会自动做);帮助 `xtc -h`',
    );
    const fsMode = this.deps.getFsAccess?.() ?? 'deny';
    const fsModeText = fsMode === 'allow' ? '可自由访问' : fsMode === 'ask' ? '越界需审批' : '越界禁止';
    lines.push(
      `- 可写范围与禁区: 工程根可读写;不确定的代码先用 check_code 工具验证(自动临时文件,不落工程根);` +
        `临时/探针文件只放 <工程>/.foundry/,严禁写到工程根;官方库与玄铁文档目录只读;工程外${fsModeText}`,
    );
    const s = getSettings();
    lines.push(`- 编译产物默认目录: ${s.buildDir && s.buildDir.trim() ? s.buildDir : ws ? backend.joinPath(ws, 'build') : '(未打开工程)'}`);
    // 本地自检结果(IDE 自动跑的内置探针):基础语义实测事实,AI 直接采用
    const pf = this.deps.getPreflight?.();
    if (pf?.result) {
      const r = pf.result;
      // 不带耗时/时间戳——系统提示词前缀保持字节稳定以命中提示词缓存
      lines.push(`- 本地玄铁环境自检(IDE 自动执行):${r.ok ? '全部通过' : '存在未通过项'}`);
      for (const it of r.items) lines.push(`  · ${it.key} = ${it.value}`);
      if (!r.ok && r.detail) lines.push(`  · 诊断: ${r.detail.split('\n').slice(-6).join(' / ')}`);
      lines.push('  (以上为本地实测事实,直接采用;不要再写探针/冒烟/前置测试验证这些基础行为)');
    }
    return (
      '\n\n<开发环境快照 由 IDE 实测提供,以下路径与版本均为事实,直接使用;禁止再用 dir/where/find 全盘探测这些信息>\n' +
      lines.join('\n') +
      '\n</开发环境快照>'
    );
  }

  /** 语义化标题:run_command→「运行 <命令>」、read_file→「读取 <路径>」、
   *  write_file→「写入 <路径> +N -M」/「新建 <路径>(N 行)」、list_files→「列出 <路径>」;
   *  工具原名只进 tooltip。diff 增删行带红绿色。 */
  private toolTitleEl(name: string, argsJson: string, rec?: ToolRecord): HTMLElement {
    const title = document.createElement('span');
    title.className = 'ai-tool-name';
    title.title = name;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>;
    } catch {
      // 回落:保持空 args,走 default 分支
    }
    const path = String(args.path ?? '');
    if (name === 'run_command') {
      const cmd = String(args.command ?? '');
      title.textContent = `运行 ${cmd.length > 60 ? `${cmd.slice(0, 60)}…` : cmd}`;
    } else if (name === 'read_file') {
      title.textContent = `读取 ${path}`;
    } else if (name === 'write_file') {
      if (rec?.isNew) {
        title.textContent = `新建 ${path}`;
        const add = document.createElement('span');
        add.className = 'ai-diff-add';
        add.textContent = ` +${String(args.content ?? '').split('\n').length}`;
        title.append(add);
      } else {
        title.textContent = `写入 ${path}`;
        if (rec && rec.added !== undefined && rec.removed !== undefined) {
          const add = document.createElement('span');
          add.className = 'ai-diff-add';
          add.textContent = ` +${rec.added}`;
          const del = document.createElement('span');
          del.className = 'ai-diff-del';
          del.textContent = ` -${rec.removed}`;
          title.append(add, del);
        }
      }
    } else if (name === 'list_files') {
      title.textContent = `列出 ${path || '.'}`;
    } else if (name === 'docs_search') {
      const q = String(args.query ?? '');
      title.textContent = `检索文档 ${q.length > 40 ? `${q.slice(0, 40)}…` : q}`;
    } else if (name === 'web_fetch') {
      const url = String(args.url ?? '');
      title.textContent = `抓取 ${url.length > 60 ? `${url.slice(0, 60)}…` : url}`;
    } else {
      title.textContent = name;
    }
    return title;
  }

  /** 工具卡片:语义标题 + 格式化参数摘要行 + 状态徽章。执行中图标为旋转 spinner、
   *  徽章带秒数(runAgentTurn 的 1s tick 驱动);终态折叠只折输出,参数行始终可见。 */
  private buildToolCard(callId: string, name: string, argsJson: string, rec?: ToolRecord): HTMLElement {
    const card = document.createElement('div');
    card.className = 'ai-tool-card running';
    card.dataset.callId = callId;
    card.dataset.toolName = name;
    card.dataset.toolKind = AiChatPanel.toolVisual(name).kind;
    // 点击卡片标题在编辑器打开该文件(仅读写工具有 path;相对路径由 main 对工程根解析)
    let filePath = '';
    try {
      const a = JSON.parse(argsJson) as { path?: string };
      if ((name === 'write_file' || name === 'read_file') && typeof a.path === 'string') {
        filePath = a.path;
      }
    } catch {
      // args 解析失败:不可打开,仅可折叠
    }
    const head = document.createElement('div');
    head.className = 'ai-tool-head';
    const chev = document.createElement('i');
    chev.className = 'codicon codicon-chevron-down ai-tool-chev';
    chev.title = '展开/折叠';
    chev.addEventListener('click', (e) => {
      e.stopPropagation();
      card.classList.toggle('collapsed');
    });
    const icon = document.createElement('i');
    // ai-tool-ico 是专属定位类:head 里还有 chevron,裸 .codicon 选择器会误伤它(踩过)
    icon.className = 'codicon codicon-loading ai-spin ai-tool-ico';
    const status = document.createElement('span');
    status.className = 'ai-tool-status';
    status.textContent = '执行中';
    head.append(chev, icon, this.toolTitleEl(name, argsJson, rec), status);
    const argsEl = document.createElement('pre');
    argsEl.className = 'ai-tool-args';
    argsEl.textContent = formatToolArgs(name, argsJson);
    const result = document.createElement('pre');
    result.className = 'ai-tool-result';
    head.addEventListener('click', () => {
      if (filePath) {
        this.deps.openFileInEditor(filePath);
      } else {
        card.classList.toggle('collapsed');
      }
    });
    if (filePath) {
      head.classList.add('openable');
      head.title = '点击在编辑器打开';
    }
    card.append(head, argsEl, result);
    return card;
  }

  /** 工具视觉:按操作类型给图标与配色族(read 阅读/ edit 编辑 / exec 执行 / web 网络)。
   *  图标类名均经 codicon.css 核实;配色在 CSS [data-tool-kind=...] 上。 */
  static toolVisual(name: string): { icon: string; kind: string } {
    if (name === 'read_file' || name === 'list_files') return { icon: 'codicon-eye', kind: 'read' };
    if (name === 'write_file') return { icon: 'codicon-edit', kind: 'edit' };
    if (name === 'run_command') return { icon: 'codicon-terminal', kind: 'exec' };
    if (name === 'docs_search' || name === 'example_search') return { icon: 'codicon-search', kind: 'read' };
    if (name === 'check_code') return { icon: 'codicon-beaker', kind: 'exec' };
    if (name === 'web_fetch' || name === 'web_search' || name === 'web_render') return { icon: 'codicon-globe', kind: 'web' };
    return { icon: 'codicon-tools', kind: 'other' };
  }

  private static readonly TOOL_STATUS_LABEL: Record<ToolCardStatus, string> = {
    'running': '执行中',
    'awaiting-approval': '等待批准',
    'done': '已完成',
    'denied': '被拒绝',
    'failed': '失败',
  };

  private updateToolCard(container: HTMLElement, callId: string, status: ToolCardStatus, detail?: string, elapsedMs?: number): void {
    const card = container.querySelector(`[data-call-id="${callId}"]`) as HTMLElement | null;
    if (!card) return;
    const terminal = status === 'done' || status === 'failed' || status === 'denied';
    if ((status === 'done' || status === 'failed') && elapsedMs !== undefined && !this.toolMsCounted.has(callId)) {
      this.toolMsCounted.add(callId);
      this.usage.toolMs += elapsedMs;
      this.renderStats();
    }
    card.className = `ai-tool-card ${status}${terminal ? ' collapsed' : ''}`;
    const badge = card.querySelector('.ai-tool-status');
    if (badge) {
      const label = AiChatPanel.TOOL_STATUS_LABEL[status];
      badge.textContent = terminal && elapsedMs !== undefined ? `${label} · ${fmtDur(elapsedMs)}` : label;
    }
    // 精确定位类型图标(ai-tool-ico):裸 .codicon 会命中 chevron,曾致 spinner 永不替换
    const icon = card.querySelector('.ai-tool-ico') as HTMLElement | null;
    if (icon) {
      const v = AiChatPanel.toolVisual(card.dataset.toolName ?? '');
      icon.className = terminal ? `codicon ${v.icon} ai-tool-ico` : 'codicon codicon-loading ai-spin ai-tool-ico';
    }
    if (detail) {
      const result = card.querySelector('.ai-tool-result') as HTMLElement;
      result.textContent = detail;
      // 内部滚动容器跟随内容增长(定稿折叠后无影响)
      result.scrollTop = result.scrollHeight;
    }
  }

  /** 连续同类工具分组行:「运行了 N 条指令 · 总 Xs」,点击展开明细。 */
  private buildToolGroup(): { el: HTMLElement; head: HTMLElement; list: HTMLElement } {
    const el = document.createElement('div');
    el.className = 'ai-tool-group';
    const head = document.createElement('div');
    head.className = 'ai-tool-group-head';
    const chev = document.createElement('i');
    chev.className = 'codicon codicon-chevron-right';
    const text = document.createElement('span');
    head.append(chev, text);
    const list = document.createElement('div');
    list.className = 'ai-tool-group-list';
    head.addEventListener('click', () => {
      el.classList.toggle('open');
      chev.className = el.classList.contains('open') ? 'codicon codicon-chevron-down' : 'codicon codicon-chevron-right';
    });
    el.append(head, list);
    return { el, head: text, list };
  }

  private static groupLabel(name: string, count: number): string {
    return name === 'run_command' ? `运行了 ${count} 条指令` : `调用了 ${count} 次 ${name}`;
  }

  private updateGroupHead(head: HTMLElement, name: string, records: ToolRecord[]): void {
    const total = records.reduce((acc, r) => acc + (r.elapsedMs ?? 0), 0);
    head.textContent = `${AiChatPanel.groupLabel(name, records.length)} · 总 ${fmtDur(total)}`;
  }

  /** Agent 模式的完整一轮(调用方保证 msgs 末尾是刚推入的用户消息)。
   *  直播气泡 = 段容器:text/think/tool 段按真实发生顺序就地交错;
   *  每个 step 首个 reasoning 就地开思考段(流式默认展开,step 末自折);
   *  定稿就地收尾(不拆气泡),TurnParts 装配 parts/thinking/content 进 this.msgs。 */
  private async runAgentTurn(): Promise<void> {
    const userText = this.msgs[this.msgs.length - 1]?.content ?? '';
    const turnStart = Date.now();
    aiLog('info', 'aichat', `agent turn 开始(${userText.length} 字符)`);
    let ctl: AgentMode;
    try {
      ctl = await this.ensureAgentCtl();
    } catch (error) {
      aiLog('error', 'aichat', `Agent 内核加载失败: ${error instanceof Error ? error.message : String(error)}`);
      this.addBubble('err', `Agent 内核加载失败: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    // 工程指令(AGENTS.md / XuanTieAI.md)与玄铁文档索引:随系统提示词携带;
    // 引用提示仅在会话首次携带时亮一次——每轮都挂 chip 只是视觉噪音(携带行为本身是会话级的)
    const instrNames = await ctl.loadInstructions().catch(() => [] as string[]);
    const docsCount = ctl.getLoadedDocsCount();
    const firstCarry =
      !this.msgs.some((m) => m.role === 'assistant' && ((m.instrNames?.length ?? 0) > 0 || (m.docsCount ?? 0) > 0));
    this.setBusy(true);

    // 直播气泡:段容器(text/think/tool 交错)+ 底部状态行
    const wrap = document.createElement('div');
    wrap.className = 'ai-wrap';
    const msgEl = document.createElement('div');
    msgEl.className = 'ai-msg bot';
    const segs = document.createElement('div');
    segs.className = 'ai-segs';
    if (firstCarry && instrNames.length > 0) {
      const ref = document.createElement('div');
      ref.className = 'ai-instr-ref';
      const ic = document.createElement('i');
      ic.className = 'codicon codicon-checklist';
      ref.append(ic, document.createTextNode(`已加载工程指令: ${instrNames.join('、')}`));
      ref.title = '该文件已作为系统提示词随本会话发送(修改后新开会话生效)';
      segs.appendChild(ref);
    }
    if (firstCarry && docsCount > 0) {
      const ref = document.createElement('div');
      ref.className = 'ai-instr-ref';
      const ic = document.createElement('i');
      ic.className = 'codicon codicon-book';
      ref.append(ic, document.createTextNode(`已加载玄铁文档索引(${docsCount} 条)`));
      ref.title = '官方文档已下载到本地;AI 会按需用 read_file 阅读对应文档';
      segs.appendChild(ref);
    }
    // 状态行(DSH 式):spinner + 状态文本;turn 结束撤下,footer 回归 Token 计数
    const foot = document.createElement('div');
    foot.className = 'ai-tok';
    const statusEl = document.createElement('span');
    statusEl.className = 'ai-status';
    const spin = document.createElement('i');
    spin.className = 'codicon codicon-loading ai-spin';
    const statusText = document.createElement('span');
    statusEl.append(spin, statusText);
    foot.appendChild(statusEl);
    msgEl.append(segs, foot);
    wrap.appendChild(msgEl);
    this.els.msgs.appendChild(wrap);
    this.scheduleScroll();

    let tokens = 0;
    let gotUsage = false;
    const tp = new TurnParts();
    this.liveParts = tp;
    this.liveSegs = segs;
    const cardTimers = new Map<string, number>();
    // 工具参数流式预卡:正式 tool/call 事件到达前立"准备中"卡,(空窗期可见)
    const pendingCards = new Map<string, { el: HTMLElement; name: string; args: string; titleEl: HTMLElement }>();
    /** 从流式(可能未闭合的)JSON 里宽松提取字符串参数(如 path/command),取不到返回空串。 */
    const peekArg = (json: string, key: string): string => {
      const m = json.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
      if (!m) return '';
      try {
        return JSON.parse(`"${m[1]}"`) as string;
      } catch {
        return m[1];
      }
    };
    let segEl: HTMLElement | undefined;
    let segText = '';
    let thinkSegEl: HTMLElement | undefined;
    let thinkBodyEl: HTMLElement | undefined;
    let thinkSegSince = 0;
    let firstDeltaAt = 0; // 首 token 时刻(含思考增量)

    // 环境自检未完成:状态行先显示校验提示并等其完成(随后结果进环境快照,AI 免自探)
    const pfState = this.deps.getPreflight?.();
    if (pfState?.running) {
      statusText.textContent = '正在校验本地玄铁环境…';
      await pfState.promise;
    }

    // 数据流静默监控:20s 无任何增量 → 状态行追加"(数据流静默 Ns)",与"模型在思考"可辨
    let lastDataAt = Date.now();

    // 活动状态机:任何时刻给出一个明确的「正在工作」状态
    const tracker = new ActivityTracker();
    const updateStatus = (): void => {
      const v = tracker.view(Date.now());
      if (!v) {
        statusEl.remove();
        return;
      }
      statusText.textContent = v.text;
    };
    const ev = (e: Parameters<ActivityTracker['event']>[0]): void => {
      tracker.event(e, Date.now());
      lastDataAt = Date.now(); // 任何活动都重置静默计时
      updateStatus();
    };
    updateStatus();

    // 连续同类工具分组(≥3 收组):runName/runTools 跟踪当前连续段,activeGroup 是已收成的组
    let runName = '';
    let runTools: { record: ToolRecord; card: HTMLElement }[] = [];
    let activeGroup: { head: HTMLElement; list: HTMLElement; records: ToolRecord[] } | undefined;
    const breakRun = (): void => {
      runName = '';
      runTools = [];
      activeGroup = undefined;
    };

    // 1s tick:状态行秒数、流式思考段头部时长、running 工具卡秒数、组行总耗时
    const tick = window.setInterval(() => {
      updateStatus();
      // 静默提示:updateStatus 重写文本后追加(不叠加)——长静默时"正在思考"不再掩盖"流已卡住"
      const gapMs = Date.now() - lastDataAt;
      if (gapMs > 20000 && this.liveParts) {
        statusText.textContent += `(数据流静默 ${Math.round(gapMs / 1000)}s)`;
      }
      if (thinkSegEl && thinkSegSince > 0) {
        const head = thinkSegEl.querySelector('.ai-think-head');
        if (head) head.textContent = `思考中… ${fmtDur(Date.now() - thinkSegSince)}`;
      }
      for (const [callId, start] of cardTimers) {
        if (tp.tool(callId)?.status !== 'running') continue;
        const badge = segs.querySelector(`[data-call-id="${callId}"] .ai-tool-status`);
        if (badge) badge.textContent = `执行中 · ${fmtDur(Date.now() - start)}`;
      }
      if (activeGroup) this.updateGroupHead(activeGroup.head, runName, activeGroup.records);
    }, 1000);

    // 平滑吐字器:正文吐进当前 step 文本段,思考吐进当前思考段;收尾先 flush 再 md 替换
    const textTyper = new SmoothTyper((text) => {
      const el = segEl;
      if (!el) return;
      const span = document.createElement('span');
      span.className = 'ai-flow';
      span.textContent = text;
      el.appendChild(span);
    });
    const thinkTyper = new SmoothTyper((text) => {
      const el = thinkBodyEl;
      if (!el) return;
      const span = document.createElement('span');
      span.className = 'ai-flow';
      span.textContent = text;
      el.appendChild(span);
    });

    const openSeg = (): void => {
      segText = '';
      segEl = document.createElement('div');
      segEl.className = 'md';
      segs.appendChild(segEl);
    };
    // step 文本段收尾:先吐尽缓冲,再一次性 md 渲染(顺序不能反)
    const closeSeg = (): void => {
      if (!segEl) return;
      textTyper.flush();
      if (segText) {
        segEl.innerHTML = this.md(segText);
      } else {
        segEl.remove();
      }
      segEl = undefined;
      segText = '';
    };
    // 思考段:step 内首个 reasoning 就地新开(默认展开);step 末自折成「思考过程 · Xs」
    const openThinkSeg = (): void => {
      thinkSegSince = Date.now();
      const seg = document.createElement('div');
      seg.className = 'ai-think open';
      const head = document.createElement('div');
      head.className = 'ai-think-head';
      head.textContent = '思考中…';
      const body = document.createElement('div');
      body.className = 'ai-think-body';
      seg.append(head, body);
      head.addEventListener('click', () => seg.classList.toggle('open'));
      segs.appendChild(seg);
      thinkSegEl = seg;
      thinkBodyEl = body;
    };
    const closeThinkSeg = (): void => {
      if (!thinkSegEl) return;
      thinkTyper.flush();
      thinkSegEl.classList.remove('open');
      const head = thinkSegEl.querySelector('.ai-think-head');
      if (head) head.textContent = `思考过程 · ${fmtDur(Date.now() - thinkSegSince)}`;
      thinkSegEl = undefined;
      thinkBodyEl = undefined;
    };
    const updateFoot = (): void => {
      if (gotUsage) foot.textContent = `Token: ${tokens}`;
      this.scheduleScroll();
    };

    const ui: AgentTurnUI = {
      onStepStart: () => {
        closeSeg();
        breakRun();
        tp.stepStart();
        openSeg();
      },
      onStepEnd: () => {
        closeSeg();
        closeThinkSeg();
        tp.stepEnd(Date.now());
        this.usage.steps++;
        this.renderStats();
        // 思考段关闭(思考完)即落盘一次
        this.persistLive(this.liveTurnMsg());
      },
      onTextDelta: (d) => {
        if (!firstDeltaAt) firstDeltaAt = Date.now();
        if (!segEl) openSeg();
        segText += d;
        textTyper.push(d);
        tp.text(d);
        ev({ type: 'text' });
        this.scheduleScroll();
      },
      onReasoningDelta: (d) => {
        if (!firstDeltaAt) firstDeltaAt = Date.now();
        if (!thinkSegEl) {
          closeSeg();
          breakRun();
          openThinkSeg();
        }
        thinkTyper.push(d);
        if (thinkBodyEl) thinkBodyEl.scrollTop = thinkBodyEl.scrollHeight;
        tp.reasoning(d, Date.now());
        ev({ type: 'reasoning' });
        this.scheduleScroll();
      },
      onToolCall: (info) => {
        // 预卡退场:正式调用事件(完整参数)已到,换常规卡接力
        const pre = pendingCards.get(info.callId);
        if (pre) {
          pre.el.remove();
          pendingCards.delete(info.callId);
        }
        closeSeg();
        cardTimers.set(info.callId, Date.now());
        tp.toolCall(info, Date.now());
        const record = tp.tool(info.callId) as ToolRecord;
        const card = this.buildToolCard(info.callId, info.name, info.arguments, record);
        // 连续同类 ≥3 收组;组内继续累加
        if (activeGroup && runName === info.name) {
          runTools.push({ record, card });
          activeGroup.records.push(record);
          activeGroup.list.appendChild(card);
          this.updateGroupHead(activeGroup.head, runName, activeGroup.records);
        } else if (runName === info.name) {
          runTools.push({ record, card });
          if (runTools.length >= 3) {
            const group = this.buildToolGroup();
            const first = runTools[0].card;
            first.replaceWith(group.el);
            for (const t of runTools) group.list.appendChild(t.card);
            activeGroup = { head: group.head, list: group.list, records: runTools.map((t) => t.record) };
            this.updateGroupHead(group.head, runName, activeGroup.records);
          } else {
            segs.appendChild(card);
          }
        } else {
          breakRun();
          runName = info.name;
          runTools = [{ record, card }];
          segs.appendChild(card);
        }
        ev({ type: 'tool-call', callId: info.callId, name: info.name, summary: formatToolArgs(info.name, info.arguments) });
        this.scheduleScroll();
      },
      onToolStreamDelta: (callId, name, argsDelta) => {
        // 参数流式生成(write_file 大文件内容可达几十秒):立"准备中"卡,防空窗期无提示。
        // 正式 tool/call 事件到达时按 callId 退场;titleEl 随 path/command 闭合逐步精确。
        const key = callId || `anon-${name}`;
        let pre = pendingCards.get(key);
        if (!pre) {
          const el = document.createElement('div');
          el.className = 'ai-tool-card running';
          const head = document.createElement('div');
          head.className = 'ai-tool-head';
          const ico = document.createElement('i');
          ico.className = 'codicon codicon-loading ai-spin ai-tool-ico';
          const titleEl = document.createElement('span');
          titleEl.className = 'ai-tool-name';
          titleEl.textContent = '正在生成工具参数…';
          const st = document.createElement('span');
          st.className = 'ai-tool-status';
          st.textContent = '准备中…';
          head.append(ico, titleEl, st);
          el.appendChild(head);
          segs.appendChild(el);
          pre = { el, name: name || '', args: '', titleEl };
          pendingCards.set(key, pre);
        }
        if (name) pre.name = name;
        pre.args += argsDelta;
        if (pre.name === 'write_file') {
          const p = peekArg(pre.args, 'path');
          pre.titleEl.textContent = p ? `正在编辑 ${p}…` : '正在生成文件内容…';
        } else if (pre.name === 'run_command') {
          const c = peekArg(pre.args, 'command');
          pre.titleEl.textContent = c ? `正在生成命令 ${c.length > 50 ? `${c.slice(0, 50)}…` : c}` : '正在生成命令…';
        } else if (pre.name) {
          pre.titleEl.textContent = `正在生成 ${pre.name} 参数…`;
        }
        ev({ type: 'tool-call', callId: key, name: pre.name || '工具', summary: '' });
        this.scheduleScroll();
      },
      onToolStatus: (callId, status, detail) => {
        const terminal = status === 'done' || status === 'failed' || status === 'denied';
        if (terminal) {
          cardTimers.delete(callId);
          // 工具执行完毕即落盘一次(实时保存:此前只在整轮结束才保存)
          this.persistLive(this.liveTurnMsg());
        }
        tp.toolStatus(callId, status, detail, Date.now());
        this.updateToolCard(segs, callId, status, detail, tp.tool(callId)?.elapsedMs);
        if (activeGroup) this.updateGroupHead(activeGroup.head, runName, activeGroup.records);
        ev({ type: 'tool-status', callId, status });
        this.scheduleScroll();
      },
      onUsage: (u) => {
        tokens = u.totalTokens ?? u.inputTokens + u.outputTokens;
        gotUsage = true;
        updateFoot();
        this.absorbUsage(u);
      },
    };

    const result = await ctl.send(userText, ui);
    this.setBusy(false);
    const turnEndTs = Date.now();
    if (firstDeltaAt > 0) {
      this.usage.ttftMs += firstDeltaAt - turnStart;
      this.usage.ttftCount++;
      this.usage.genMs += turnEndTs - firstDeltaAt;
    }
    this.usage.turns++;
    this.renderStats();
    aiLog(
      result.ok ? 'info' : 'error',
      'aichat',
      `agent turn 结束(用时 ${fmtDur(Date.now() - turnStart)}): ${result.ok ? 'ok' : (result.error ?? 'unknown')}`,
    );
    closeSeg();
    closeThinkSeg();
    tp.stepEnd(Date.now());
    thinkTyper.dispose();
    textTyper.dispose();
    window.clearInterval(tick);
    ev({ type: 'turn-end' }); // 状态行撤下,footer 回归 Token 计数

    // 就地定稿:footer 收尾;终态卡片与思考段已是折叠态
    const parts = tp.getParts();
    const content = tp.contentText();
    const thinking = tp.thinkingText();
    foot.textContent = gotUsage ? `Token: ${tokens}` : result.ok ? '本轮完成' : '本轮结束';

    if (content || parts.length > 0 || thinking) {
      const msg: ChatMsg = {
        role: 'assistant',
        content,
        ...(thinking ? { thinking } : {}),
        ...(parts.length > 0 ? { parts } : {}),
        ...(firstCarry && instrNames.length > 0 ? { instrNames } : {}),
        ...(firstCarry && docsCount > 0 ? { docsCount } : {}),
      };
      this.msgs.push(msg);
      wrap.dataset.idx = String(this.msgs.length - 1);
      wrap.appendChild(this.buildActionsBar(msg, this.msgs.length - 1));
      this.deps.onConversationChange(this.richMessages());
    } else {
      wrap.remove();
    }
    for (const p of pendingCards.values()) p.el.remove();
    pendingCards.clear();
    this.liveParts = undefined;
    this.liveSegs = undefined;
    if (!result.ok) {
      if (result.error === 'cancelled') this.addBubble('err', '已停止');
      else this.showStreamError(result.error ?? '未知错误', content, 'Agent 出错: ');
    } else if (result.error) {
      this.addBubble('err', result.error);
    }
    this.scheduleScroll();
  }

  /** write_file 的 diff 回调(agent-mode → 本面板):更新 TurnParts 记录与直播卡标题。 */
  private handleWriteDiff = (info: { callId: string; path: string; added: number; removed: number; isNew: boolean }): void => {
    const tp = this.liveParts;
    const segs = this.liveSegs;
    if (!tp || !segs) return;
    tp.writeDiff(info.callId, { added: info.added, removed: info.removed, isNew: info.isNew });
    const record = tp.tool(info.callId);
    if (!record) return;
    const title = segs.querySelector(`[data-call-id="${info.callId}"] .ai-tool-name`);
    if (title) title.replaceWith(this.toolTitleEl(record.name, record.args, record));
  };
}
