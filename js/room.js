/*
 * Cannon Goblin —— 联机房间层
 *
 * 设计目标（玩家没有公网 IP、也没有服务器）：
 *
 *   1. 房间号是一个 6 位短码，B 输入即进，不需要回传任何东西。
 *   2. 连接失败率必须是 0：手机 5G / 校园网 / 运营商网络都在对称 NAT 后面，
 *      而免费公共 TURN 已不可用，所以"打不通"必须有兜底。
 *
 * 因此握手和数据分两层：
 *
 *   - 公共 MQTT broker 当房间与信令通道（双方都只是"往外连"，与 NAT 无关）。
 *   - 双方还能直连时，对局数据优先走 WebRTC DataChannel（延时最低）。
 *   - 直连打不通就由房主决定改用 MQTT 中继，双方行为一致，不会各走一半。
 *
 * 话题方向（避免自己收到自己发的消息）：
 *   房主 订阅 <root>/<code>/g2h，发布 <root>/<code>/h2g
 *   加入 订阅 <root>/<code>/h2g，发布 <root>/<code>/g2h
 */
(function (root) {
  'use strict';

  // 排除易混字符 0/O/1/I/L，房间号要能口头念、能手打。
  const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const ROOM_CODE_LENGTH = 6;
  const TOPIC_ROOT = 'cannongoblin/v1';

  // 直连等待上限：超过就判定打不通，改用中继。
  const P2P_WAIT_MS = 6000;
  // 等房主回应的上限，避免输错房间号后一直转圈。
  const JOIN_TIMEOUT_MS = 20000;
  const ICE_GATHER_TIMEOUT_MS = 5000;

  // 公共 STUN 只用于探路，不中转数据；打不通时由中继兜底，所以不需要 TURN。
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];

  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    if (root.crypto && typeof root.crypto.getRandomValues === 'function') {
      root.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return bytes;
  }

  function generateRoomCode() {
    const bytes = randomBytes(ROOM_CODE_LENGTH);
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
    }
    return code;
  }

  /**
   * 加入方的会话标识。
   * 公共话题上可能同时有别人在听：房主发给"某个加入方"的信令必须带 sid，
   * 否则已经在房里的对手会误收（例如多出来的加入方触发的 busy）。
   */
  function randomToken(byteLength) {
    return Array.from(randomBytes(byteLength), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** 宽容地把玩家输入变成标准房间号：转大写、去掉字母表外的字符。 */
  function normalizeRoomCode(input) {
    if (typeof input !== 'string') return '';
    return input
      .toUpperCase()
      .split('')
      .filter((ch) => ROOM_CODE_ALPHABET.includes(ch))
      .join('')
      .slice(0, ROOM_CODE_LENGTH);
  }

  /** 调试/测试用：?transport=relay 可以强制走中继，用来排查直连问题。 */
  function resolveForcedTransport() {
    try {
      const mode = new URLSearchParams(root.location?.search || '').get('transport');
      return mode === 'relay' ? 'relay' : null;
    } catch {
      return null;
    }
  }

  /** 允许自建 broker：?brokers=wss://host:8084/mqtt,wss://host2/mqtt */
  function resolveBrokers() {
    try {
      const param = new URLSearchParams(root.location?.search || '').get('brokers');
      const list = param ? param.split(',').map((s) => s.trim()).filter(Boolean) : null;
      if (list && list.length) return list;
    } catch { /* 用默认列表 */ }
    return root.CannonMqtt.DEFAULT_BROKERS.slice();
  }

  /* ------------------------------------------------------------------ *
   * WebRTC 直连（只在真的能连通时才起作用）
   * ------------------------------------------------------------------ */

  class P2PConnection {
    constructor(handlers = {}) {
      this.handlers = handlers;
      this.pc = null;
      this.channel = null;
      this._openWaiters = [];
    }

    isOpen() {
      return !!this.channel && this.channel.readyState === 'open';
    }

    _settleOpenWaiters(value) {
      const waiters = this._openWaiters;
      this._openWaiters = [];
      for (const resolve of waiters) resolve(value);
    }

    _createPeerConnection() {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pc.onconnectionstatechange = () => {
        // 直连彻底失败时立刻放行等待者，不必干等到超时。
        if (pc.connectionState === 'failed' && !this.isOpen()) this._settleOpenWaiters(false);
      };
      return pc;
    }

    _bindChannel(channel) {
      channel.onopen = () => {
        this._settleOpenWaiters(true);
        this.handlers.onOpen?.();
      };
      channel.onclose = () => {
        this._settleOpenWaiters(false);
        this.handlers.onClose?.();
      };
      channel.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return; // 脏消息丢弃
        }
        this.handlers.onMessage?.(message);
      };
    }

    _waitForIceGathering(pc) {
      return new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve();
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          pc.removeEventListener('icegatheringstatechange', onChange);
          clearTimeout(timer);
          resolve();
        };
        const onChange = () => {
          if (pc.iceGatheringState === 'complete') finish();
        };
        pc.addEventListener('icegatheringstatechange', onChange);
        // 超时就用已收集到的候选出牌，避免个别网络下无限等待。
        const timer = setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
      });
    }

    async createOffer() {
      this.pc = this._createPeerConnection();
      this.channel = this.pc.createDataChannel('cannon-goblin', { ordered: true });
      this._bindChannel(this.channel);
      await this.pc.setLocalDescription(await this.pc.createOffer());
      await this._waitForIceGathering(this.pc);
      return { type: this.pc.localDescription.type, sdp: this.pc.localDescription.sdp };
    }

    async acceptOffer(offer) {
      this.pc = this._createPeerConnection();
      this.pc.ondatachannel = (event) => {
        this.channel = event.channel;
        this._bindChannel(event.channel);
      };
      await this.pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      await this._waitForIceGathering(this.pc);
      return { type: this.pc.localDescription.type, sdp: this.pc.localDescription.sdp };
    }

    async acceptAnswer(answer) {
      if (!this.pc) throw new Error('直连尚未开始');
      await this.pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    }

    waitForOpen(timeoutMs) {
      if (this.isOpen()) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this._openWaiters = this._openWaiters.filter((w) => w !== onOpen);
          resolve(false);
        }, timeoutMs);
        const onOpen = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        this._openWaiters.push(onOpen);
      });
    }

    send(message) {
      if (!this.isOpen()) return false;
      try {
        this.channel.send(JSON.stringify(message));
        return true;
      } catch {
        return false;
      }
    }

    close() {
      this._settleOpenWaiters(false);
      try { this.channel?.close(); } catch { /* 已关闭 */ }
      try { this.pc?.close(); } catch { /* 已关闭 */ }
      this.channel = null;
      this.pc = null;
    }
  }

  /* ------------------------------------------------------------------ *
   * 房间
   * ------------------------------------------------------------------ */

  class GameRoom {
    /**
     * @param {{onStatus?:Function,onReady?:Function,onMessage?:Function,onError?:Function,onClosed?:Function}} handlers
     */
    constructor(handlers = {}) {
      this.handlers = handlers;
      this.role = null;
      this.code = null;
      this.transport = null;      // 'p2p' | 'relay'
      this.mqtt = null;
      this.peer = null;
      this.closed = false;
      this.brokers = resolveBrokers();
      this.forcedTransport = resolveForcedTransport();
      this._inTopic = null;
      this._outTopic = null;
      this._negotiating = false;
      this._joinTimer = null;
      this.sid = null;            // 加入方的会话标识（房主用它定向回话）
      this._guestSid = null;      // 房主记住的当前对手
    }

    /** 房主建房间，返回房间号。 */
    async host() {
      this.role = 'host';
      this.code = generateRoomCode();
      this._setTopics();
      this.mqtt = await this._connectBroker();
      this.mqtt.onMessage = (topic, payload) => this._onWire(payload);
      await this.mqtt.subscribe(this._inTopic);
      this.handlers.onStatus?.({ phase: 'waiting', code: this.code });
      return this.code;
    }

    /** 加入别人的房间。 */
    async join(code) {
      this.role = 'guest';
      this.sid = randomToken(6);
      this.code = normalizeRoomCode(code);
      if (this.code.length !== ROOM_CODE_LENGTH) {
        throw new Error('房间号应为 ' + ROOM_CODE_LENGTH + ' 位');
      }
      this._setTopics();
      this.mqtt = await this._connectBroker();
      this.mqtt.onMessage = (topic, payload) => this._onWire(payload);
      await this.mqtt.subscribe(this._inTopic);

      this.handlers.onStatus?.({ phase: 'joining', code: this.code });
      this._publish({ type: 'join', sid: this.sid });

      this._joinTimer = setTimeout(() => {
        if (!this.transport) {
          this.handlers.onError?.(new Error('没有找到这个房间：请核对房间号，或让房主重新创建'));
        }
      }, JOIN_TIMEOUT_MS);
    }

    /** 对局消息：直连可用就走 DataChannel，否则走 MQTT 中继。 */
    send(type, payload) {
      const message = { type, ...(payload || {}) };
      if (this.transport === 'relay') return this._publish(message);
      if (this.peer && this.peer.isOpen()) return this.peer.send(message);
      return false;
    }

    isReady() {
      return !!this.transport;
    }

    close(notify = false) {
      if (this.closed) return;
      this.closed = true;
      if (this._joinTimer) { clearTimeout(this._joinTimer); this._joinTimer = null; }

      if (notify && this.transport) this.send('bye', {});

      try { this.peer?.close(); } catch { /* 已关闭 */ }
      this.peer = null;

      const mqtt = this.mqtt;
      this.mqtt = null;
      // 留一点时间让 bye 真正发出去，再断开 broker。
      if (mqtt) setTimeout(() => mqtt.close(), notify ? 200 : 0);
    }

    _setTopics() {
      const base = TOPIC_ROOT + '/' + this.code;
      const hostToGuest = base + '/h2g';
      const guestToHost = base + '/g2h';
      this._inTopic = this.role === 'host' ? guestToHost : hostToGuest;
      this._outTopic = this.role === 'host' ? hostToGuest : guestToHost;
    }

    async _connectBroker() {
      let lastError = null;
      for (let i = 0; i < this.brokers.length; i++) {
        this.handlers.onStatus?.({
          phase: 'connecting', index: i + 1, total: this.brokers.length, code: this.code
        });
        const client = new root.CannonMqtt.MqttClient(this.brokers[i]);
        try {
          await client.connect();
          client.onClose = () => this._onBrokerClose();
          return client;
        } catch (error) {
          lastError = error;
          client.close();
        }
      }
      throw new Error('所有中转服务器都连不上，请检查网络后重试'
        + (lastError ? '（' + lastError.message + '）' : ''));
    }

    _onBrokerClose() {
      if (this.closed) return;
      // 直连模式下 broker 掉了无所谓，对局继续；中继模式才会真的断。
      if (this.transport === 'relay') {
        this.handlers.onClosed?.('中转连接已断开');
      }
    }

    _onWire(payload) {
      let message;
      try {
        message = JSON.parse(payload);
      } catch {
        return;
      }
      if (!message || typeof message !== 'object') return;

      // 公共话题上可能还有别人在听：房主定向发给某个加入方的消息，别人必须丢掉。
      if (this.role === 'guest' && message.sid && message.sid !== this.sid) return;

      switch (message.type) {
        case 'join':
          if (this.role !== 'host') break;
          // 同一个加入方的重试（比如网络抖动）忽略即可。
          if (this._guestSid && this._guestSid === message.sid) break;
          if (this._negotiating || this.transport || this._guestSid) {
            // 已经有对手了，告诉后来者换房间（只针对他，房里的对手不会收到）。
            this._publish({ type: 'busy', sid: message.sid });
            break;
          }
          this._guestSid = message.sid || null;
          this._startNegotiation();
          break;

        case 'busy':
          if (this.role === 'guest') {
            this.handlers.onError?.(new Error('这个房间已经有对手了，请让房主重新创建房间'));
          }
          break;

        case 'offer':
          if (this.role === 'guest') this._acceptOffer(message);
          break;

        case 'answer':
          if (this.role === 'host') this._acceptAnswer(message);
          break;

        case 'transport':
          this._useTransport(message.mode);
          break;

        default:
          // 其余都是对局消息：直连模式下走 DataChannel，只有中继模式才从这里进。
          if (this.transport === 'relay') this.handlers.onMessage?.(message);
          break;
      }
    }

    async _startNegotiation() {
      this._negotiating = true;
      try {
        if (this.forcedTransport === 'relay' || typeof RTCPeerConnection === 'undefined') {
          this._announceTransport('relay');
          return;
        }

        this.peer = new P2PConnection({
          onMessage: (message) => this.handlers.onMessage?.(message),
          onClose: () => this.handlers.onClosed?.('与对手的直连已断开')
        });

        const offer = await this.peer.createOffer();
        this._publish({ type: 'offer', sdp: offer.sdp });
        this.handlers.onStatus?.({ phase: 'negotiating', code: this.code });
      } catch {
        // 连 offer 都出不来，直接降级，不让玩家卡在等待。
        this._announceTransport('relay');
      }
    }

    async _acceptAnswer(message) {
      try {
        await this.peer.acceptAnswer({ type: 'answer', sdp: message.sdp });
        const opened = await this.peer.waitForOpen(P2P_WAIT_MS);
        this._announceTransport(opened ? 'p2p' : 'relay');
      } catch {
        this._announceTransport('relay');
      }
    }

    async _acceptOffer(message) {
      if (this.forcedTransport === 'relay' || typeof RTCPeerConnection === 'undefined') return;
      try {
        this.peer = new P2PConnection({
          onMessage: (msg) => this.handlers.onMessage?.(msg),
          onClose: () => this.handlers.onClosed?.('与对手的直连已断开')
        });
        const answer = await this.peer.acceptOffer({ type: 'offer', sdp: message.sdp });
        this._publish({ type: 'answer', sdp: answer.sdp });
        this.handlers.onStatus?.({ phase: 'negotiating', code: this.code });
      } catch {
        // 失败就什么都不发，等房主那边超时后统一改成中继。
      }
    }

    /** 由房主单方面决定并广播，保证两端行为一致。 */
    _announceTransport(mode) {
      this._publish({ type: 'transport', mode });
      this._useTransport(mode);
    }

    _useTransport(mode) {
      if (this.transport) return;
      if (mode !== 'p2p' && mode !== 'relay') return;

      this.transport = mode;
      if (this._joinTimer) { clearTimeout(this._joinTimer); this._joinTimer = null; }

      if (mode === 'relay') {
        try { this.peer?.close(); } catch { /* 已关闭 */ }
        this.peer = null;
      }

      this.handlers.onReady?.({ role: this.role, code: this.code, transport: mode });
    }

    _publish(message) {
      if (!this.mqtt) return false;
      // 房主发出的消息带上对手的 sid：定向消息保留自己的 sid，其余默认发给当前对手。
      const sid = message.sid || (this.role === 'host' ? this._guestSid : null);
      const envelope = sid ? { ...message, sid } : message;
      return this.mqtt.publish(this._outTopic, JSON.stringify(envelope));
    }
  }

  // 只暴露一个命名空间：历史上 app.js 用过裸全局，漏导出会让点击静默失败。
  root.CannonRoom = {
    GameRoom,
    P2PConnection,
    generateRoomCode,
    normalizeRoomCode,
    ROOM_CODE_ALPHABET,
    ROOM_CODE_LENGTH,
    TOPIC_ROOT,
    ICE_SERVERS
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);