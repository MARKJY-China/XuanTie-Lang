// 铸造厂可视化 UI 设计器 —— 切片 1 自检(纯函数:解析/生成/区段读写)
// 运行: npm run test:designer   (esbuild 打包 + node 执行;无新增依赖)
// 判定: 往返幂等 / 生成确定性(规范序、无尾随逗号) / 区外零改动(含 CRLF 保持) / 非子集→只读
import { parseDesignFunction } from './parser';
import { generateDesignFunction } from './generator';
import { findRegions, replaceRegion, appendRegion, regionText } from './region';
import { layoutTree, type Measure } from './layout';

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

console.log('\n设计器自检: 通过 ' + pass + ' / 失败 ' + fail);
if (fail > 0) process.exitCode = 1;
