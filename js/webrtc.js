/*
 * Cannon Goblin —— 无服务器联机层
 *
 * 设计前提：玩家没有公网 IP，也没有任何服务器。
 * 因此这里不引入信令服务器，而是把 WebRTC 的 SDP 压成一段可复制粘贴的「邀请码 / 应答码」，
 * 由玩家通过任意聊天工具（QQ / 微信 / 短信）人工转发。握手完成后，
 * 双方的对局数据走 RTCDataChannel 点对点直连，中途不再需要任何第三方。
 *
 * 握手时序：
 *   房主 createOffer()            -> 邀请码   --(聊天工具)--> 对手
 *   对手 acceptOffer(邀请码)       -> 应答码   --(聊天工具)--> 房主
 *   房主 acceptAnswer(应答码)      -> DataChannel 打开，开始对局
 */
(function (root) {
  'use strict';

  // 邀请码前缀，用于识别粘贴内容并容忍聊天工具插入的换行/空格。
  const CODE_PREFIX = 'CG1.';

  // 公共 STUN 服务器：只用来发现双方公网地址，不中转对局数据，无需自建。
  // 若双方都处于「对称 NAT」（常见于手机 4G/5G 热点），STUN 打洞会失败，
  // 此时必须追加一台 TURN 中继服务器，例如：
  //   { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];

  // 非 trickle 模式：等 ICE 收集结束再出码，保证一段码里自带全部候选地址。
  const ICE_GATHER_TIMEOUT_MS = 5000;

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToBytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /** 把 SDP 会话描述编码成一段便于聊工具转发的纯文本码。 */
  function encodeDescription(description) {
    const payload = JSON.stringify({ v: 1, type: description.type, sdp: description.sdp });
    return CODE_PREFIX + bytesToBase64(new TextEncoder().encode(payload));
  }

  /**
   * 解析玩家粘贴的码。刻意宽容：忽略空白与零宽字符、允许省略前缀、
   * 也接受直接粘贴 JSON（方便调试），但对内容严格校验。
   */
  function decodeDescription(code) {
    if (typeof code !== 'string' || !code.trim()) throw new Error('代码为空，请先粘贴邀请码或应答码');

    const cleaned = code.replace(/[\s\u200b-\u200f\ufeff]+/g, '');
    const body = cleaned.startsWith(CODE_PREFIX) ? cleaned.slice(CODE_PREFIX.length) : cleaned;

    let data;
    if (body.startsWith('{')) {
      try {
        data = JSON.parse(body);
      } catch {
        throw new Error('代码格式无法识别，请完整复制（不要手动删改）');
      }
    } else {
      let json;
      try {
        json = new TextDecoder().decode(base64ToBytes(body));
      } catch {
        throw new Error('代码格式无法识别，请完整复制（不要手动删改）');
      }
      try {
        data = JSON.parse(json);
      } catch {
        throw new Error('代码已损坏，可能复制时被截断，请重新复制完整内容');
      }
    }

    if (!data || data.v !== 1 || typeof data.sdp !== 'string' || !data.sdp) {
      throw new Error('代码已损坏，可能复制时被截断，请重新复制完整内容');
    }
    if (data.type !== 'offer' && data.type !== 'answer') {
      throw new Error('代码类型不正确');
    }
    return { type: data.type, sdp: data.sdp };
  }

  class P2PConnection {
    /**
     * @param {{onOpen?:Function,onMessage?:Function,onState?:Function,onClose?:Function}} handlers
     */
    constructor(handlers = {}) {
      this.handlers = handlers;
      this.pc = null;
      this.channel = null;
      this.role = null;
      this.closed = false;
    }

    isOpen() {
      return !!this.channel && this.channel.readyState === 'open';
    }

    _createPeerConnection() {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pc.onconnectionstatechange = () => {
        this._emit('onState', {
          connectionState: pc.connectionState,
          iceConnectionState: pc.iceConnectionState
        });
      };
      return pc;
    }

    _bindChannel(channel) {
      channel.onopen = () => this._emit('onOpen', {});
      channel.onclose = () => this._emit('onClose', {});
      channel.onerror = () => this._emit('onState', { connectionState: 'channel-error' });
      channel.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return; // 忽略无法解析的消息，不让对局崩掉
        }
        this._emit('onMessage', message);
      };
    }

    _emit(name, payload) {
      const fn = this.handlers[name];
      if (typeof fn === 'function') fn(payload);
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
        // 超时后就用已收集到的候选地址出码，避免个别网络下无限等待。
        const timer = setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
      });
    }

    /** 房主第一步：生成邀请码。 */
    async createOffer() {
      this.role = 'host';
      this.pc = this._createPeerConnection();
      this.channel = this.pc.createDataChannel('cannon-goblin', { ordered: true });
      this._bindChannel(this.channel);

      await this.pc.setLocalDescription(await this.pc.createOffer());
      await this._waitForIceGathering(this.pc);
      return encodeDescription(this.pc.localDescription);
    }

    /** 对手第一步：吃邀请码，吐应答码。 */
    async acceptOffer(code) {
      this.role = 'guest';
      const offer = decodeDescription(code);
      if (offer.type !== 'offer') throw new Error('这是应答码，不是房主的邀请码');

      this.pc = this._createPeerConnection();
      this.pc.ondatachannel = (event) => {
        this.channel = event.channel;
        this._bindChannel(event.channel);
      };

      await this.pc.setRemoteDescription(offer);
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      await this._waitForIceGathering(this.pc);
      return encodeDescription(this.pc.localDescription);
    }

    /** 房主第二步：吃应答码，建连。 */
    async acceptAnswer(code) {
      if (!this.pc) throw new Error('请先点「生成邀请码」');
      const answer = decodeDescription(code);
      if (answer.type !== 'answer') throw new Error('这是邀请码，不是对手回传的应答码');
      await this.pc.setRemoteDescription(answer);
    }

    /** 发送一条对局消息；通道未开时返回 false，调用方据此提示用户。 */
    send(type, payload) {
      if (!this.isOpen()) return false;
      try {
        this.channel.send(JSON.stringify({ type, ...(payload || {}) }));
        return true;
      } catch {
        return false;
      }
    }

    close() {
      this.closed = true;
      try { this.channel?.close(); } catch { /* 已关闭 */ }
      try { this.pc?.close(); } catch { /* 已关闭 */ }
      this.channel = null;
      this.pc = null;
    }
  }

  root.CannonSignaling = { encodeDescription, decodeDescription, CODE_PREFIX };
  root.CannonWebRTC = { P2PConnection, ICE_SERVERS, CODE_PREFIX };
  // app.js 通过内联 onclick 调用全局函数，这里也按同样的全局脚本风格暴露。
  root.P2PConnection = P2PConnection;
})(typeof globalThis !== 'undefined' ? globalThis : this);