#!/usr/bin/env node
/** dsh-host —— DSH 宿主壳统一入口。
 *
 * 子命令即模块：动态 import 即执行（auth-proxy / start-safe 顶层即副作用，
 * 收编自 dsh-runtime 宿主壳时刻意保留原语义，不改造成可导出函数）。
 */
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const COMMANDS = {
  'auth-proxy': '零登录认证代理：拉起 dsh web、抓 boot token 换信任 cookie，浏览器免登录直连',
  'start-safe': '安全启动：端口体检清理 → 前台守卫 → 拉起 auth-proxy',
};

const help = () => {
  console.log('用法: dsh-host <command>');
  console.log('');
  console.log('命令:');
  for (const [name, desc] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(12)} ${desc}`);
  }
  console.log('');
  console.log('实例参数经环境变量注入：DSH_WORKSPACE / DSH_BIN / DSH_PROFILE / DSH_HOME /');
  console.log('DSH_UP_PORT / DSH_PROXY_PORT / DSH_LOCK_FILE / DSH_PID_FILE（缺省落调用目录），');
  console.log('详见 README。');
};

const [cmd] = process.argv.slice(2);
if (!cmd || cmd === '--help' || cmd === '-h') {
  help();
  process.exit(cmd ? 0 : 1);
}
if (!COMMANDS[cmd]) {
  console.error(`未知命令: ${cmd}`);
  console.error('');
  help();
  process.exit(1);
}

/* Windows 下动态 import 必须用 file:// URL（裸盘符路径会抛 ERR_UNSUPPORTED_ESM_URL_SCHEME） */
await import(pathToFileURL(join(HERE, '..', 'src', `${cmd}.mjs`)).href);
