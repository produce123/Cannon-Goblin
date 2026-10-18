/*
 * Cannon Goblin —— 极简 MQTT 3.1.1 over WebSocket 客户端
 *
 * 为什么需要它：WebRTC 只能解决"双方能直连"的情况。手机 5G、校园网、运营商网络
 * 大量处于对称 NAT / CGNAT 后面，打洞必然失败，而免费公共 TURN 已经不可用
 * （openrelay.metered.ca 域名失效，实测 0 个 relay 候选）。所以必须有一个
 * "双方都能连出去的公共中转点"，本文件就是把公共 MQTT broker 当成这个中转点。
 *
 * 只实现对局需要的部分：CONNECT / SUBSCRIBE / PUBLISH(QoS0) / PINGREQ，
 * 不引入任何第三方库（项目约定：零依赖、零构建、经典全局脚本）。
 */
(function (root) {
  'use strict';

  // 实测可用的公共 broker（都无需注册）。按顺序尝试，前一个连不上就换下一个。
  // 换自建 broker 也可以：用 URL 参数 ?brokers=wss://你的域名:8084/mqtt
  const DEFAULT_BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',      // 映云科技（国内厂商）
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://mqtt-dashboard.com:8884/mqtt'
  ];

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const KEEPALIVE_SECONDS = 45;
  const CONNECT_TIMEOUT_MS = 8000;
  const SUBSCRIBE_TIMEOUT_MS = 3000;

  const MQTT_SUBPROTOCOL = 'mqtt';

  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    if (root.crypto && typeof root.crypto.getRandomValues === 'function') {
      root.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return bytes;
  }

  /** MQTT 的变长整数（remaining length）。 */
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

  /** MQTT 字符串：2 字节大端长度 + UTF-8 内容。 */
  function encodeString(text) {
    const bytes = encoder.encode(text);
    if (bytes.length > 0xffff) throw new Error('字符串超出 MQTT 长度限制');
    return [bytes.length >> 8, bytes.length & 0xff, ...bytes];
  }

  function encodePacket(type, body) {
    return new Uint8Array([type, ...encodeVarLen(body.length), ...body]);
  }

  function buildConnect(clientId, keepalive = KEEPALIVE_SECONDS) {
    const body = [
      0, 4, 0x4d, 0x51, 0x54, 0x54,   // 协议名 "MQTT"
      4,                               // 协议级别 3.1.1
      0x02,                            // clean session
      keepalive >> 8, keepalive & 0xff,
      ...encodeString(clientId)
    ];
    return encodePacket(0x10, body);
  }

  function buildSubscribe(packetId, topic) {
    const body = [packetId >> 8, packetId & 0xff, ...encodeString(topic), 0x00]; // QoS 0
    return encodePacket(0x82, body);
  }

  function buildPublish(topic, text) {
    const body = [...encodeString(topic), ...encoder.encode(text)];
    return encodePacket(0x30, body); // QoS 0、不 retain（避免公共 broker 残留旧会话）
  }

  const buildPingReq = () => new Uint8Array([0xc0, 0x00]);
  const buildDisconnect = () => new Uint8Array([0xe0, 0x00]);

  /**
   * 从字节流里切出完整报文，返回未消费的剩余部分（WebSocket 分片会切开报文）。
   */
  function decodePackets(buffer) {
    const packets = [];
    let offset = 0;

    for (;;) {
      if (buffer.length - offset < 2) break;

      let multiplier = 1;
      let length = 0;
      let index = offset + 1;
      let byte;

      for (;;) {
        if (index >= buffer.length) return { packets, rest: buffer.slice(offset) };
        byte = buffer[index++];
        length += (byte & 0x7f) * multiplier;
        multiplier *= 128;
        if (!(byte & 0x80)) break;
        if (multiplier > 128 * 128 * 128) throw new Error('报文长度字段非法');
      }

      const end = index + length;
      if (buffer.length < end) return { packets, rest: buffer.slice(offset) };

      packets.push({ type: buffer[offset] >> 4, body: buffer.slice(index, end) });
      offset = end;
    }

    return { packets, rest: buffer.slice(offset) };
  }

  function parsePublish(body) {
    const topicLength = (body[0] << 8) | body[1];
    return {
      topic: decoder.decode(body.slice(2, 2 + topicLength)),
      payload: decoder.decode(body.slice(2 + topicLength))
    };
  }

  class MqttClient {
    constructor(url) {
      this.url = url;
      this.ws = null;
      this.buffer = new Uint8Array(0);
      this.nextPacketId = 1;
      this.onMessage = null;   // (topic, payload) => void
      this.onClose = null;
      this._connected = false;
      this._pingTimer = null;
      this._subackWaiters = [];
      this._onConnack = null;
      this._onConnackFail = null;
    }

    connect(timeoutMs = CONNECT_TIMEOUT_MS) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };

        let ws;
        try {
          ws = new WebSocket(this.url, MQTT_SUBPROTOCOL);
        } catch {
          return reject(new Error('无法连接中转服务器'));
        }
        ws.binaryType = 'arraybuffer';
        this.ws = ws;

        const timer = setTimeout(() => {
          settle(() => { this.close(); reject(new Error('连接中转服务器超时')); });
        }, timeoutMs);

        this._onConnack = () => {
          this._connected = true;
          this._startPing();
          settle(resolve);
        };
        this._onConnackFail = (code) => {
          settle(() => { this.close(); reject(new Error('中转服务器拒绝接入 (rc=' + code + ')')); });
        };

        ws.onopen = () => {
          const clientId = 'cg-' + Array.from(randomBytes(6), (b) => b.toString(16).padStart(2, '0')).join('');
          ws.send(buildConnect(clientId));
        };
        ws.onerror = () => {
          settle(() => reject(new Error('中转服务器连接失败')));
        };
        ws.onclose = () => {
          const wasConnected = this._connected;
          this._connected = false;
          this._stopPing();
          if (settled) {
            if (wasConnected) this.onClose?.();
          } else {
            settle(() => reject(new Error('中转服务器连接中断')));
          }
        };
        ws.onmessage = (event) => this._feed(new Uint8Array(event.data));
      });
    }

    subscribe(topic) {
      if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('尚未连接中转服务器'));
      const packetId = this.nextPacketId++;
      this.ws.send(buildSubscribe(packetId, topic));

      // 没有 SUBACK 也先放行：公共 broker 偶尔不回，硬等反而卡住流程。
      return new Promise((resolve) => {
        const waiter = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          const index = this._subackWaiters.indexOf(waiter);
          if (index >= 0) this._subackWaiters.splice(index, 1);
          resolve();
        }, SUBSCRIBE_TIMEOUT_MS);
        this._subackWaiters.push(waiter);
      });
    }

    /** broker 连接现在能不能真的发消息（掉线时 room.js 要靠它决定还能不能改走中继）。 */
    isConnected() {
      return this._connected && !!this.ws && this.ws.readyState === 1;
    }

    publish(topic, text) {
      if (!this.ws || this.ws.readyState !== 1) return false;
      try {
        this.ws.send(buildPublish(topic, text));
        return true;
      } catch {
        return false;
      }
    }

    close() {
      this._stopPing();
      this._connected = false;
      if (this.ws) {
        try { if (this.ws.readyState === 1) this.ws.send(buildDisconnect()); } catch { /* 已断开 */ }
        try { this.ws.close(); } catch { /* 已断开 */ }
        this.ws = null;
      }
    }

    _startPing() {
      this._stopPing();
      this._pingTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === 1) {
          try { this.ws.send(buildPingReq()); } catch { /* 已断开 */ }
        }
      }, (KEEPALIVE_SECONDS * 1000) / 2);
    }

    _stopPing() {
      if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    }

    _feed(chunk) {
      const merged = new Uint8Array(this.buffer.length + chunk.length);
      merged.set(this.buffer);
      merged.set(chunk, this.buffer.length);

      let decoded;
      try {
        decoded = decodePackets(merged);
      } catch {
        return; // 脏数据直接丢弃，别让对局崩掉
      }
      this.buffer = decoded.rest;
      for (const packet of decoded.packets) this._dispatch(packet);
    }

    _dispatch(packet) {
      if (packet.type === 2) {              // CONNACK
        const code = packet.body[1];
        if (code === 0) this._onConnack?.();
        else this._onConnackFail?.(code);
      } else if (packet.type === 9) {       // SUBACK
        this._subackWaiters.shift()?.();
      } else if (packet.type === 3) {       // PUBLISH
        const { topic, payload } = parsePublish(packet.body);
        this.onMessage?.(topic, payload);
      }
    }
  }

  root.CannonMqtt = {
    MqttClient,
    DEFAULT_BROKERS,
    MQTT_SUBPROTOCOL,
    encodeVarLen,
    encodeString,
    encodePacket,
    buildConnect,
    buildSubscribe,
    buildPublish,
    buildPingReq,
    buildDisconnect,
    decodePackets,
    parsePublish
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);