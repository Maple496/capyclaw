import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { acquireLock } from './single-instance.mjs';
import { enforceRunInForeground } from './foreground-guard.mjs';

// ========== 前台运行守卫：强制在可见终端中运行 ==========
// 注意：当由统一的 ServiceManager 管理时，不需要守卫
// 因为 ServiceManager 已通过 detached: false 确保生命周期绑定
// 
// 守卫仅在直接运行时生效（手动启动、开发调试等场景）
const isDirectRun = !process.env.DSHD_MANAGED && process.stdout.isTTY === false;

if (isDirectRun) {
  enforceRunInForeground({
    serviceName: 'DeepSeek Harness Auth Proxy',
    strict: true,
    allowCI: false,
  });
}

const HERE = dirname(fileURLToPath(import.meta.url));
const CWD = process.cwd(); /* npm 安装形态：可写状态（workspace/锁）落调用目录，不落包内 node_modules */
/* 实例参数（env 可覆盖，缺省 = 实例 1）：同一 dsh 程序可拉起多个实例，
 * 每实例 = 自己的工作区（不同注入技能）+ 自己的 dsh 端口 + 自己的代理
 * 端口；DSH_PROFILE 用以区分 dsh profile（各自 profile 级 MCP 补丁）。 */
const WS_DIR = process.env.DSH_WORKSPACE || join(CWD, 'workspace');
const PROFILE = process.env.DSH_PROFILE || 'web';
/* dsh 入口解析：DSH_BIN 显式指定 → 与本包同装的 @deepseek-ai/dsh（peer）→
 * 旧目录布局（脚本与 node_modules 同级，dsh-runtime 时代）。
 * 收编进 npm 包后 HERE 在 node_modules 内，原 HERE 直连必不命中。 */
function resolveDshBin() {
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  try { return createRequire(import.meta.url).resolve('@deepseek-ai/dsh/lib/bin.js'); }
  catch { /* 未与 @deepseek-ai/dsh 同装 */ }
  return join(HERE, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}
const DSH_BIN = resolveDshBin();
/* 每个 runtime 一个锁文件；未设置时落调用目录全局锁。 */
const LOCK_FILE = process.env.DSH_LOCK_FILE || join(CWD, '.dsh-instance.lock');
/* 端口可经环境变量覆盖（缺省 = 桌面 .works 声明的地址对） */
const UP_HOST = '127.0.0.1';
const UP_PORT = Number(process.env.DSH_UP_PORT) || 3080;
const PROXY_PORT = Number(process.env.DSH_PROXY_PORT) || 3081;

let cookie = null;   /* 'dsh-auth-…=v1.…'（签发时绑定 127.0.0.1:3080 authority） */
let token = null;    /* 本次 dsh boot 的登录 token */
let exchanging = null;

/* 就绪闸：dsh 起来 + cookie 兑换完成之前，浏览器请求在服务端排队
 * （桌面作品打开即拉起服务，iframe 首个请求可能早于 dsh 监听——
 * 排队而非 502，首屏直出）。 */
let readyGateFired = false;
function readyGate(timeoutMs = 90000) {
    if (cookie)
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        const check = setInterval(() => {
            if (cookie) {
                clearInterval(check);
                clearTimeout(bail);
                resolve();
            }
        }, 200);
        const bail = setTimeout(() => {
            clearInterval(check);
            reject(new Error('harness 启动超时（90s）'));
        }, timeoutMs);
    });
}

const strip = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-connection', 'cookie', 'origin']);

function upstreamHeaders(src) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const key = k.toLowerCase();
    if (!strip.has(key) && v != null) out[key] = Array.isArray(v) ? v.join(', ') : v;
  }
  out.host = `${UP_HOST}:${UP_PORT}`;
  if (cookie) out.cookie = cookie;
  return out;
}

async function exchange() {
  if (!token) throw new Error('token 尚未从 dsh stdout 捕获');
  const res = await fetch(`http://${UP_HOST}:${UP_PORT}/?token=${encodeURIComponent(token)}`,
    { redirect: 'manual' });
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const pick = set.map(c => c.split(';')[0]).find(c => c.startsWith('dsh-auth'));
  if (res.status !== 303 || !pick) throw new Error(`token 兑换失败 HTTP ${res.status}`);
  cookie = pick;
  console.log('[proxy] 已取得 dsh 信任 cookie（浏览器侧无需登录）');
}

/* ---- 1. 启动 dsh web 子进程并抓 token ----
 * 内置 web profile 直接引导；非内置 profile（多实例）：目录不存在 =
 * 首次 --from-default-profile 自模板初始化，已初始化（有 dsh.profile）=
 * 普通引导。实例的 MCP 注入经 DSH_PROFILE_PATCH 指向的 patch 文件在
 * 初始化后拷入 profiles/<name>/cordis.patch.yml（web 模板 HMR 热加载）。 */
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
const PROFILE_PATCH = process.env.DSH_PROFILE_PATCH || '';
/* DSH_HOME 隔离（2026-10-21 多实例稳定性裁定）：每个实例可有独立的
 * profile/会话/工作区注册表；缺省仍为 ~/.dsh。 */
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE);
/* profile 目录存在 = 已初始化（普通引导）；不存在 = 首次自模板初始化。
 * （dsh 无 dsh.profile 标记文件，目录本身即初始化标记；--from-default-profile
 * 对已存在目录会报错，因此绝不能对已初始化 profile 重放。） */
const dshArgs = PROFILE === 'web' || existsSync(PROFILE_DIR)
    ? ['--profile', PROFILE, '--no-open']
    : ['--profile', PROFILE, '--from-default-profile', 'web', '--no-open'];
dshArgs.push('--port', String(UP_PORT));  /* dsh 缺省听 3080：多实例必须显式对齐上游端口 */
/* 首跑自举工作区：npm 形态下 DSH_WORKSPACE 缺省目录尚不存在，
 * spawn 的 cwd 缺失会以 ENOENT 误伤（报错指向 node.exe 本身）。 */
mkdirSync(WS_DIR, { recursive: true });
const child = spawn(process.execPath, [DSH_BIN, ...dshArgs], {
    cwd: WS_DIR, stdio: ['ignore', 'pipe', 'inherit'], env: process.env,
});
if (PROFILE !== 'web' && PROFILE_PATCH) {
    const t = setInterval(() => {
        if (!existsSync(PROFILE_DIR))
            return;
        clearInterval(t);
        try {
            copyFileSync(PROFILE_PATCH, join(PROFILE_DIR, 'cordis.patch.yml'));
            console.log('[proxy] 已注入实例 profile 补丁:', PROFILE_PATCH);
        }
        catch (e) {
            console.error('[proxy] profile 补丁注入失败:', e.message);
        }
    }, 500);
    setTimeout(() => clearInterval(t), 60000);
}
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  process.stdout.write('[dsh] ' + chunk);
  const m = /token=([A-Za-z0-9_-]+)/.exec(chunk);
  if (m && !token) {
    token = m[1];
    exchanging = exchange().catch((e) => console.error('[proxy] ' + e.message));
  }
});
child.on('exit', (code) => {
  console.error(`[proxy] dsh 子进程退出（code=${code}），代理随之关闭——请重新运行本脚本`);
  process.exit(1);
});
child.on('error', (e) => {
  console.error(`[proxy] 无法拉起 dsh（${e.message}）：请确认已安装 @deepseek-ai/dsh，或用 DSH_BIN 指定入口`);
  process.exit(1);
});
/* 代理被 SIGTERM/SIGKILL 之外的信号或异常带走时，子进程不留孤儿
 * （2026-10-21：孤儿 dsh 占住 3080 会让下一次拉起必失败 = 连接不上）。 */
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { child.kill(); } catch { /* 已退出 */ } process.exit(0); });
}
process.on('exit', () => { try { child.kill(); } catch { /* 已退出 */ } });

/* ---- 2/3. HTTP 代理（401 自动重兑换一次；GET/HEAD 可无伤重试） ---- */
function proxyGet(req, res) {
  const up = httpRequest({
    host: UP_HOST, port: UP_PORT, path: req.url, method: req.method,
    headers: upstreamHeaders(req.headers),
  });
  up.on('response', (ur) => {
    res.writeHead(ur.statusCode || 502, ur.headers);
    ur.pipe(res);
  });
  up.on('error', (e) => {
    /* 响应头已发出后 writeHead 会 throw ERR_HTTP_HEADERS_SENT，未捕获即
     * 整进程崩溃（2026-10-21 稳定性裁定）：已发出 = 只能掐断连接。 */
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('harness proxy error: ' + e.message);
  });
  up.end();
}

const server = createServer((req, res) => {
    readyGate().then(() => {
        const up = httpRequest({
            host: UP_HOST, port: UP_PORT, path: req.url, method: req.method,
            headers: upstreamHeaders(req.headers),
        });
        up.on('response', (ur) => {
            if (ur.statusCode === 401 && token && (req.method === 'GET' || req.method === 'HEAD')) {
                ur.resume();
                exchange()
                    .then(() => proxyGet(req, res))
                    .catch((e) => { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('harness re-auth failed: ' + e.message); });
                return;
            }
            res.writeHead(ur.statusCode || 502, ur.headers);
            ur.pipe(res);
        });
        up.on('error', (e) => {
          if (res.headersSent) { res.destroy(); return; }
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('harness proxy error: ' + e.message);
        });
        /* 客户端中断（刷新/关标签/切页）→ 销毁上游，避免半开连接堆积
         * 与「写已关闭响应」二次崩溃。 */
        res.on('close', () => { if (!up.destroyed) up.destroy(); });
        req.on('aborted', () => { if (!up.destroyed) up.destroy(); });
        req.pipe(up);
    }).catch((e) => {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('harness not ready: ' + e.message);
    });
});

/* ---- 4. WebSocket 隧道（upgrade 的 Connection/Upgrade 头必须保留） ---- */
server.on('upgrade', (req, socket, head) => {
    readyGate().then(() => {
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) {
            const key = k.toLowerCase();
            if (key === 'cookie' || key === 'origin' || key === 'host') continue;
            headers[key] = Array.isArray(v) ? v.join(', ') : v;
        }
        headers.host = `${UP_HOST}:${UP_PORT}`;
        if (cookie) headers.cookie = cookie;
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
        const upstream = netConnect(UP_PORT, UP_HOST, () => {
            upstream.write(lines.join('\r\n') + '\r\n\r\n');
            if (head?.length) upstream.write(head);
            upstream.pipe(socket);
            socket.pipe(upstream);
        });
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
    }).catch(() => socket.destroy());
});

server.on('error', (e) => {
  console.error(`[proxy] 监听失败（${PROXY_PORT}）：${e.message}——端口可能被另一个实例占用`);
  try { child.kill(); } catch { /* 已退出 */ }
  process.exit(1);
});

/* 单实例检查：同一个 runtime 只允许一个 auth-proxy；不同 runtime 用不同锁文件。 */
if (!acquireLock(LOCK_FILE)) {
  console.error('[proxy] 启动失败：已有另一个实例在运行');
  try { child.kill(); } catch { /* 已退出 */ }
  process.exit(1);
}

server.listen(PROXY_PORT, '127.0.0.1', () => {
  console.log(`[proxy] dsh 认证代理就绪：http://localhost:${PROXY_PORT}/（上游 ${UP_HOST}:${UP_PORT}，浏览器零登录）`);
});
