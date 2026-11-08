// build:app 的前置守卫:没有更新签名私钥就别开跑。
//
// 为什么需要:tauri build 会先编译 2-3 分钟,直到最后的 bundle 步骤才检查私钥,
// 然后报 "A public key has been found, but no private key"。那时候时间已经浪费了。
//
// 用法:由 npm 的 prebuild:app 自动执行,不需要手动调用。
// 通过条件:TAURI_SIGNING_PRIVATE_KEY 已设置(路径或内容均可)。
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const envKey = process.env.TAURI_SIGNING_PRIVATE_KEY;
if (envKey) process.exit(0);

const fallback = join(process.env.USERPROFILE || process.env.HOME || '', '.tauri', 'xuantie-foundry.key');
if (existsSync(fallback)) {
  console.error('');
  console.error('[build] 检测到签名私钥,但 TAURI_SIGNING_PRIVATE_KEY 没设置。');
  console.error('[build] 直接跑 npm run build:app 会在最后签名步骤失败(白编译 2-3 分钟)。');
  console.error('[build] 请改用一键脚本:  ide\\build.cmd');
  console.error('[build] 或手动: set TAURI_SIGNING_PRIVATE_KEY=' + fallback);
  console.error('[build] 或手动: set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=   (空密码,build.cmd 用 < nul 实现)');
  console.error('');
  process.exit(1);
}

console.error('');
console.error('[build] 既没有 TAURI_SIGNING_PRIVATE_KEY,也没有找到默认私钥:');
console.error('[build]   ' + fallback);
console.error('[build] 更新签名缺失会导致客户端拒绝自动更新;确认要出无签名包请临时设置该变量。');
console.error('');
process.exit(1);
