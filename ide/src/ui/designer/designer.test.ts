// 铸造厂可视化 UI 设计器 —— 切片 1 自检(纯函数:解析/生成/区段读写)
// 运行: npm run test:designer   (esbuild 打包 + node 执行;无新增依赖)
// 判定: 往返幂等 / 生成确定性(规范序、无尾随逗号) / 区外零改动(含 CRLF 保持) / 非子集→只读
import { parseDesignFunction, type DesignNode } from './parser';
import { generateDesignFunction } from './generator';
import { findRegions, replaceRegion, appendRegion, regionText } from './region';
import { layoutTree, type Measure } from './layout';
import {
  applyMove,
  applyResize,
  findParent,
  findPath,
  levelOp,
  lockedAxes,
  moveMode,
  nodeAtPath,
  numOpt,
  snapMove,
  snapResize,
  MIN_SIZE,
} from './edit';

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

// ------- 样例 B:全 14 控件覆盖 -------
const SAMPLE_B = [
  '函 全控件(s) {',
  '    设 绝对区 = UI.绝对([',
  '        UI.矩形({"x": 0, "y": 0, "宽": 10, "高": 10}),',
  '        UI.图片("logo.png", {}),',
  '        UI.图标按钮("i.png", {})',
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

t('样例B(全14控件) 解析通过+覆盖齐14个构造器', () => {
  const r = parseDesignFunction(SAMPLE_B);
  eq(r.ok, true, 'ok 应为 true;issues=' + JSON.stringify(r.issues));
  const seen = new Set<string>();
  const walk = (n: { widget: string; children: { widget: string; children: unknown[] }[] }): void => {
    seen.add(n.widget);
    for (const c of n.children as never[]) walk(c);
  };
  walk(r.root as never);
  eq(seen.size, 14, '控件种类数(实际: ' + [...seen].join(',') + ')');
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

console.log('\n设计器自检: 通过 ' + pass + ' / 失败 ' + fail);
if (fail > 0) process.exitCode = 1;