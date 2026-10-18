/*
 * E2E 用的极简 MQTT-over-WebSocket broker。
 *
 * 为什么要自带一个：真实的公共 broker 能用，但让测试依赖公网既慢又不可靠
 * （公共测试 broker 偶尔抖一下，测试就会假失败）。这里只用 node 内置模块
 * 手写 WebSocket 服务端 + MQTT 3.1.1 的最小语义，让 E2E 完全自洽：
 *   CONNECT → CONNACK，SUBSCRIBE → SUBACK，PUBLISH(QoS0) 转发给订阅者，
 *   PINGREQ → PINGRESP，DISCONNECT 关连接。
 *
 * 话题按精确匹配转发（游戏只用固定话题，不需要通配符）。
 */
import { createHash } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function attachMqttBroker(server, path = '/mqtt') {
  const clients = new Set();
  let delivered = 0;

  server.on('upgrade', (req, socket) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const key = req.headers['sec-websocket-key'];
    if (pathname !== path || !key) {
      socket.destroy();
      return;
    }

    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + accept,
      'Sec-WebSocket-Protocol: mqtt',
      '', ''
    ].join('\r\n'));
    socket.setNoDelay(true);

    const client = {
      socket,
      frame: Buffer.alloc(0),
      mqtt: Buffer.alloc(0),
      subscriptions: new Set()
    };
    clients.add(client);

    socket.on('data', (chunk) => {
      client.frame = Buffer.concat([client.frame, chunk]);
      drainFrames(client);
    });
    socket.on('close', () => clients.delete(client));
    socket.on('error', () => clients.delete(client));
  });

  function sendFrame(client, opcode, payload) {
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    client.socket.write(Buffer.concat([header, payload]));
  }

  function drainFrames(client) {
    for (;;) {
      const buffer = client.frame;
      if (buffer.length < 2) return;

      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      let mask = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) return;

      let payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      client.frame = Buffer.from(buffer.subarray(offset + length));

      if (opcode === 0x8) { client.socket.end(); return; }
      if (opcode === 0x9) { sendFrame(client, 0xa, payload); continue; }
      if (opcode === 0xa) continue;

      // 文本/二进制/续帧都当 MQTT 字节流处理：MQTT 报文可能跨 WebSocket 帧。
      client.mqtt = Buffer.concat([client.mqtt, payload]);
      drainMqtt(client);
    }
  }

  function drainMqtt(client) {
    for (;;) {
      const buffer = client.mqtt;
      if (buffer.length < 2) return;

      let multiplier = 1;
      let length = 0;
      let index = 1;
      let byte;
      for (;;) {
        if (index >= buffer.length) return;
        byte = buffer[index++];
        length += (byte & 0x7f) * multiplier;
        multiplier *= 128;
        if (!(byte & 0x80)) break;
      }
      if (buffer.length < index + length) return;

      const packet = { type: buffer[0] >> 4, body: buffer.subarray(index, index + length) };
      client.mqtt = Buffer.from(buffer.subarray(index + length));
      handlePacket(client, packet);
    }
  }

  function handlePacket(client, packet) {
    if (packet.type === 1) {                       // CONNECT
      sendFrame(client, 0x2, Buffer.from([0x20, 0x02, 0x00, 0x00]));   // CONNACK
      return;
    }

    if (packet.type === 8) {                       // SUBSCRIBE
      const body = packet.body;
      const packetId = body.subarray(0, 2);
      const granted = [];
      let offset = 2;
      while (offset + 3 <= body.length) {
        const topicLength = body.readUInt16BE(offset);
        offset += 2;
        if (offset + topicLength + 1 > body.length) break;
        const topic = body.toString('utf8', offset, offset + topicLength);
        offset += topicLength + 1;
        client.subscriptions.add(topic);
        granted.push(0x00);
      }
      sendFrame(client, 0x2, Buffer.from([0x90, 2 + granted.length, ...packetId, ...granted]));
      return;
    }

    if (packet.type === 3) {                       // PUBLISH (QoS0)
      const topicLength = packet.body.readUInt16BE(0);
      const topic = packet.body.toString('utf8', 2, 2 + topicLength);
      const payload = Buffer.from(packet.body.subarray(2 + topicLength));

      const topicBuf = Buffer.from(topic, 'utf8');
      const body = Buffer.concat([
        Buffer.from([topicBuf.length >> 8, topicBuf.length & 0xff]),
        topicBuf,
        payload
      ]);
      const frame = Buffer.concat([
        Buffer.from([0x30]),
        Buffer.from(encodeVarLen(body.length)),
        body
      ]);

      // 和真实 broker 一样：发布者自己订阅了也会收到（可以顺带暴露自收自发的 bug）。
      for (const peer of clients) {
        if (peer.subscriptions.has(topic)) {
          sendFrame(peer, 0x2, frame);
          delivered++;
        }
      }
      return;
    }

    if (packet.type === 12) {                      // PINGREQ
      sendFrame(client, 0x2, Buffer.from([0xd0, 0x00]));   // PINGRESP
      return;
    }

    if (packet.type === 14) {                      // DISCONNECT
      client.socket.end();
    }
  }

  return {
    get clientCount() { return clients.size; },
    get delivered() { return delivered; }
  };
}

function encodeVarLen(value) {
  const bytes = [];
  let rest = value;
  do {
    let byte = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest > 0);
  return bytes;
}