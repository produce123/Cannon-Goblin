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

  // 直连断掉后，加入方等房主宣布"改走中继"的宽限时间；等不到就说明房主也没了。
  const RELAY_WATCHDOG_MS = 6000;

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
      this._leavePeer = false;    // 标记"这次 peer 关闭是我们自己关的"，避免重复报掉线
      this._relayWatchdog = null; // 加入方等房主宣布改走中继的计时器
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
        this._leavePairing();
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
          // 通路由房主单方面决定，只该加入方听；房主自己不接受别人的"决定"。
          if (this.role === 'guest') this._useTransport(message.mode, true);
          break;

        default:
          // 其余都是对局消息：直连模式下走 DataChannel，只有中继模式才从这里进。
          if (this.transport === 'relay') this._onPeerMessage(message);
          break;
      }
    }

    /**
     * 对手发来的对局消息。'bye' 要顺手解除配对：
     * 否则房主的 _guestSid / transport 一直留着，同一个房间号再进人只会被回 busy ——
     * 这就是"对手点返回离开后，再也进不来房间"的原因。解除配对不等于关房间，
     * broker 连接不动，房间号继续有效。
     */
    _onPeerMessage(message) {
      if (message && message.type === 'bye') this._leavePairing();
      this.handlers.onMessage?.(message);
    }

    /** 对手**明确**走了（收到 bye），或两条链路都断了：回到"等人进来"的状态，房间继续开着。 */
    _leavePairing() {
      this._negotiating = false;
      this.transport = null;
      if (this._joinTimer) { clearTimeout(this._joinTimer); this._joinTimer = null; }
      if (this._relayWatchdog) { clearTimeout(this._relayWatchdog); this._relayWatchdog = null; }

      // 主动关闭要标记一下，别把自己的 close 当成"对手掉线"再报一次。
      this._leavePeer = true;
      try { this.peer?.close(); } catch { /* 已关闭 */ }
      this.peer = null;

      if (this.role === 'host') {
        this._guestSid = null;
        this.handlers.onStatus?.({ phase: 'waiting', code: this.code });
      }
    }

    /** 直连断掉（对手关页面 / 掉线 / 手机锁屏把 WebRTC 冻住）：**不等于对手走了**。
     *  这里曾经直接解除配对，结果房主还停在准备界面、transport 却没了，
     *  点「开始游戏」就弹"对手还没有进来"——而对手其实一直在等。 */
    _onPeerClose() {
      if (this.closed || this._leavePeer) return;
      // 注意判断的是"broker 现在还能不能发消息"，不是"有没有这个对象"：
      // socket 已经断了但对象还在时，改走中继是发不出去的，那就得照实说断开。
      const brokerAlive = !!this.mqtt && typeof this.mqtt.isConnected === 'function' && this.mqtt.isConnected();

      if (this.role === 'host' && brokerAlive) {
        // broker 还活着：改走中继让对局继续（房主决定并广播，两端行为一致）。
        this._announceTransport('relay');
        return;
      }

      if (brokerAlive) {
        // 加入方无权决定通路，只能等房主的广播；等不到就是房主也断了。
        this._relayWatchdog = setTimeout(() => {
          this._relayWatchdog = null;
          if (this.transport === 'p2p') this.handlers.onClosed?.('与房主的连接已断开');
        }, RELAY_WATCHDOG_MS);
        return;
      }

      // 连 broker 都没了，那才是真的断了：放出房间，别再锁着。
      this._leavePairing();
      this.handlers.onClosed?.('与对手和中转服务器的连接都断了');
    }

    async _startNegotiation() {
      this._negotiating = true;
      try {
        if (this.forcedTransport === 'relay' || typeof RTCPeerConnection === 'undefined') {
          this._announceTransport('relay');
          return;
        }

        this._leavePeer = false;
        this.peer = new P2PConnection({
          onMessage: (message) => this._onPeerMessage(message),
          onClose: () => this._onPeerClose()
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
        this._leavePeer = false;
        this.peer = new P2PConnection({
          onMessage: (msg) => this._onPeerMessage(msg),
          onClose: () => this._onPeerClose()
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
      this._useTransport(mode, true);
    }

    /**
     * 定通路。默认只决定一次（first 决定完就不再改）；force 用于半路换通路
     * （例如直连断了改走中继）——那种情况下界面**不能**被顶回准备页，只提示一句。
     */
    _useTransport(mode, force = false) {
      if (mode !== 'p2p' && mode !== 'relay') return;
      if (!force && this.transport) return;
      if (this.transport === mode) return;         // 已经是这个通路了，别重复通知

      const first = !this.transport;
      this.transport = mode;
      if (this._joinTimer) { clearTimeout(this._joinTimer); this._joinTimer = null; }
      if (this._relayWatchdog) { clearTimeout(this._relayWatchdog); this._relayWatchdog = null; }

      if (mode === 'relay') {
        try { this.peer?.close(); } catch { /* 已关闭 */ }
        this.peer = null;
      }

      if (first) {
        this.handlers.onReady?.({ role: this.role, code: this.code, transport: mode });
      } else {
        this.handlers.onStatus?.({ phase: 'transport', mode });
      }
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