#!/usr/bin/env node
// tools/check-lsp-icons.mjs —— LSP 图标字符串补全自动测试(无窗口,可提交)
//
// 覆盖:lsp/xt_lsp.xt 的「图标字符串上下文」补全——在 `UI.图标("…")` /
// `界面.图标按钮("…")` 的第一个字符串实参里,只返回 lib/UI/图标中文表.xt 的图标名
// (中文主项 sortText 0_ 在前,英文次项 1_ 在后),不混关键字/符号补全。
//
// 做法:真的启动 build/xt_lsp.exe(LSP 服务器),按 Content-Length JSON-RPC 分帧通信:
//   initialize → didOpen 虚拟文档 → textDocument/completion → 断言 → shutdown/exit。
// 传输优先 TCP 回环 20807(--tcp);端口被占用或监听失败时自动回退 stdio,二者都真跑进程。
// 测试夹具:系统临时目录下建一个带 `玄铁.配置.toml` 与 `lib/UI/图标中文表.xt`(从仓库复制)
// 的工程,虚拟文档 _fsPath 指向其中——验证「项目根/lib/UI/图标中文表.xt」优先命中。
//
// 用法:node tools/check-lsp-icons.mjs
// 退出码:0 = PASS;1 = FAIL。

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = path.join(ROOT, 'build', 'xt_lsp.exe');
const TABLE = path.join(ROOT, 'lib', 'UI', '图标中文表.xt');
const IDE_FEATURES = path.join(ROOT, 'ide', 'src', 'lsp', 'features.ts');
const TCP_PORT = 20807;
const REQUEST_TIMEOUT_MS = 20000;
const TCP_CONNECT_TIMEOUT_MS = 10000;

let passCount = 0;
let failCount = 0;

function check(name, ok, detail) {
  if (ok) {
    passCount += 1;
    console.log(`PASS: ${name}${detail == null || detail === '' ? '' : ` (${detail})`}`);
  } else {
    failCount += 1;
    console.error(`FAIL: ${name}${detail == null || detail === '' ? '' : ` (${detail})`}`);
  }
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- LSP 客户端(Content-Length 分帧;TCP 或 stdio 同一套读写) ----------

function createClient(readStream, writeStream, mode, child) {
  let buf = Buffer.alloc(0);
  const pending = new Map();
  const notifWaiters = new Set();
  let nextId = 1;
  let closed = false;

  readStream.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const headEnd = buf.indexOf('\r\n\r\n');
      if (headEnd < 0) return;
      const header = buf.subarray(0, headEnd).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        buf = buf.subarray(headEnd + 4);
        continue;
      }
      const len = Number.parseInt(m[1], 10);
      const bodyStart = headEnd + 4;
      if (buf.length < bodyStart + len) return;
      const body = buf.subarray(bodyStart, bodyStart + len);
      buf = buf.subarray(bodyStart + len);
      let msg;
      try {
        msg = JSON.parse(body.toString('utf8'));
      } catch (err) {
        console.error(`[${mode}] 收到无法解析的 JSON-RPC 帧: ${err.message}`);
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        const slot = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(slot.timer);
        slot.resolve({ result: msg.result, error: msg.error, bytes: len, raw: msg });
        continue;
      }
      // 通知(publishDiagnostics 等):交给等待者,否则忽略
      if (msg.method) {
        for (const waiter of [...notifWaiters]) {
          if (waiter.method !== msg.method) continue;
          let hit = false;
          try {
            hit = waiter.predicate(msg);
          } catch {
            hit = false;
          }
          if (!hit) continue;
          notifWaiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(msg);
        }
      }
    }
  });

  readStream.on('close', () => {
    closed = true;
    for (const [, slot] of pending) {
      clearTimeout(slot.timer);
      slot.reject(new Error(`[${mode}] 连接已关闭,请求未完成`));
    }
    pending.clear();
    for (const waiter of notifWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`[${mode}] 连接已关闭,等待的通知未到达`));
    }
    notifWaiters.clear();
  });

  function send(msg) {
    const json = JSON.stringify(msg);
    writeStream.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  }

  function request(method, params) {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`请求 ${method} 超时(${REQUEST_TIMEOUT_MS}ms)`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }

  function notify(method, params) {
    send({ jsonrpc: '2.0', method, params });
  }

  function waitNotification(method, predicate = () => true, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const waiter = { method, predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        notifWaiters.delete(waiter);
        reject(new Error(`等待通知 ${method} 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      notifWaiters.add(waiter);
    });
  }

  return {
    mode,
    child,
    request,
    notify,
    waitNotification,
    get closed() {
      return closed;
    },
  };
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

// TCP 模式:spawn --tcp,轮询连接回环端口。端口不可用/连不上返 null(交调用方回退 stdio)。
async function connectTcp(exe) {
  const child = spawn(exe, ['--tcp'], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[xt_lsp stderr] ${d}`));
  let spawnError = null;
  child.once('error', (err) => {
    spawnError = err;
  });

  const deadline = Date.now() + TCP_CONNECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError) {
      child.unref();
      throw new Error(`启动 ${exe} 失败: ${spawnError.message}`);
    }
    if (child.exitCode !== null) return null;
    const socket = await new Promise((resolve) => {
      const s = net.connect({ port: TCP_PORT, host: '127.0.0.1' });
      s.once('connect', () => resolve(s));
      s.once('error', () => {
        s.destroy();
        resolve(null);
      });
    });
    if (socket) {
      socket.setNoDelay(true);
      return createClient(socket, socket, 'tcp', child);
    }
    await sleep(100);
  }
  child.kill();
  return null;
}

// stdio 模式:spawn 无参数,帧走 stdin/stdout(服务器默认正式形态)。
async function connectStdio(exe) {
  const child = spawn(exe, [], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[xt_lsp stderr] ${d}`));
  let spawnError = null;
  child.once('error', (err) => {
    spawnError = err;
  });
  await sleep(300);
  if (spawnError) throw new Error(`启动 ${exe} 失败: ${spawnError.message}`);
  return createClient(child.stdout, child.stdin, 'stdio', child);
}

// ---------- 测试夹具:临时工程(玄铁.配置.toml + lib/UI/图标中文表.xt) ----------

function makeFixture(tableContent = null) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'xt-lsp-icons-'));
  mkdirSync(path.join(dir, 'lib', 'UI'), { recursive: true });
  writeFileSync(path.join(dir, '玄铁.配置.toml'), '[项目]\n入口 = "演示.xt"\n', 'utf8');
  if (tableContent == null) copyFileSync(TABLE, path.join(dir, 'lib', 'UI', '图标中文表.xt'));
  else writeFileSync(path.join(dir, 'lib', 'UI', '图标中文表.xt'), tableContent, 'utf8');
  return dir;
}

// 与 lsp/xt_lsp.xt 解析口径一致的纯 JS 解析(只为断言期望值;不参与被测路径)
function parseIconTable(text) {
  const zhToEn = new Map();
  const enToZh = new Map();
  const order = [];
  let section = '';
  const fieldsOf = (line) => {
    const out = [];
    let open = -1;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === '"') {
        if (open < 0) open = i;
        else {
          out.push(line.slice(open + 1, i));
          open = -1;
        }
      }
    }
    return out;
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r/g, '').trim();
    if (!line || line.startsWith('//')) continue;
    if (line.includes('图标中文名序')) {
      section = 'order';
      continue;
    }
    if (line.includes('图标英文')) {
      section = 'en';
      continue;
    }
    if (line.includes('图标中文')) {
      section = 'zh';
      continue;
    }
    if (!section) continue;
    const fields = fieldsOf(line);
    if (section === 'zh' && fields.length >= 2) {
      enToZh.set(fields[0], fields[1]);
      zhToEn.set(fields[1], fields[0]);
    } else if (section === 'en' && fields.length >= 2) {
      zhToEn.set(fields[0], fields[1]);
    } else if (section === 'order' && fields.length >= 1 && fields[0]) {
      order.push(fields[0]);
    }
  }
  return { enToZh, zhToEn, order };
}

// ---------- 断言辅助 ----------

function lineOf(text, n) {
  return text.split('\n')[n] ?? '';
}

function positionAtLineEnd(text, line) {
  return { line, character: lineOf(text, line).length };
}

function assertIconResult(label, payload, expected) {
  const { result, bytes } = payload;
  const okArray = check(`${label}: 返回图标补全数组`, Array.isArray(result), Array.isArray(result) ? `${result.length} 项` : typeof result);
  if (!okArray) return null;

  const items = result;
  check(
    `${label}: 只含图标项(条数 = 中文 ${expected.order.length} + 英文 ${expected.enCount})`,
    items.length === expected.order.length + expected.enCount,
    `${items.length} 项`,
  );

  const zh = items.find((it) => it && it.label === '搜索' && it.insertText === '搜索');
  const en = items.find((it) => it && it.label === 'search' && it.insertText === 'search');
  check(`${label}: 中文主项「搜索」存在`, Boolean(zh));
  check(`${label}: 英文次项「search」存在`, Boolean(en));

  if (zh) {
    check(`${label}: 中文主项 kind=22`, zh.kind === 22, `kind=${zh.kind}`);
    check(`${label}: 中文主项 detail=英文ID — Lucide 图标`, zh.detail === 'search — Lucide 图标', String(zh.detail));
    check(`${label}: 中文主项 sortText=0_0001`, zh.sortText === '0_0001', String(zh.sortText));
  }
  if (en) {
    check(`${label}: 英文次项 kind=3`, en.kind === 3, `kind=${en.kind}`);
    check(`${label}: 英文次项 detail=中文名`, en.detail === '搜索', String(en.detail));
    check(`${label}: 英文次项 sortText=1_0001`, en.sortText === '1_0001', String(en.sortText));
  }

  const zhAll = items.filter((it) => it && typeof it.sortText === 'string' && it.sortText.startsWith('0_'));
  const enAll = items.filter((it) => it && typeof it.sortText === 'string' && it.sortText.startsWith('1_'));
  check(
    `${label}: sortText 中文主项全部 0_ 在前、英文次项全部 1_ 在后`,
    zhAll.length === expected.order.length &&
      enAll.length === expected.enCount &&
      items.every((it, idx) => (idx < zhAll.length ? it.sortText.startsWith('0_') : it.sortText.startsWith('1_'))),
    `0_=${zhAll.length}, 1_=${enAll.length}`,
  );
  check(`${label}: 首项是常用度最高的中文「搜索」`, items[0] && items[0].label === '搜索', items[0] && String(items[0].label));
  check(
    `${label}: 中文主项在响应数组中先于英文次项`,
    Boolean(zh) && Boolean(en) && items.indexOf(zh) < items.indexOf(en),
  );
  check(
    `${label}: 不混关键字/符号补全(全部 label 均来自图标表)`,
    items.every((it) => it && (expected.names.has(it.label) || expected.english.has(it.label))),
  );

  check(`${label}: 响应 JSON 体积可接受(< 4 MB)`, bytes > 0 && bytes < 4 * 1024 * 1024, `${(bytes / 1024).toFixed(1)} KB`);
  return { zh, en, items, bytes };
}

// ---------- 主流程 ----------

async function main() {
  console.log(`== LSP 图标补全测试 ==\n仓库根: ${ROOT}\n服务器: ${EXE}\n映射表: ${TABLE}\n`);
  if (!check('LSP 服务器已编译(build/xt_lsp.exe 存在)', existsSync(EXE))) return;
  if (!check('图标中文表存在(lib/UI/图标中文表.xt)', existsSync(TABLE))) return;

  const table = parseIconTable(readFileSync(TABLE, 'utf8'));
  const expected = {
    order: table.order,
    enCount: table.order.filter((n) => table.zhToEn.get(n)).length,
    names: new Set([...table.order, ...table.enToZh.values()]),
    english: new Set(table.order.map((n) => table.zhToEn.get(n)).filter(Boolean)),
  };
  console.log(`映射表解析: 中文 ${expected.order.length} 条,英文 ${expected.enCount} 条\n`);

  const fixture = makeFixture();
  // 解析失败兜底用例夹具:工程里放一份内容损坏的图标表(候选命中但解析出 0 条)
  const fixtureBad = makeFixture(
    '// 故意损坏的图标表(测试解析失败静默回退)\n公 常 图标中文 = {\n}\n公 常 图标英文 = {\n}\n公 常 图标中文名序 = [\n]\n',
  );
  const docUri = (name, dir = fixture) => pathToFileURL(path.join(dir, name)).toString();
  let client = null;

  try {
    const tcpFree = await isPortFree(TCP_PORT);
    if (tcpFree) {
      try {
        client = await connectTcp(EXE);
      } catch (err) {
        console.error(`TCP 模式启动失败,回退 stdio: ${err.message}`);
        client = null;
      }
    } else {
      console.error(`端口 ${TCP_PORT} 被占用,改用 stdio 模式`);
    }
    if (!client) client = await connectStdio(EXE);
    console.log(`传输模式: ${client.mode === 'tcp' ? `TCP 127.0.0.1:${TCP_PORT}` : 'stdio'}\n`);

    const init = await client.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'check-lsp-icons', version: '1.0' },
      rootUri: pathToFileURL(fixture).toString(),
      capabilities: {},
    });
    check('initialize 返回 completionProvider 能力', Boolean(init.result && init.result.capabilities && init.result.capabilities.completionProvider));
    client.notify('initialized', {});

    // 打开虚拟文档并等 didOpen 的诊断发布完成(服务器单线程顺序处理;这样耗时只算补全本身)
    async function openDoc(name, text, dir = fixture) {
      const uri = docUri(name, dir);
      const diagnostics = client.waitNotification(
        'textDocument/publishDiagnostics',
        (msg) => msg.params && msg.params.uri === uri,
      );
      client.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'xuantie', version: 1, text },
        _fsPath: path.join(dir, name),
      });
      await diagnostics;
      return uri;
    }

    // --- 用例 1:UI.图标("搜 ---
    const textA = '引 "UI" 予 UI\n函 演示() {\n    UI.图标("搜';
    const uriA = await openDoc('演示.xt', textA);

    const t0 = Date.now();
    const completionA = await client.request('textDocument/completion', {
      textDocument: { uri: uriA },
      position: positionAtLineEnd(textA, 2),
    });
    const elapsedA = Date.now() - t0;
    console.log(`用例1 UI.图标("搜 —— 补全往返 ${elapsedA}ms,响应体 ${(completionA.bytes / 1024).toFixed(1)} KB\n`);
    check('用例1: 补全往返耗时 < 3s', elapsedA < 3000, `${elapsedA}ms`);
    const resultA = assertIconResult('用例1', completionA, expected);

    // --- 用例 2:界面.图标按钮("删(任意模块别名) ---
    const textB = '引 "UI" 予 界面\n函 演示2() {\n    界面.图标按钮("删';
    const uriB = await openDoc('演示2.xt', textB);
    const t1 = Date.now();
    const completionB = await client.request('textDocument/completion', {
      textDocument: { uri: uriB },
      position: positionAtLineEnd(textB, 2),
    });
    const elapsedB = Date.now() - t1;
    console.log(`用例2 界面.图标按钮("删 —— 补全往返 ${elapsedB}ms(映射表缓存)\n`);
    const resultB = completionB.result;
    check(
      '用例2: 任意模块别名 界面.图标按钮("删 也命中图标补全',
      Array.isArray(resultB) &&
        resultB.some((it) => it && it.label === '删除' && it.insertText === '删除' && it.sortText === '0_0010'),
      Array.isArray(resultB) ? `${resultB.length} 项` : typeof resultB,
    );

    // --- 用例 3:刚输入开引号触发(空前缀) ---
    const textC = '引 "UI" 予 界面\n函 演示3() {\n    界面.图标("';
    const uriC = await openDoc('演示3.xt', textC);
    const t2 = Date.now();
    const completionC = await client.request('textDocument/completion', {
      textDocument: { uri: uriC },
      position: positionAtLineEnd(textC, 2),
    });
    const elapsedC = Date.now() - t2;
    console.log(`用例3 界面.图标(" —— 补全往返 ${elapsedC}ms(映射表缓存)\n`);
    check('用例3: 缓存命中后补全往返 < 300ms', elapsedC < 300, `${elapsedC}ms`);
    const resultC = completionC.result;
    check(
      '用例3: 空字符串前缀(刚打引号)返回全部中文图标主项',
      Array.isArray(resultC) && resultC.length === expected.order.length + expected.enCount && resultC[0]?.label === '搜索',
      Array.isArray(resultC) ? `${resultC.length} 项` : typeof resultC,
    );

    // --- 用例 4:非图标字符串上下文不返回图标项(普通补全仍可用) ---
    const completionD = await client.request('textDocument/completion', {
      textDocument: { uri: uriA },
      position: { line: 1, character: 3 },
    });
    const resultD = completionD.result;
    // 注意:普通补全里 右移/左移 等关键字与图标中文名可能同名(合法,不是泄漏);
    // 泄漏判定只看图标补全专属特征(detail 含 Lucide / insertText=搜索 / 整体条数)。
    const leaked = Array.isArray(resultD)
      ? resultD.filter(
          (it) =>
            it &&
            (it.insertText === '搜索' ||
              (typeof it.detail === 'string' && it.detail.includes('Lucide 图标'))),
        )
      : [];
    check(
      '用例4: 图标字符串外不混入图标补全',
      Array.isArray(resultD) && leaked.length === 0 && resultD.length !== expected.order.length + expected.enCount,
      Array.isArray(resultD) ? `${resultD.length} 项${leaked.length ? `,泄漏 ${leaked.slice(0, 5).map((x) => x.label).join(',')}` : ''}` : typeof resultD,
    );
    check('用例4: 普通补全仍返回关键字/符号', Array.isArray(resultD) && resultD.length > 0, Array.isArray(resultD) ? `${resultD.length} 项` : '');
    check('用例4: 服务器仍存活', client.child.exitCode === null);

    // --- 用例 5:图标表解析失败时静默回退普通补全(不报错、不崩溃、不混图标项) ---
    const textBad = '引 "UI" 予 UI\n函 演示5() {\n    UI.图标("搜';
    const uriBad = await openDoc('损坏.xt', textBad, fixtureBad);
    const completionBad = await client.request('textDocument/completion', {
      textDocument: { uri: uriBad },
      position: positionAtLineEnd(textBad, 2),
    });
    const resultBad = completionBad.result;
    check(
      '用例5: 图标表损坏时静默回退普通补全(无 Lucide 图标项)',
      Array.isArray(resultBad) &&
        resultBad.length > 0 &&
        !resultBad.some((it) => it && typeof it.detail === 'string' && it.detail.includes('Lucide 图标')) &&
        !resultBad.some((it) => it && it.insertText === '搜索'),
      Array.isArray(resultBad) ? `${resultBad.length} 项` : typeof resultBad,
    );
    check('用例5: 解析失败后服务器仍存活', client.child.exitCode === null);

    // --- 用例 6:空白文档普通补全回归(重建 xt_lsp 后应含 时/文件/数学 3 个命名空间,总数 74) ---
    const textE = '设 甲 = 1\n';
    const uriE = await openDoc('回归.xt', textE);
    const completionE = await client.request('textDocument/completion', {
      textDocument: { uri: uriE },
      position: positionAtLineEnd(textE, 0),
    });
    const labelsE = Array.isArray(completionE.result) ? completionE.result.map((it) => it && it.label) : [];
    check(
      '用例6: 普通补全含 时/文件/数学 三个内置命名空间',
      ['时', '文件', '数学'].every((ns) => labelsE.includes(ns)),
      `共 ${labelsE.length} 项`,
    );
    check('用例6: 普通补全总数仍为 74(重建 xt_lsp 后含 产出/化 等内建)', labelsE.length === 74, `共 ${labelsE.length} 项: ${labelsE.join(',')}`);

    // --- 用例 7:前端补全触发字符含双引号(契约:ide/src/lsp/features.ts) ---
    if (existsSync(IDE_FEATURES)) {
      const features = readFileSync(IDE_FEATURES, 'utf8');
      const m = /triggerCharacters:\s*\[([^\]]*)\]/.exec(features);
      check(
        '用例7: Monaco 补全 provider triggerCharacters 含 "',
        Boolean(m) && m[1].includes('"'),
        m ? `[${m[1].trim()}]` : '未找到 triggerCharacters',
      );
    } else {
      console.log('SKIP: 用例7 未找到 ide/src/lsp/features.ts');
    }

    // 缓存复用:第二文档(用例2)响应体应与用例1 同量级(此处仅打印,便于人工判断性能)
    if (resultA) console.log(`\n图标补全 JSON: ${(resultA.bytes / 1024).toFixed(1)} KB / ${resultA.items.length} 项\n`);

    // --- 收尾:shutdown + exit ---
    await client.request('shutdown', {}).catch(() => {});
    client.notify('exit', {});
    await waitChildExit(client.child, 3000);
    check('shutdown/exit 后服务器进程退出', client.child.exitCode !== null || client.closed);
  } finally {
    if (client && client.child.exitCode === null) {
      try {
        client.child.kill();
      } catch {
        /* ignore */
      }
    }
    try {
      for (const dir of [fixture, fixtureBad]) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不影响结论 */
    }
  }
}

function waitChildExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

main()
  .catch((err) => {
    failCount += 1;
    console.error(`FAIL: 测试执行异常: ${err && err.stack ? err.stack : err}`);
  })
  .then(() => {
    console.log('');
    if (failCount === 0) {
      console.log(`PASS: check-lsp-icons 全部通过(${passCount} 项断言)`);
      process.exit(0);
    } else {
      console.log(`FAIL: check-lsp-icons 存在失败(${passCount} 通过 / ${failCount} 失败)`);
      process.exit(1);
    }
  });
