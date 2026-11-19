// 铸造厂可视化 UI 设计器 —— 切片 1 自检(纯函数:解析/生成/区段读写)
// 运行: npm run test:designer   (esbuild 打包 + node 执行;无新增依赖)
// 判定: 往返幂等 / 生成确定性(规范序、无尾随逗号) / 区外零改动(含 CRLF 保持) / 非子集→只读
import { parseDesignFunction, type DesignNode } from './parser';
import { generateDesignFunction, strVal, CANONICAL_KEYS } from './generator';
import { findRegions, replaceRegion, appendRegion, regionText } from './region';
import { layoutTree, type Measure } from './layout';
import {
  applyMove,
  applyResize,
  cloneSubtree,
  defaultWidget,
  findParent,
  findPath,
  insertNode,
  levelOp,
  lockedAxes,
  moveMode,
  nodeAtPath,
  numOpt,
  removeNode,
  removeOpt,
  setInsets,
  snapMove,
  snapResize,
  MIN_SIZE,
} from './edit';
import { COLOR_PALETTE, TOOLBOX, WIDGET_KEYS, specOf } from './props';
import { WIDGETS } from './spec';
import { ICON_CATALOG, findIcon } from './iconCatalog';
import { iconEntryByName } from './paint';
import {
  appendEntry,
  buildRenderEntry,
  collectStateKeys,
  ensureUiImport,
  hasRenderEntry,
  uiAliasOf,
} from './runentry';

/** 与 lib/UI/UI.xt:99-110 的 色彩 键逐字一致(改库色板必须同步改这里与 props.ts) */
const PALETTE_CHECK = ['白', '黑', '红', '绿', '蓝', '黄', '灰', '深灰', '浅灰', '透明', '主题', '强调'];

declare const process: { exitCode?: number };

let pass = 0;
let fail = 0;
function t(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log('  [通过] ' + name);
  } catch (e) {
    fail++;
    console.error('  [失败] ' + name + '\n         ' + (e as Error).message);
  }
}
function eq<T>(actual: T, expected: T, what: string): void {
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const b = typeof expected === 'string' ? expected : JSON.stringify(expected);
  if (a !== b) throw new Error(what + '\n         实际: ' + JSON.stringify(a) + '\n         期望: ' + JSON.stringify(b));
}
function ok(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

// ------- 样例 A:探针验证过的结构(选项故意乱序,校验规范序重排) -------
const SAMPLE_A = [
  '// ===== 铸造厂·设计区 开始:主界面 =====',
  '// (本区由设计器维护;手工改动仅限属性值;非子集写法将导致本区只读)',
  '函 主界面(s) {',
  '    设 左栏 = UI.列([',
  '        UI.文本(UI.态取(s, "标题"), {"字号": 24, "字色": UI.色彩["主题"]}),',
  '        UI.按钮("开始", {"点击": 开始点击, "宽": 120, "高": 40})',
  '    ], {"弹性": 1})',
  '    设 画布 = UI.绝对([',
  '        UI.矩形({"x": 40, "y": 24, "宽": 200, "高": 80, "底色": UI.色彩["强调"]})',
  '    ], {"宽": 800, "高": 560})',
  '    设 根 = UI.行([左栏, 画布], {"宽": 800, "高": 560})',
  '    返 根',
  '}',
  '// ===== 铸造厂·设计区 结束:主界面 =====',
  '',
].join('\n');

const EXPECT_A = [
  '// ===== 铸造厂·设计区 开始:主界面 =====',
  '// (本区由设计器维护;手工改动仅限属性值;非子集写法将导致本区只读)',
  '函 主界面(s) {',
  '    设 左栏 = UI.列([',
  '        UI.文本(UI.态取(s, "标题"), {"字色": UI.色彩["主题"], "字号": 24}),',
  '        UI.按钮("开始", {"宽": 120, "高": 40, "点击": 开始点击})',
  '    ], {"弹性": 1})',
  '    设 画布 = UI.绝对([',
  '        UI.矩形({"x": 40, "y": 24, "宽": 200, "高": 80, "底色": UI.色彩["强调"]})',
  '    ], {"宽": 800, "高": 560})',
  '    设 根 = UI.行([',
  '        左栏,',
  '        画布',
  '    ], {"宽": 800, "高": 560})',
  '    返 根',
  '}',
  '// ===== 铸造厂·设计区 结束:主界面 =====',
  '',
].join('\n');

/** 解析用样例(与 SAMPLE_A 相同;名字保留以区分"解析输入/生成期望"两种角色) */
const CLEAN_A = SAMPLE_A;

// ------- 样例 B:全 15 控件覆盖 -------
const SAMPLE_B = [
  '函 全控件(s) {',
  '    设 绝对区 = UI.绝对([',
  '        UI.矩形({"x": 0, "y": 0, "宽": 10, "高": 10}),',
  '        UI.图片("logo.png", {}),',
  '        UI.图标按钮("i.png", {}),',
  '        UI.图标("搜索", {"图标尺寸": 24})',
  '    ], {})',
  '    设 叠层 = UI.叠([',
  '        绝对区,',
  '        UI.空白({}),',
  '        UI.弹性(2, {}),',
  '        UI.输入栏(s, "名字", {}),',
  '        UI.多行编辑(s, "正文", {})',
  '    ], {})',
  '    设 横排 = UI.行([',
  '        UI.文本("标题", {"字号": 20}),',
  '        UI.按钮("确定", {"点击": 确定点击})',
  '    ], {})',
  '    设 滚动区 = UI.滚动容器([',
  '        横排',
  '    ], {"高": 200})',
  '    设 根 = UI.列([',
  '        叠层,',
  '        滚动区',
  '    ], {"宽": 800, "高": 560})',
  '    返 根',
  '}',
  '',
].join('\n');

console.log('== 设计器切片1自检 ==');

// ---- 解析与生成 ----
t('样例A 解析通过且无 issue', () => {
  const r = parseDesignFunction(CLEAN_A);
  eq(r.ok, true, 'ok 应为 true');
  eq(r.issues.length, 0, '不应有 issue');
  eq(r.funcName, '主界面', '函数名');
  eq(r.stateParam, 's', '状态参数名');
});

t('样例A 生成逐字节等于规范序期望', () => {
  const r = parseDesignFunction(CLEAN_A);
  const gen = generateDesignFunction(r.funcName!, r.stateParam!, r.root!);
  eq(gen, EXPECT_A, '生成文本(键按规范序、无尾随逗号、行式)');
});

t('样例A 往返幂等(二次生成逐字节一致)', () => {
  const g1 = (() => { const r = parseDesignFunction(CLEAN_A); return generateDesignFunction(r.funcName!, r.stateParam!, r.root!); })();
  const r2 = parseDesignFunction(g1);
  eq(r2.ok, true, '再解析应通过;issues=' + JSON.stringify(r2.issues));
  const g2 = generateDesignFunction(r2.funcName!, r2.stateParam!, r2.root!);
  eq(g2, g1, '二次生成应与首次逐字节一致');
});

t('生成文本不含尾随逗号', () => {
  const g1 = (() => { const r = parseDesignFunction(CLEAN_A); return generateDesignFunction(r.funcName!, r.stateParam!, r.root!); })();
  ok(!/,\s*[\]}]/.test(g1), '不得出现 ,] 或 ,} 形式');
});

t('样例B(全15控件) 解析通过+覆盖齐15个构造器', () => {
  const r = parseDesignFunction(SAMPLE_B);
  eq(r.ok, true, 'ok 应为 true;issues=' + JSON.stringify(r.issues));
  const seen = new Set<string>();
  const walk = (n: { widget: string; children: { widget: string; children: unknown[] }[] }): void => {
    seen.add(n.widget);
    for (const c of n.children as never[]) walk(c);
  };
  walk(r.root as never);
  eq(seen.size, 15, '控件种类数(实际: ' + [...seen].join(',') + ')');
});

t('样例B 往返幂等', () => {
  const r1 = parseDesignFunction(SAMPLE_B);
  const g1 = generateDesignFunction(r1.funcName!, r1.stateParam!, r1.root!);
  const r2 = parseDesignFunction(g1);
  const g2 = generateDesignFunction(r2.funcName!, r2.stateParam!, r2.root!);
  eq(g2, g1, '二次生成一致');
});

// ---- 非子集 → 只读(ok=false + 可读原因) ----
const BAD: Array<[string, string, string]> = [
  ['函数内非声明语句(若)', '函 f(s) {\n    设 a = UI.行([], {})\n    若 真 { }\n    返 a\n}', '返'],
  ['未知控件', '函 f(s) {\n    设 a = UI.滑块({})\n    返 a\n}', '未知控件'],
  ['children 内联容器', '函 f(s) {\n    设 a = UI.行([UI.列([], {})], {})\n    返 a\n}', '内联容器'],
  ['尾随逗号', '函 f(s) {\n    设 a = UI.行([\n        UI.文本("x", {}),\n    ], {})\n    返 a\n}', 'children'],
  ['叶子控件被 设 命名', '函 f(s) {\n    设 t = UI.文本("x", {})\n    返 t\n}', '叶子'],
  ['变量名重复', '函 f(s) {\n    设 a = UI.行([], {})\n    设 a = UI.列([], {})\n    返 a\n}', '重复'],
  ['引用未定义容器', '函 f(s) {\n    设 a = UI.行([b], {})\n    返 a\n}', '未定义'],
  ['死代码容器', '函 f(s) {\n    设 a = UI.行([], {})\n    设 b = UI.行([], {})\n    返 a\n}', '未被引用'],
  ['表达式值(子集外字符)', '函 f(s) {\n    设 a = UI.行([], {"x": 40 + 40})\n    返 a\n}', '子集外'],
  ['缺 返', '函 f(s) {\n    设 a = UI.行([], {})\n}', '返'],
  ['引用成环', '函 f(s) {\n    设 a = UI.行([b], {})\n    设 b = UI.列([a], {})\n    返 a\n}', '成环'],
];
for (const [name, src, needle] of BAD) {
  t('非子集只读: ' + name, () => {
    const r = parseDesignFunction(src);
    eq(r.ok, false, 'ok 应为 false(设计器随后只读)');
    const joined = r.issues.map(i => i.message).join(' | ');
    ok(joined.includes(needle), '原因应包含「' + needle + '」;实际: ' + joined);
  });
}

// ---- 区段读写:区外零改动 + 行尾保持 ----
const REGION_LF = (() => { const r = parseDesignFunction(CLEAN_A); return generateDesignFunction(r.funcName!, r.stateParam!, r.root!); })();
const crlfOf = (s: string): string => s.replace(/\n/g, '\r\n');

t('CRLF 文件原样回写:整文件逐字节不变', () => {
  const file = '// 头\r\n设 x = 1\r\n\r\n' + crlfOf(REGION_LF) + '\r\n// 尾\r\n';
  const refs = findRegions(file);
  eq(refs.length, 1, '找到一个设计区');
  eq(refs[0].name, '主界面', '区名');
  const said = replaceRegion(file, refs[0], REGION_LF);
  eq(said, file, '原样回写必须逐字节不变');
});

t('修改后:区外逐字节不变、行尾仍 CRLF', () => {
  const file = '// 头\r\n设 x = 1\r\n\r\n' + crlfOf(REGION_LF) + '\r\n// 尾\r\n';
  const refs = findRegions(file);
  const r = parseDesignFunction(CLEAN_A);
  // 改一棵树:给左栏再加一个叶子
  const root = r.root!;
  root.children.push({ widget: '文本', kind: 'leaf', args: [{ t: 'str', raw: '"新"', v: '新' }], options: [], children: [], line: 0, endLine: 0 });
  const gen2 = generateDesignFunction(r.funcName!, r.stateParam!, root);
  const out = replaceRegion(file, refs[0], gen2);
  ok(out.startsWith('// 头\r\n设 x = 1\r\n\r\n'), '区前逐字节不变');
  ok(out.endsWith('\r\n// 尾\r\n'), '区后逐字节不变');
  ok(out.includes('\r\n        UI.文本("新", {})'), '新叶子在区内且为 CRLF');
  ok(out.split('\n').slice(0, -1).every(l => l.endsWith('\r')), '除文件末换行外,每行都应以 CRLF 结束');
});

t('两段设计区:都能定位;regionText 取出原文', () => {
  const f = REGION_LF + '\n' + REGION_LF.replace(/主界面/g, '设置界面');
  const refs = findRegions(f);
  eq(refs.length, 2, '两段都找到');
  eq(refs[0].name + ',' + refs[1].name, '主界面,设置界面', '区名顺序');
  ok(regionText(f, refs[1]).includes('函 设置界面(s)'), 'regionText 含构建函');
});

t('未闭合的开始标记被忽略(不可安全改写)', () => {
  const f = '// ===== 铸造厂·设计区 开始:半截 =====\n函 半截(s) {\n';
  eq(findRegions(f).length, 0, '不产出区间');
});

t('appendRegion:空行分隔、行尾随文件风格、可被定位', () => {
  const f1 = appendRegion('设 a = 1\n', REGION_LF);
  ok(f1.startsWith('设 a = 1\n\n'), 'LF 文件:空行分隔');
  eq(findRegions(f1).length, 1, '追加后可定位');
  const f2 = appendRegion('设 a = 1\r\n', REGION_LF);
  ok(f2.startsWith('设 a = 1\r\n\r\n'), 'CRLF 文件:空行分隔用 CRLF');
  ok(f2.includes('// ===== 铸造厂·设计区 开始:主界面 =====\r\n'), '追加内容为 CRLF');
});

// ---- 子字典(锚/偏/内边距/三态覆写) ----
t('子字典:解析/规范序/往返幂等', () => {
  const src = [
    '函 界面(s) {',
    '    设 根 = UI.绝对([',
    '        UI.按钮("确定", {"锚": {"右": 0.5, "左": 0.5}, "偏": {"左": 8}, "内边距": {"上": 4, "下": 4}, "悬浮": {"底色": UI.色彩["主题"]}})',
    '    ], {"宽": 400, "高": 300})',
    '    返 根',
    '}',
    '',
  ].join('\n');
  const r = parseDesignFunction(src);
  eq(r.ok, true, 'ok 应为 true;issues=' + JSON.stringify(r.issues));
  const g1 = generateDesignFunction(r.funcName!, r.stateParam!, r.root!);
  ok(g1.includes('"锚": {"左": 0.5, "右": 0.5}'), '锚键按规范序(左在右前);实际:' + g1);
  ok(g1.includes('"偏": {"左": 8}'), '偏子字典');
  ok(g1.includes('"内边距": {"上": 4, "下": 4}'), '内边距按 上/下 规范序');
  ok(g1.includes('"悬浮": {"底色": UI.色彩["主题"]}'), '三态覆写子字典');
  const r2 = parseDesignFunction(g1);
  eq(r2.ok, true, '再解析应通过;issues=' + JSON.stringify(r2.issues));
  eq(generateDesignFunction(r2.funcName!, r2.stateParam!, r2.root!), g1, '往返幂等');
});

t('非子集只读: 子字典值含非字面量', () => {
  const src = '函 f(s) {\n    设 a = UI.行([], {"锚": {"左": UI.态取(s, "k")}})\n    返 a\n}';
  const r = parseDesignFunction(src);
  eq(r.ok, false, 'ok 应为 false');
  ok(r.issues.map(i => i.message).join(' | ').includes('子字典'), '原因应指向子字典');
});

// ---- 布局引擎(只读画布的核心;measure 用确定性的桩) ----
const MEASURE: Measure = (text, fontSize) => ({ w: text.length * fontSize * 0.6, h: fontSize * 1.25 });

t('布局:根尺寸取 宽/高;绝对容器按 x/y 直摆', () => {
  const src = [
    '函 界面(s) {',
    '    设 根 = UI.绝对([',
    '        UI.矩形({"x": 40, "y": 24, "宽": 200, "高": 80})',
    '    ], {"宽": 400, "高": 300})',
    '    返 根',
    '}',
    '',
  ].join('\n');
  const r = parseDesignFunction(src);
  const laid = layoutTree(r.root!, MEASURE);
  eq(laid.frameW, 400, '设计宽取根 宽');
  eq(laid.frameH, 300, '设计高取根 高');
  const rect = laid.boxes.find(b => b.node.widget === '矩形')!;
  eq([rect.x, rect.y, rect.w, rect.h], [40, 24, 200, 80], '矩形位置尺寸');
});

t('布局:行容器 间距 + 弹性 分配余量', () => {
  const src = [
    '函 界面(s) {',
    '    设 根 = UI.行([',
    '        UI.矩形({"宽": 100, "高": 40}),',
    '        UI.弹性(1, {}),',
    '        UI.矩形({"宽": 60, "高": 40})',
    '    ], {"宽": 400, "高": 100, "间距": 10})',
    '    返 根',
    '}',
    '',
  ].join('\n');
  const r = parseDesignFunction(src);
  const laid = layoutTree(r.root!, MEASURE);
  const rects = laid.boxes.filter(b => b.node.widget === '矩形');
  // 基准 100+0+60 + 间距 10×2 = 180;余量 220 全给弹性 → 弹性格位 220
  eq(rects[0].x, 0, '首块起点');
  const flexBox = laid.boxes.find(b => b.node.widget === '弹性')!;
  eq([flexBox.x, flexBox.w], [110, 220], '弹性格位 = 起点 110、宽 220');
  eq(rects[1].x, 340, '尾块 = 110+220+间距 10');
  eq(rects[1].w, 60, '尾块宽');
});

t('布局:叠容器默认吃满内容槽;锚双锚拉伸', () => {
  const src = [
    '函 界面(s) {',
    '    设 根 = UI.叠([',
    '        UI.矩形({}),',
    '        UI.矩形({"锚": {"左": 0.0, "右": 0.5}, "高": 20})',
    '    ], {"宽": 400, "高": 200})',
    '    返 根',
    '}',
    '',
  ].join('\n');
  const r = parseDesignFunction(src);
  const rects = layoutTree(r.root!, MEASURE).boxes.filter(b => b.node.widget === '矩形');
  eq([rects[0].x, rects[0].y, rects[0].w, rects[0].h], [0, 0, 400, 200], '无尺寸子项吃满内容槽');
  eq([rects[1].x, rects[1].w], [0, 200], '双锚拉伸 = 槽宽×0.5');
});

t('布局:平移叠加 / 可视=假淡显 / 滚动容器裁剪区', () => {
  const src = [
    '函 界面(s) {',
    '    设 根 = UI.绝对([',
    '        UI.矩形({"x": 10, "y": 10, "宽": 50, "高": 50, "平移x": 5, "平移y": -3}),',
    '        UI.矩形({"x": 0, "y": 0, "宽": 10, "高": 10, "可视": 假})',
    '    ], {"宽": 400, "高": 300})',
    '    设 滚 = UI.滚动容器([',
    '        UI.矩形({"宽": 50, "高": 400})',
    '    ], {"宽": 100, "高": 60})',
    '    设 根2 = UI.行([根, 滚], {})',
    '    返 根2',
    '}',
    '',
  ].join('\n');
  const r = parseDesignFunction(src);
  eq(r.ok, true, '样例解析应通过;issues=' + JSON.stringify(r.issues));
  const laid = layoutTree(r.root!, MEASURE);
  const 现场 = ' 盒子=' + laid.boxes.map(b => `${b.node.widget}(${b.x},${b.y},${b.w},${b.h})`).join(' ');
  const rects = laid.boxes.filter(b => b.node.widget === '矩形');
  ok(rects.length >= 3, '应有 3 个矩形盒(含滚动容器内)' + 现场);
  eq([rects[0].x, rects[0].y], [15, 7], '平移x/y 叠加' + 现场);
  eq(rects[1].dim, true, '可视=假 → 淡显标记' + 现场);
  const scrolled = rects[2];
  ok(!!scrolled.clip, '滚动容器内子项带裁剪区' + 现场);
  eq([scrolled.clip!.w, scrolled.clip!.h], [100, 60], '裁剪区 = 视口尺寸' + 现场);
});

// ---------------- 切片 3:编辑内核 ----------------

/** 解析 → 取根(编辑类用例的起点) */
function rootOf(src: string): DesignNode {
  const r = parseDesignFunction(src);
  ok(r.ok, '样例解析应通过;issues=' + JSON.stringify(r.issues));
  return r.root!;
}

/** 改树 → 重发整区 → 重解析(复刻面板写回闭环);返回新树 */
function roundTrip(root: DesignNode): { root: DesignNode; text: string } {
  const text = generateDesignFunction('界面', 's', root);
  const r = parseDesignFunction(text);
  ok(r.ok, '生成文本应可被解析;issues=' + JSON.stringify(r.issues));
  return { root: r.root!, text };
}

// 子集约束:容器必须 设 成变量,children 里只许 叶子调用 | 已设容器名(故 行 先写、绝对 后写)
const EDIT_SAMPLE = [
  '函 界面(s) {',
  '    设 条 = UI.行([UI.文本("甲", {}), UI.文本("乙", {})], {"宽": 300, "高": 40})',
  '    设 根 = UI.绝对([',
  '        UI.矩形({"x": 40, "y": 24, "宽": 200, "高": 80, "平移x": 5}),',
  '        UI.矩形({"x": 100, "y": 100, "宽": 50, "高": 50}),',
  '        UI.矩形({"宽": 60, "高": 30, "锚": {"左": 0.5}, "偏": {"左": -30}}),',
  '        条',
  '    ], {"宽": 800, "高": 560})',
  '    返 根',
  '}',
  '',
].join('\n');

t('编辑:移动模式判定(绝对子项=x/y,锚定/流式=平移,根=不可动)', () => {
  const root = rootOf(EDIT_SAMPLE); // 根即 绝对 容器
  const anchored = root.children[2];
  const row = root.children[3];
  eq(moveMode(root.children[0], root), 'xy', '绝对容器的非锚定子项 → 写 x/y');
  eq(moveMode(anchored, root), 'offset', '带锚的节点 → 写 平移(x/y 会被忽略)');
  eq(moveMode(row.children[0], row), 'offset', '行容器子项 → 写 平移(不改兄弟排布)');
  eq(moveMode(root, null), 'none', '根无父 → 不可移动');
});

t('编辑:applyMove 增量语义(delta=0 不留噪声键)', () => {
  const root = rootOf(EDIT_SAMPLE);
  const r0 = root.children[0];
  ok(applyMove(r0, 'xy', 20, -5), '移动应有写入');
  eq(numOpt(r0, 'x'), 60, 'x = 原值 + 20');
  eq(numOpt(r0, 'y'), 19, 'y = 原值 - 5');
  eq(numOpt(r0, '平移x'), 5, '原有 平移x 不受 x/y 写入影响');
  const anchored = root.children[2];
  ok(applyMove(anchored, 'offset', 10, 0), '锚定节点移动写 平移x');
  eq(numOpt(anchored, '平移y'), undefined, '未动的轴不产生 "平移y": 0 噪声');
  eq(applyMove(root, 'none', 10, 10), false, '根不可移动');
});

t('编辑:移动后布局盒位移恰等于增量(编辑内核 ⇄ 布局引擎闭环)', () => {
  const cases: Array<[number[], number, number, string]> = [
    [[0], 20, -5, '绝对子项写 x/y'],
    [[2], 10, 4, '锚定节点写 平移'],
    [[3, 1], -12, 7, '行容器子项写 平移'],
  ];
  for (const [path, dx, dy, label] of cases) {
    const root = rootOf(EDIT_SAMPLE);
    const node = nodeAtPath(root, path)!;
    if (!node) throw new Error('路径无效: ' + path.join('.'));
    const b0 = layoutTree(root, MEASURE).boxes.find((v) => v.node === node)!;
    const ox = b0.x;
    const oy = b0.y;
    const mode = moveMode(node, findParent(root, node));
    ok(applyMove(node, mode, dx, dy), label + ':写回应成功');
    const rt = roundTrip(root);
    const node2 = nodeAtPath(rt.root, path)!;
    const b1 = layoutTree(rt.root, MEASURE).boxes.find((v) => v.node === node2)!;
    eq([b1.x - ox, b1.y - oy], [dx, dy], label + ':盒位移应等于拖拽增量');
  }
});

t('编辑:缩放写 宽/高,左/上手柄同步移动原点,下限截断,锁定轴忽略', () => {
  const root = rootOf(EDIT_SAMPLE);
  const boxOf = (n: DesignNode): { x: number; y: number; w: number; h: number } => {
    const b = layoutTree(root, MEASURE).boxes.find((v) => v.node === n)!;
    return { x: b.x, y: b.y, w: b.w, h: b.h };
  };
  const r0 = root.children[0];
  ok(applyResize(r0, 'xy', boxOf(r0), 'se', 30, 10, { x: false, y: false }), 'se 应写入');
  eq([numOpt(r0, '宽'), numOpt(r0, '高')], [230, 90], '宽/高 各加增量');
  eq([numOpt(r0, 'x'), numOpt(r0, 'y')], [40, 24], 'se 不动原点');
  const r1 = root.children[1];
  ok(applyResize(r1, 'xy', boxOf(r1), 'w', 20, 0, { x: false, y: false }), 'w 应写入');
  eq(numOpt(r1, '宽'), 30, 'w:宽 - 20');
  eq(numOpt(r1, 'x'), 120, 'w:左边缘跟手(x + 20)');
  ok(applyResize(r1, 'xy', boxOf(r1), 'e', -1000, 0, { x: false, y: false }), '触底仍写入');
  eq(numOpt(r1, '宽'), MIN_SIZE, '宽 截断到尺寸下限');
  eq(applyResize(r0, 'xy', boxOf(r0), 'e', 10, 0, { x: true, y: false }), false, '锁定轴整体忽略');
});

t('编辑:锁定轴判定(双锚轴与弹性主轴)', () => {
  const srcA = [
    '函 界面(s) {',
    '    设 根 = UI.绝对([',
    '        UI.矩形({"宽": 100, "高": 50, "锚": {"左": 0, "右": 1}}),',
    '        UI.矩形({"宽": 40, "高": 40, "锚": {"上": 0.5}})',
    '    ], {"宽": 800, "高": 560})',
    '    返 根',
    '}',
    '',
  ].join('\n');
  const rootA = rootOf(srcA); // 根即 绝对 容器
  eq(lockedAxes(rootA.children[0], rootA), { x: true, y: false }, '双锚(左+右)→ 水平尺寸锁定');
  eq(lockedAxes(rootA.children[1], rootA), { x: false, y: false }, '单锚不锁尺寸');
  const srcB = [
    '函 界面(s) {',
    '    设 根 = UI.行([',
    '        UI.文本("甲", {}),',
    '        UI.矩形({"宽": 40, "高": 40, "弹性": 1})',
    '    ], {"宽": 300, "高": 40})',
    '    返 根',
    '}',
    '',
  ].join('\n');
  const rootB = rootOf(srcB); // 根即 行 容器
  eq(lockedAxes(rootB.children[0], rootB), { x: false, y: false }, '无弹性:行主轴可手调');
  eq(lockedAxes(rootB.children[1], rootB), { x: true, y: false }, '有弹性份额:行主轴锁定');
});

t('编辑:吸附(对位取最近一条,阈值外不动,给出参考线)', () => {
  const box = { x: 100, y: 100, w: 50, h: 50 };
  const target = { x: 198, y: 300, w: 60, h: 20 }; // x 线:198 / 228 / 258
  const s = snapMove(box, [target], 100, 0, 6); // 落点左边缘 200,距 198 差 2
  eq(s.dx, 98, '左边缘吸附到参考左边缘');
  eq(s.dy, 0, '垂直方向无对位');
  ok(s.guides.length === 1 && s.guides[0].axis === 'x' && s.guides[0].pos === 198, '给出竖向参考线(pos=198)');
  const s2 = snapMove(box, [target], 0, 0, 6);
  eq([s2.dx, s2.dy], [0, 0], '阈值外不动');
  eq(s2.guides.length, 0, '无吸附则无参考线');
  const s3 = snapResize(box, [target], 'e', 46, 0, 6); // 右边缘 196,距 198 差 2
  eq(s3.dx, 48, '缩放的被拖边吸附到参考线');
  ok(s3.guides.length === 1 && s3.guides[0].pos === 198, '缩放同样给参考线');
});

t('编辑:层级操作与选中路径', () => {
  const root = rootOf(EDIT_SAMPLE); // 根即 绝对 容器,children = [矩形, 矩形, 矩形, 条]
  const [a, b, c] = root.children;
  const order = (): string[] => root.children.map((n) => (n === a ? 'a' : n === b ? 'b' : n === c ? 'c' : 'd'));
  eq(findPath(root, c), [2], '路径定位');
  eq(nodeAtPath(root, [2]), c, '按路径还原节点');
  eq(order(), ['a', 'b', 'c', 'd'], '初始序');
  ok(levelOp(root, c, 'up'), 'c 上移一层');
  eq(order(), ['a', 'c', 'b', 'd'], '上移=与前一位置换');
  ok(levelOp(root, c, 'top'), 'c 置顶');
  eq(order(), ['a', 'b', 'd', 'c'], '置顶=移到末尾');
  ok(levelOp(root, c, 'bottom'), 'c 置底');
  eq(order(), ['c', 'a', 'b', 'd'], '置底=移到开头');
  eq(levelOp(root, c, 'up'), false, '已在开头,上移不动');
  eq(levelOp(root, c, 'bottom'), false, '已在开头,置底不动');
  eq(levelOp(root, root, 'up'), false, '根无层级');
  const rt = roundTrip(root);
  eq(rt.root.children.length, 4, '层级改动往返后子项数不变');
  eq(findPath(rt.root, rt.root.children[0]), [0], '往返后路径语义不变(底 = 位置0)');
});

// ---------------- 切片 4:属性编辑与工具箱 ----------------

t('值白名单:UI.色16("#hex") 与 UI.<常量> 解析/生成往返(含子字典内)', () => {
  const src = [
    '函 界面(s) {',
    '    设 根 = UI.行([',
    '        UI.矩形({"宽": 120, "高": 80, "底色": UI.色16("#3B82F6"), "底色2": UI.色16("#8B5CF6")}),',
    '        UI.文本("甲", {"主轴对齐": UI.对齐中, "叉轴对齐": UI.叉撑, "锚": {"左": 0.5, "右": 0.5}, "悬底色": UI.色16("#FF0000")})',
    '    ], {"宽": 400, "高": 200})',
    '    返 根',
    '}',
    '',
  ].join('\n');
  const root = rootOf(src);
  const rect = root.children[0];
  const hex = rect.options.find((o) => o.key === '底色')?.value;
  eq(hex?.t, 'hex16', '色16 解析为 hex16');
  eq(hex && hex.t === 'hex16' ? hex.v : '', '#3B82F6', '保留原始 hex 文本');
  const align = root.children[1].options.find((o) => o.key === '主轴对齐')?.value;
  eq(align?.t, 'libConst', 'UI.对齐中 解析为库常量');
  const sub = root.children[1].options.find((o) => o.key === '锚')?.value;
  eq(sub?.t, 'dict', '锚 仍是子字典');
  const subColor = root.children[1].options.find((o) => o.key === '悬底色')?.value;
  eq(subColor?.t, 'hex16', '色16 出现在子字典里也认(此处为顶层键,三态覆写同形)');
  const rt = roundTrip(root);
  eq(rt.text.includes('UI.色16("#3B82F6")'), true, '生成器按原样回写 色16');
  eq(rt.text.includes('UI.对齐中'), true, '库常量按原样回写');
  eq(rt.root.children[0].options.find((o) => o.key === '底色')?.value.t, 'hex16', '往返后仍为 hex16');
});

t('值白名单:色16 参数非字符串 / UI.<名>(…) 调用形态仍判非子集', () => {
  const bad1 = ['函 界面(s) {', '    设 根 = UI.矩形({"底色": UI.色16(123)})', '    返 根', '}', ''].join('\n');
  eq(parseDesignFunction(bad1).ok, false, '色16 参数必须是字符串字面量');
  const bad2 = ['函 界面(s) {', '    设 根 = UI.矩形({"底色": UI.对齐中(1)})', '    返 根', '}', ''].join('\n');
  eq(parseDesignFunction(bad2).ok, false, '未支持的 UI.<名>(…) 调用形态应拒绝');
});

t('属性写入:setInsets 数字↔子字典升降级与清除', () => {
  const root = rootOf(EDIT_SAMPLE);
  const r0 = root.children[0];
  ok(setInsets(r0, '内边距', { 左: 8, 上: 8, 右: 8, 下: 8 }), '四边同值写入');
  eq(numOpt(r0, '内边距'), 8, '四边同值保持数字形态');
  ok(setInsets(r0, '内边距', { 左: 12, 上: 8, 右: 8, 下: 8 }), '改为不等值');
  const d = r0.options.find((o) => o.key === '内边距')?.value;
  eq(d?.t, 'dict', '不等值升级为子字典');
  ok(removeOpt(r0, 'x'), '删除选项');
  eq(numOpt(r0, 'x'), undefined, 'x 已删除');
  eq(removeOpt(r0, 'x'), false, '重复删除返回 false');
});

t('工具箱:默认节点逐个控件可生成且可再解析(形状合法)', () => {
  const WIDGET_LIST = ['行', '列', '叠', '绝对', '滚动容器', '文本', '按钮', '矩形', '图片', '图标按钮', '图标', '输入栏', '多行编辑', '空白', '弹性'];
  const root = rootOf(EDIT_SAMPLE);
  for (const w of WIDGET_LIST) {
    const host = w === '行' || w === '列' || w === '叠' || w === '绝对' || w === '滚动容器' ? root : root;
    const fresh = defaultWidget(w, 's');
    ok(insertNode(root, host, fresh, 'child'), `${w}: 插入应成功`);
    const rt = roundTrip(root);
    const found = rt.root.children.some((c) => c.widget === w);
    ok(found, `${w}: 生成→再解析后应仍在树中;文本=\n` + rt.text);
    eq(rt.root.children.length, root.children.length, `${w}: 子项数一致`);
    ok(removeNode(root, fresh), `${w}: 删除应成功`);
    eq(root.children.length, rt.root.children.length - 1, `${w}: 删除后回到原状`);
  }
});

t('工具箱:插入位置(child/after)、复制命名避撞、根不可删', () => {
  const root = rootOf(EDIT_SAMPLE);
  const row = root.children[3]; // 条(行容器)
  const fresh = defaultWidget('文本', 's');
  ok(insertNode(root, row, fresh, 'child'), '容器:追加为子项');
  eq(row.children.length, 3, '行容器子项 +1');
  const afterNode = defaultWidget('矩形', 's');
  ok(insertNode(root, row, afterNode, 'after'), '叶子:插在其父的后一位');
  ok(root.children.indexOf(afterNode) === root.children.indexOf(row) + 1, '插入位置紧随其后');
  eq(insertNode(root, root, afterNode, 'after'), false, '根没有"后一位"');
  eq(removeNode(root, root), false, '根不可删');

  // 复制:容器名清空并避让既有名(条 已是变量名;复制后必须拿到新名)
  const row2 = cloneSubtree(row);
  ok(insertNode(root, row, row2, 'after'), '复制体插入');
  const rt = roundTrip(root);
  const names = rt.text.match(/设 (\S+) = UI\./g) ?? [];
  const uniq = new Set(names);
  eq(uniq.size, names.length, '生成文本中变量名不重复\n' + rt.text);
  eq(parseDesignFunction(rt.text).ok, true, '复制后仍可解析');
});

t('属性元数据:调色板键与库一致、未知键只读、工具箱覆盖全部构造器', () => {
  eq(COLOR_PALETTE.length, 12, '调色板 12 色');
  eq(PALETTE_CHECK.every((k) => (COLOR_PALETTE as readonly string[]).includes(k)), true, '调色板键与 lib/UI/UI.xt 的 色彩 键一致');
  eq(specOf('不存在的键').kind, 'readonly', '未知键 → 只读');
  const boxWidgets = TOOLBOX.flatMap((g) => [...g.widgets]);
  eq(boxWidgets.length, 15, '工具箱列出全部 15 个构造器');
  eq(boxWidgets.includes('滚动容器') && boxWidgets.includes('弹性') && boxWidgets.includes('图标'), true, '容器与特殊叶子都在列');
  eq(specOf('底色').kind, 'color', '底色 → 颜色编辑器');
  eq(specOf('主轴对齐').kind, 'enum', '主轴对齐 → 枚举编辑器');
});

t('值白名单:UI.色(r,g,b[,a]) 通道色解析/生成往返,通道非数字仍拒', () => {
  const src = [
    '函 界面(s) {',
    '    设 根 = UI.行([',
    '        UI.按钮("甲", {"悬底色": UI.色(255, 60, 60, 255), "按底色": UI.色(36, 40, 52)})',
    '    ], {"宽": 400, "高": 200})',
    '    返 根',
    '}',
    '',
  ].join('\n');
  const root = rootOf(src);
  const btn = root.children[0];
  const v1 = btn.options.find((o) => o.key === '悬底色')?.value;
  eq(v1?.t, 'rgba', 'UI.色(4 通道)解析为 rgba');
  eq(v1 && v1.t === 'rgba' ? v1.channels.join(',') : '', '255,60,60,255', '通道原文');
  const v2 = btn.options.find((o) => o.key === '按底色')?.value;
  eq(v2 && v2.t === 'rgba' ? v2.channels.length : 0, 3, '3 通道也接受(a 由库补 255)');
  const rt = roundTrip(root);
  eq(rt.text.includes('UI.色(255, 60, 60, 255)'), true, '生成器原样回写');
  const bad = ['函 界面(s) {', '    设 根 = UI.矩形({"底色": UI.色(255, 60)})', '    返 根', '}', ''].join('\n');
  eq(parseDesignFunction(bad).ok, false, '通道数不足应拒绝');
  const bad2 = ['函 界面(s) {', '    设 根 = UI.矩形({"底色": UI.色(255, 60, "x")})', '    返 根', '}', ''].join('\n');
  eq(parseDesignFunction(bad2).ok, false, '通道非数字应拒绝');
});

t('字对齐(库 v1.5.4):解析/生成往返,枚举归一,规范序按"组末尾追加"落位', () => {
  const src = [
    '函 界面(s) {',
    '    设 根 = UI.行([',
    '        UI.文本("居中", {"宽": 300, "字对齐": UI.对齐中}),',
    '        UI.文本("靠右", {"宽": 200, "字对齐": UI.对齐末})',
    '    ], {"宽": 500, "高": 100})',
    '    返 根',
    '}',
    '',
  ].join('\n');
  const root = rootOf(src);
  const v = root.children[0].options.find((o) => o.key === '字对齐')?.value;
  eq(v?.t, 'libConst', '字对齐 解析为库常量');
  const rt = roundTrip(root);
  eq(rt.text.includes('"字对齐": UI.对齐中'), true, '生成器原样回写');
  eq(specOf('字对齐').kind, 'enum', '属性面板按枚举编辑');
  eq(specOf('字对齐').enums?.length, 3, '三档:始/中/末');
  ok(CANONICAL_KEYS.indexOf('字对齐') > CANONICAL_KEYS.indexOf('裁剪'), '新键追加在视觉组末尾(不插乱既有顺序)');
});

t('字叉对齐(库 v1.5.7):解析/生成往返,枚举归一,规范序排在 字对齐 之后', () => {
  const src = [
    '函 界面(s) {',
    '    设 根 = UI.列([',
    '        UI.文本("垂直居中", {"宽": 300, "高": 80, "字叉对齐": UI.对齐中}),',
    '        UI.文本("贴底", {"宽": 200, "高": 40, "字叉对齐": UI.对齐末})',
    '    ], {"宽": 500, "高": 200})',
    '    返 根',
    '}',
    '',
  ].join('\n');
  const root = rootOf(src);
  const v = root.children[0].options.find((o) => o.key === '字叉对齐')?.value;
  eq(v?.t, 'libConst', '字叉对齐 解析为库常量');
  const rt = roundTrip(root);
  eq(rt.text.includes('"字叉对齐": UI.对齐中'), true, '生成器原样回写');
  eq(specOf('字叉对齐').kind, 'enum', '属性面板按枚举编辑');
  eq(specOf('字叉对齐').enums?.length, 3, '三档:始/中/末');
  ok(CANONICAL_KEYS.indexOf('字叉对齐') > CANONICAL_KEYS.indexOf('字对齐'), '追加在 字对齐 之后(不插乱既有顺序)');
});

t('渲染入口:补 UI 引入 / 生成 UI.应用 调用 / 按文件行尾追加', () => {
  eq(uiAliasOf('引 "UI" 予 UI\n'), 'UI', '识别 UI 别名');
  eq(uiAliasOf('引 "UI" 予 界面\n'), '界面', '识别自定义别名');
  eq(uiAliasOf('设 A = 1\n'), null, '没有引入');
  const imported = ensureUiImport('函 主界面(s) {\n    返 空\n}\n');
  ok(imported.startsWith('引 "UI" 予 UI\n\n'), '自动补引入');
  eq(ensureUiImport(imported), imported, '已引入不重复补');

  const entry = buildRenderEntry({
    alias: 'UI', funcName: '主界面', stateParam: 's', title: '主界面', width: 800, height: 560,
    stateKeys: ['计数', '开关'],
  });
  ok(
    entry.includes('UI.应用(界面状态, 函(s) { 返 主界面(s) }, {"宽": 800, "高": 560, "标题": "主界面"})'),
    '应用调用形态',
  );
  ok(entry.includes('{"计数": 0, "开关": 0}'), '态取键预置为 0');
  ok(hasRenderEntry(entry), '入口自带标记');
  ok(hasRenderEntry('设 状态 = UI.造状态({})\nR.初始化窗口(1, 2, "x")'), '用户自写初始化也算已有入口');
  ok(!hasRenderEntry('函 主界面(s) { 返 空 }'), '纯函数不算入口');

  const lf = appendEntry('设 A = 1', entry);
  ok(lf.startsWith('设 A = 1\n\n'), '追加前留空行');
  ok(lf.endsWith('"标题": "主界面"})\n'), '入口在文件末尾');
  const crlf = appendEntry('设 A = 1\r\n', entry);
  ok(crlf.includes('\r\n') && !/[^\r]\n/.test(crlf), 'CRLF 文件保持 CRLF');

  // 设计树里 态取 的键要被收集(普通字符串不算)
  const src = [
    '函 界面(s) {',
    '    设 根 = UI.列([',
    '        UI.文本(UI.态取(s, "计数"), {}),',
    '        UI.文本("说明", {})',
    '    ], {})',
    '    返 根',
    '}',
    '',
  ].join('\n');
  const root = rootOf(src);
  eq(collectStateKeys(root).join(','), '计数', '只收 态取 键');
});

// ---------------- 切片 5:图标控件与图标选择器(lib/UI v1.8.0) ----------------

t('图标数据:ICON_CATALOG 2359 个、按常用度排序、全为 currentColor', () => {
  eq(ICON_CATALOG.length, 2359, '内嵌图标数量(与 lib/UI/图标表.xt 对应)');
  eq(ICON_CATALOG[0].zh + '/' + ICON_CATALOG[0].en, '搜索/search', '首个 = 最常用(搜索/search)');
  eq(ICON_CATALOG.every((it, i) => it.rank === i + 1), true, 'rank 从 1 连续递增(即常用度序)');
  eq(ICON_CATALOG.every((it) => it.svg.includes('currentColor')), true, '白色已换成 currentColor(画布用 CSS 着色)');
  eq(new Set(ICON_CATALOG.map((it) => it.en)).size, 2359, '英文 ID 无重复');
  eq(new Set(ICON_CATALOG.map((it) => it.zh)).size, 2359, '中文名无重复');
});

t('图标选择器:findIcon 中文/英文即时过滤,空查询给前 240 个', () => {
  eq(findIcon('').length, 240, '空查询返回前 240 个');
  eq(findIcon('')[0].zh, '搜索', '空查询按常用度序(搜索第一)');
  ok(findIcon('搜').some((it) => it.zh === '搜索'), '中文子串「搜」→ 含 搜索');
  ok(findIcon('search').some((it) => it.en === 'search'), '英文子串「search」→ search');
  ok(findIcon('更多·横向').some((it) => it.en === 'more-horizontal'), '含 · 的中文名可精确搜');
  eq(findIcon('不存在的图标名xyz').length, 0, '无命中返回空');
});

t('图标控件:spec 形态(叶子/src+options)、工具箱、可写键与 图片/图标按钮 同套', () => {
  eq(WIDGETS['图标'].kind, 'leaf', 'kind = leaf');
  eq(WIDGETS['图标'].args.join(','), 'src,options', '首参 src + options');
  const widgets = TOOLBOX.flatMap((g) => [...g.widgets]);
  eq(widgets.includes('图标'), true, '控件库含 图标');
  eq(WIDGET_KEYS['图标'].join(','), WIDGET_KEYS['图片'].join(','), '可写键与 图片 同套');
  eq(WIDGET_KEYS['图标'].join(','), WIDGET_KEYS['图标按钮'].join(','), '可写键与 图标按钮 同套');
  eq(WIDGET_KEYS['图标'].includes('图标尺寸') && WIDGET_KEYS['图标'].includes('图标色'), true, '含 图标尺寸/图标色');
});

t('图标控件:默认节点形状合法(搜索 + 图标尺寸 24 + UI.色彩[浅灰]),可直接生成', () => {
  const fresh = defaultWidget('图标', 's');
  eq(fresh.widget, '图标', '控件名');
  eq(fresh.kind, 'leaf', '叶子');
  eq(fresh.args.length, 1, '一个位置实参(src)');
  eq(fresh.args[0].t === 'str' ? fresh.args[0].v : '', '搜索', '默认源 = 搜索');
  eq(numOpt(fresh, '图标尺寸'), 24, '默认 图标尺寸 24');
  const color = fresh.options.find((o) => o.key === '图标色')?.value;
  eq(color?.t === 'colorConst' ? color.key : '', '浅灰', '默认 图标色 = UI.色彩["浅灰"]');
  const root = rootOf(EDIT_SAMPLE);
  ok(insertNode(root, root, fresh, 'child'), '插入应成功');
  const rt = roundTrip(root);
  eq(rt.text.includes('UI.图标("搜索", {"图标尺寸": 24, "图标色": UI.色彩["浅灰"]})'), true, '生成默认节点\n' + rt.text);
});

t('图标控件:可生成/可再解析(中文名与英文 ID 等价,选项按规范序)', () => {
  const src = [
    '函 界面(s) {',
    '    设 根 = UI.绝对([',
    '        UI.图标("搜索", {"图标尺寸": 24, "图标色": UI.色彩["浅灰"]}),',
    '        UI.图标("more-horizontal", {})',
    '    ], {"宽": 200, "高": 60})',
    '    返 根',
    '}',
    '',
  ].join('\n');
  const root = rootOf(src);
  eq(root.children.length, 2, '两个图标子项');
  const first = root.children[0];
  eq(first.widget, '图标', '控件名');
  eq(first.args[0].t === 'str' ? first.args[0].v : '', '搜索', '中文名 src');
  const rt = roundTrip(root);
  eq(rt.text.includes('UI.图标("搜索", {"图标尺寸": 24, "图标色": UI.色彩["浅灰"]})'), true, '生成文本(键按规范序)\n' + rt.text);
  eq(rt.text.includes('UI.图标("more-horizontal", {})'), true, '英文 ID 原样回写');
  const second = rt.root.children[1];
  eq(second.widget + ':' + (second.args[0].t === 'str' ? second.args[0].v : ''), '图标:more-horizontal', '往返保真');
});

t('图标源写入:strVal 最小转义(更多·横向 原样;引号/反斜杠/换行转义),写回后可解析', () => {
  eq(strVal('更多·横向').raw, '"更多·横向"', '· 不需转义');
  eq(strVal('a"b').raw, '"a\\"b"', '双引号转义');
  eq(strVal('a\\b').raw, '"a\\\\b"', '反斜杠转义');
  eq(strVal('a\nb').raw, '"a\\nb"', '换行转义');
  eq(strVal('a\tb').raw, '"a\\tb"', '制表符转义');
  // 模拟选择器写回:默认 图标 节点的 src 换成含 · 的中文名 → 生成 → 再解析
  const root = rootOf(EDIT_SAMPLE);
  const fresh = defaultWidget('图标', 's');
  fresh.args[0] = strVal('更多·横向');
  ok(insertNode(root, root, fresh, 'child'), '插入应成功');
  const rt = roundTrip(root);
  ok(rt.text.includes('UI.图标("更多·横向",'), '生成文本把中文名写入字符串\n' + rt.text);
  const re = parseDesignFunction(rt.text);
  eq(re.ok, true, '写回文本应可再解析;issues=' + JSON.stringify(re.issues));
  const found = re.root!.children.find((c) => c.widget === '图标');
  eq(found?.args[0].t === 'str' ? found.args[0].v : '', '更多·横向', '源值往返保真');
});

t('图标预览:画布按源名解析(中文↔英文),非内置名回落占位', () => {
  eq(iconEntryByName('搜索')?.en, 'search', '中文名 → search');
  eq(iconEntryByName('search')?.zh, '搜索', '英文 ID → 搜索');
  eq(iconEntryByName('more-horizontal')?.zh, '更多·横向', '含 · 的中文名');
  eq(iconEntryByName('图片.png'), undefined, '图片路径不是内置图标名(预览画占位)');
  eq(iconEntryByName(''), undefined, '空源 → 占位');
});

t('布局:图标默认 24×24 固有尺寸;图标尺寸 可指定;显式 宽/高 优先', () => {
  const src = [
    '函 界面(s) {',
    '    设 根 = UI.绝对([',
    '        UI.图标("搜索", {}),',
    '        UI.图标("菜单", {"图标尺寸": 40}),',
    '        UI.图标("设置", {"宽": 48, "高": 32, "图标尺寸": 20})',
    '    ], {"宽": 400, "高": 80})',
    '    返 根',
    '}',
    '',
  ].join('\n');
  const laid = layoutTree(rootOf(src), MEASURE);
  const icons = laid.boxes.filter((b) => b.node.widget === '图标');
  eq(icons.length, 3, '三个图标盒');
  eq([icons[0].w, icons[0].h], [24, 24], '默认 24×24');
  eq([icons[1].w, icons[1].h], [40, 40], '图标尺寸 决定固有尺寸');
  eq([icons[2].w, icons[2].h], [48, 32], '显式 宽/高 优先于 图标尺寸');
});

// ---------------- 切片 6:R-08 输入能力(库 v1.8.0;属性面板可写键) ----------------

t('输入能力:属性元数据 行距/自动增高/最小高/最大高/提交 的编辑器形态与分组', () => {
  eq(specOf('行距').kind, 'num', '行距 → 数值编辑器');
  eq(specOf('行距').group, '文字', '行距 属文字组');
  eq(specOf('行距').min, 0, '行距 min 0');
  eq(specOf('自动增高').kind, 'bool', '自动增高 → 布尔编辑器');
  eq(specOf('最小高').kind === 'num' && specOf('最小高').min === 0, true, '最小高 → 数值,min 0');
  eq(specOf('最大高').kind === 'num' && specOf('最大高').min === 0, true, '最大高 → 数值,min 0');
  eq(specOf('提交').kind, 'readonly', '提交 与 点击 同款只读(回调名手写,面板不改写)');
  eq(CANONICAL_KEYS.includes('行距') && CANONICAL_KEYS.includes('自动增高') && CANONICAL_KEYS.includes('提交'), true, '新键已入规范序');
  ok(CANONICAL_KEYS.indexOf('行距') > CANONICAL_KEYS.indexOf('首按延迟'), '新键追加在既有规范序之后(不插乱既有键序)');
});

t('输入能力:WIDGET_KEYS 按库读取点分发(输入栏不吃 行距/自动增高/最小高/最大高)', () => {
  const has = (w: string, k: string): boolean => (WIDGET_KEYS[w] ?? []).includes(k);
  eq(has('文本', '行距'), true, '文本 读 行距(多行文本排版)');
  eq(
    has('多行编辑', '行距') && has('多行编辑', '自动增高') && has('多行编辑', '最小高') && has('多行编辑', '最大高') && has('多行编辑', '提交'),
    true,
    '多行编辑 五项齐全',
  );
  eq(has('输入栏', '提交'), true, '输入栏 读 提交(回车回调)');
  eq(has('输入栏', '行距') || has('输入栏', '自动增高') || has('输入栏', '最小高') || has('输入栏', '最大高'), false, '输入栏 不读 行距/自动增高/最小高/最大高(不进可写键矩阵,不骗人)');
  eq(has('文本', '提交') || has('按钮', '提交'), false, '文本/按钮 无 提交');
});

t('输入能力:解析/生成往返(行距·自动增高·最小高/最大高·提交回调)', () => {
  const src = [
    '函 界面(s) {',
    '    设 根 = UI.行([',
    '        UI.文本("多行文本", {"行距": 6}),',
    '        UI.多行编辑(s, "正文", {"行距": 4, "自动增高": 真, "最小高": 40, "最大高": 240, "提交": 发送}),',
    '        UI.输入栏(s, "名字", {"提交": 发送})',
    '    ], {"宽": 500, "高": 300})',
    '    返 根',
    '}',
    '',
  ].join('\n');
  const root = rootOf(src);
  const rt = roundTrip(root);
  eq(rt.text.includes('"行距": 6'), true, '文本 行距 回写\n' + rt.text);
  eq(rt.text.includes('"行距": 4'), true, '多行编辑 行距 回写');
  eq(rt.text.includes('"自动增高": 真'), true, '自动增高 布尔回写');
  eq(rt.text.includes('"最小高": 40'), true, '最小高 回写');
  eq(rt.text.includes('"最大高": 240'), true, '最大高 回写');
  eq(rt.text.includes('"提交": 发送'), true, '提交 回调按具名引用回写');
  const editor = rt.root.children[1];
  eq(editor.options.find((o) => o.key === '自动增高')?.value.t, 'bool', '往返后 自动增高 仍为布尔');
  eq(editor.options.find((o) => o.key === '提交')?.value.t, 'fnRef', '往返后 提交 仍为回调引用');
});

console.log('\n设计器自检: 通过 ' + pass + ' / 失败 ' + fail);
if (fail > 0) process.exitCode = 1;