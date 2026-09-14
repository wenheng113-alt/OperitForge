'use strict';
/**
 * 一起听「房间聊天」收发 —— 走云信（NIM）长连接。
 *
 * ══════════════════════════════════════════════════════════════
 * 为什么需要这个模块（v0.5 重大突破）
 * ══════════════════════════════════════════════════════════════
 *
 * v0.4 曾判定：**「房间聊天只能发、不能读」**
 *   依据是 HTTP 层探测 —— `chatroom/{history,messages,get}` 全部 404。
 *
 * v0.5 推翻该结论：**读是可行的，只是不在 HTTP 层，而在云信长连接。**
 *
 * 完整链路（已实测跑通）：
 *
 *   1. 用**任意身份**的网易云 cookie 拿云信登录凭证
 *        POST /api/middle/im/token/get   { roomId }
 *        → { uid, accId, token }
 *
 *   2. 用官方 NIM SDK 登录（accId + token + appKey）
 *        appKey 不是接口下发的，是客户端常量：
 *        运行时 `NIMClient.getAppKey()` 读出 = 3a6a3e48f6854dfa4e4464f3bdaec3b4
 *
 *   3. 进入聊天室（chatroomId 取自 roomInfo.chatRoomId）
 *        instance.enter(chatroomId, { accountId, token })
 *        → 此时开始实时收包
 *
 *   4. 两种读法
 *        · 实时： V2NIMChatroomService.on('onReceiveMessages', fn)
 *        · 历史： await V2NIMChatroomService.getMessageList({ roomId, limit })
 *
 * ⚠️ 关键点：**AI 用自己的 cookie 就能拿到 token**，
 *    不需要真人 cookie —— 这正是「only AI」模式（真人用官方客户端）的基础。
 *
 * ══════════════════════════════════════════════════════════════
 * 依赖
 * ══════════════════════════════════════════════════════════════
 *
 *   npm install nim-web-sdk-ng      # 官方 SDK，实测 10.11.0 可用
 *
 * 本模块零依赖除 SDK 外，但 SDK 是**浏览器产物**，在 Node 里跑需要
 * 先补浏览器全局对象（见 installBrowserGlobals）。
 * Node 18+ 自带 WebSocket，无需额外 polyfill。
 */

/** 云信 appKey —— 网易云音乐客户端常量，非接口下发。 */
const NIM_APP_KEY = '3a6a3e48f6854dfa4e4464f3bdaec3b4';

/** 消息类型。 */
const MSG_TYPE = {
  TEXT: 0,
  PICTURE: 1,
  AUDIO: 2,
  VIDEO: 3,
  FILE: 4,
  NOTIFICATION: 5, // 成员进房/退房等系统消息，无 text
};

/**
 * 装好浏览器全局对象，让浏览器版 NIM SDK 能在 Node 里加载。
 *
 * SDK 在 **模块加载时** 就调用内部 setAdapters()，读 window.localStorage /
 * window.WebSocket，缺任何一个都会在运行期报
 * "localStorage.removeItem is not a function"。
 * 所以本函数必须在 `import CHATROOM_BROWSER_SDK` **之前** 调用。
 *
 * @param {{storageDir?: string}} [opts]
 */
function installBrowserGlobals(opts) {
  const o = opts || {};
  const fs = require('fs');
  const path = require('path');

  globalThis.self = globalThis;
  globalThis.window = globalThis;

  const dir = o.storageDir || '/tmp/nim-adapter-store';
  const file = path.join(dir, 'store.json');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}

  let store = {};
  try { store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { store = {}; }
  const persist = function () { try { fs.writeFileSync(file, JSON.stringify(store)); } catch (e) {} };

  const localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); persist(); },
    removeItem: function (k) { delete store[k]; persist(); },
    clear: function () { store = {}; persist(); },
    key: function (i) { return Object.keys(store)[i] || null; },
  };
  Object.defineProperty(localStorage, 'length', { get: function () { return Object.keys(store).length; } });

  globalThis.localStorage = localStorage;
  globalThis.window.localStorage = localStorage;
  globalThis.sessionStorage = globalThis.sessionStorage || localStorage;
  globalThis.window.sessionStorage = globalThis.sessionStorage;
  globalThis.window.WebSocket = globalThis.WebSocket;

  // navigator / document 在 Node 里是 getter，只能 defineProperty
  try {
    Object.defineProperty(globalThis.window, 'navigator', {
      value: globalThis.navigator, writable: true, configurable: true,
    });
  } catch (e) { /* 已存在即可 */ }
  if (!globalThis.window.document) {
    try {
      Object.defineProperty(globalThis.window, 'document', {
        value: {}, writable: true, configurable: true,
      });
    } catch (e) {}
  }

  // 网络状态监听：浏览器 bundle 会 addEventListener('online'/'offline')
  if (typeof globalThis.window.addEventListener !== 'function') {
    globalThis.window.addEventListener = function () {};
    globalThis.window.removeEventListener = function () {};
  }
  if (typeof globalThis.addEventListener !== 'function') {
    globalThis.addEventListener = function () {};
    globalThis.removeEventListener = function () {};
  }

  return { localStorage: localStorage };
}

/**
 * 从 message.serverExtension（JSON 字符串）里取发送者资料。
 *
 * 实测形态：
 *   {"serverExt":{"gender":1,"avatarUrl":"...","nickname":"...","userId":10000000002},
 *    "appName":"music",
 *    "clientExt":{"bizType":"listenTogether","ltType":"FRIEND","roomId":"..."},
 *    "clientInfo":{...}}
 *
 * @param {object} msg
 * @returns {{nickname: string, userId: string, avatarUrl: string}|null}
 */
function parseSenderExt(msg) {
  const raw = msg && (msg.serverExtension || msg.serverExt);
  if (!raw) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch (e) { return null; }
  }
  const ext = obj.serverExt || obj;
  return {
    nickname: ext.nickname || '',
    userId: ext.userId === undefined ? '' : String(ext.userId),
    avatarUrl: ext.avatarUrl || '',
  };
}

/**
 * 把 NIM 消息压成精简结构（供 UI / AI 消费）。
 *
 * ⚠️ 系统通知消息（messageType=5）没有 text，此时 text 为空串，
 *    用 isNotification 区分；不要把它当成「空消息」丢掉，
 *    成员进房/退房正是靠它。
 *
 * @param {object} msg
 * @returns {{id, senderId, senderNick, senderAvatar, text, messageType,
 *            isNotification, isSelf, roomId, time, raw}}
 */
function parseMessage(msg) {
  const m = msg || {};
  const ext = parseSenderExt(m);
  const type = m.messageType === undefined ? 0 : Number(m.messageType);
  const text = m.text || (m.messageBody && m.messageBody.text) || '';
  return {
    id: m.messageClientId || '',
    senderId: m.senderId === undefined ? '' : String(m.senderId),
    senderNick: (ext && ext.nickname) || (m.userInfoConfig && m.userInfoConfig.senderNick) || '',
    senderAvatar: (ext && ext.avatarUrl) || (m.userInfoConfig && m.userInfoConfig.senderAvatar) || '',
    text: String(text),
    messageType: type,
    isNotification: type === MSG_TYPE.NOTIFICATION,
    isSelf: !!m.isSelf,
    roomId: m.roomId === undefined ? '' : String(m.roomId),
    time: m.createTime || m.messageTime || 0,
    raw: m,
  };
}

/**
 * 房间聊天服务：登录云信 → 进聊天室 → 收发消息。
 *
 * 一个实例对应一个 (身份, 房间) 组合。
 */
class RoomChatService {
  /**
   * @param {object} o
   * @param {string} o.cookie     该身份的网易云 cookie（任意身份均可）
   * @param {object} o.client     已构造的 NativeClient（与 cookie 二选一）
   * @param {string} [o.appKey]   云信 appKey，默认用 NIM_APP_KEY
   */
  constructor(o) {
    const opts = o || {};
    this.client = opts.client;
    this.cookie = opts.cookie || '';
    this.appKey = opts.appKey || NIM_APP_KEY;
    this.instance = null;
    this.roomId = '';
    this.chatroomId = '';
    this._listeners = [];
  }

  /**
   * 取云信登录凭证。
   *
   * ⚠️ 实测：`roomId` 是**必需参数**，不传会 HTTP 400。
   *    返回的 accId 就是当前身份 uid。
   *
   * @param {string} roomId 一起听 roomId（形如 `<hex>_<ts>`）
   * @returns {Promise<{uid: string, accId: string, token: string}>}
   */
  async fetchToken(roomId) {
    if (!this.client) throw new Error('缺少 NativeClient（或用 cookie 构造）');
    const resp = await this.client.eapiRequest('/api/middle/im/token/get', { roomId: roomId });
    if (!resp || resp.code !== 200 || !resp.data) {
      throw new Error('取云信 token 失败: ' + JSON.stringify(resp));
    }
    return resp.data;
  }

  /**
   * 登录云信并进入聊天室；成功后开始实时收消息。
   *
   * @param {object} o
   * @param {string} o.roomId      一起听 roomId
   * @param {string|number} o.chatroomId roomInfo.chatRoomId
   * @param {string} [o.nick]      进房昵称
   * @param {Function} o.onMessage 收到消息回调，参数为 parseMessage 结果
   * @returns {Promise<object>} enter 的原始返回
   */
  async enter(o) {
    const opts = o || {};
    const roomId = opts.roomId;
    const chatroomId = String(opts.chatroomId || '');
    if (!roomId) throw new Error('缺少 roomId');
    if (!chatroomId) throw new Error('缺少 chatroomId（取自 roomInfo.chatRoomId）');

    const tk = opts.token ? opts.token : await this.fetchToken(roomId);

    // 延迟到运行时 require，避免没装 SDK 时整包加载失败
    installBrowserGlobals({ storageDir: opts.storageDir });
    const sdkPath = this._resolveSdk(opts.sdkDir);
    const NS = require(sdkPath);
    const V2NIMChatroom = (NS.default || NS).default || NS.default;

    const inst = V2NIMChatroom.newInstance({
      appkey: this.appKey,
      debugLevel: opts.debugLevel || 'off',
      apiVersion: 'v2',
      account: tk.accId,
      token: tk.token,
    });
    this.instance = inst;
    this.roomId = roomId;
    this.chatroomId = chatroomId;

    if (typeof opts.onMessage === 'function') {
      this.onMessage(opts.onMessage);
    }

    const resp = await inst.enter(chatroomId, {
      accountId: tk.accId,
      token: tk.token,
      roomNick: opts.nick || '',
      enableLbs: true,
    });
    return resp;
  }

  /**
   * 定位 NIM SDK 产物路径。
   *
   * SDK 通过 npm 安装，可能装在任意目录（项目根 / 插件包 / 全局），
   * 因此按顺序尝试，并允许调用方显式指定 sdkDir。
   *
   * @param {string} [sdkDir] 含 node_modules/nim-web-sdk-ng 的目录
   * @returns {string} 可 require 的绝对路径
   */
  _resolveSdk(sdkDir) {
    const fs = require('fs');
    const path = require('path');
    const REL = 'node_modules/nim-web-sdk-ng/dist/v2/CHATROOM_BROWSER_SDK.js';
    const roots = [];
    if (sdkDir) roots.push(sdkDir);
    if (process.env.NIM_SDK_DIR) roots.push(process.env.NIM_SDK_DIR);
    roots.push(__dirname);                       // reference/native/
    roots.push(path.join(__dirname, '..', '..')); // reference/
    roots.push(path.join(__dirname, '..', '..', '..')); // 插件根
    roots.push(process.cwd());
    for (let i = 0; i < roots.length; i += 1) {
      const p = path.join(roots[i], REL);
      if (fs.existsSync(p)) return p;
    }
    throw new Error(
      '找不到 nim-web-sdk-ng。请先安装：\n' +
      '  npm install nim-web-sdk-ng\n' +
      '或通过 sdkDir / NIM_SDK_DIR 指定 node_modules 所在目录。'
    );
  }

  /**
   * 注册实时收消息回调。可注册多个。
   * @param {Function} fn 参数为 parseMessage 结果
   */
  onMessage(fn) {
    if (typeof fn !== 'function') return;
    const self = this;
    const wrapped = function (msgs) {
      const arr = Array.isArray(msgs) ? msgs : [msgs];
      for (let i = 0; i < arr.length; i += 1) {
        try { fn(parseMessage(arr[i])); } catch (e) { /* 单个消息失败不影响其它 */ }
      }
    };
    // ⚠️ 必须注册在 V2NIMChatroomService 上，不是 instance 上。
    //    在 instance 上注册 onReceiveMessages 不会触发。
    const svc = this.instance.V2NIMChatroomService;
    svc.on('onReceiveMessages', wrapped);
    this._listeners.push({ svc: svc, ev: 'onReceiveMessages', fn: wrapped });
  }

  /**
   * 拉取历史消息（含双方发言）。
   *
   * ⚠️ 实测一次最多返回 50 条；不接受 limit 之外的翻页参数时不报错但也不生效。
   *
   * @param {{limit?: number}} [o]
   * @returns {Promise<Array>} parseMessage 结果数组
   */
  async history(o) {
    const opts = o || {};
    if (!this.instance) throw new Error('尚未 enter');
    const svc = this.instance.V2NIMChatroomService;
    const resp = await svc.getMessageList({
      roomId: this.chatroomId,
      limit: opts.limit || 50,
    });
    const list = Array.isArray(resp) ? resp : ((resp && resp.messages) || []);
    return list.map(parseMessage);
  }

  /**
   * 在房间里发一条文字消息（走云信，与 HTTP chatroom/send 等价）。
   * @param {string} text
   * @returns {Promise<object>}
   */
  async send(text) {
    const body = String(text || '');
    if (!body) throw new Error('消息不能为空');
    if (!this.instance) throw new Error('尚未 enter');
    const svc = this.instance.V2NIMChatroomService;
    const accId = this.instance.account ? this.instance.account() : '';
    return svc.sendMessage({
      roomId: this.chatroomId,
      messageClientId: 'c' + Date.now() + Math.random().toString(16).slice(2, 8),
      senderId: String(accId),
      text: body,
    });
  }

  /** 退出聊天室。 */
  exit() {
    for (let i = 0; i < this._listeners.length; i += 1) {
      const l = this._listeners[i];
      try { if (l.svc.off) l.svc.off(l.ev, l.fn); } catch (e) {}
    }
    this._listeners = [];
    try { if (this.instance) this.instance.exit(); } catch (e) {}
    this.instance = null;
  }
}

module.exports = {
  NIM_APP_KEY: NIM_APP_KEY,
  MSG_TYPE: MSG_TYPE,
  installBrowserGlobals: installBrowserGlobals,
  parseSenderExt: parseSenderExt,
  parseMessage: parseMessage,
  RoomChatService: RoomChatService,
};
