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

const KEYWORDS = [
  '设', '常', '函', '型', '造', '口', '承', '覆', '公', '私', '护', '外', '弱', '此',
  '若', '抑', '否', '当', '循', '遍历', '于', '断', '续', '返', '匹配', '尝试', '捕捉',
  '终', '异步', '等待', '并行', '引', '予',
];
const TYPE_WORDS = ['整', '小数', '字', '字符串', '字典', '字节', '数组', '布尔', '结果', '任务'];
const BUILTIN_WORDS = ['示', '输', '求', '连', '听', '执', '化', '解', '道', '选', '收', '发'];
const NS_WORDS = ['时', '文件', '数学'];
const CONST_WORDS = ['真', '假', '空'];
const OP_WORDS = ['且', '或', '非', '是', '位与', '位或', '异或', '左移', '右移', '取反'];

const language: monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.xt',
  tokenizer: {
    root: [
      [/\/\/.*$/, 'comment'],
      [/"""/, { token: 'string.quote', next: '@tdouble' }],
      [/'''/, { token: 'string.quote', next: '@tsingle' }],
      [/"/, { token: 'string.quote', next: '@dquote' }],
      [/'/, { token: 'string.quote', next: '@squote' }],
      [alt(KEYWORDS), 'keyword'],
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
      [/[+\-*/%<>=!&|:;,.?]/, 'operator'],
      [/\s+/, 'white'],
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

const theme: monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6a9955' },
    { token: 'keyword', foreground: 'c586c0' },
    { token: 'type', foreground: '4ec9b0' },
    { token: 'builtin', foreground: 'dcdcaa' },
    { token: 'namespace', foreground: '4fc1ff' },
    { token: 'constant', foreground: '569cd6' },
    { token: 'operator.word', foreground: 'c8c8c8' },
    { token: 'operator', foreground: 'd4d4d4' },
    { token: 'string', foreground: 'ce9178' },
    { token: 'string.quote', foreground: 'ce9178' },
    { token: 'string.escape', foreground: 'd7ba7d' },
    { token: 'string.invalid', foreground: 'f14c4c' },
    { token: 'delimiter.interp', foreground: 'e8b76a' },
    { token: 'number', foreground: 'b5cea8' },
    { token: 'number.float', foreground: 'b5cea8' },
    { token: 'identifier', foreground: 'd4d4d4' },
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
      { token: 'comment', foreground: '5a7d47' },
      { token: 'keyword', foreground: '8a3ab0' },
      { token: 'type', foreground: '0f7b6c' },
      { token: 'builtin', foreground: '795e26' },
      { token: 'namespace', foreground: '0b6fa4' },
      { token: 'constant', foreground: '2653a6' },
      { token: 'string', foreground: 'a31515' },
      { token: 'string.escape', foreground: '8a6d1e' },
      { token: 'number', foreground: '1a7a3c' },
      { token: 'delimiter.interp', foreground: 'c96a10' },
      { token: 'identifier', foreground: '1f1f1f' },
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
