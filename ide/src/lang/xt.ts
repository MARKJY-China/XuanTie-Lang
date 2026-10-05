// 玄铁语言在 Monaco 中的注册:Monarch 语法 + 语言配置 + 主题
// 依据:词法.xt(标识符含任意非 ASCII、可 ? 结尾;// 行注释;单双引号+三引号多行;
//       #{表达式} 插值;无十六进制字面量)与 lsp/xt_lsp.xt 关键字文档表
import * as monaco from 'monaco-editor';

export const XT_LANGUAGE_ID = 'xuantie';

// 标识符后继字符:字母数字下划线 + 任意非 ASCII + 结尾 ?
const TAIL = 'a-zA-Z0-9_\\u0080-\\uFFFF?';

// 关键字规则必须带「后继非标识符」前瞻:否则 位置 会被切成 位+置 误判成 位与 类
function alt(words: string[]): RegExp {
  return new RegExp(words.map((w) => w + '(?![' + TAIL + '])').join('|'));
}

// 关键字分两类(对齐文档站 scope:声明类=storage.type 蓝、控制类=keyword.control 紫)
const DECL_KEYWORDS = ['设', '常', '函', '型', '造', '口', '承', '覆', '公', '私', '护', '外', '弱', '引', '予'];
const CONTROL_KEYWORDS = ['若', '抑', '否', '当', '循', '遍历', '于', '断', '续', '返', '匹配', '尝试', '捕捉', '终', '异步', '等待', '并行', '此'];
const TYPE_WORDS = ['整', '小数', '字', '字符串', '字典', '字节', '数组', '布尔', '结果', '任务'];
const BUILTIN_WORDS = ['示', '输', '求', '连', '听', '执', '化', '解', '道', '选', '收', '发'];
const NS_WORDS = ['时', '文件', '数学'];
const CONST_WORDS = ['真', '假', '空'];
const OP_WORDS = ['且', '或', '非', '是', '位与', '位或', '异或', '左移', '右移', '取反'];

export const language: monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.xt',
  tokenizer: {
    root: [
      [/\/\/.*$/, 'comment'],
      [/"""/, { token: 'string.quote', next: '@tdouble' }],
      [/'''/, { token: 'string.quote', next: '@tsingle' }],
      [/"/, { token: 'string.quote', next: '@dquote' }],
      [/'/, { token: 'string.quote', next: '@squote' }],
      [alt(DECL_KEYWORDS), 'storage.type'],
      [alt(CONTROL_KEYWORDS), 'keyword'],
      [alt(TYPE_WORDS), 'type'],
      [alt(BUILTIN_WORDS), 'builtin'],
      [alt(NS_WORDS), 'namespace'],
      [alt(CONST_WORDS), 'constant'],
      [alt(OP_WORDS), 'operator.word'],
      [/\d+\.\d+/, 'number.float'],
      [/\d+/, 'number'],
      [/[a-zA-Z_\u0080-\uFFFF][a-zA-Z0-9_\u0080-\uFFFF]*\??/, 'identifier'],
      [/[{}[\]()]/, '@brackets'],
      [/->/, 'operator'],
      // 点后成员(联.成功 / 流.写):独立 token 上色,与文档站 entity 色一致
      [/\./, { token: 'delimiter', next: '@afterDot' }],
      [/[+\-*/%<>=!&|:;,.?]/, 'operator'],
      [/\s+/, 'white'],
    ],
    afterDot: [
      [/[a-zA-Z_\u0080-\uFFFF][a-zA-Z0-9_\u0080-\uFFFF]*\??/, { token: 'member', next: '@pop' }],
      [/[\s\S]/, { token: '', next: '@pop' }],
    ],
    dquote: [
      [/[^\\#"\n]+/, 'string'],
      [/\\[\\'"nrt${}]/, 'string.escape'],
      [/\\./, 'string.invalid'],
      [/#\{/, { token: 'delimiter.interp', next: '@interp' }],
      [/"/, { token: 'string.quote', next: '@pop' }],
      [/\n/, { token: 'string', next: '@pop' }],
    ],
    squote: [
      [/[^\\#'\n]+/, 'string'],
      [/\\[\\'"nrt${}]/, 'string.escape'],
      [/\\./, 'string.invalid'],
      [/#\{/, { token: 'delimiter.interp', next: '@interp' }],
      [/'/, { token: 'string.quote', next: '@pop' }],
      [/\n/, { token: 'string', next: '@pop' }],
    ],
    tdouble: [
      [/[^#"]+/, 'string'],
      [/"""/, { token: 'string.quote', next: '@pop' }],
      [/#\{/, { token: 'delimiter.interp', next: '@interp' }],
      [/#/, 'string'],
      [/"/, 'string'],
    ],
    tsingle: [
      [/[^#']+/, 'string'],
      [/'''/, { token: 'string.quote', next: '@pop' }],
      [/#\{/, { token: 'delimiter.interp', next: '@interp' }],
      [/#/, 'string'],
      [/'/, 'string'],
    ],
    interp: [
      [/\{/, { token: 'delimiter.bracket', next: '@push' }],
      [/\}/, { token: 'delimiter.interp', next: '@pop' }],
      [/#\{/, { token: 'delimiter.interp', next: '@push' }],
      [/"/, { token: 'string.quote', next: '@dquote' }],
      [/'/, { token: 'string.quote', next: '@squote' }],
      [/[^{}'"#]+/, ''],
      [/./, ''],
    ],
  },
};

const config: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '//' },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string'] },
    { open: "'", close: "'", notIn: ['string'] },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  wordPattern: /[a-zA-Z0-9_\u0080-\uFFFF]+/,
};

// 配色对齐文档站(取 site/.vitepress/config.mts 的 xuantieDark 补丁 + vitesse 原生色,
// 已从构建产物 guide/*.html 的 --shiki-dark 内联样式实测核对):
//   声明关键字/类型/常量 #569CD6 · 控制关键字 #C586C0 · 内建(示/连/时/文件/数学) #B8A965
//   标识符 #BD976A · 点后成员 #80A665 · 字符串 #98C379 · 数字 #4C9A91 · 注释 #758575
//   插值标点 #666666 · 运算符/正文 #D4D4D4
const theme: monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '758575' },
    { token: 'storage.type', foreground: '569cd6' },
    { token: 'keyword', foreground: 'c586c0' },
    { token: 'type', foreground: '569cd6' },
    { token: 'builtin', foreground: 'b8a965' },
    { token: 'namespace', foreground: 'b8a965' },
    { token: 'constant', foreground: '569cd6' },
    { token: 'operator.word', foreground: 'd4d4d4' },
    { token: 'operator', foreground: 'd4d4d4' },
    { token: 'member', foreground: '80a665' },
    { token: 'string', foreground: '98c379' },
    { token: 'string.quote', foreground: '98c379' },
    { token: 'string.escape', foreground: 'd7ba7d' },
    { token: 'string.invalid', foreground: 'f14c4c' },
    { token: 'delimiter.interp', foreground: '666666' },
    { token: 'number', foreground: '4c9a91' },
    { token: 'number.float', foreground: '4c9a91' },
    { token: 'identifier', foreground: 'bd976a' },
  ],
  colors: {
    'editor.background': '#1e1e1e',
    'editorLineNumber.foreground': '#6e7681',
    'editorLineNumber.activeForeground': '#e8b76a',
    'editor.selectionBackground': '#264f78',
    'editorCursor.foreground': '#e8842c',
  },
};

export function registerXtLanguage(): void {
  monaco.languages.register({
    id: XT_LANGUAGE_ID,
    extensions: ['.xt'],
    aliases: ['XuanTie', '玄铁'],
  });
  monaco.languages.setMonarchTokensProvider(XT_LANGUAGE_ID, language);
  monaco.languages.setLanguageConfiguration(XT_LANGUAGE_ID, config);
  monaco.editor.defineTheme('xuantie-dark', theme);
  monaco.editor.defineTheme('xuantie-light', {
    base: 'vs',
    inherit: true,
    rules: [
      // 与暗色同构的 scope 划分,取文档站 xuantieLight 配色(关键字 #AF00DB/类型 #0000FF/
      // 字符串 #22863A/变量 #B07D48/运算符 #393A34/插值标点 #999999)
      { token: 'comment', foreground: '6e7781' },
      { token: 'storage.type', foreground: '0000ff' },
      { token: 'keyword', foreground: 'af00db' },
      { token: 'type', foreground: '0000ff' },
      { token: 'builtin', foreground: '795e26' },
      { token: 'namespace', foreground: '795e26' },
      { token: 'constant', foreground: '0000ff' },
      { token: 'member', foreground: '267f99' },
      { token: 'string', foreground: '22863a' },
      { token: 'string.quote', foreground: '22863a' },
      { token: 'string.escape', foreground: '8a6d1e' },
      { token: 'number', foreground: '098658' },
      { token: 'number.float', foreground: '098658' },
      { token: 'delimiter.interp', foreground: '999999' },
      { token: 'identifier', foreground: 'b07d48' },
      { token: 'operator.word', foreground: '393a34' },
      { token: 'operator', foreground: '393a34' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editorLineNumber.foreground': '#9a9a9a',
      'editorLineNumber.activeForeground': '#c96a10',
      'editor.selectionBackground': '#b3d7f2',
      'editorCursor.foreground': '#c96a10',
    },
  });
}
