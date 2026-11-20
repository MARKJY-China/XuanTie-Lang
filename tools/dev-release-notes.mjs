#!/usr/bin/env node
// dev Release 变更摘要:对比「当前 GitHub Latest Release」与本次 dev 构建提交。
// 输入 git 历史(workflow 需 fetch-depth: 0),输出一段 Markdown 追加到 Release 正文。
//
// 用法:
//   node tools/dev-release-notes.mjs --latest v1.0-rc.5 --head <sha> \
//     --version v1.0-rc.5-20261121.xxxxxxx --repo owner/repo --out dev-changes.md
// 没有 --latest/Release 时输出“首次 dev 构建,无 Latest 基线”的说明,不报错。
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

function arg(name, fallback = '') {
  const eq = process.argv.find((x) => x.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  // 空值在部分 shell 会被吞掉,不能把下一个 --flag 误当参数
  return process.argv[i + 1].startsWith('--') ? fallback : process.argv[i + 1];
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function short(sha) {
  return sha ? sha.slice(0, 7) : '';
}

const latest = arg('latest').trim();
const head = arg('head', process.env.GITHUB_SHA || 'HEAD').trim();
const version = arg('version').trim();
const repo = arg('repo', process.env.GITHUB_REPOSITORY || '').trim();
const out = arg('out', 'dev-changes.md').trim();

const lines = [];
const append = (...xs) => lines.push(...xs);

function commitLink(sha) {
  const label = '`' + short(sha) + '`';
  return repo ? `[${label}](https://github.com/${repo}/commit/${sha})` : label;
}

function classify(title) {
  const m = /^([a-zA-Z]+)(?:\([^)]*\))?!?:\s*(.*)$/.exec(title);
  if (!m) return { group: '其他改动', title };
  const kind = m[1].toLowerCase();
  if (kind === 'feat') return { group: '新增', title };
  if (kind === 'fix') return { group: '修复', title };
  if (kind === 'perf') return { group: '性能', title };
  if (kind === 'revert') return { group: '回滚', title };
  return { group: '其他改动', title };
}

let baseSha = '';
let baseNote = '';
if (latest) {
  try {
    baseSha = git(['rev-parse', `${latest}^{commit}`]);
  } catch (e) {
    console.error(`[dev-release-notes] 无法解析 Latest tag ${latest};请确认 fetch-depth:0 且 tag 已 fetch`);
    console.error(String(e.stderr || e.message || e));
    process.exit(1);
  }
} else {
  baseNote = '未找到 GitHub Latest Release(首次 dev 构建),无对比基线。';
}

let commits = [];
let rangeNote = '';
let headSha = '';
try {
  headSha = git(['rev-parse', `${head}^{commit}`]);
} catch {
  headSha = head;
}
if (baseSha) {
  const anc = spawnSync('git', ['merge-base', '--is-ancestor', baseSha, headSha], { stdio: 'ignore' });
  if (anc.status === 0) {
    const raw = git(['log', '--no-merges', '--reverse', '--pretty=format:%H%x09%s', `${baseSha}..${headSha}`]);
    commits = raw ? raw.split('\n').filter(Boolean).map((l) => {
      const [sha, ...rest] = l.split('\t');
      return { sha, title: rest.join('\t') };
    }) : [];
    if (commits.length === 0) rangeNote = `当前提交与 Latest 基线相同,无新增提交。`;
  } else {
    // 基线不是 HEAD 祖先(极少见:发布线被重写/交叉):按最近 100 个提交列出,明确标注
    const raw = git(['log', '--no-merges', '--max-count=100', '--reverse', '--pretty=format:%H%x09%s', headSha]);
    commits = raw ? raw.split('\n').filter(Boolean).map((l) => {
      const [sha, ...rest] = l.split('\t');
      return { sha, title: rest.join('\t') };
    }) : [];
    rangeNote = `Latest 基线 \`${latest}\` 不是当前提交的祖先,以下按最近 100 个提交列出。`;
  }
}
// 兜底再过滤掉合并/机器人发布噪声
commits = commits.filter((c) => c.title && !/^Merge\s/i.test(c.title) && !/^chore\(release\):/i.test(c.title));

append('### 对比 Latest', '');
if (baseNote) {
  append(`- **对比基线**:${baseNote}`);
} else {
  append(`- **对比基线**:\`${latest}\`(${commitLink(baseSha)})`);
}
if (version) append(`- **本 dev**:\`${version}\`(${commitLink(headSha)})`);
else append(`- **本 dev 提交**:${commitLink(headSha)}`);
append(`- **变更提交**:${commits.length} 个`);
if (rangeNote) append(`- ${rangeNote}`);
append('');

if (commits.length === 0) {
  append('> 无可列出的新增提交。');
} else {
  const groups = new Map();
  for (const c of commits) {
    const { group } = classify(c.title);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(c);
  }
  const order = ['新增', '修复', '性能', '回滚', '其他改动'];
  for (const g of order) {
    const items = groups.get(g);
    if (!items || items.length === 0) continue;
    append(`#### ${g}`, '');
    for (const c of items) append(`- ${commitLink(c.sha)} ${c.title}`);
    append('');
  }
}

writeFileSync(out, lines.join('\n') + '\n', 'utf8');
console.log(`[dev-release-notes] 已生成 ${out}: ${commits.length} 个提交,LATEST=${latest || '(none)'} (${short(baseSha) || '-'})`);
