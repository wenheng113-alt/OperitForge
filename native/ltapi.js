'use strict';
/**
 * ============================================================
 *  native/ltapi.js — 网易云「一起听」REST 协议客户端（P3）
 * ------------------------------------------------------------
 *  2026 实测（AI cookie + weapi 加密，真实上游）：
 *    ✔ POST /weapi/listen/together/room/create          → 建房/已在房，返回 roomId
 *    ✔ POST /weapi/listen/together/status/get           → 房间成员/状态回读
 *    ✔ POST /weapi/listen/together/play/command/report  → {result:true} 播放指令下发
 *    ✔ POST /weapi/listen/together/query/exit/info      → {code:200}
 *    ✔ POST /weapi/listen/together/heartbeat            → { roomId, songId,
 *          playStatus, progress, playlistVersion }（2026 实测 200 {result:true}）
 *          ⚠ songId 不能为空串（空串→400 参数错误），必须传真实歌曲 id；
 *            缺任一字段→400。
 *    ✔ POST /weapi/listen/together/end/check            → { roomId }（退房前校验，200 result:true）
 *    ✔ POST /weapi/listen/together/end/v2               → { roomId, shareInfo,
 *          needRecord, scene, exitType }（真正退房；2026 实测 200 {success:true}）
 *    ✔ POST /weapi/listen/together/invite/message/send  → { roomId, acceptorId, ltType }
 *          ⚠ ltType 必须为 1（传 0 → 400「类型错误」）；2026 实测 ltType=1 → 200
 *    ✔ POST /weapi/listen/together/play/invitation/accept → { roomId, inviterId }
 *          ⚠ 被邀请人若已在别的房 → 200 type=ALREADY_IN_ROOM 且返回自己的房；
 *            必须先 end/v2 退房再 accept，之后房间 status 从 NOT_CONNECTED → CONNECTED
 *    ✗ play/command / room/status / sync/command        → 404（路径不存在）
 *
 *  关键结论：播放指令**不需要 WebSocket/云信长连接**，
 *  纯 REST 即可真正控制一起听房间。这推翻了 P5 必须引入
 *  nim-web-sdk-ng 的假设（云信仅用于房间内文字聊天）。
 *
 *  play/command/report 请求体（反编译 rg0/t0$i0.smali 实证）：
 *    { roomId, commandInfo: <PlayCommand 的 JSON 字符串> }
 *  PlayCommand 字段（meta/PlayCommand.java）：
 *    commandType / formerSongId / targetSongId / progress /
 *    playStatus / clientSeq / serverSeq / triggerType /
 *    ignoreUserId / userId
 *  ⚠ 字段名坑：targetSongId / formerSongId ≠ songId（历史踩坑记录）
 * ============================================================
 */
const https = require('https');
const crypto = require('./crypto');
const identity = require('./identity');

/* ==================================================================
 * 通道切换（2026-09）：weapi(PC) → eapi(移动端)
 * ------------------------------------------------------------------
 *  官方客户端的一起听全走 eapi 移动端协议，我们此前走 weapi PC 协议，
 *  导致真人 APP 点邀请卡提示「对方版本较低」。现全部切到 eapi。
 * ================================================================== */
const EAPI_HOST = 'interface.music.163.com';
/** eapi 用移动端 UA（与官方一致） */
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const REFERER = 'https://music.163.com/';

/**
 * 设备信息 cookie。eapi 走移动端语义：
 *   os=android; appver —— 这两个是关键，缺了容易被判非常规客户端。
 * 2026 关键修复：appver 必须 >= 官方客户端版本，否则服务端在
 *   POST /api/listen/together/room/check 对该房主返回 HIGH_V_REJECTED
 *   （copywriting「对方当前版本较低，需升级至最新版本才可以一起听歌」），
 *   导致真人 APP 点邀请卡无法进房。
 *   反编译 APK 实测 versionName = 9.5.70，故此处对齐 9.5.70。
 */
const APP_VER = '9.5.70';
const DEVICE_COOKIE = 'os=android; appver=' + APP_VER + '; osver=13; deviceId=ncm-native-listen; channel=netease; __remember_me=true';

/** 合并 cookie 片段：设备信息在前，登录态在后，重复 key 以后者为准 */
function mergeCookies() {
  const seen = new Map();
  for (let i = 0; i < arguments.length; i += 1) {
    const part = arguments[i];
    if (!part) continue;
    String(part).split(';').forEach(function (kv) {
      const s = kv.trim();
      if (!s) return;
      const eq = s.indexOf('=');
      if (eq <= 0) return;
      seen.set(s.slice(0, eq).trim(), s);
    });
  }
  return Array.from(seen.values()).join('; ');
}

/**
 * eapi POST（带 cookie），返回 {status, text}。
 * @param {string} path 形如 /api/listen/together/heartbeat（传 /api 形式）
 * @param {object} obj 明文参数
 * @param {string} cookie 登录态 cookie
 */
function eapiPost(path, obj, cookie) {
  return new Promise(function (resolve, reject) {
    const params = crypto.eapiEncrypt(path, obj || {});
    const body = 'params=' + encodeURIComponent(params);
    const fullPath = '/eapi' + crypto.eapiPathSuffix(path);
    const req = https.request({
      host: EAPI_HOST, port: 443, path: fullPath, method: 'POST',
      headers: {
        'User-Agent': UA,
        'Referer': REFERER,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Cookie': mergeCookies(DEVICE_COOKIE, cookie || ''),
      },
      timeout: 30000,
    }, function (res) {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { data += c; });
      res.on('end', function () { resolve({ status: res.statusCode, text: data }); });
    });
    req.on('timeout', function () { req.destroy(new Error('ltapi timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** 兼容旧名：weapiPost 现在指向 eapiPost（本文件内部已无 weapi 调用） */
const weapiPost = eapiPost;

/** 解析 JSON，容错 */
function parse(text) {
  try { return JSON.parse(text); } catch (e) { return {}; }
}

/* ---------- 对外能力 ---------- */

/**
 * 建房 / 进房。若已在房间则返回 ALREADY_IN_ROOM（同样有效）。
 * @returns {ok, roomId, roomInfo, type, message}
 */
async function createRoom(who) {
  const cookie = identity.readCookie(who);
  if (!cookie) return { ok: false, message: 'no cookie for ' + who };
  // eapi 建房：官方传空 body（参考实现 room.js create() 传 {}）
  const r = await weapiPost('/api/listen/together/room/create', {}, cookie);
  const j = parse(r.text);
  const d = (j && j.data) || {};
  const info = d.roomInfo || {};
  if (j && j.code === 200 && info.roomId) {
    return { ok: true, roomId: info.roomId, roomInfo: info, type: d.type || '', message: '' };
  }
  return { ok: false, message: (j && j.message) || ('HTTP ' + r.status), raw: j };
}

/**
 * 房间状态回读（P4）。
 * @returns {ok, inRoom, status, roomInfo, users}
 */
async function statusGet(who, roomId) {
  const cookie = identity.readCookie(who);
  if (!cookie) return { ok: false, message: 'no cookie for ' + who };
  // eapi 官方 status() 传空 body（不传 roomId），返回"我当前所在房间"的状态
  const r = await weapiPost('/api/listen/together/status/get', {}, cookie);
  const j = parse(r.text);
  const d = (j && j.data) || {};
  if (j && j.code === 200) {
    const info = d.roomInfo || {};
    return {
      ok: true,
      inRoom: !!d.inRoom,
      status: d.status || '',
      roomInfo: info,
      users: info.roomUsers || [],
    };
  }
  return { ok: false, message: (j && j.message) || ('HTTP ' + r.status), raw: j };
}

/**
 * 房间播放态 + 歌单回读（P7 新增，2026-09 真机双人房实测通过）。
 *   POST /weapi/listen/together/sync/playlist/get  body { roomId }
 *   返回 data.playCommand（真人最近一次播放指令）+ data.playlist.displayList.result（歌单）。
 *   ⚠ 读取路径坑：playCommand 在 data.playCommand，不在 data.playlist.playCommand。
 *   ⚠ 单人房时 data 可能为 {}（须容错，返回 ok:true 但 playCommand=null）。
 * @returns {ok, playCommand, songIds, playMode, playlistVersion, raw}
 */
async function syncPlaylist(who, roomId) {
  const cookie = identity.readCookie(who);
  if (!cookie) return { ok: false, message: 'no cookie for ' + who };
  const r = await weapiPost('/api/listen/together/sync/playlist/get', { roomId: roomId }, cookie);
  const j = parse(r.text);
  if (!(j && j.code === 200)) {
    return { ok: false, message: (j && j.message) || ('HTTP ' + r.status), raw: j };
  }
  const d = (j && j.data) || {};
  const pl = (d && d.playlist) || {};
  const dl = (pl && pl.displayList) || {};
  return {
    ok: true,
    playCommand: (d && d.playCommand) || null,
    songIds: Array.isArray(dl.result) ? dl.result.map(String) : [],
    playMode: pl.playMode || '',
    playlistVersion: pl.version || [],
    replace: !!pl.replace,
    raw: d,
  };
}

/**
 * 心跳上报（P5 新增，2026 反编译实证）。
 *   POST /weapi/listen/together/heartbeat
 *   body { roomId, songId, playStatus, progress, playlistVersion }
 *   其中 progress 为 String.valueOf(long)，playlistVersion 为 List<CommandVersion>
 *   序列化后的 JSON 字符串（无歌单变更时传 "[]"）。
 *   ⚠ songId 不能为空串（空串→400 参数错误）；缺任一字段→400。
 *   成功判定：code==200 && data.result==true（旧写法 isResult 实为 result）。
 *   返回 {ok, result, timeSpan, message}
 */
async function heartbeat(who, roomId, opts) {
  const cookie = identity.readCookie(who);
  if (!cookie) return { ok: false, message: 'no cookie for ' + who };
  const o = opts || {};
  // eapi 心跳只发 4 个字段：roomId / songId / playStatus / progress。
  // ⚠️ 官方默认 songId='0'、playStatus='playing'（小写）、progress=30000。
  //    缺任一字段 → 400；songId 空串 → 400，故一律用 '0' 兜底。
  //    (旧实现多发 playlistVersion 且 songId 空串报错，与官方不符 → 已废弃)
  const songId = o.songId != null && String(o.songId) !== '' ? String(o.songId) : '0';
  const body = {
    roomId: roomId,
    songId: songId,
    playStatus: o.playStatus != null ? String(o.playStatus) : 'playing',
    progress: o.progress != null ? String(o.progress) : '30000',
  };
  const r = await weapiPost('/api/listen/together/heartbeat', body, cookie);
  const j = parse(r.text);
  const d = (j && j.data) || {};
  if (j && j.code === 200 && d.result === true) {
    return { ok: true, result: true, timeSpan: d.timeSpan, message: '' };
  }
  return { ok: false, result: false, type: d.type || (j && j.code !== 200 ? 'ERROR_ROOM_INVALID' : ''), message: (j && j.message) || ('HTTP ' + r.status), raw: j };
}

/**
 * 退房前校验（P5 新增）。
 *   POST /weapi/listen/together/end/check  body { roomId }
 * @returns {ok, result, raw}
 */
async function endCheck(who, roomId) {
  const cookie = identity.readCookie(who);
  if (!cookie) return { ok: false, message: 'no cookie for ' + who };
  const r = await weapiPost('/api/listen/together/end/check', { roomId: roomId }, cookie);
  const j = parse(r.text);
  if (j && j.code === 200) return { ok: true, result: true, data: (j.data || null) };
  return { ok: false, message: (j && j.message) || ('HTTP ' + r.status), raw: j };
}

/**
 * 退房 / 结束一起听（P5 新增，反编译 rg0/t0$g.smali 实证）。
 *   POST /weapi/listen/together/end/v2
 *   body { roomId, shareInfo(字符串), needRecord(bool), scene, exitType }
 *   i(roomId, shareInfo, needRecord, scene, exitType)
 *   scene 必填（如 "listenTogether"）；exitType 可空。
 * @returns {ok, result, shareInfo, raw}
 */
async function endRoom(who, roomId, opts) {
  const cookie = identity.readCookie(who);
  if (!cookie) return { ok: false, message: 'no cookie for ' + who };
  const o = opts || {};
  const shareInfo = o.shareInfo != null
    ? (typeof o.shareInfo === 'string' ? o.shareInfo : JSON.stringify(o.shareInfo))
    : 'null';
  const body = {
    roomId: roomId,
    shareInfo: shareInfo,
    needRecord: !!o.needRecord,
    scene: o.scene != null ? String(o.scene) : 'listenTogether',
    exitType: o.exitType != null ? String(o.exitType) : '',
  };
  const r = await weapiPost('/api/listen/together/end/v2', body, cookie);
  const j = parse(r.text);
  if (j && j.code === 200) {
    return { ok: true, result: true, shareInfo: (j.data && j.data.shareInfo) || null, data: (j.data || null) };
  }
  return { ok: false, message: (j && j.message) || ('HTTP ' + r.status), raw: j };
}

/**
 * 发送一起听邀请（P5 新增，反编译 rg0/t0.smali L3905 实证）。
 *   POST /weapi/listen/together/invite/message/send
 *   s(roomId, acceptorId(long), ltType(int)) → body { roomId, acceptorId, ltType }
 *   ⚠ ltType 必须为 1（传 0 → 400「类型错误」）；2026 实测 ltType=1 → 200。
 * @returns {ok, result, message}
 */
async function inviteSend(who, roomId, acceptorId, ltType) {
  const cookie = identity.readCookie(who);
  if (!cookie) return { ok: false, message: 'no cookie for ' + who };
  const r = await weapiPost('/api/listen/together/invite/message/send', {
    roomId: roomId,
    acceptorId: String(acceptorId),
    ltType: String(ltType != null ? ltType : 1),
  }, cookie);
  const j = parse(r.text);
  if (j && j.code === 200) return { ok: true, result: (j.data || true), message: '' };
  return { ok: false, message: (j && j.message) || ('HTTP ' + r.status), raw: j };
}

/**
 * 查询待处理邀请（P5 新增，反编译 rg0/t0$k.smali）。
 *   POST /weapi/listen/together/invitation-info/get  body { invitationVersion }
 * @returns {ok, inviteMsg, raw}
 */
async function invitationInfo(who, invitationVersion) {
  const cookie = identity.readCookie(who);
  if (!cookie) return { ok: false, message: 'no cookie for ' + who };
  const r = await weapiPost('/api/listen/together/invitation-info/get', {
    invitationVersion: String(invitationVersion != null ? invitationVersion : 0),
  }, cookie);
  const j = parse(r.text);
  if (j && j.code === 200) return { ok: true, inviteMsg: (j.data || null), raw: j };
  return { ok: false, message: (j && j.message) || ('HTTP ' + r.status), raw: j };
}

/**
 * 接受一起听邀请（P5 新增，反编译 rg0/t0$r.smali）。
 *   POST /weapi/listen/together/play/invitation/accept
 *   body { roomId, inviterId, [refer] }  → RoomInfoResult
 *   ⚠ 若被邀请人已在别的房，返回 type=ALREADY_IN_ROOM 且 roomInfo 是"自己的房"；
 *     此时应返回 needLeave=true，调用方需先 endRoom 退房再重试。
 * @returns {ok, roomId, roomInfo, type, needLeave, message}
 */
async function acceptInvitation(who, roomId, inviterId, refer) {
  const cookie = identity.readCookie(who);
  if (!cookie) return { ok: false, message: 'no cookie for ' + who };
  const body = { roomId: roomId, inviterId: String(inviterId) };
  // eapi 官方会带 listenTogetherRefer，实测默认 '1' 最稳（参考实现 room.js accept()）
  body.listenTogetherRefer = String(refer === undefined || refer === null ? '1' : refer);
  const r = await weapiPost('/api/listen/together/play/invitation/accept', body, cookie);
  const j = parse(r.text);
  const d = (j && j.data) || {};
  const info = d.roomInfo || {};
  const type = d.type || '';
  if (j && j.code === 200 && info.roomId && info.roomId === roomId) {
    return { ok: true, roomId: info.roomId, roomInfo: info, type: type, needLeave: false, message: '' };
  }
  if (j && j.code === 200 && type === 'ALREADY_IN_ROOM') {
    return {
      ok: false, type: type, needLeave: true,
      roomId: info.roomId || '', roomInfo: info,
      message: '被邀请人已在其他房间（roomId=' + (info.roomId || '') + '），需先退房再 accept',
    };
  }
  return { ok: false, type: type, needLeave: false, message: (j && j.message) || ('HTTP ' + r.status), raw: j };
}

/**
 * 拒绝一起听邀请（P5 新增，反编译 rg0/t0$f0.smali）。
 *   POST /weapi/listen/together/invitation/reject  body { roomId }
 * @returns {ok, result, message}
 */
async function rejectInvitation(who, roomId) {
  const cookie = identity.readCookie(who);
  if (!cookie) return { ok: false, message: 'no cookie for ' + who };
  const r = await weapiPost('/api/listen/together/invitation/reject', { roomId: roomId }, cookie);
  const j = parse(r.text);
  if (j && j.code === 200) return { ok: true, result: (j.data || true), message: '' };
  return { ok: false, message: (j && j.message) || ('HTTP ' + r.status), raw: j };
}

/**
 * 下发播放指令（P3 核心）。
 * @param {string} who
 * @param {string} roomId
 * @param {object} cmd  PlayCommand 字段（commandType/targetSongId/formerSongId/progress/playStatus/...）
 * @returns {ok, result, message}
 */
async function reportCommand(who, roomId, cmd) {
  const cookie = identity.readCookie(who);
  if (!cookie) return { ok: false, message: 'no cookie for ' + who };
  /* P9i: 统一兜底补全信封 —— 官方客户端 clientSeq 是毫秒时间戳；
   * 缺失/为 0 会被 APP 当过期指令忽略。这里对所有调用方一次性兜底。 */
  const c = Object.assign({}, cmd || {});
  const _t = Math.floor(Date.now() / 1000);   /* P9s: clientSeq 用秒级（官方 PlayCommand.clientSeq 是 int32） */
  if (!c.clientSeq) c.clientSeq = _t;
  if (c.playStatus === 'PLAYING') c.playStatus = 'PLAY';
  if (c.playStatus === 'PAUSED') c.playStatus = 'PAUSE';
  delete c.clientTime;   // P9j: 官方抓包无此字段，去掉以完全对齐
  const info = JSON.stringify(c);
  const r = await weapiPost('/api/listen/together/play/command/report', { roomId: roomId, commandInfo: info }, cookie);
  const j = parse(r.text);
  if (j && j.code === 200 && j.data && j.data.result === true) {
    return { ok: true, result: true, message: '' };
  }
  return { ok: false, message: (j && j.message) || ('HTTP ' + r.status), raw: j };
}

/**
 * 获取登录账号资料（含头像）。P5 新增（2026 实测）。
 *   POST /weapi/w/nuser/account/get {} → {code:200, profile:{userId,nickname,avatarUrl}}
 * 用途：接入「一起听」成功后，把该网易云账号的头像展示到播放页。
 * @returns {ok, userId, nickname, avatarUrl, profile}
 */
async function userAccount(who) {
  const cookie = identity.readCookie(who);
  if (!cookie) return { ok: false, message: 'no cookie for ' + who };
  const r = await weapiPost('/api/nuser/account/get', {}, cookie);
  const j = parse(r.text);
  const p = (j && j.profile) || (j && j.data && j.data.profile) || null;
  if (j && j.code === 200 && p) {
    return { ok: true, userId: p.userId, nickname: p.nickname || '', avatarUrl: p.avatarUrl || '', profile: p };
  }
  return { ok: false, message: (j && j.message) || ('HTTP ' + r.status), raw: j };
}

/* ==================================================================
 * 播放列表变更（REPLACE 全量替换）—— P8 新增，2026-09 融合参考实现
 * ------------------------------------------------------------------
 *  参考实现 room.js 实测结论（Frida hook okhttp 抓官方真实载荷）：
 *    ✅ 加歌 / 换歌单走 POST /api/listen/together/sync/list/command/report
 *       载荷是 commandType:'REPLACE' + **完整 displayList**（不是 ADD 增量）。
 *       旧实现用 operationType:'ADD' 是错误语义，服务端一律假成功。
 *    实测：15 → 17 首（追加） ✅    17 → 77 首（整单替换） ✅
 *  ⚠️ result:true 不代表生效，必须回读 syncPlaylist 做 diff 才作数。
 * ================================================================== */

/** 一起听接口路径（全部实测存在，融合自参考 room.js）。 */
const PATHS = {
  create: '/api/listen/together/room/create',
  accept: '/api/listen/together/play/invitation/accept',
  end: '/api/listen/together/end/v2',
  heartbeat: '/api/listen/together/heartbeat',
  status: '/api/listen/together/status/get',
  playlist: '/api/listen/together/sync/playlist/get',
  playCommand: '/api/listen/together/play/command/report',
  listCommand: '/api/listen/together/sync/list/command/report',
};

/** 心跳默认进度（毫秒），非零值更像正常客户端。 */
const DEFAULT_PROGRESS = 30000;

/**
 * 构造切歌指令（返回 JSON 字符串，塞进 commandInfo 时是「字符串套 JSON」）。
 * ⚠️ 字段名坑：必须用 targetSongId / formerSongId，**不是 songId**。
 *    用 songId 时接口照样返回 result:true，但 serverSeq 纹丝不动（假成功）。
 * @returns {string}
 */
function buildCommandInfo(o) {
  const opts = o || {};
  const t = Date.now();
  const target = String(opts.targetSongId !== undefined ? opts.targetSongId : opts.songId);
  const former = String(opts.formerSongId !== undefined ? opts.formerSongId : target);
  return JSON.stringify({
    commandType: opts.commandType || 'GOTO',
    targetSongId: target,
    formerSongId: former,
    playStatus: opts.playStatus || 'PLAY',
    progress: opts.progress || 0,
    clientSeq: t,
    clientTime: t,
  });
}

/**
 * 构造播放列表变更指令（返回 JSON 字符串）。
 * 核心认知：房间列表没有「加一首」的语义，只有「用完整列表 REPLACE」。
 * @param {object} o
 * @param {Array} o.displayList 完整歌单（必须全量！）
 * @param {Array} [o.version] 当前版本数组（从 syncPlaylist.playlistVersion 取）
 * @returns {string}
 */
function buildPlaylistParam(o) {
  const opts = o || {};
  const list = (opts.displayList || []).map(String);
  const anchorSongId = opts.anchorSongId != null
    ? String(opts.anchorSongId)
    : (list.length ? list[list.length - 1] : '');
  const anchorPosition = opts.anchorPosition != null
    ? opts.anchorPosition
    : Math.max(0, list.length - 1);
  return JSON.stringify({
    anchorPosition: anchorPosition,
    anchorSongId: anchorSongId,
    clientSeq: Date.now(),
    commandType: opts.commandType || 'REPLACE',
    displayList: list,
    randomList: [],
    version: opts.version || [],
  });
}

/**
 * 用一份**完整列表**替换房间歌单（换歌单 / 加歌都走这里）。
 *   POST /api/listen/together/sync/list/command/report
 *   body { roomId, playlistParam: <REPLACE JSON 字符串> }
 * ⚠️ 返回 result:true 不代表生效，调用方必须回读 syncPlaylist 复核。
 * @returns {ok, result, message, raw}
 */
async function replaceList(who, roomId, displayList, opts) {
  const cookie = identity.readCookie(who);
  if (!cookie) return { ok: false, message: 'no cookie for ' + who };
  const o = opts || {};
  let version = o.version;
  if (!version) {
    const cur = await syncPlaylist(who, roomId);
    version = (cur && cur.playlistVersion) || [];
  }
  const playlistParam = o.rawPlaylistParam || buildPlaylistParam({
    displayList: displayList,
    version: version,
    anchorSongId: o.anchorSongId,
    anchorPosition: o.anchorPosition,
  });
  const r = await weapiPost(PATHS.listCommand, { roomId: roomId, playlistParam: playlistParam }, cookie);
  const j = parse(r.text);
  if (j && j.code === 200) return { ok: true, result: true, data: (j.data || null), raw: j };
  return { ok: false, message: (j && j.message) || ('HTTP ' + r.status), raw: j };
}

/**
 * 把歌**追加**进房间列表（v0.4 已跑通）。
 * 实现：读当前列表 → 去重追加 → 整份 REPLACE 回去。
 *
 * ⚠️ 2026-09 真机实测：REPLACE 生效有 **约 3–5 秒服务端传播延迟**，
 *    即时回读会读到旧列表从而误判为「假成功」。故本函数默认做
 *    带重试的延迟验证（verify），`verified:true` 才算真正生效。
 * @param {string} who
 * @param {string} roomId
 * @param {Array} songIds 要追加的歌
 * @param {object} [opts] {dedupe=true, verify=true, verifyRetries=5, verifyDelayMs=1500}
 * @returns {ok, before, after, added, verified, message}
 */
async function addSongs(who, roomId, songIds, opts) {
  const o = opts || {};
  const cur = await syncPlaylist(who, roomId);
  if (!cur.ok) return { ok: false, message: cur.message || 'read playlist failed', raw: cur.raw };
  const before = (cur.songIds || []).map(String);
  const incoming = (songIds || []).map(String);
  const dedupe = o.dedupe !== false;
  const fresh = dedupe ? incoming.filter(function (id) { return before.indexOf(id) < 0; }) : incoming;
  if (!fresh.length) {
    return { ok: true, before: before.length, after: before.length, added: [], verified: true, result: true };
  }
  const displayList = before.concat(fresh);
  const r = await replaceList(who, roomId, displayList, {
    version: cur.playlistVersion,
    anchorSongId: fresh[fresh.length - 1],
    anchorPosition: displayList.length - 1,
  });
  if (!r.ok) return { ok: false, before: before.length, after: before.length, added: [], message: r.message, raw: r.raw };
  /* 带重试的延迟验证：服务端 REPLACE 传播有 3–5s 延迟 */
  let verified = false;
  let observed = before.length;
  if (o.verify !== false) {
    const retries = o.verifyRetries != null ? o.verifyRetries : 5;
    const delayMs = o.verifyDelayMs != null ? o.verifyDelayMs : 1500;
    for (let i = 0; i < retries; i += 1) {
      await new Promise(function (res) { setTimeout(res, delayMs); });
      const chk = await syncPlaylist(who, roomId);
      if (chk && chk.ok && Array.isArray(chk.songIds)) {
        observed = chk.songIds.length;
        if (observed >= displayList.length) { verified = true; break; }
      }
    }
  } else {
    verified = true; /* 未开启验证时不阻塞返回 */
  }
  return {
    ok: true, before: before.length, after: displayList.length, added: fresh,
    verified: verified, observed: observed, result: true,
    message: verified ? '' : ('已下发 REPLACE（result:true），但 ' + (o.verifyRetries || 5) + ' 次回读仍为 ' + observed + ' 首 —— 服务端可能有更长延迟或未生效，请再回读确认'),
  };
}

/**
 * 心跳 + 房间存活判定（融合参考 heartbeatChecked）。
 * 官方在**对方关房**时心跳返回 488（已由对方结束）→ 调用方应清空本地
 * roomId 重找邀请，否则会死守一个已消失的房间。
 * 网络错误不判定为房间消失，避免抖动误清。
 * @returns {alive, code, reason, raw}
 */
async function heartbeatChecked(who, roomId, opts) {
  let r;
  try {
    r = await heartbeat(who, roomId, opts);
  } catch (e) {
    return { alive: true, code: 0, reason: 'network_error', raw: null };
  }
  // 心跳返回体顶层可能是 code，也可能封装在 raw
  const code = Number((r && r.raw && r.raw.code) || (r && r.ok ? 200 : (r && r.code) || 0));
  if (code === 488) return { alive: false, code: 488, reason: 'ended_by_peer', raw: r.raw };
  if (r && r.ok) return { alive: true, code: 200, reason: 'ok', raw: r.raw };
  if (code && code !== 200) return { alive: false, code: code, reason: 'room_gone', raw: r.raw };
  return { alive: false, code: code || 0, reason: 'failed', raw: r.raw };
}

module.exports = {
  createRoom: createRoom, statusGet: statusGet, heartbeat: heartbeat,
  endCheck: endCheck, endRoom: endRoom,
  inviteSend: inviteSend, invitationInfo: invitationInfo,
  acceptInvitation: acceptInvitation, rejectInvitation: rejectInvitation,
  reportCommand: reportCommand, userAccount: userAccount, weapiPost: weapiPost,
  syncPlaylist: syncPlaylist,
  // P8 新增（REPLACE 全量替换 + 心跳存活判定）
  PATHS: PATHS,
  DEFAULT_PROGRESS: DEFAULT_PROGRESS,
  buildCommandInfo: buildCommandInfo,
  buildPlaylistParam: buildPlaylistParam,
  replaceList: replaceList,
  addSongs: addSongs,
  heartbeatChecked: heartbeatChecked,
};
