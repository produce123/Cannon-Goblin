/*
 * 浏览器端 E2E：起一个临时静态服务器 + 一个内置的极简 MQTT broker，
 * 用无头 Chrome/Edge 加载 tests/browser/handshake.html。
 * 该页面会在两个同源 iframe 里各跑一份真实的 index.html，完整走一遍：
 *   在线大厅 → 房主建房拿到房间号 → 加入方输房间号进房 → 双方进准备界面
 *   → 房主选地图开始 → 双方走子同步 → 两条重开路径 → 再跑一遍强制中继模式
 *   → 本地/人机冒烟
 * 之所以必须用真浏览器：WebRTC 握手、DataChannel 同步、以及内联 onclick 里被吞掉的
 * async 报错，都只有真环境才暴露得出来。
 *
 * 用法:  node tests/browser/run.mjs  [浏览器可执行文件路径]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { attachMqttBroker } from './broker.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS = process.env.E2E_HARNESS || 'tests/browser/online.html';
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 180000);

const CANDIDATES = [
  process.argv[2],
  process.env.CHROME_PATH,
  join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
  join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

const browser = CANDIDATES.find((path) => existsSync(path));
if (!browser) {
  console.error('找不到 Chrome/Edge，请显式传入路径：node tests/browser/run.mjs <浏览器路径>');
  process.exit(2);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

let child = null;
let settled = false;
function finish(code) {
  if (settled) return;
  settled = true;
  console.log('内置 broker: 连接过 ' + broker.clientCount + ' 个客户端，转发 ' + broker.delivered + ' 条消息');
  try { server.close(); } catch { /* ignore */ }
  try { child?.kill(); } catch { /* ignore */ }
  process.exit(code);
}

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && (req.url === '/progress' || req.url === '/result')) {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url === '/progress') {
      console.log('  · ' + body);
      return res.end('ok');
    }
    const result = JSON.parse(body);
    console.log(result.ok ? '\n✅ 浏览器 E2E 通过：' + result.detail : '\n❌ 浏览器 E2E 失败：' + result.detail);
    res.end('ok');
    return setTimeout(() => finish(result.ok ? 0 : 1), 150);
  }

  let path = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  if (path === '/') path = '/' + HARNESS;
  const target = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]/, ''));
  if (!target.startsWith(ROOT + sep)) { res.writeHead(403); return res.end('denied'); }
  try {
    const data = await readFile(target);
    res.writeHead(200, { 'content-type': TYPES[extname(target)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const broker = attachMqttBroker(server, '/mqtt');
// 默认用内置 broker（快、不依赖公网）；E2E_PUBLIC=1 时改用 app 内置的公共 broker 列表。
const PUBLIC_BROKERS = process.env.E2E_PUBLIC === '1';
const url = `http://127.0.0.1:${server.address().port}/${HARNESS}${PUBLIC_BROKERS ? '?public=1' : ''}`;
console.log('浏览器 E2E: ' + browser);
console.log('中转 broker: ' + (PUBLIC_BROKERS ? '公共 broker（EMQX / HiveMQ）' : '内置 ws://127.0.0.1:' + server.address().port + '/mqtt'));
console.log('临时服务:  ' + url + '\n');

child = spawn(browser, [
  '--headless=new',
  '--disable-gpu',
  '--mute-audio',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate',
  // E2E_DSF=3 模拟高分屏手机，用来验证棋盘的 DPR 位图路径
  ...(process.env.E2E_DSF ? ['--force-device-scale-factor=' + process.env.E2E_DSF] : []),
  '--user-data-dir=' + join(tmpdir(), 'cannon-goblin-e2e-' + Date.now()),
  url
], { stdio: 'ignore' });

setTimeout(() => {
  console.error('\n❌ 超时：' + TIMEOUT_MS + 'ms 内没有拿到结果');
  finish(1);
}, TIMEOUT_MS);