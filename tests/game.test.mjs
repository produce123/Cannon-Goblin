import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// 浏览器脚本没有模块导出，这里用 vm 沙箱按 index.html 的顺序加载它们。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadSandbox() {
  const sandbox = { console, TextEncoder, TextDecoder, btoa, atob, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  for (const file of ['js/game.js', 'js/webrtc.js']) {
    vm.runInContext(readFileSync(join(ROOT, file), 'utf8'), sandbox, { filename: file });
  }
  vm.runInContext(
    'globalThis.__api = { GameState, EMPTY, CANNON, GHOST, CannonSignaling, CannonWebRTC };',
    sandbox
  );
  return sandbox.__api;
}

const { GameState, CANNON, GHOST, CannonSignaling, CannonWebRTC } = loadSandbox();

// 沙箱里的对象来自另一个 realm，原型不同会让严格深比较失败，先转成本 realm 的普通对象。
const plain = (value) => JSON.parse(JSON.stringify(value));

// ---------- 信令编解码 ----------

test('邀请码/应答码可无损往返，且只包含可粘贴字符', () => {
  const sdp = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\n' +
    'a=ice-ufrag:Ab3/xY\r\na=fingerprint:sha-256 AB:CD:EF\r\n';

  for (const type of ['offer', 'answer']) {
    const code = CannonSignaling.encodeDescription({ type, sdp });
    assert.ok(code.startsWith(CannonWebRTC.CODE_PREFIX), '邀请码应带协议前缀');
    assert.match(code, /^CG1\.[A-Za-z0-9+/=]+$/, '邀请码应只含 base64 字符，便于聊天工具转发');
    assert.deepEqual(plain(CannonSignaling.decodeDescription(code)), { type, sdp });
  }
});

test('解析容忍聊天工具插入的换行、空格与零宽字符', () => {
  const expected = { type: 'offer', sdp: 'v=0\r\na=mid:0\r\n' };
  const code = CannonSignaling.encodeDescription(expected);

  const chunks = code.slice(4).replace(/(.{40})/g, '$1\n\u200b');
  const mangled = '  ' + chunks + '\n\n';
  assert.deepEqual(plain(CannonSignaling.decodeDescription(mangled)), expected);

  // 前缀被聊天工具吃掉时也应能解析
  assert.deepEqual(plain(CannonSignaling.decodeDescription(code.replace('CG1.', ''))), expected);
});

test('可直接粘贴 JSON 原文（便于调试）', () => {
  const expected = { type: 'answer', sdp: 'v=0\r\n' };
  const raw = JSON.stringify({ v: 1, type: expected.type, sdp: expected.sdp });
  assert.deepEqual(plain(CannonSignaling.decodeDescription(raw)), expected);
});

test('拒绝空码、乱码、被截断的码与错误类型', () => {
  assert.throws(() => CannonSignaling.decodeDescription(''), /代码为空/);
  assert.throws(() => CannonSignaling.decodeDescription('   '), /代码为空/);
  assert.throws(() => CannonSignaling.decodeDescription('这不是邀请码'));

  const code = CannonSignaling.encodeDescription({ type: 'offer', sdp: 'v=0\r\n' });
  assert.throws(() => CannonSignaling.decodeDescription(code.slice(0, code.length - 8)));

  const wrongType = 'CG1.' + Buffer.from(JSON.stringify({ v: 1, type: 'candidate', sdp: 'x' })).toString('base64');
  assert.throws(() => CannonSignaling.decodeDescription(wrongType), /类型不正确/);
});

// ---------- 对局规则（双方本地重放的一致性前提） ----------

test('大炮隔着恰好一个空格可吃小鬼，中间有子则不能吃', () => {
  const open = new GameState(6, 6);
  open.placeCannon(0, 0);
  open.placeGhost(2, 0);
  assert.deepEqual(plain(open.getAllMoves(0, 0).filter(m => m.capture)), [{ r: 2, c: 0, capture: true }]);

  const blocked = new GameState(6, 6);
  blocked.placeCannon(0, 0);
  blocked.placeGhost(1, 0);
  blocked.placeGhost(2, 0);
  assert.equal(blocked.getAllMoves(0, 0).filter(m => m.capture).length, 0);

  const tooFar = new GameState(6, 6);
  tooFar.placeCannon(0, 0);
  tooFar.placeGhost(3, 0);
  assert.equal(tooFar.getAllMoves(0, 0).filter(m => m.capture).length, 0);
});

test('小鬼数 <= 大炮数时判大炮获胜', () => {
  const gs = new GameState(5, 5);
  gs.placeCannon(0, 0);
  gs.placeCannon(0, 1);
  gs.placeGhost(2, 0);
  gs.placeGhost(4, 4);

  assert.ok(gs.selectPiece(0, 0));
  assert.ok(gs.movePiece(1, 0));
  assert.equal(gs.gameOver, true);
  assert.equal(gs.winner, CANNON);
});

test('双方各自本地重放同一串走子后局面完全一致（在线同步不变量）', () => {
  const build = () => {
    const gs = new GameState(6, 6);
    gs.placeCannon(5, 2);
    gs.placeCannon(5, 3);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) gs.placeGhost(r, c);
    return gs;
  };

  const host = build();
  const guest = build();

  // 模拟：一方走子 -> 通过网络只发 from/to -> 对方本地重放
  const moves = [[5, 2, 4, 2], [2, 0, 3, 0], [5, 3, 4, 3], [2, 1, 3, 1]];
  for (const [fromR, fromC, toR, toC] of moves) {
    assert.equal(host.currentTurn, guest.currentTurn, '走子前双方轮次必须一致');

    for (const gs of [host, guest]) {
      assert.ok(gs.selectPiece(fromR, fromC), `(${fromR},${fromC}) 应可选中`);
      assert.ok(gs.movePiece(toR, toC), `(${fromR},${fromC})->(${toR},${toC}) 应可走`);
    }
  }

  assert.deepEqual(host.board, guest.board);
  assert.equal(host.currentTurn, guest.currentTurn);
  assert.equal(host.gameOver, guest.gameOver);
});

test('吃子同样能在双方本地重放出一致局面', () => {
  const build = () => {
    const gs = new GameState(6, 6);
    gs.placeCannon(0, 0);
    gs.placeGhost(2, 0);
    gs.placeGhost(0, 3);
    gs.placeGhost(1, 3);
    gs.placeGhost(2, 3);
    gs.placeGhost(3, 3);
    return gs;
  };

  const host = build();
  const guest = build();

  for (const gs of [host, guest]) {
    assert.ok(gs.selectPiece(0, 0));
    const result = gs.movePiece(2, 0);
    assert.equal(result.captured, true);
  }

  assert.equal(host.getPiece(2, 0), CANNON);
  assert.equal(host.countGhosts(), 4);
  assert.deepEqual(host.board, guest.board);
  assert.equal(host.currentTurn, GHOST);
  assert.equal(guest.currentTurn, GHOST);
});