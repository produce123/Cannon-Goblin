import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// 浏览器脚本没有模块导出，这里用 vm 沙箱按 index.html 的顺序加载它们。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadSandbox() {
  const sandbox = {
    console, TextEncoder, TextDecoder, setTimeout, clearTimeout,
    URLSearchParams, crypto: globalThis.crypto
  };
  vm.createContext(sandbox);
  for (const file of ['js/game.js', 'js/mqtt.js', 'js/room.js']) {
    vm.runInContext(readFileSync(join(ROOT, file), 'utf8'), sandbox, { filename: file });
  }
  vm.runInContext(
    'globalThis.__api = { GameState, EMPTY, CANNON, GHOST, CannonMqtt, CannonRoom };',
    sandbox
  );
  return sandbox.__api;
}

const { GameState, CANNON, GHOST, CannonMqtt, CannonRoom } = loadSandbox();

// 沙箱里的对象来自另一个 realm，原型不同会让严格深比较失败，先转成本 realm 的普通对象。
const plain = (value) => JSON.parse(JSON.stringify(value));

// ---------- MQTT 报文编解码（联机中转的基础） ----------

test('CONNECT 报文编码正确（协议名 / 级别 / clean session / keepalive / clientId）', () => {
  const packet = CannonMqtt.buildConnect('cg-test', 45);

  assert.equal(packet[0], 0x10, 'CONNECT 固定头');
  assert.deepEqual(Array.from(packet.slice(2, 8)), [0x00, 0x04, 0x4d, 0x51, 0x54, 0x54], '协议名应为 MQTT');
  assert.equal(packet[8], 4, '协议级别应为 3.1.1');
  assert.equal(packet[9], 0x02, '应为 clean session');
  assert.equal((packet[10] << 8) | packet[11], 45, 'keepalive 应写入');
  assert.equal((packet[12] << 8) | packet[13], 7, 'clientId 长度前缀');
  assert.equal(Buffer.from(packet.slice(14)).toString('utf8'), 'cg-test');
});

test('SUBSCRIBE 报文指向目标话题（QoS 0）', () => {
  const packet = CannonMqtt.buildSubscribe(7, 'cannongoblin/v1/ABC234/h2g');
  assert.equal(packet[0], 0x82);
  assert.equal((packet[2] << 8) | packet[3], 7, 'packetId 应写入');

  const topicLength = (packet[4] << 8) | packet[5];
  assert.equal(Buffer.from(packet.slice(6, 6 + topicLength)).toString('utf8'), 'cannongoblin/v1/ABC234/h2g');
  assert.equal(packet[6 + topicLength], 0x00, '请求 QoS 0');
});

test('PUBLISH 报文（长度字段跨字节）能被同协议的解析器无损还原', () => {
  const topic = 'cannongoblin/v1/ABC234/h2g';
  // 真实 SDP 有 1~2KB，长度字段必须是多字节的变长整数
  const sdp = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\n' +
    'a=fingerprint:sha-256 ' + 'AB:CD:EF:01:23:45:67:89'.repeat(6) + '\r\n' +
    ('a=candidate:1 1 udp 2113937151 192.168.1.5 54321 typ host\r\n').repeat(4);
  const payload = JSON.stringify({ type: 'offer', sdp });
  const packet = CannonMqtt.buildPublish(topic, payload);

  assert.equal(packet[0], 0x30, 'PUBLISH 固定头');
  assert.ok(packet.length > 127, '这条报文应当需要多字节长度字段');
  assert.ok((packet[1] & 0x80) !== 0, '长度字段第一个字节应带续位标志');

  const { packets, rest } = CannonMqtt.decodePackets(packet);
  assert.equal(rest.length, 0, '不应有剩余字节');
  assert.equal(packets.length, 1);
  assert.equal(packets[0].type, 3);

  const parsed = CannonMqtt.parsePublish(packets[0].body);
  assert.equal(parsed.topic, topic);
  assert.equal(parsed.payload, payload);
});

test('decodePackets 能把跨分片的字节流拼回完整报文', () => {
  const ping = CannonMqtt.buildPingReq();
  const publish = CannonMqtt.buildPublish('topic/x', 'hello');
  const stream = new Uint8Array([...ping, ...publish]);

  // 只喂前 3 字节：PINGREQ 完整，PUBLISH 只到了固定头
  const first = CannonMqtt.decodePackets(stream.slice(0, 3));
  assert.equal(first.packets.length, 1);
  assert.equal(first.packets[0].type, 12, 'PINGREQ');
  assert.equal(first.rest.length, 1, '剩下的半个报文必须留着');

  const second = CannonMqtt.decodePackets(new Uint8Array([...first.rest, ...stream.slice(3)]));
  assert.equal(second.packets.length, 1);
  assert.equal(second.packets[0].type, 3);
  assert.equal(second.rest.length, 0);
  assert.deepEqual(plain(CannonMqtt.parsePublish(second.packets[0].body)), { topic: 'topic/x', payload: 'hello' });
});

test('长度字段没读全时不吐出半个报文', () => {
  const packet = CannonMqtt.buildPublish('t', 'x'.repeat(200));
  const partial = packet.slice(0, 2);   // 固定头 + 一个带续位标志的长度字节

  const decoded = CannonMqtt.decodePackets(partial);
  assert.equal(decoded.packets.length, 0);
  assert.equal(decoded.rest.length, partial.length, '未消费的字节必须原样保留');
});

// ---------- 房间号 ----------

test('房间号是 6 位，且不含 0/O/1/I/L 这类易混字符', () => {
  for (let i = 0; i < 300; i++) {
    const code = CannonRoom.generateRoomCode();
    assert.equal(code.length, 6);
    assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    assert.doesNotMatch(code, /[0O1IL]/);
  }
});

test('房间号输入归一化：转大写、剔除字母表外字符、最多 6 位', () => {
  assert.equal(CannonRoom.normalizeRoomCode('abc234'), 'ABC234');
  assert.equal(CannonRoom.normalizeRoomCode(' a b c 2 3 4 '), 'ABC234');
  assert.equal(CannonRoom.normalizeRoomCode('ab-12il'), 'AB2', '1/i/l 不属于字母表');
  assert.equal(CannonRoom.normalizeRoomCode('ABCDEFGHJKM'), 'ABCDEF', '超出 6 位要截断');
  assert.equal(CannonRoom.normalizeRoomCode('0O1IL'), '');
  assert.equal(CannonRoom.normalizeRoomCode(null), '');
  assert.equal(CannonRoom.normalizeRoomCode(undefined), '');
});

// ---------- 房间话题与定向投递 ----------

test('房主与加入方的话题方向相反且严丝合缝（自己不会收到自己发的消息）', () => {
  const host = new CannonRoom.GameRoom();
  host.role = 'host';
  host.code = 'ABC234';
  host._setTopics();

  const guest = new CannonRoom.GameRoom();
  guest.role = 'guest';
  guest.code = 'ABC234';
  guest._setTopics();

  assert.ok(host._inTopic.endsWith('/g2h'));
  assert.ok(host._outTopic.endsWith('/h2g'));
  assert.notEqual(host._inTopic, host._outTopic, '同一个人不能既订阅又发布同一话题');
  assert.equal(guest._inTopic, host._outTopic, '一方发布的必须是另一方订阅的');
  assert.equal(guest._outTopic, host._inTopic);
  assert.ok(host._inTopic.startsWith(CannonRoom.TOPIC_ROOT + '/ABC234/'));
});

/** 构造一个不真的连 broker 的房间，只测消息编址。 */
function fakeRoom(role, code, sid) {
  const room = new CannonRoom.GameRoom();
  room.role = role;
  room.code = code;
  room.sid = sid || null;
  room._setTopics();
  room.transport = 'relay';
  room.published = [];
  room.mqtt = {
    publish: (topic, payload) => { room.published.push({ topic, payload }); return true; }
  };
  room.received = [];
  room.handlers = { onMessage: (message) => room.received.push(message) };
  return room;
}

test('中继模式下房主发出的消息带对手 sid；busy 的 sid 不会被覆盖', () => {
  const host = fakeRoom('host', 'ABC234');
  host._guestSid = 'deadbeef';

  host.send('move', { fromR: 1, fromC: 1, toR: 2, toC: 1 });
  assert.equal(host.published.length, 1);
  assert.equal(host.published[0].topic, host._outTopic);
  assert.deepEqual(plain(JSON.parse(host.published[0].payload)),
    { type: 'move', fromR: 1, fromC: 1, toR: 2, toC: 1, sid: 'deadbeef' });

  // 多出来的加入方触发的 busy 是发给"他"的，不能把 sid 改成房里对手的
  host._publish({ type: 'busy', sid: 'othersid' });
  assert.equal(JSON.parse(host.published[1].payload).sid, 'othersid');
});

test('加入方丢弃 sid 对不上的消息，只接收发给自己的（防止公共话题上误收别人的信令）', () => {
  const guest = fakeRoom('guest', 'ABC234', 'mine');

  guest._onWire(JSON.stringify({ type: 'move', sid: 'someone-else', toR: 9, toC: 9 }));
  guest._onWire(JSON.stringify({ type: 'transport', mode: 'relay', sid: 'someone-else' }));
  guest._onWire(JSON.stringify({ type: 'move', sid: 'mine', toR: 2, toC: 2 }));

  assert.equal(guest.received.length, 1, '只有 sid 匹配的对局消息能进来');
  assert.equal(guest.received[0].toR, 2);
  assert.equal(guest.transport, 'relay', '别人的 transport 决定不能生效');
});

test('房主对第二个加入方回 busy，对同一个加入方的重试保持沉默', () => {
  const host = fakeRoom('host', 'ABC234');
  host._guestSid = 'first';
  host.transport = 'p2p';

  host._onWire(JSON.stringify({ type: 'join', sid: 'first' }));     // 同一个人的重试
  assert.equal(host.published.length, 0, '重试应被静默忽略');

  host._onWire(JSON.stringify({ type: 'join', sid: 'second' }));    // 后来者
  assert.equal(host.published.length, 1);
  assert.deepEqual(plain(JSON.parse(host.published[0].payload)), { type: 'busy', sid: 'second' });
  assert.equal(host._guestSid, 'first', '房里原有的对手不能被顶掉');
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