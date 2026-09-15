#!/usr/bin/env node
/**
 * netease_listen server — 一起听信令 + 播放器页面伺服 + 网易云API代理
 * 零依赖，Node >= 16
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const vm = require('vm'); /* __CUSTOM_SOURCE_ENGINE__ */
/* P1: 原生一起听驱动（接入模式分流） */
const nativeDriver = require('./native/driver').createDriver();
/* P2 扩展: 扫码登录（网易云 unikey 状态机，纯 API） */
const qrlogin = require('./native/qrlogin');
/* P2 扩展: 短信验证码登录（weapi 加密换 cookie） */
const smslogin = require('./native/smslogin');
/* P8: 原生一起听 REST 能力（REPLACE 加歌 / 邀请解析 / 房间发言） */
const ltapi = require('./native/ltapi');
const inviteLib = require('./native/invite');
const messageLib = require('./native/message');

const PORT = process.env.LT_PORT || 18765;
const PUBLIC_DIR = path.join(__dirname, 'public');
/* 网易云 API 地址: 可从 ai_config.json 的 neteaseApi 字段配置, 也可用环境变量覆盖 */
const DEFAULT_NETEASE_API = process.env.NETEASE_API || 'http://139.9.223.233:3000';
let NETEASE_API = DEFAULT_NETEASE_API;
/* --- 可配置音源接口 (预留: 可在设置面板修改, 支持 {mid}/{br}/{quality} 占位符) --- */
const DEFAULT_QQ_SEARCH_API = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const DEFAULT_QQ_RESOLVE_APIS = [
  'https://tang.api.s01s.cn/music_open_api.php?mid={mid}',
  'https://tang.api.s01s.cn/music_open_api.php?mid={mid}&quality={quality}',
  'https://metingapi.nanorocky.top/?server=tencent&type=url&br={br}&id={mid}'
];
let QQ_SEARCH_API = DEFAULT_QQ_SEARCH_API;
let QQ_RESOLVE_APIS = DEFAULT_QQ_RESOLVE_APIS.slice();

/* ---------------- 房间状态 ---------------- */
const state = {
  /* P1: 接入模式 local=纯本地(现状) | duo=真人一起听(AI+真人) | solo_ai=仅AI伴听 */
  mode: 'local',
  /* P9: 播放控制同步开关。
   *   false（默认）= 各端独立：网易云 APP 里的切歌/换歌/暂停只在 APP 生效，
   *                   插件内的播放操作也只在插件生效，互不干扰。
   *   true          = 双向同步：本地操作推送进房间，APP 操作回灌本地。
   *   ⚠️ 聊天消息不受此开关影响，始终双向同步。 */
  playSync: false,
  native: { enabled: false, connected: false, lastError: null, lastSyncTs: 0 },
  roomId: 'bailey-' + Math.random().toString(36).slice(2, 8),
  song: null,            // {id,name,artist,album,pic,url,duration}
  playing: false,
  positionMs: 0,
  anchorTs: Date.now(),  // 锚点：positionMs 对应的时间戳
  seq: 0,
  updatedAt: Date.now(),
updatedBy: 'system',
  /* 展示用元数据(页面点击自定义, 随状态持久化+广播) */
  meta: { distanceKm: '12.6', listenSeconds: 0 },
  playMode: 'order',     // order=顺序循环 | one=单曲循环 | random=随机播放
  playlist: [],          // 待播队列
  favorites: [],     // 红心
  favoritesSeq: 0,   // red heart seq
  history: [],           // 播放过的歌（供 next/prev）
  members: {},           // clientId -> {name,role,lastSeen}
  /* 循环检测: 同一首歌连续播放次数 + 上次触发主动消息的计数 */
  _repeatCount: 0,
  _lastRepeatTriggered: 0,
  _lastSongId: null,
  pendingPlaylist: null,  // 待确认的整单歌单 {name,songs,ts}
 };
/* 换歌时追踪循环次数, 触发主动消息 */
function trackSongRepeat(song) {
  if (!song || !song.id) return;
  var sid = String(song.id);
  if (state._lastSongId === sid) {
    state._repeatCount++;
  } else {
    state._lastSongId = sid;
    state._repeatCount = 1;
  }
  /* 第3次循环触发主动消息(只触发一次) */
  if (state._repeatCount >= 3 && state._repeatCount > state._lastRepeatTriggered) {
    state._lastRepeatTriggered = state._repeatCount;
    triggerProactiveRepeat(song, state._repeatCount);
  }
  /* 第7次再触发一次 */
  if (state._repeatCount >= 7 && state._repeatCount > state._lastRepeatTriggered) {
    state._lastRepeatTriggered = state._repeatCount;
    triggerProactiveRepeat(song, state._repeatCount);
  }
}
/* 主动消息: AI对循环歌曲发表评论 */
function triggerProactiveRepeat(song, count) {
  if (!aiConfig.endpoint || !aiConfig.apiKey || !aiConfig.model) return;
  var sysPrompt = aiConfig.systemPrompt;
  sysPrompt += '\n\n【自动触发】你正在和用户一起听歌。同一首歌《' + (song.name||'') + '》（' + (song.artist||'') + '）已经循环播放了' + count + '遍。'
    + '请自然地提一下这件事，语气随意、不要太长(30字以内)。可以调侃用户是不是很喜欢这首歌，或者说这首歌确实很好听值得循环。不要提"系统"、"触发"等字眼。';
  var messages = [{ role: 'system', content: sysPrompt }];
  messages.push({ role: 'user', content: '（系统提示：歌曲已循环' + count + '遍，主动评论一下）' });
  callLLM(messages, function(err, reply) {
    if (err) return;
    var text = String(reply).replace(/\[(PLAY|RECOMMEND):[^\]]+\]/g, '').replace(/\n{3,}/g,'\n').trim().slice(0, 200);
    if (!text) return;
    var msg = addChat('ai', '好友', text);
    msg.popEmoji = '🎵';
    broadcast('chat', msg);
    forwardChatToRoom('ai', text);
  });
}
 function pushHistory(song) {
  if (!song || !song.id) return;
  if (state.history.length && state.history[state.history.length-1].id === song.id) return;
  state.history.push(song);
  if (state.history.length > 50) state.history.shift();
}
/* 播过的歌进播放列表: 按id去重, 已在列表则只标已播 */
function touchPlaylist(song) {
  if (!song || song.id == null) return;
  const id = String(song.id);
  const i = state.playlist.findIndex((g) => String(g.id) === id);
  if (i < 0) state.playlist.push(Object.assign({ played: true }, song));
  else state.playlist[i].played = true;
  if (state.playlist.length > 100) state.playlist.shift();
}
// members: role: host=用户, ai=好友

function snapshot() {
  return {
    type: 'state',
    roomId: state.roomId,
    song: state.song,
    playing: state.playing,
    positionMs: currentPos(),
    seq: state.seq,
    playMode: state.playMode,
    updatedBy: state.updatedBy,
    playlist: state.playlist,
    history: state.history,
    favorites: state.favorites,
    meta: { distanceKm: state.meta.distanceKm, listenSeconds: currentListenSeconds(), listenHours: listenHoursStr(currentListenSeconds()) },
    members: Object.entries(state.members).map(([id, m]) => ({ id, ...m })),
    /* P5: 接入模式 + 网易云账号资料（含头像），供前端进页即渲染 */
    mode: state.mode,
    nativeAccount: (nativeDriver && nativeDriver.status) ? nativeDriver.status().account : null,
    nativeAccounts: (nativeDriver && nativeDriver.status) ? nativeDriver.status().accounts : null,
    /* P6: 实时房间快照（同房人数/连接态），供前端展示"两人已同房" */
    nativeRoom: (nativeDriver && nativeDriver.status) ? (function () {
      const ns = nativeDriver.status();
      return { connected: !!ns.connected, roomId: ns.roomId || null, remoteUsers: ns.remoteUsers || [] };
    })() : null,
    ts: Date.now(),
  };
}
/* 累计听歌秒数(播放时实时增长, 暂停时冻结) */
function currentListenSeconds() {
  var base = state.meta.listenSeconds || 0;
  if (state.playing && state._listenAnchor) {
    var add = Math.floor((Date.now() - state._listenAnchor) / 1000);
    if (add > 0) return base + add;
  }
  return base;
}
/* 暂停/切歌时把累计的增量固化到 listenSeconds */
function flushListenSeconds() {
  if (state._listenAnchor) {
    var add = Math.floor((Date.now() - state._listenAnchor) / 1000);
    if (add > 0) state.meta.listenSeconds = (state.meta.listenSeconds || 0) + add;
    state._listenAnchor = null;
  }
}
/* 秒数 → 小时字符串, 保留1位小数(6分钟=0.1小时) */
function listenHoursStr(sec) {
  return ((sec || 0) / 3600).toFixed(1);
}
function currentPos() {
  if (!state.playing) return state.positionMs;
  return state.positionMs + (Date.now() - state.anchorTs);
}

/* ---------------- SSE 客户端 ---------------- */
/** @type {Map<string, import('http').ServerResponse>} */
const clients = new Map();
let clientSeq = 0;

function sseInit(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(':ok\n\n');
  const id = 'c' + (++clientSeq);
  clients.set(id, res);
  return id;
}
function broadcast(event, data, excludeId) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [id, res] of clients) {
    if (id === excludeId) continue;
    try { res.write(payload); } catch (e) {}
  }
}
function pushState(reason) {
  broadcast('sync', snapshot());
  try { saveStateDebounced(); } catch (e) {}
}

/* ---------------- 聊天存储（持久化） ---------------- */
const CHAT_LOG_PATH = path.join(__dirname, 'chat_log.json');
const chatLog = []; // {id,from,name,text,ts}
try {
  const saved = JSON.parse(fs.readFileSync(CHAT_LOG_PATH, 'utf8'));
  if (Array.isArray(saved)) saved.forEach(m => chatLog.push(m));
  console.log('[LT] restored chat log:', chatLog.length, 'messages');
} catch(e) {}
let _chatSaveT = null;
function saveChatLogDebounced() {
  clearTimeout(_chatSaveT);
  _chatSaveT = setTimeout(function() {
    try { fs.writeFileSync(CHAT_LOG_PATH, JSON.stringify(chatLog.slice(-200))); } catch(e) {}
  }, 1000);
}
/* 清洗聊天文本：剥离模型工具调用标记（DSML / tool_calls / invoke / parameter），避免泄进气泡 */
function sanitizeChat(t) {
  if (t == null) return '';
  var s = String(t);
  // 1) 归一化全角变体（｜ ＜ ＞），模型输出常混入
  s = s.replace(/\uFF5C/g, '|').replace(/\uFF1C/g, '<').replace(/\uFF1E/g, '>');
  // 2) 从第一个工具调用标记起，整段截断到结尾
  var m = s.search(/<\s*\/?\s*\|*\s*(DSML|tool_calls|invoke|parameter)\b/i);
  if (m >= 0) s = s.slice(0, m);
  // 3) 残留的成对/自闭合标签
  s = s.replace(/<\/?\s*(tool_calls|invoke|parameter)(\s[^>]*)?>/gi, '');
  // 4) 折叠多余空行
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}
function addChat(from, name, text) {
  const msg = { id: 'm' + Date.now() + Math.random().toString(36).slice(2, 5), from, name, text: sanitizeChat(text).slice(0, 500), ts: Date.now() };
  chatLog.push(msg);
  if (chatLog.length > 200) chatLog.shift();
  saveChatLogDebounced();
  return msg;
}

/* ---------------- 工具 ---------------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { resolve({}); } });
  });
}
/* 大体积 JSON body (语音 base64 录音可达数百KB), 单独放宽上限 */
function readBodyLarge(req, maxBytes) {
  maxBytes = maxBytes || 8e6;
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > maxBytes) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
/* 语音转文字: 调 omni 多模态模型 (qwen3.5-omni-flash 实测可吃 input_audio) */
async function transcribeAudio(b64, format) {
  if (!aiConfig.endpoint || !aiConfig.apiKey) return { ok: false, error: '请先配置模型' };
  var fmt = (format || 'wav').replace(/[^a-z0-9]/gi, '') || 'wav';
  var url = aiConfig.endpoint.replace(/\/+$/, '') + '/chat/completions';
  var payload = JSON.stringify({
    model: 'qwen3.5-omni-flash',
    messages: [{
      role: 'user',
      content: [
        { type: 'input_audio', input_audio: { data: 'data:audio/' + fmt + ';base64,' + b64, format: fmt } },
        { type: 'text', text: '请把这段音频转写成中文文字，只输出转写结果，不要任何解释、标点以外的多余内容。如果听不清就输出空字符串。' }
      ]
    }],
    max_tokens: 300
  });
  var resp = await httpsPostJson(url, payload, { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + aiConfig.apiKey }, 60000);
  if (!resp) return { ok: false, error: '转写请求超时' };
  if (resp.status !== 200) {
    var em = 'HTTP ' + resp.status;
    try { var eo = JSON.parse(resp.body); if (eo && eo.error && eo.error.message) em = eo.error.message; } catch (e) {}
    return { ok: false, error: '转写失败: ' + em };
  }
  try {
    var d = JSON.parse(resp.body);
    var c = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    if (typeof c === 'string') return { ok: true, text: c.trim() };
    if (Array.isArray(c)) return { ok: true, text: c.map(function(x){return x&&x.text||''}).join('').trim() };
    return { ok: false, error: '转写返回为空' };
  } catch (e) { return { ok: false, error: '解析转写结果失败' }; }
}
/* ---------------- 工具调用 XML 清理（模型偶尔输出 Operit 工具块导致气泡空白） ----------------
 * 实测：用户说「换一首」时，模型会返回
 *   <function_calls><invoke name="netease_listen:ai_play_control">
 *     <parameter name="action">next</parameter></invoke></function_calls>
 * 旧实现只清理 [PLAY:xxx] 标记，此 XML 原样广播 → 前端当作 HTML 标签吞掉 → 气泡空白。
 * 这里：① 提取工具意图并落地为真正的本地动作；② 从展示文本中剥离 XML。 */
function extractToolIntents(text) {
  const out = [];
  const s = String(text || '');
  const invokeRe = /<(?:antml:)?invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/(?:antml:)?invoke>/gi;
  let m;
  while ((m = invokeRe.exec(s)) !== null) {
    const tool = m[1];
    const inner = m[2];
    const params = {};
    const pRe = /<(?:antml:)?parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/(?:antml:)?parameter>/gi;
    let pm;
    while ((pm = pRe.exec(inner)) !== null) params[pm[1]] = String(pm[2]).trim();
    out.push({ tool: tool, params: params });
  }
  return out;
}
function stripToolXml(text) {
  let s = String(text || '');
  s = s.replace(/<(?:antml:)?function_calls[^>]*>[\s\S]*?<\/(?:antml:)?function_calls>/gi, '');
  s = s.replace(/<(?:antml:)?invoke\s+name="[^"]*"[^>]*>[\s\S]*?<\/(?:antml:)?invoke>/gi, '');
  s = s.replace(/<(?:antml:)?invoke[^>]*\/>/gi, '');
  s = s.replace(/<\s*(?:antml:)?(?:invoke|parameter|function_calls)\b[^>]*>/gi, '');
  s = s.replace(/<\s*\/\s*(?:antml:)?(?:invoke|parameter|function_calls)\s*>/gi, '');
  s = s.replace(/`{3,}/g, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}
/* 把工具意图落地为本地动作（复用现有 /control 全套逻辑，零重复实现） */
function selfControl(body) {
  try {
    const data = JSON.stringify(body || {});
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: '/control', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    });
    r.on('error', function () {});
    r.write(data);
    r.end();
  } catch (e) {}
}
function applyToolIntent(it, opts) {
  try {
    const tool = String((it && it.tool) || '');
    const p = (it && it.params) || {};
    const action = String(p.action || '').toLowerCase();
    if (/ai_play_control/.test(tool)) {
      if (['next', 'prev', 'play', 'pause', 'toggle'].indexOf(action) >= 0) {
        selfControl({ action: action, by: 'ai' });
      } else if (action === 'seek' && (p.position_ms != null || p.position != null)) {
        selfControl({ action: 'seek', position: Number(p.position_ms != null ? p.position_ms : p.position) || 0, by: 'ai' });
      }
    } else if (/play_song|play_from_favorite/.test(tool)) {
      const kw = p.keyword || p.song_name || p.song_id;
      if (kw) { try { aiSearchAndPlay(String(kw), true, opts); } catch (e) {} }
    }
  } catch (e) {}
}
/* 确定性本地控制指令识别：短句祈使句直接落地，不依赖模型是否输出工具块。
 * 实测「暂停一下」模型只口头答应、未落地 → 这里兜底。 */
function detectLocalCommand(text) {
  const s = String(text || '').replace(/\s/g, '');
  if (!s || s.length > 12) return null;
  if (/^(暂停|停一下|暂停一下|别放了|先停|pause)$/i.test(s)) return 'pause';
  if (/^(继续|继续播放|接着放|播放|放吧|play|恢复播放)$/i.test(s)) return 'play';
  if (/^(下一首|切歌|换一首|换歌|换首|切下一首|next|来下一首|换一首歌)$/i.test(s)) return 'next';
  if (/^(上一首|前一首|回上一首|prev|previous)$/i.test(s)) return 'prev';
  return null;
}
/* P8: 统一转发聊天到网易云一起听房间（真人 APP 聊天区可见）。
 * ⚠️ 身份必须按来源区分：
 *   - 用户/真人发的（from='me'/'host'）→ 用 **human** 身份发送，APP 里显示成「你自己」
 *   - AI 回复（from='ai'）           → 用 **ai** 身份发送
 * 房间内文字走 HTTP /api/middle/im/chatroom/send，**不需要云信 SDK**。 */
function forwardChatToRoom(from, text) {
  const t = String(text || '').trim();
  if (!t) return;
  try {
    let ds = {};
    try { ds = nativeDriver.status() || {}; } catch (e) {}
    const chatroomId = ds.chatRoomId || state.native.chatRoomId || '';
    const roomId = ds.roomId || state.native.roomId || '';
    if (!chatroomId) { console.log('[chat→room] skip: no chatRoomId（未接入房间）'); return; }
    const who = (from === 'ai') ? 'ai' : 'human';
    /* P9: 记录本地主动转发的文本，供 roomwatch 做「回声过滤」，
     *     避免本地播放器发的话被云信读回后又触发一次 AI 回复。 */
    _recentForwarded[t] = Date.now();
    const svc = new messageLib.MessageService(who);
    svc.sendToRoom({ chatroomId: chatroomId, text: t.slice(0, 700), roomId: roomId, ltType: 'FRIEND' })
      .then(function (r) { console.log('[chat→room]', who, 'code=' + (r && r.code)); })
      .catch(function (e) { console.log('[chat→room]', who, 'error:', (e && e.message) || e); });
  } catch (e) {}
}
/** P9: 本地最近转发到房间的文本 → 时间戳（回声过滤用） */
const _recentForwarded = {};
function _pruneForwarded() {
  const now = Date.now();
  Object.keys(_recentForwarded).forEach(function (k) {
    if (now - _recentForwarded[k] > 8000) delete _recentForwarded[k];
  });
}
/* ============================================================
 * P9: 房间「读消息」闭环 —— 网易云 APP 里真人发言 → 本地感知 → AI 回复
 * ------------------------------------------------------------
 *  背景：HTTP 层 chatroom/{history,messages,get} 全部 404（已复测），
 *        读房间消息唯一途径是云信长连接（native/im.js + roomwatch.js）。
 *  链路：roomwatch 常驻收包 → pull → 回灌本地 chatLog（from='me'）
 *        → 触发本地 AI 回复（复用 /ai/chat 全套逻辑，含点歌/推荐/转发）
 * ============================================================ */
const roomwatchLib = require('./native/roomwatch');
const roomWatch = roomwatchLib.createRoomWatch();
let _roomWatchCursor = 0;
let _roomWatchTimer = null;
let _roomWatchLastErr = '';
let _roomWatchLastStart = 0;

/** 把一条真人房间消息回灌本地，并触发 AI 回复（复用 /ai/chat） */
function handleRoomHumanMessage(m) {
  try {
    const nick = m.senderNick || '好友';
    const text = String(m.text || '').trim();
    if (!text) return;
    /* P9 回声过滤：本地刚转发出去的话会被云信读回（human 身份），
     * 此时不能再次触发 AI 回复，否则会「自问自答」刷屏。 */
    _pruneForwarded();
    if (_recentForwarded[text]) {
      console.log('[roomwatch] echo skipped (local forward):', text.slice(0, 40));
      return;
    }
    console.log('[roomwatch] human:', nick, '|', text.slice(0, 60));
    /* ① 回灌到本地聊天（标记来源房间，避免与本地输入重复） */
    const msg = addChat('me', nick, text);
    msg.fromRoom = true;
    broadcast('chat', msg);
    /* ② 触发 AI 回复：走本地 /ai/chat，复用完整链路（点歌/推荐/身份转发） */
    selfPostChat(text, true);
  } catch (e) { console.log('[roomwatch] handle error:', (e && e.message) || e); }
}

/** 向本机 /ai/chat 发一条消息（用于把房间消息喂给 AI），不阻塞 */
function selfPostChat(text, fromRoom) {
  /* P9g: fromRoom=true → AI 知道这是「APP 里说的话」，换歌只动 APP，不动插件本地。 */
  const body = JSON.stringify({ text: String(text || '').slice(0, 500), fromRoom: !!fromRoom });
  const req = http.request({
    host: '127.0.0.1', port: PORT, path: '/ai/chat', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, function (r) { r.resume(); });
  req.on('error', function (e) { console.log('[roomwatch] selfPostChat error:', e.message); });
  req.write(body); req.end();
}

/** 尝试启动云信房间监听（需已接入房间） */
function tryStartRoomWatch() {
  const ds = (function () { try { return nativeDriver.status() || {}; } catch (e) { return {}; } })();
  if (!ds.connected || !ds.roomId || !ds.chatRoomId) return;
  if (roomWatch.status().started) return;
  if (Date.now() - _roomWatchLastStart < 15000) return; // 失败退避，避免频繁重连
  _roomWatchLastStart = Date.now();
  roomWatch.start({
    roomId: ds.roomId,
    chatroomId: ds.chatRoomId,
    nick: (ds.account && ds.account.nickname) || '',
  }).then(function (r) {
    _roomWatchCursor = roomWatch.cursor(); // 跳过历史，只收新消息
    _roomWatchLastErr = '';
    console.log('[roomwatch] started chatroomId=' + r.chatroomId + ' (cursor=' + _roomWatchCursor + ')');
  }).catch(function (e) {
    _roomWatchLastErr = String((e && e.message) || e);
    console.log('[roomwatch] start failed:', _roomWatchLastErr);
  });
}

/** 轮询消费 roomwatch 缓冲 */
function roomWatchTick() {
  try {
    if (!roomWatch.status().started) return;
    const items = roomWatch.pull(_roomWatchCursor);
    for (let i = 0; i < items.length; i += 1) {
      _roomWatchCursor = items[i].seq;
      handleRoomHumanMessage(items[i].msg);
    }
  } catch (e) {}
}
_roomWatchTimer = setInterval(function () { tryStartRoomWatch(); roomWatchTick(); }, 2000);
if (_roomWatchTimer.unref) _roomWatchTimer.unref();

/* P9b: 把「AI 点歌」推送到网易云房间（AI 操控 APP 切歌）。
 * ⚠️ 两个实测坑：
 *   ① 顺序：必须先 addSongs 并**等它真正生效**（REPLACE 有 3–5s 服务端传播延迟），
 *      否则 GOTO 指向一首「还不在房间里」的歌会被忽略。
 *   ② 指令信封：**不能**直接调 ltapi.reportCommand（缺 clientSeq/triggerType/userId，
 *      发出去 clientSeq=0、triggerType=null，APP 端按 clientSeq 去重会当成「已处理」直接忽略）。
 *      必须走 /control 的 load 动作，由 driver.handleControl 补全信封字段。 */
function pushSongToRoom(songId, opts) {
  const o = opts || {};
  /* P9f: AI 点歌 → 推送到网易云 APP（这就是「在 APP 里让 AI 切歌」能生效的关键）。
   * 手动路径不会走到这里，所以插件 UI 依旧不影响 APP。 */
  let ds = {};
  try { ds = nativeDriver.status() || {}; } catch (e) {}
  if (!ds.connected || !ds.roomId) { console.log('[song→room] skip: 未接入房间'); return; }
  const sid = String(songId);
  const roomId = ds.roomId;
  const playing = o.playing !== false;
  ltapi.addSongs('ai', roomId, [sid], { dedupe: true, verify: true, verifyRetries: 6, verifyDelayMs: 1500 })
    .then(function (r) {
      console.log('[song→room] addSongs ok=' + (r && r.ok) + ' verified=' + (r && r.verified) + ' id=' + sid);
      /* 等列表传播稳定后，再经 /control（handleControl 补全 clientSeq/triggerType/userId）下发播放 */
      return new Promise(function (res) { setTimeout(res, 1800); });
    })
    .then(function () {
      selfControl({
        action: 'load',
        song: { id: sid, name: (o.name || ''), artist: (o.artist || '') },
        position: 0,
        autoplay: playing,
        by: 'ai',
      });
      console.log('[song→room] dispatch /control load id=' + sid);
    })
    .catch(function (e) { console.log('[song→room] err:', (e && e.message) || e); });
}

function fetchUpstreamJson(pathWithQuery) {
  return new Promise((resolve, reject) => {
    http.get(NETEASE_API + pathWithQuery, { headers: { 'User-Agent': 'curl/7.68.0' } }, ur => {
      let buf = '';
      ur.on('data', c => buf += c);
      ur.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function proxyReq(req, res, targetPath, search) {
  const url = NETEASE_API + targetPath + (search || '');
  const headers = { 'User-Agent': 'curl/7.68.0', Accept: '*/*' };
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  const opts = { method: req.method, headers };
  const upstream = http.request(url, opts, ur => {
    const h = { ...ur.headers };
    h['Access-Control-Allow-Origin'] = '*';
    delete h['content-security-policy'];
    delete h['x-frame-options'];
    res.writeHead(ur.statusCode, h);
    ur.pipe(res);
  });
  upstream.on('error', err => {
    try { json(res, 502, { code: 502, msg: 'upstream error: ' + err.message }); } catch (e) {}
  });
  req.pipe(upstream);
}

/* ---------------- QQ 音乐音源: 搜索 + URL 解析 ---------------- */
/* 移植自 AstrBot 插件 txqq.py + ynx_resolver.py, 零依赖 Node.js 版 */

/* 通用 HTTPS GET 返回 {status, body, headers} */
function httpsGetJson(url, headers, timeout) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const opts = { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'GET',
      headers: Object.assign({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36' }, headers || {}) };
    let resolved = false;
    const r = mod.request(opts, (resp) => {
      let buf = '';
      resp.on('data', c => buf += c);
      resp.on('end', () => {
        if (!resolved) { resolved = true; resolve({ status: resp.statusCode, body: buf, headers: resp.headers, location: resp.headers.location || '' }); }
      });
    });
    r.on('error', (e) => { if (!resolved) { resolved = true; resolve(null); } });
    if (timeout) {
      setTimeout(() => { if (!resolved) { resolved = true; try { r.destroy(); } catch(e){} resolve(null); } }, timeout);
    }
    r.end();
  });
}

/* HTTPS POST JSON: 发送 body, 返回 { status, body, location } */
function httpsPostJson(url, body, headers, timeout) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const hdrs = Object.assign({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36' }, headers || {});
    if (body && !hdrs['Content-Length']) hdrs['Content-Length'] = Buffer.byteLength(body);
    const opts = { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'POST', headers: hdrs };
    let resolved = false;
    const r = mod.request(opts, (resp) => {
      let buf = '';
      resp.on('data', c => buf += c);
      resp.on('end', () => {
        if (!resolved) { resolved = true; resolve({ status: resp.statusCode, body: buf, headers: resp.headers, location: resp.headers.location || '' }); }
      });
    });
    r.on('error', (e) => { if (!resolved) { resolved = true; resolve(null); } });
    if (timeout) {
      setTimeout(() => { if (!resolved) { resolved = true; try { r.destroy(); } catch(e){} resolve(null); } }, timeout);
    }
    if (body) r.write(body);
    r.end();
  });
}

/* QQ 音乐搜索: 调 u.y.qq.com musicu.fcg GET 接口, 返回标准化歌曲数组 */
async function qqSearch(keyword, limit) {
  limit = Math.max(limit || 20, 20);
  var body = JSON.stringify({
    comm: { ct: '20', cv: '0' },
    req: { module: 'music.search.SearchCgiService', method: 'DoSearchForQQMusicMobile',
      param: { search_type: 0, query: keyword, page_num: 1, num_per_page: limit } }
  });
  /* 用 POST 避免 GET URL 过长, 速度更快 */
  var resp = await httpsPostJson(QQ_SEARCH_API, body, { 'Referer': 'https://y.qq.com/', 'Content-Type': 'application/json' }, 8000);
  if (!resp || resp.status !== 200) return [];
  try {
    var d = JSON.parse(resp.body);
    if (d.code !== 0 || (d.req && d.req.code !== 0)) return [];
    var items = (d.req && d.req.data && d.req.data.body && d.req.data.body.item_song) || [];
    var songs = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var file = item.file || {};
      if (!file.media_mid) continue;
      var album = item.album || {};
      var singers = item.singer || [];
      var albumMid = album.mid || '';
      var singerMid = singers.length ? singers[0].mid : '';
      var cover = albumMid
        ? 'https://y.gtimg.cn/music/photo_new/T002R500x500M000' + albumMid + '.jpg'
        : (singerMid ? 'https://y.gtimg.cn/music/photo_new/T001R500x500M000' + singerMid + '.jpg' : '');
      var songMid = item.mid || file.media_mid || '';
      var songId = item.id || 0;  /* QQ 数字 songid, 用于评论 API */
      var rawTitle = item.title || item.name || '';
      var cleanTitle = rawTitle.replace(/<\/?em>/g, '');
      var artistNames = [];
      for (var j = 0; j < singers.length; j++) { if (singers[j].name) artistNames.push(singers[j].name); }
      songs.push({
        id: String(songMid),
        songid: songId,  /* QQ 数字 ID */
        name: cleanTitle || '未知',
        artist: artistNames.join('/') || '',
        pic: cover,
        source: 'qq',
        duration: (file.size && file.size * 8 / 128000) | 0 || 0
      });
    }
    return songs;
  } catch (e) { return []; }
}

/* ================= 自定义音源脚本引擎 __CUSTOM_SOURCE_ENGINE__ ================= */
/* 用户可导入 JS 音源脚本, 在 vm 沙箱中运行; 自定义音源优先级最高, 失败自动回落内置源 */
const CUSTOM_SOURCES_PATH = path.join(__dirname, 'custom_sources.json');
let customSources = []; /* [{ id, name, script, enabled, ts }] */
try {
  const _csv = JSON.parse(fs.readFileSync(CUSTOM_SOURCES_PATH, 'utf8'));
  if (Array.isArray(_csv)) customSources = _csv.filter(function (s) { return s && typeof s.script === 'string'; });
} catch (e) {}
function saveCustomSources() { try { fs.writeFileSync(CUSTOM_SOURCES_PATH, JSON.stringify(customSources, null, 2)); } catch (e) {} }
/* 从本地文件读取音源脚本（路径白名单 + 扩展名 + 大小限制） */
function readSourceFile(fp) {
  fp = String(fp || '').trim();
  if (!fp) return { ok: false, error: '路径为空' };
  var allow = ['/sdcard/', '/storage/emulated/0/', '/data/user/0/com.ai.assistance.operit/', '/home/ubuntu/', '/data/data/com.ai.assistance.operit/'];
  var okp = allow.some(function (a) { return fp.indexOf(a) === 0; });
  if (!okp) return { ok: false, error: '路径不在允许范围（请用 /sdcard/... 等）' };
  if (!/\.(js|mjs|txt|json)$/i.test(fp)) return { ok: false, error: '仅支持 .js/.mjs/.txt/.json' };
  try {
    var st = fs.statSync(fp);
    if (!st.isFile()) return { ok: false, error: '不是文件' };
    if (st.size > 2 * 1024 * 1024) return { ok: false, error: '文件过大(>2MB)' };
    var content = fs.readFileSync(fp, 'utf8');
    var base = path.basename(fp).replace(/\.(js|mjs|txt|json)$/i, '');
    return { ok: true, content: content, name: base, size: st.size };
  } catch (e) { return { ok: false, error: '读取失败: ' + ((e && e.message) || e) }; }
}
function genSourceId() { return 'src_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
/* 在 vm 沙箱中执行单个音源脚本; 脚本需定义 async function resolve(ctx){} (或 module.exports) */
function runCustomScript(src2, ctx, timeoutMs) {
  timeoutMs = timeoutMs || 8000;
  return new Promise(function (resolveResult) {
    let settled = false;
    function finish(v) { if (!settled) { settled = true; resolveResult(v); } }
    const timer = setTimeout(function () { finish(null); }, timeoutMs);
    try {
      const sandbox = {
        console: { log: function () {}, error: function () {}, warn: function () {} },
        module: { exports: {} }, exports: {},
        Buffer: Buffer, URL: URL, setTimeout: setTimeout, clearTimeout: clearTimeout,
        /* 注入安全网络工具, 供脚本调用第三方接口 */
        fetchJson: function (url, opts) {
          opts = opts || {};
          return httpsGetJson(url, opts.headers || {}, opts.timeout || 8000).then(function (r) {
            if (!r) return null;
            try { return JSON.parse(r.body); } catch (e) { return r.body; }
          });
        },
        httpGet: function (url, headers, timeout) { return httpsGetJson(url, headers || {}, timeout || 8000); },
        httpPost: function (url, body, headers, timeout) { return httpsPostJson(url, body, headers || {}, timeout || 8000); }
      };
      const context = vm.createContext(sandbox); /* __SRC_VM_FIX__ */
      sandbox.__nl_ctx = ctx;
      sandbox.__nl_out = null;
      /* 直接在沙箱内调用 resolve(), 让同步死循环也被 vm timeout 兜住 */
      const wrapped = '"use strict";\n' + String(src2) + '\n;__nl_out = (typeof resolve === "function") ? resolve(__nl_ctx) : ((typeof module === "object" && module.exports) ? ((typeof module.exports === "function") ? module.exports(__nl_ctx) : (typeof module.exports.resolve === "function" ? module.exports.resolve(__nl_ctx) : (typeof module.exports.default === "function" ? module.exports.default(__nl_ctx) : null))) : null);';
      vm.runInContext(wrapped, context, { timeout: timeoutMs });
      const factory = function () { return sandbox.__nl_out; };
      Promise.resolve().then(function () { return factory(ctx); }).then(function (v) {
        clearTimeout(timer);
        if (v == null) return finish(null);
        if (typeof v === 'string') return finish(v);
        if (typeof v === 'object') return finish(v.url || v.play_url || v.music_url || v.src || v.link || null);
        finish(null);
      }).catch(function () { clearTimeout(timer); finish(null); });
    } catch (e) { clearTimeout(timer); finish(null); }
  });
}
/* 依次尝试所有启用的自定义音源, 返回第一个可用 URL; 全部失败返回 null */
async function resolveCustomUrl(ctx) {
  if (!customSources.length) return null;
  const list = customSources.filter(function (s) { return s && s.enabled !== false && s.script; });
  for (let i = 0; i < list.length; i++) {
    let url = null;
    try { url = await runCustomScript(list[i].script, ctx, 8000); } catch (e) { url = null; }
    if (url && typeof url === 'string' && /^https?:\/\//.test(url)) {
      console.log('[SRC] custom source hit:', list[i].name);
      return url;
    }
  }
  return null;
}
/* ---------- 多接口解析工具 ---------- */
/* 模板替换: 支持 {mid}/{br}/{quality} 及 {midRaw}/{brRaw}/{qualityRaw} 和任意自定义键 */
function applyTpl(str, ctx) {
  if (str == null) return str;
  return String(str).replace(/\{(\w+)\}/g, function (m, k) {
    return (ctx && ctx[k] !== undefined && ctx[k] !== null) ? String(ctx[k]) : m;
  });
}
/* 按点路径取值: 'data.url' / 'a.b.0.c' */
function getByPath(obj, path) {
  if (obj == null || !path) return null;
  var parts = String(path).split('.');
  var cur = obj;
  for (var i = 0; i < parts.length; i++) {
    if (cur == null) return null;
    if (Array.isArray(cur)) { var idx = parseInt(parts[i], 10); cur = isNaN(idx) ? undefined : cur[idx]; }
    else cur = cur[parts[i]];
  }
  return cur == null ? null : cur;
}
/* 归一化单个解析接口: 兼容旧字符串写法与新的对象写法 */
function normalizeResolveItem(item) {
  if (typeof item === 'string') { var t = item.trim(); return t ? { url: t } : null; }
  if (!item || typeof item !== 'object') return null;
  var o = { url: (typeof item.url === 'string') ? item.url.trim() : '' };
  if (String(item.method || 'GET').toUpperCase() === 'POST') o.method = 'POST';
  if (item.headers && typeof item.headers === 'object') o.headers = item.headers;
  if (item.params && typeof item.params === 'object') o.params = item.params;
  if (typeof item.body === 'string' && item.body) o.body = item.body;
  if (typeof item.extract === 'string' && item.extract.trim()) o.extract = item.extract.trim();
  if (typeof item.label === 'string' && item.label) o.label = item.label;
  if (typeof item.name === 'string' && item.name && !o.label) o.label = item.name;
  if (typeof item.apiKey === 'string' && item.apiKey) o.apiKey = item.apiKey;
  if (!o.url) return null;
  return o;
}
/* 组装最终 URL: 模板替换 + params 合并 */
function buildResolveUrl(it, ctx) {
  var url = applyTpl(it.url, ctx);
  if (it.params) {
    var qs = [];
    Object.keys(it.params).forEach(function (k) {
      var v = applyTpl(it.params[k], ctx);
      if (v !== undefined && v !== null && v !== '') qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    if (qs.length) url += (url.indexOf('?') >= 0 ? '&' : '?') + qs.join('&');
  }
  return url;
}
/* QQ 音乐 URL 解析: 并行尝试所有接口, 谁先成功用谁 (支持自定义 参数/请求头/请求方式/提取路径) */
async function qqResolveUrl(songMid, quality) {
  quality = quality || '128k';
  var br = (quality === '320k') ? '320' : (quality === 'flac' || quality === 'hires') ? '999' : '128';
  var ctx = {
    mid: encodeURIComponent(songMid), br: String(br), quality: encodeURIComponent(quality),
    midRaw: songMid, brRaw: String(br), qualityRaw: quality
  };
  /* 自定义音源优先: 命中则直接返回, 失败回落内置接口 */
  try {
    let _nm = '', _ar = '';
    if (state.song && String(state.song.id) === 'qq_' + songMid) { _nm = state.song.name || ''; _ar = state.song.artist || ''; }
    const _cust = await resolveCustomUrl({ id: 'qq_' + songMid, mid: songMid, midRaw: songMid, name: _nm, artist: _ar, quality: quality, br: String(br) });
    if (_cust) return _cust;
  } catch (e) {}
  var items = (QQ_RESOLVE_APIS || []).map(normalizeResolveItem).filter(Boolean);
  if (!items.length) return null;
  return new Promise(function (resolve) {
    var done = false, remaining = items.length;
    function finish() { if (!done) { done = true; resolve(null); } }
    function handle(resp, it) {
      if (done) return;
      remaining--;
      if (resp && resp.status < 400) {
        if (resp.location && /^https?:\/\//.test(resp.location)) { done = true; resolve(resp.location); return; }
        /* 优先按用户自定义的提取路径取值 */
        if (it.extract) {
          var data = null;
          try { data = JSON.parse(resp.body); } catch (e) { data = null; }
          var picked = data ? getByPath(data, it.extract) : null;
          if (typeof picked === 'string' && /^https?:\/\//.test(picked)) { done = true; resolve(picked); return; }
          if (typeof picked === 'string' && picked) { done = true; resolve(picked); return; }
        }
        var play = extractAudioUrl(resp.body);
        if (play) { done = true; resolve(play); return; }
      }
      if (remaining <= 0) finish();
    }
    items.forEach(function (it) {
      /* 每个接口独立上下文: 支持 {apiKey}/{key} 占位符 */
      var ictx = Object.assign({}, ctx, { apiKey: it.apiKey || '', key: it.apiKey || '' });
      var url;
      try { url = buildResolveUrl(it, ictx); } catch (e) { url = null; }
      if (!url) { handle(null, it); return; }
      var headers = { 'Accept': 'application/json, text/plain, */*' };
      /* 有 API Key 自动带上 Authorization 头 (若用户未自定义) */
      if (it.apiKey && !it.headers) headers['Authorization'] = 'Bearer ' + it.apiKey;
      if (it.headers) Object.keys(it.headers).forEach(function (k) { headers[k] = applyTpl(it.headers[k], ictx); });
      var p;
      try {
        if (it.method === 'POST' || it.body) {
          var body = it.body ? applyTpl(it.body, ictx) : '';
          if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
          p = httpsPostJson(url, body, headers, 8000);
        } else {
          p = httpsGetJson(url, headers, 8000);
        }
      } catch (e) { handle(null, it); return; }
      p.then(function (resp) { handle(resp, it); }).catch(function () { handle(null, it); });
    });
  });
}
/* 从 JSON 或文本中提取音频 URL */
function extractAudioUrl(raw) {
  if (!raw) return null;
  /* 直接是 URL */
  var trimmed = raw.trim();
  if (trimmed.match(/^https?:\/\/[^\s'"<>]+\.(mp3|m4a|flac|ape|wav)/i)) return trimmed;
  if (trimmed.match(/^https?:\/\/[^\s'"<>]+stream\.qqmusic\.qq\.com/i)) return trimmed;
  /* JSON 解析 */
  var data;
  try { data = JSON.parse(raw); } catch (e) { 
    /* 从文本里正则提取 */
    var m = raw.match(/(https?:\/\/[^\s'"<>]+\.(mp3|m4a|flac|ape|wav))/i);
    if (m) return m[1];
    m = raw.match(/(https?:\/\/[^\s'"<>]+stream\.qqmusic\.qq\.com[^\s'"<>]*)/i);
    if (m) return m[1];
    return null;
  }
  /* 递归搜索 JSON 找音频 URL */
  var keys1 = ['url', 'music_url', 'play_url', 'audio', 'src', 'link', 'song_play_url', 'song_play_url_standard', 'song_play_url_hq', 'song_play_url_sq', 'song_play_url_pq', 'song_play_url_fq'];
  var keys2 = ['data', 'result', 'song', 'music', 'info'];
  function findUrl(obj, depth) {
    if (depth > 4 || !obj) return null;
    if (typeof obj === 'string') {
      if (obj.match(/^https?:\/\/[^\s'"<>]+\.(mp3|m4a|flac|ape|wav)/i)) return obj;
      if (obj.match(/^https?:\/\/[^\s'"<>]+stream\.qqmusic\.qq\.com/i)) return obj;
      return null;
    }
    if (Array.isArray(obj)) { for (var i = 0; i < obj.length; i++) { var u = findUrl(obj[i], depth+1); if (u) return u; } return null; }
    if (typeof obj === 'object') {
      for (var k = 0; k < keys1.length; k++) { if (obj[keys1[k]] != null) { var u = findUrl(obj[keys1[k]], depth+1); if (u) return u; } }
      for (var k = 0; k < keys2.length; k++) { if (obj[keys2[k]] != null) { var u = findUrl(obj[keys2[k]], depth+1); if (u) return u; } }
    }
    return null;
  }
  return findUrl(data, 0);
}

/* ---------------- HTTP 路由 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.lottie': 'application/octet-stream',
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  /* --- 自定义头像上传: who=me(用户)|by(好友), 页面Canvas裁剪256px JPEG dataUrl --- */
  if (p === '/avatar/set' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const who = b.who === 'by' ? 'by' : 'me';
      const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(b.dataUrl || ''));
      if (!m) return json(res, 400, { error: 'bad dataUrl' });
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length || buf.length > 4e5) return json(res, 400, { error: 'too large' });
      ['jpg', 'png', 'webp'].forEach(x => { try { fs.unlinkSync(path.join(__dirname, 'avatar_' + who + '.' + x)); } catch (e) {} });
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      fs.writeFileSync(path.join(__dirname, 'avatar_' + who + '.' + ext), buf);
      saveState();
      console.log('[LT] custom avatar saved:', who, ext, buf.length + 'B');
      return json(res, 200, { ok: true, url: '/avatar/' + who + '?t=' + Date.now() });
    } catch (e) { return json(res, 500, { error: String((e && e.message) || e) }); }
  }

  /* --- 头像存在性探测: 页面据此决定是否替换emoji(避免302兜底图误替换) --- */
  if (p === '/avatar/has') {
    const has = w => ['jpg', 'png', 'webp'].some(x => { try { return fs.existsSync(path.join(__dirname, 'avatar_' + w + '.' + x)); } catch (e) { return false; } });
    let operit = false;
    try {
      operit = fs.readdirSync('/data/user/0/com.ai.assistance.operit/files').some(n => /^user_avatar_.*\.(png|jpg|jpeg|webp)$/i.test(n));
    } catch (e) {}
    return json(res, 200, { me: has('me') || operit, by: has('by') });
  }

  /* --- 头像读取: /avatar/me 用户(自定义>Operit>兜底) | /avatar/by 好友(自定义>兜底) --- */
  if (p === '/avatar/me' || p === '/avatar/by') {
    const who = p === '/avatar/by' ? 'by' : 'me';
    let f = null;
    try {
      ['jpg', 'png', 'webp'].some(x => { const c = path.join(__dirname, 'avatar_' + who + '.' + x); if (fs.existsSync(c)) { f = c; return true; } return false; });
    } catch (e) {}
    if (!f && who === 'me') try {
      const dir = '/data/user/0/com.ai.assistance.operit/files';
      const cands = fs.readdirSync(dir).filter(n => /^user_avatar_.*\.(png|jpg|jpeg|webp)$/i.test(n));
      if (cands.length) { // 取最新的
        cands.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
        f = path.join(dir, cands[0]);
      }
    } catch (e) {}
    if (!f) { res.writeHead(302, { Location: '/vendor/disk.png' }); return res.end(); }
    try {
      const img = fs.readFileSync(f);
      res.writeHead(200, { 'Content-Type': /\.jpe?g$/i.test(f) ? 'image/jpeg' : (/\.webp$/i.test(f) ? 'image/webp' : 'image/png'), 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      return res.end(img);
    } catch (e) { res.writeHead(302, { Location: '/vendor/disk.png' }); return res.end(); }
  }

  /* --- P5: /avatar/netease — 代理网易云账号头像（CDN 直连可能被防盗链拦，走服务端转发更稳） --- */
  if (p === '/avatar/netease') {
    try {
      const qs = new URL(req.url, 'http://x').searchParams;
      const acct = (nativeDriver && nativeDriver.status) ? nativeDriver.status().account : null;
      let target = qs.get('u') || (acct && acct.avatarUrl) || '';
      if (!target) { res.writeHead(302, { Location: '/vendor/disk.png' }); return res.end(); }
      if (target.indexOf('//') === 0) target = 'https:' + target;
      target = target.replace(/^http:/, 'https:');
      const pr = https.get(target, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://music.163.com/' }, timeout: 10000 }, (pres) => {
        if (pres.statusCode >= 400) { res.writeHead(302, { Location: '/vendor/disk.png' }); pres.resume(); return res.end(); }
        res.writeHead(200, { 'Content-Type': pres.headers['content-type'] || 'image/jpeg', 'Cache-Control': 'no-cache' });
        pres.pipe(res);
      });
      pr.on('timeout', () => { try { pr.destroy(); } catch (e) {} try { res.writeHead(302, { Location: '/vendor/disk.png' }); res.end(); } catch (e) {} });
      pr.on('error', () => { try { res.writeHead(302, { Location: '/vendor/disk.png' }); res.end(); } catch (e) {} });
    } catch (e) { res.writeHead(302, { Location: '/vendor/disk.png' }); res.end(); }
    return;
  }

  /* --- SSE --- */
  if (p === '/events') {
    const cid = sseInit(res);
    res.write(`event: hello\ndata: ${JSON.stringify({ clientId: cid, you: state.members[cid] || null })}\n\n`);
    res.write(`event: sync\ndata: ${JSON.stringify(snapshot())}\n\n`);
    req.on('close', () => { clients.delete(cid); delete state.members[cid]; pushState(); });
    return;
  }

  /* --- 加入房间 --- */
  if (p === '/join' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.clientId && clients.has(b.clientId)) {
      state.members[b.clientId] = { name: b.name || 'Guest', role: b.role || 'guest', lastSeen: Date.now() };
      pushState();
      broadcast('chat_sys', { text: `${b.name} 加入了房间` });
    } else {
      // 幽灵成员（SSE未建立的调用方，如AI插件）
      const cid = b.clientId || ('g' + (++clientSeq));
      state.members[cid] = { name: b.name || 'Guest', role: b.role || 'ghost', lastSeen: Date.now() };
      pushState();
    }
    return json(res, 200, { ok: true });
  }

  /* --- 诊断日志接收 --- */
  if (p === '/debug' && req.method === 'POST') {
    try { const b = await readBody(req); console.log('[DEBUG]', JSON.stringify(b)); } catch (e) {}
    return json(res, 200, { ok: true });
  }

  /* --- P1: 接入模式切换 ---
   * GET  /mode → 查当前模式与驱动状态
   * POST /mode {mode:'local'|'duo'|'solo_ai'} → 切换 */
  if (p === '/mode' && req.method === 'GET') {
    return json(res, 200, { ok: true, mode: state.mode, playSync: state.playSync === true, roomWatch: Object.assign({}, roomWatch.status(), { lastErr: _roomWatchLastErr }), native: Object.assign({}, state.native, nativeDriver.status()) });
  }
  /* P9: 播放控制同步开关：GET 查询 / POST {enabled:true|false} 设置。
   *   false（默认）= 各端独立；true = 双向同步。聊天始终双向，不受此开关影响。 */
  if (p === '/play_sync' && (req.method === 'GET' || req.method === 'POST')) {
    if (req.method === 'POST') {
      const b = await readBody(req);
      state.playSync = !!(b && b.enabled);
      state.seq++;
      pushState('play_sync_change');
    }
    return json(res, 200, { ok: true, playSync: state.playSync === true });
  }
  if (p === '/mode' && req.method === 'POST') {
    const b = await readBody(req);
    const m = String((b && b.mode) || '');
    if (nativeDriver.MODES.indexOf(m) < 0) return json(res, 400, { error: 'bad mode', allowed: nativeDriver.MODES });
    try {
      const st = (m === 'local') ? nativeDriver.stop() : await nativeDriver.start(m);
      /* P2: 若缺 cookie 则模式不生效，回滚到 local 并返回 409 */
      if (st && st.ok === false) {
        state.native.lastError = st.lastError || 'cookie 未就绪';
        /* 切换失败：把驱动内部 mode 回滚到当前生效的 state.mode，避免状态错位 */
        if (nativeDriver.syncMode) nativeDriver.syncMode(state.mode);
        return json(res, 409, { ok: false, mode: state.mode, missing: st.missing || [], error: state.native.lastError, native: Object.assign({}, state.native, nativeDriver.status()) });
      }
      state.mode = m;
      state.native.enabled = !!st.enabled;
      state.native.connected = !!st.connected;
      state.native.lastError = st.lastError || null;
      state.native.lastSyncTs = st.lastSyncTs || 0;
      state.seq++;
      pushState('mode_change');
      /* P9: 模式切换成功后立即尝试启动房间读消息监听 */
      try { tryStartRoomWatch(); } catch (e) {}
      return json(res, 200, { ok: true, mode: state.mode, native: Object.assign({}, state.native, nativeDriver.status()) });
    } catch (e) {
      state.native.lastError = String((e && e.message) || e);
      return json(res, 500, { ok: false, error: state.native.lastError });
    }
  }

  /* ================= P2: 原生一起听 —— 身份（cookie）管理 =================
   *  POST /native/cookie/import {who:'ai'|'human', cookie:'...'}  → 落盘 0600
   *  GET  /native/cookie/status                                  → 脱敏回显
   *  POST /native/cookie/clear  {who?}                           → 清除（不传 who 清全部）
   */
  if (p === '/native/cookie/import' && req.method === 'POST') {
    const b = await readBody(req);
    const who = String((b && b.who) || '').trim();
    const cookie = String((b && b.cookie) || '');
    if (nativeDriver && nativeDriver.importCookie) {
      try {
        const r = nativeDriver.importCookie(who, cookie);
        pushState('cookie_import');
        return json(res, 200, { ok: true, who: who, status: r.status, all: nativeDriver.cookieStatus() });
      } catch (e) {
        return json(res, 400, { ok: false, error: String((e && e.message) || e) });
      }
    }
    return json(res, 500, { ok: false, error: 'driver 不可用' });
  }
  if (p === '/native/cookie/status' && req.method === 'GET') {
    return json(res, 200, { ok: true, status: nativeDriver.cookieStatus() });
  }
  if (p === '/native/cookie/clear' && req.method === 'POST') {
    const b = await readBody(req);
    const who = String((b && b.who) || '').trim();
    try {
      const r = nativeDriver.clearCookie(who || undefined);
      pushState('cookie_clear');
      return json(res, 200, { ok: true, cleared: who || 'all', result: r, all: nativeDriver.cookieStatus() });
    } catch (e) {
      return json(res, 400, { ok: false, error: String((e && e.message) || e) });
    }
  }

  /* ================= P2 扩展: 扫码登录获取 cookie =================
   *  POST /native/login/qr/create {who:'ai'|'human'} → 申请二维码
   *      返回 {unikey, qrUrl(二维码内容), url(手机可点开)}
   *  POST /native/login/qr/poll   {who}            → 轮询状态机
   *      801 等待扫码 / 802 已扫码待确认 / 803 成功(自动落盘 cookie) / 800 过期
   *  POST /native/login/qr/cancel {who?}           → 取消会话
   *  GET  /native/login/qr/status?who=ai           → 会话回显（无敏感信息）
   *  说明：803 时把网易下发的 cookie 经 identity.saveCookie 落盘 0600，
   *        明文不外泄，仅回脱敏状态。
   */
  if (p === '/native/login/qr/create' && req.method === 'POST') {
    const b = await readBody(req);
    const who = String((b && b.who) || 'ai').trim();
    try {
      const r = await qrlogin.begin(who);
      return json(res, 200, r);
    } catch (e) {
      return json(res, 502, { ok: false, error: String((e && e.message) || e) });
    }
  }
  if (p === '/native/login/qr/poll' && req.method === 'POST') {
    const b = await readBody(req);
    const who = String((b && b.who) || 'ai').trim();
    try {
      const r = await qrlogin.poll(who);
      if (r && r.saved) pushState('qr_login');
      return json(res, 200, r);
    } catch (e) {
      return json(res, 502, { ok: false, error: String((e && e.message) || e) });
    }
  }
  if (p === '/native/login/qr/cancel' && req.method === 'POST') {
    const b = await readBody(req);
    const who = String((b && b.who) || '').trim();
    return json(res, 200, qrlogin.cancel(who || undefined));
  }
  if (p === '/native/login/qr/status' && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const who = String(u.searchParams.get('who') || 'ai');
    return json(res, 200, { ok: true, session: qrlogin.sessionStatus(who) });
  }

  /* ================= P2 扩展: 短信验证码登录 =================
   *  POST /native/login/sms/send   {who,phone}            → 发送验证码（60s 冷却）
   *  POST /native/login/sms/verify {who,phone,captcha}    → 校验并登录（weapi 换 cookie，落盘 0600）
   *  GET  /native/login/sms/status?who=ai                 → 会话回显（脱敏手机号 + 冷却剩余）
   *  POST /native/login/sms/cancel {who?}                 → 取消会话
   *  说明：网易短信换 cookie 走 weapi 加密（/api/login/cellphone 已 401 ENC），
   *        成功后经 identity.saveCookie 落盘，明文不外泄。
   */
  if (p === '/native/login/sms/send' && req.method === 'POST') {
    const b = await readBody(req);
    const who = String((b && b.who) || 'ai').trim();
    const phone = String((b && b.phone) || '').trim();
    try {
      const r = await smslogin.send(who, phone);
      return json(res, r.ok ? 200 : 429, r);
    } catch (e) {
      return json(res, 400, { ok: false, error: String((e && e.message) || e) });
    }
  }
  if (p === '/native/login/sms/verify' && req.method === 'POST') {
    const b = await readBody(req);
    const who = String((b && b.who) || 'ai').trim();
    const phone = String((b && b.phone) || '').trim();
    const captcha = String((b && b.captcha) || '').trim();
    try {
      const r = await smslogin.verify(who, phone, captcha);
      if (r && r.saved) pushState('sms_login');
      return json(res, r.ok ? 200 : 400, r);
    } catch (e) {
      return json(res, 400, { ok: false, error: String((e && e.message) || e) });
    }
  }
  if (p === '/native/login/sms/cancel' && req.method === 'POST') {
    const b = await readBody(req);
    const who = String((b && b.who) || '').trim();
    return json(res, 200, smslogin.cancel(who || undefined));
  }
  if (p === '/native/login/sms/status' && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const who = String(u.searchParams.get('who') || 'ai');
    return json(res, 200, { ok: true, session: smslogin.sessionStatus(who) });
  }

  /* --- P6: 把真人编排进 AI 当前房间（duo 业务流一键同房）---
   * POST /native/join   （也允许 GET，便于浏览器/curl 直接验证）
   * 前置：需处于 duo 模式且 AI 已建房（connected=true）
   * 参数：{ autoAccept: true } → 服务端用 human cookie 代 accept（无人值守自检用）；
   *      默认 false → 只发邀请，把"接受"留给真人 APP 点卡（避免消费掉邀请卡导致"失效"）。
   * 返回：{ok, step, roomId, users, aiConnected, humanConnected, message}
   */
  if (p === '/native/join' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      if (!nativeDriver.bringHumanIn) return json(res, 500, { ok: false, step: 'unsupported', message: 'driver 未实现 bringHumanIn' });
      let body = {};
      if (req.method === 'POST') body = await readBody(req);
      const autoAccept = !!(body && body.autoAccept);
      const r = await nativeDriver.bringHumanIn({ autoAccept: autoAccept });
      console.log('[native] P6 join result:', JSON.stringify(r).slice(0, 300));
      pushState('native_join_result');
      return json(res, r && r.ok ? 200 : 409, r || { ok: false });
    } catch (e) {
      return json(res, 500, { ok: false, step: 'error', message: String((e && e.message) || e) });
    }
  }

  /* --- 同步控制（核心协议，参考 FLTPlayStatusSyncInfo）--- */
  if (p === '/control' && req.method === 'POST') {
    /* 支持 sendBeacon: body 可能为空, 参数从 query 读 */

    const b = await readBody(req); // {action, songId?, position?, by?, song?}

    /* --- P1: 接入模式分流 ---
     * local  → 走下方原有本地逻辑（一行不动）
     * duo / solo_ai → 交给原生驱动翻译成协议指令并回读
     * 失败/异常时回落到本地逻辑，保证不把页面搞挂。 */
    /* 纯本地语义动作（心跳校准/元数据/播放模式/自愈刷新/音量）：
     * 原生驱动不翻译这些，必须始终走本地分支，
     * 否则 solo_ai / duo 模式下会被 native default 静默吞掉（心跳被丢 → 进度不校准）。 */
    const LOCAL_ONLY_ACTIONS = ['heartbeat', 'setmeta', 'setmode', 'refreshurl'];
    /* P8 双写动作：既要转发原生（让同房好友同步），又必须本地同步落地。
     * next/prev：本地 switch 有完整切歌实现，但 solo_ai 单人房没有远端 playCommand
     * 回灌（NEXT/PREV 指令不带 songId，_pullRemote 命中 `if(!cmd)return null` 直接返回），
     * 若只转发不落地，本地 state.song 永不推进 → 切歌彻底失效。故转发后继续走本地逻辑。 */
    const DUAL_WRITE_ACTIONS = ['next', 'prev'];
    /* P9f: 播放动作的转发策略 —— 双向语义隔离（修正 P9e 的一刀切）
     *   - **AI 发起的动作（by==='ai'）下发房间** → 在 APP 里说「换首歌」、
     *     在插件聊天框说「换首歌」，AI 都能真的操控网易云 APP 切歌/换歌。
     *   - 手动操作（插件 UI 点击，by='用户'）不下发 → 插件归插件，不动 APP。
     *   - 下行（APP 手动 → 插件）由 applyNativeRemote / Playlist 的 playSync
     *     守卫挡住 → APP 归 APP，不动插件。
     *   - 聊天/心跳/本地语义动作不受影响。 */
    const PLAY_ACTIONS = ['play', 'pause', 'toggle', 'next', 'prev', 'seek', 'load'];
    const _act = b && b.action;
    const _byAi = String((b && b.by) || '') === 'ai';
    const _playGated = !_byAi && (state.playSync !== true) && PLAY_ACTIONS.indexOf(_act) >= 0;
    if (state.mode && state.mode !== 'local' && !_playGated && LOCAL_ONLY_ACTIONS.indexOf(_act) < 0) {
      try {
        const r = await nativeDriver.handleControl(b);
        /* 纯原生动作：原生驱动负责翻译+下发，转发即完成，直接返回 */
        if (DUAL_WRITE_ACTIONS.indexOf(b && b.action) < 0) {
          return json(res, 200, r);
        }
        /* 双写动作：转发结果不阻塞，继续走下方本地逻辑让 state 立即生效（原生转发失败也不影响本机切歌） */
        state.native.lastForward = r;
      } catch (e) {
        state.native.lastError = String((e && e.message) || e);
        console.log('[LT] native control error, fallback to local:', state.native.lastError);
        /* 继续走下面本地逻辑兜底 */
      }
    }

    state.seq++;
    switch (b.action) {
      case 'play':
        state.playing = true;
        if (typeof b.position === 'number') state.positionMs = b.position;
        state.anchorTs = Date.now();
        state._listenAnchor = Date.now();  /* 开始计时 */
        break;
      case 'pause':
        flushListenSeconds();  /* 固化听歌时长 */
        state.positionMs = currentPos(); // 先固化进度
        state.playing = false;
        break;
      case 'seek': {
        /* 双字段兼容: 页面发 position，部分客户端发 positionMs */
        const rawP = (b.position !== undefined && b.position !== null) ? b.position : b.positionMs;
        const np = Number(rawP);
        state.positionMs = Math.max(0, isFinite(np) ? Math.round(np) : 0); // NaN防护: 无效值归0而非破坏锚点
        state.anchorTs = Date.now();
        break;
      }
      case 'load':
        if (b.song) {
          flushListenSeconds();  /* 切歌前固化听歌时长 */
          const changed = !state.song || state.song.id !== b.song.id;
          if (changed && state.song) pushHistory(state.song);
          /* 持久化: 同一首歌重载时保留上次进度(暂停/退出后恢复) */
          state.song = b.song;
          touchPlaylist(b.song);
          state.playing = b.autoplay !== false;
          state.positionMs = (!changed && typeof b.position !== 'number')
            ? state.positionMs  // 同歌重载: 保留服务端已有进度
            : (typeof b.position === 'number' ? b.position : 0);
          if (state.playing) { state.anchorTs = Date.now(); state._listenAnchor = Date.now(); }
          /* QQ 音乐: URL 为空时服务端自动解析, 避免前端两步串行 */
          if (String(state.song.id).startsWith('qq_') && !state.song.url) {
            var loadMid = String(state.song.id).slice(3);
            qqResolveUrl(loadMid, '128k').then(function(qurl) {
              if (qurl && state.song && String(state.song.id) === b.song.id) {
                state.song.url = qurl;
                broadcast('sync', snapshot());
              }
            });
          }
          if (changed) { broadcast('song_change', { song: b.song, playing: state.playing, positionMs: state.positionMs }); trackSongRepeat(b.song); }
          // 封面自动补抓：任何来源点歌，pic为空就用song/detail兜底
          if ((!state.song.pic || state.song.pic === '') && state.song.id) {
            const sid = String(state.song.id);
            fetch(NETEASE_API + '/song/detail?ids=' + sid).then(r => r.json()).then(d => {
              const al = d && d.songs && d.songs[0] && d.songs[0].al;
              const pic = al && al.picUrl;
              if (pic && state.song && String(state.song.id) === sid && state.song.pic !== pic) {
                state.song.pic = pic;
                console.log('[LT] cover fetched for', sid);
                broadcast('sync', snapshot());
              }
            }).catch(() => {});
          }
        }
        break;
      case 'next':
      case 'prev': {
        /* 官方「当前播放」模型: 列表固定不消耗, next/prev 在列表内环形移动 */
        const pl = state.playlist;
        const curIdx = state.song ? pl.findIndex((g) => String(g.id) === String(state.song.id)) : -1;
        let target = null;
        const pickHist = (fromEnd) => { // 从历史里挑一首非当前曲
          if (fromEnd) { for (let i = state.history.length - 1; i >= 0; i--) { if (!state.song || String(state.history[i].id) !== String(state.song.id)) return state.history[i]; } }
          else { for (let i = 0; i < state.history.length; i++) { if (!state.song || String(state.history[i].id) !== String(state.song.id)) return state.history[i]; } }
          return null;
        };
        if (b.action === 'prev') {
          if (curIdx > 0) target = pl[curIdx - 1]; // 列表内前移
          else if (curIdx === 0) target = pl[pl.length - 1]; // 到头绕回末尾(循环)
          else if (pl.length) target = pl[pl.length - 1]; // 当前不在列表: 取末尾
          if (!target) target = pickHist(true); // 列表没得退: 历史兜底
          if (!target && state.song) target = { ...state.song }; // 彻底没得退: 重播当前
        } else {
          if (state.playMode === 'one' && b.auto && state.song) {
            target = { ...state.song }; // 单曲循环: 自然播完同曲重播
          } else if (state.playMode === 'random' && pl.length) {
            /* 随机模式: 从「当前播放」列表随机挑一首非当前曲 */
            const cand = pl.filter((g) => !state.song || String(g.id) !== String(state.song.id));
            target = cand.length ? cand[Math.floor(Math.random() * cand.length)] : { ...pl[0] };
          } else if (curIdx >= 0 && pl.length > 1) {
            let ni = curIdx + 1; if (ni >= pl.length) ni = 0; // 列表内后移(循环)
            target = pl[ni];
          } else if (curIdx >= 0 && pl.length === 1) {
            target = { ...pl[0] }; // 只有一首: 循环重播
          } else if (pl.length) {
            target = state.playMode === 'random' ? pl[Math.floor(Math.random() * pl.length)] : pl[0];
          } else if (state.playMode === 'random') {
            const cand = state.history.filter((x) => !state.song || String(x.id) !== String(state.song.id));
            target = cand.length ? cand[Math.floor(Math.random() * cand.length)] : null;
          } else {
            target = pickHist(false) || pickHist(true); // 自然播完取最旧, 手动取最近
          }
          if (!target && state.song) target = { ...state.song }; // 循环兜底: 重播当前
        }
        if (!target) return json(res, 400, { error: '没有可切换的歌曲' });
        // 解析音源URL可能过期，重新拿
        try {
          if (String(target.id).startsWith('qq_')) {
            /* QQ 音乐: 走 QQ 解析链刷新 URL */
            var qqMid = String(target.id).slice(3);
            var qqUrl = await qqResolveUrl(qqMid, '128k');
            if (qqUrl) { target.url = qqUrl; }
          } else {
            /* 网易云: 走网易云 API 刷新 URL */
            const ur = await fetchUpstreamJson('/song/url/v1?id=' + target.id + '&level=exhigh');
            const d0 = (ur && ur.data && ur.data[0]) || {};
            if (d0.url) { target.url = d0.url; target.duration = d0.time || target.duration; }
          }
        } catch (e) {}
        if (state.song) pushHistory(state.song);
        state.song = target;
        touchPlaylist(target); // 切到的歌也进「当前播放」列表
        state.playing = true;
        state.positionMs = 0;
        state.anchorTs = Date.now();
        state._listenAnchor = Date.now();  /* 开始计时 */
        broadcast('song_change', { song: target, dir: b.action, playing: state.playing, positionMs: 0 }); trackSongRepeat(target);
        break;
      }
      case 'refreshurl': { // 页面播放出错时的自愈通道
        refreshCurrentUrl();
        break;
      }
      case 'toggle': {
        if (!state.song) return json(res, 400, { error: '房间里还没有歌' });
        if (state.playing) { flushListenSeconds(); state.positionMs = currentPos(); state.playing = false; }
        else {
          flushListenSeconds(); state.anchorTs = Date.now(); state.playing = true;
          state._listenAnchor = Date.now();  /* 开始计时 */
          /* QQ 音乐: 先同步刷新 URL 再返回, 避免旧 vkey 播放失败 */
          if (String(state.song.id).startsWith('qq_')) {
            var qqMid = String(state.song.id).slice(3);
            var qqNewUrl = await qqResolveUrl(qqMid, '128k');
            if (qqNewUrl) state.song.url = qqNewUrl;
          } else {
            refreshCurrentUrl(); // 网易云: 异步刷新即可
          }
        }
        break;
      }
      case 'setmode': {
        const m = String(b.mode || '');
        if (['order', 'one', 'random'].indexOf(m) < 0) return json(res, 400, { error: 'bad mode' });
        state.playMode = m;
        broadcast('playmode', { mode: m });
        break;
      }
      case 'heartbeat': {
        // 心跳校准：带上客户端实际播放位置
        if (typeof b.position === 'number' && state.playing) {
          state.positionMs = b.position;
          state.anchorTs = Date.now();
        }
        return json(res, 200, snapshot());
      }
      case 'setmeta': {
        /* 展示元数据自定义: distanceKm字符串 / listenSeconds数字(用户手动校准听歌时长) */
        if (b.meta && typeof b.meta === 'object') {
          if (typeof b.meta.distanceKm === 'string' && b.meta.distanceKm.trim()) state.meta.distanceKm = b.meta.distanceKm.trim().slice(0, 12);
          if (typeof b.meta.listenSeconds === 'number' && isFinite(b.meta.listenSeconds)) {
            state.meta.listenSeconds = Math.max(0, Math.round(b.meta.listenSeconds));
            /* 用户手动校准后重置锚点, 从新基准继续自动累计 */
            if (state.playing) state._listenAnchor = Date.now();
          }
        }
        break;
      }
      default:
        return json(res, 400, { error: 'unknown action' });
    }
    state.updatedBy = b.by || 'unknown';
    state.updatedAt = Date.now();
    pushState();
    return json(res, 200, snapshot());
  }

  /* --- 歌单 --- */
  if (p === '/playlist/add' && req.method === 'POST') {
    const b = await readBody(req);
    const dedup = (arr) => (arr || []).filter((g) => g && g.id != null && !state.playlist.some((x) => String(x.id) === String(g.id)) && String(g.id) !== String((state.song || {}).id));
    if (Array.isArray(b.songs)) state.playlist.push(...dedup(b.songs).map((g) => Object.assign({ played: false }, g)));
    else if (b.song) { const ok = dedup([b.song]); if (ok.length) state.playlist.push(Object.assign({ played: false }, b.song)); }
    else return json(res, 400, { error: 'no song' });
    state.seq++;
    pushState();
    return json(res, 200, { ok: true, playlist: state.playlist });
  }
  if (p === '/playlist/clear' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    if (b && typeof b.index === 'number' && b.index >= 0 && b.index < state.playlist.length) state.playlist.splice(b.index, 1);
    else state.playlist = [];
    state.seq++;
    pushState();
    return json(res, 200, { ok: true });
  }
  /* 整单替换: 直接清空队列+灌入+播放(工具直接点播用) */
  if (p === '/playlist/replace' && req.method === 'POST') {
    const b = await readBody(req);
    if (!Array.isArray(b.songs) || !b.songs.length) return json(res, 400, { error: 'no songs' });
    var card = buildPendingPlaylist(b.name || '歌单', b.songs);
    if (!card) return json(res, 400, { error: 'no valid songs' });
    var rr = await applyPlaylistReplace(b.by || 'ai');
    return json(res, 200, { ok: !!rr, count: rr ? rr.count : 0, playing: rr ? rr.first.name : null });
  }
  /* 发起歌单推荐: 暂存 + 广播确认卡片 */
  if (p === '/playlist/propose' && req.method === 'POST') {
    const b = await readBody(req);
    if (!Array.isArray(b.songs) || !b.songs.length) return json(res, 400, { error: 'no songs' });
    var card2 = buildPendingPlaylist(b.name, b.songs);
    if (!card2) return json(res, 400, { error: 'no valid songs' });
    card2.st = 'pending';
    var text2 = b.text || ('我给你挑了一张歌单《' + card2.name + '》，共 ' + card2.count + ' 首，点下面的按钮就整单替换播放列表一起听~ 🎧');
    var msg = addChat('ai', '好友', text2);
    msg.popEmoji = '🎧';
    msg.playlistCard = card2;
    broadcast('chat', msg);
    forwardChatToRoom('ai', text2);
    return json(res, 200, { ok: true, count: card2.count, msgId: msg.id, playlist: card2.name });
  }
  /* 用户确认: 执行整单替换 */
  if (p === '/playlist/confirm' && req.method === 'POST') {
    var r2 = await applyPlaylistReplace('host');
    if (!r2) return json(res, 400, { error: '没有待确认的歌单' });
    broadcast('chat', { type: 'playlist_confirmed', name: r2.first ? r2.first.name : '' });
    return json(res, 200, { ok: true, count: r2.count, playing: r2.first.name, playlist: state.playlist });
  }
  /* 用户取消 */
  if (p === '/playlist/reject' && req.method === 'POST') {
    state.pendingPlaylist = null;
    return json(res, 200, { ok: true });
  }
  /* --- 红心歌单 --- */
  if (p === '/favorite/toggle' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b || !b.song || !b.song.id) return json(res, 400, { error: 'no song' });
    const idx = state.favorites.findIndex((g) => String(g.id) === String(b.song.id));
    let added = false;
    if (idx >= 0) { state.favorites.splice(idx, 1); }
    else { state.favorites.push(Object.assign({}, b.song)); added = true; }
    state.seq++;
    state.favoritesSeq++;
    pushState();
    return json(res, 200, { ok: true, added, favorites: state.favorites });
  }
  if (p === '/favorite/clear' && req.method === 'POST') {
    state.favorites = [];
    state.seq++;
    state.favoritesSeq++;
    pushState();
    return json(res, 200, { ok: true });
  }

  /* --- 聊天 --- */
  if (p === '/chat' && req.method === 'POST') {
    const b = await readBody(req); // {from:'host'|'ai'|..., name, text, popEmoji}
    const msg = addChat(b.from, b.name, b.text);
    if (b.popEmoji) msg.popEmoji = String(b.popEmoji).slice(0, 8);
    broadcast('chat', msg);
    /* P8: 转发到网易云房间（真人用 human 身份、AI 用 ai 身份） */
    forwardChatToRoom(b.from, b.text);
    return json(res, 200, { ok: true, msg });
  }
  if (p === '/chat/clear' && req.method === 'POST') {
    chatLog.length = 0;
    try { fs.unlinkSync(CHAT_LOG_PATH); } catch(e) {}
    broadcast('chat', { type: 'cleared' });
    return json(res, 200, { ok: true });
  }
  if (p === '/chat/history') {
    return json(res, 200, { msgs: chatLog.slice(-100) });
  }
  /* --- AI 模型配置 --- */
  if (p === '/ai/config' && req.method === 'GET') {
    return json(res, 200, { endpoint: aiConfig.endpoint, model: aiConfig.model, systemPrompt: aiConfig.systemPrompt, hasKey: !!aiConfig.apiKey, neteaseApi: NETEASE_API, soundSource: (aiConfig.soundSource||'netease'), qqSearchApi: QQ_SEARCH_API, qqResolveApis: QQ_RESOLVE_APIS, customSources: customSources.map(function (s) { return { id: s.id, name: s.name, enabled: s.enabled !== false }; }) });
  }
  if (p === '/ai/config' && req.method === 'POST') {
    const b = await readBody(req);
    if (typeof b.endpoint === 'string') aiConfig.endpoint = b.endpoint;
    if (typeof b.apiKey === 'string') aiConfig.apiKey = b.apiKey;
    if (typeof b.model === 'string') aiConfig.model = b.model;
    if (typeof b.systemPrompt === 'string') aiConfig.systemPrompt = b.systemPrompt;
    if (typeof b.neteaseApi === 'string') { aiConfig.neteaseApi = b.neteaseApi.trim(); NETEASE_API = aiConfig.neteaseApi || DEFAULT_NETEASE_API; }
    if (typeof b.soundSource === 'string') aiConfig.soundSource = b.soundSource;
    if (typeof b.qqSearchApi === 'string') { aiConfig.qqSearchApi = b.qqSearchApi.trim(); QQ_SEARCH_API = aiConfig.qqSearchApi || DEFAULT_QQ_SEARCH_API; }
    if (Array.isArray(b.qqResolveApis)) { var _ra = b.qqResolveApis.map(normalizeResolveItem).filter(Boolean); aiConfig.qqResolveApis = _ra; QQ_RESOLVE_APIS = _ra.length ? _ra.slice() : DEFAULT_QQ_RESOLVE_APIS.slice(); }
    aiConfig._userCustomized = true;  /* 用户手动修改后标记, 下次启动不再被 Operit 覆盖 */
    saveAiConfig();
    return json(res, 200, { ok: true, endpoint: aiConfig.endpoint, model: aiConfig.model, hasKey: !!aiConfig.apiKey, neteaseApi: NETEASE_API, soundSource: (aiConfig.soundSource||'netease'), qqSearchApi: QQ_SEARCH_API, qqResolveApis: QQ_RESOLVE_APIS });
  }
  /* --- 重新加载 Operit 角色卡 --- */
  if (p === '/operit/refresh' && req.method === 'POST') {
    operitConfig = loadOperitConfig();
    if (operitConfig.systemPrompt) aiConfig.systemPrompt = operitConfig.systemPrompt;
    if (operitConfig.endpoint) aiConfig.endpoint = operitConfig.endpoint;
    if (operitConfig.apiKey) aiConfig.apiKey = operitConfig.apiKey;
    if (operitConfig.model) aiConfig.model = operitConfig.model;
    aiConfig._userCustomized = false;  /* 用户主动重载 Operit 配置, 清除自定义标记 */
    saveAiConfig();
    return json(res, 200, { ok: true, model: aiConfig.model, hasKey: !!aiConfig.apiKey, hasPrompt: !!aiConfig.systemPrompt });
  }
  /* --- AI 聊天 --- */
  if (p === '/ai/chat' && req.method === 'POST') {
    const b = await readBody(req);
    /* P9g: 消息来源 —— fromRoom=true 表示来自网易云 APP 房间。
     * 在 APP 里让 AI 换歌 → 只换 APP，插件本地不动（remoteOnly）。
     * 在插件聊天框说 → 换插件（同时也推 APP，符合「插件里说就切插件」）。 */
    const _fromRoom = !!b.fromRoom;
    const _opts = { remoteOnly: _fromRoom };
    if (!aiConfig.endpoint || !aiConfig.apiKey || !aiConfig.model) return json(res, 200, { ok: false, error: '请先配置模型' });
    const recent = chatLog.slice(-10).filter(m => m.text).map(m => ({
      role: m.from === 'me' || m.from === 'host' ? 'user' : 'assistant',
      content: m.text,
    }));
    // 构造带歌曲上下文的 system prompt
    let sysPrompt = aiConfig.systemPrompt;
    const song = state.song;
    const pos = Math.round(currentPos() / 1000);
    if (song && song.name) {
      sysPrompt += '\n\n【当前正在听】' + song.name + (song.artist ? ' - ' + song.artist : '');
      if (song.album) sysPrompt += '（专辑: ' + song.album + '）';
      sysPrompt += '，播放进度 ' + Math.floor(pos/60) + ':' + String(pos%60).padStart(2,'0');
    }
    // 异步拉取歌词，注入当前播放位置附近的片段
    let lyricSnippet = '';
    if (song && song.id) {
      try {
        const lr = await fetchUpstreamJson('/lyric?id=' + song.id);
        const lrc = lr && lr.lrc && lr.lrc.lyric;
        if (lrc) {
          // 解析LRC时间轴
          const lines = [];
          lrc.split('\n').forEach(function(line) {
            const m = line.match(/\[(\d+):(\d+)\.(\d+)\](.*)/);
            if (m) lines.push({ t: parseInt(m[1]) * 60 + parseInt(m[2]), text: m[4].trim() });
          });
          // 找当前进度附近±5行的歌词
          const nearby = [];
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].t >= pos - 15 && lines[i].t <= pos + 15) nearby.push(lines[i].text);
          }
          if (nearby.length) lyricSnippet = nearby.join(' / ');
          else if (lines.length) {
            // 兜底: 取前5行
            lyricSnippet = lines.slice(0, 5).map(function(l) { return l.text }).join(' / ');
          }
        }
      } catch (e) {}
    }
    if (lyricSnippet) sysPrompt += '\n【当前歌词片段】' + lyricSnippet;
    /* 播放列表上下文 */
    if (state.playlist && state.playlist.length) {
      sysPrompt += '\n【当前播放列表】' + state.playlist.slice(0, 10).map(function(s) { return (s.name||'') + '-' + (s.artist||''); }).join('、');
    }
    /* AI智能点歌指令 */
    sysPrompt += '\n\n【特殊指令】如果你想在回复中点歌或推荐歌曲，请在回复末尾单独一行加上标记：\n'
      + '- 点歌(自动播放): [PLAY:搜索关键词]\n'
      + '- 推荐(不自动播放，显示为可点击卡片): [RECOMMEND:搜索关键词]\n'
      + '- 推荐整张歌单(用户点确认后整单替换播放列表): [PLAYLIST:歌单ID或关键词]\n'
      + '示例: "好呀，给你放一首~ [PLAY:周杰伦 晴天]"\n'
      + '示例: "推荐几首适合写作业的~ [RECOMMEND:轻音乐 纯音乐 学习]"\n'
      + '示例: "给你挑了张歌单，确认就整单换上~ [PLAYLIST:华语 经典]"\n'
      + '可以同时推荐多首，每行一个标记。其余部分正常聊天即可。如果没有点歌需求就别加标记。\n'
      + '【换歌偏好】当用户说「换一首」「来点别的」「随便放」这类没指定歌名时，'
      + '请尽量换**不同歌手/不同风格**的歌，避免总是推那几首；已经推荐过的就别再推。'
      + '\n【重要·格式约束】你是在播放器聊天框里说话，**只能输出纯文本**。'
      + '禁止输出任何工具调用/函数调用/XML 标签（如 <function_calls>、<invoke>、<parameter>、antml: 等），'
      + '也不要输出 ``` 代码块。想切歌/暂停/播放请直接用 [PLAY:关键词] 标记，或直接说「下一首」即可，'
      + '系统会自动执行，无需你调用工具。';
    const messages = [{ role: 'system', content: sysPrompt }].concat(recent);
    messages.push({ role: 'user', content: String(b.text || '').slice(0, 500) });
    callLLM(messages, (err, reply) => {
      if (err) { return json(res, 200, { ok: false, error: err }); }
      var raw = String(reply).slice(0, 800);
      /* ⓪ 确定性本地控制指令（暂停/继续/上一首/下一首）：直接落地，
       *    不依赖模型是否输出工具块（实测「暂停一下」模型只口头答应不落地）。
       *    ⚠️ 仅当模型未给出 [PLAY:] 点歌标记时才兜底，避免与「换一首」的推荐点歌冲突。 */
      try {
        if (!/\[PLAY:[^\]]+\]/.test(raw)) {
          var _lc = detectLocalCommand(b.text);
          /* P9g: 来自 APP 房间时只操控 APP（remoteOnly），插件本地不动 */
          if (_lc === 'next') {
            if (_fromRoom) {
              try { aiPlayRandomFresh({ remoteOnly: true }); } catch (e) {}
            } else {
              selfControl({ action: 'next', by: 'ai' });
              try { aiPlayRandomFresh(); } catch (e) {}
            }
          } else if (_lc) {
            if (!_fromRoom) selfControl({ action: _lc, by: 'ai' });
          } else if (/换首|换一?首|切歌|来点?新|换个|换一?个歌|下首|随便放|放点|来一首/.test(String(b.text || ''))) {
            /* 自然语言换歌意图但模型没给标记 → 兜底挑新鲜的（APP 来源只换 APP） */
            try { aiPlayRandomFresh(_opts); } catch (e) {}
          }
        }
      } catch (e) {}
      /* ① 工具调用 XML → 落地为本地动作（修复「换一首」气泡空白） */
      try { extractToolIntents(raw).forEach(function (it) { applyToolIntent(it, _opts); }); } catch (e) {}
      /* ② 从展示文本中剥离工具 XML，避免气泡空白 */
      raw = stripToolXml(raw);
      if (!raw) raw = '（已执行操作）';
      /* 解析 [PLAY:xxx] 和 [RECOMMEND:xxx] 标记 */
      var playMarks = [], recMarks = [], plMarks = [];
      var markRe = /\[(PLAY|RECOMMEND|PLAYLIST):([^\]]+)\]/g;
      var match, cleanText = raw;
      while ((match = markRe.exec(raw)) !== null) {
        var action = match[1], keyword = match[2].trim();
        cleanText = cleanText.replace(match[0], '');
        if (action === 'PLAY') playMarks.push(keyword);
        else if (action === 'RECOMMEND') recMarks.push(keyword);
        else plMarks.push(keyword);
      }
      cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();
      /* 执行点歌(自动播放) */
      playMarks.forEach(function(kw, i) {
        setTimeout(function() {
          aiSearchAndPlay(kw, true, _opts);
        }, i * 2000);
      });
      /* 处理推荐歌曲 + 整单推荐 - 异步搜索后附到消息 */
      var recResults = [];
      var playlistCard = null;
      var pendingRecs = recMarks.length + plMarks.length;
      function finishMsg() {
        var finalText = cleanText;
        var msg = addChat('ai', '好友', finalText.slice(0, 500));
        msg.popEmoji = playlistCard ? '🎧' : '💖';
        if (recResults.length) msg.recommend = recResults;
        if (playlistCard) { playlistCard.st = 'pending'; msg.playlistCard = playlistCard; }
        broadcast('chat', msg);
        forwardChatToRoom('ai', finalText);
        return json(res, 200, { ok: true, reply: finalText, recommend: recResults, playlist: playlistCard ? playlistCard.name : null });
      }
      if (!pendingRecs) {
        var msg2 = addChat('ai', '好友', cleanText.slice(0, 500));
        msg2.popEmoji = '💖';
        broadcast('chat', msg2);
        forwardChatToRoom('ai', cleanText);
        return json(res, 200, { ok: true, reply: cleanText });
      }
      recMarks.forEach(function(kw) {
        aiSearchSongs(kw, 3).then(function(songs) {
          if (songs && songs.length) {
            songs.forEach(function(s) { recResults.push({ id: String(s.id), name: s.name, artist: ((s.artists||[]).map(function(a){return a.name}).join('/'))||s.artist||'', pic: (s.album&&s.album.picUrl)||'' }); });
          }
          pendingRecs--;
          if (pendingRecs <= 0) finishMsg();
        }).catch(function() { pendingRecs--; if (pendingRecs <= 0) finishMsg(); });
      });
      plMarks.forEach(function(kw) {
        resolvePlaylistByKeyword(kw).then(function(pl) {
          if (pl && pl.songs && pl.songs.length) {
            var card = buildPendingPlaylist(pl.name, pl.songs);
            if (_fromRoom) {
              /* P9g: APP 来源直接换 APP 歌单，插件不动（也不弹插件确认卡） */
              playlistCard = null;
              try { applyPlaylistReplace('ai', { remoteOnly: true }); } catch (e) {}
            } else if (card) playlistCard = card;
          }
          pendingRecs--;
          if (pendingRecs <= 0) finishMsg();
        }).catch(function() { pendingRecs--; if (pendingRecs <= 0) finishMsg(); });
      });
    });
    return;
  }

  /* --- P9f: 从候选里挑一首"新鲜"的歌：优先没播过、不在播放列表、没在本轮推荐过的。
   *  解决「AI 切来切去总是那几首」——之前 limit=1 永远取搜索结果第一首。 */
  function pickFreshSong(list) {
    if (!list || !list.length) return null;
    var recent = {};
    (state.history || []).slice(-15).forEach(function (s) { if (s && s.id) recent[String(s.id)] = 1; });
    if (state.song && state.song.id) recent[String(state.song.id)] = 1;
    var inPl = {};
    (state.playlist || []).forEach(function (s) { if (s && s.id) inPl[String(s.id)] = 1; });
    if (state._recentAiSongs) state._recentAiSongs.forEach(function (id) { recent[String(id)] = 1; });
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var sid = String(s.id);
      if (!recent[sid] && !inPl[sid]) return s;   // 最理想：全新
    }
    for (var j = 0; j < list.length; j++) {          // 退一步：不在最近播放即可（哪怕在列表里）
      var s2 = list[j], sid2 = String(s2.id);
      if (!recent[sid2]) return s2;
    }
    return list[0];
  }
  /* --- P9f: 自动挑一首"新鲜的"歌并播放（用于「换一首」但 AI 没给 [PLAY:] 标记时的兜底）。
   *  多源候选：个性化新歌 → 关键词池搜索；配合 pickFreshSong 避开最近播放。 */
  async function aiPlayRandomFresh(opts) {
    var pool = ['华语流行', '欧美流行', '轻音乐', '民谣', '粤语经典', '爵士', '电子', '古风', 'R&B', '摇滚'];
    var candidates = [];
    try {
      var nr = await fetchUpstreamJson('/personalized/newsong?limit=30');
      var arr = (nr && (nr.result || nr.data)) || [];
      arr.forEach(function (it) { var s = it && (it.song || it); if (s && s.id) candidates.push(s); });
    } catch (e) {}
    if (candidates.length < 4) {
      var kw = pool[Math.floor(Math.random() * pool.length)];
      try {
        var sr = await fetchUpstreamJson('/search?keywords=' + encodeURIComponent(kw) + '&limit=12');
        ((sr && sr.result && sr.result.songs) || []).forEach(function (s) { if (s && s.id) candidates.push(s); });
      } catch (e) {}
    }
    if (!candidates.length) return null;
    var sg = pickFreshSong(candidates);
    if (!sg) return null;
    var ar = ((sg.artists || sg.ar || []).map(function (a) { return a.name; }).join('/')) || sg.artist || '';
    var kw2 = (sg.name || '') + (ar ? ' ' + ar.split('/')[0] : '');
    return await aiSearchAndPlay(kw2, true, opts);
  }
  /* --- AI 智能点歌: 搜索并自动播放 ---
   * P9g: opts.remoteOnly=true → **只操控网易云 APP，不改插件本地**。
   *      用于「在 APP 里让 AI 换歌」——只换 APP 的歌，插件保持原样。 */
  async function aiSearchAndPlay(keyword, autoplay, opts) {
    try {
      var _remoteOnly = !!(opts && opts.remoteOnly);
      var r = await fetchUpstreamJson('/search?keywords=' + encodeURIComponent(keyword) + '&limit=8');
      var list = (r && r.result && r.result.songs) || [];
      if (!list.length) return null;
      var sg = pickFreshSong(list);
      /* 记录本轮 AI 点过的歌，短期内不重复推同一首 */
      if (!state._recentAiSongs) state._recentAiSongs = [];
      state._recentAiSongs.push(String(sg.id));
      if (state._recentAiSongs.length > 20) state._recentAiSongs.shift();
      var ur = await fetchUpstreamJson('/song/url/v1?id=' + sg.id + '&level=exhigh');
      var d = (ur && ur.data && ur.data[0]) || {};
      if (!d.url) { ur = await fetchUpstreamJson('/song/url/v1?id=' + sg.id + '&level=standard'); d = (ur&&ur.data&&ur.data[0])||{}; }
      if (!d.url) return null;
      var ar = ((sg.artists||[]).map(function(a){return a.name}).join('/'))||sg.artist||'';
      var pic = (sg.album && sg.album.picUrl) || '';
      if (!pic) {
        try { var dd = await fetchUpstreamJson('/song/detail?ids=' + sg.id); var al = (dd&&dd.songs&&dd.songs[0]&&dd.songs[0].al)||{}; pic = al.picUrl||''; } catch(e){}
      }
      var song = { id: String(sg.id), name: sg.name||'未知', artist: ar, pic: pic, url: d.url, duration: d.time||sg.duration||0 };
      if (_remoteOnly) {
        /* P9g: 只推 APP，插件本地一字不改（这就是「在 APP 让 AI 换歌不同步到插件」） */
        pushSongToRoom(song.id, { playing: autoplay !== false, name: song.name, artist: song.artist });
        console.log('[AI] remoteOnly play → APP only:', song.name);
        return song;
      }
      /* 注入到 state 并广播 */
      if (state.song) pushHistory(state.song);
      state.song = song;
      touchPlaylist(song);
      state.playing = autoplay !== false;
      state.positionMs = 0;
      state.anchorTs = Date.now();
      state.seq++;
      pushState();
      broadcast('song_change', { song: song, playing: state.playing, positionMs: 0 }); trackSongRepeat(song);
      /* P9b: AI 点歌同步到网易云 APP（房间加歌 + 下发播放指令） */
      pushSongToRoom(song.id, { playing: state.playing });
      return song;
    } catch (e) { console.log('[AI] play error:', e.message); return null; }
  }

  /* --- AI 推荐歌曲: 只搜索不播放 --- */
  async function aiSearchSongs(keyword, limit) {
    try {
      var r = await fetchUpstreamJson('/search?keywords=' + encodeURIComponent(keyword) + '&limit=' + (limit||3));
      return (r && r.result && r.result.songs) || [];
    } catch (e) { return []; }
  }

  /* --- 歌单: 拉取全部曲目 --- */
  function normTrack(t) {
    var artist = '';
    if (Array.isArray(t.ar)) artist = t.ar.map(function(a){return a.name}).join('/');
    else if (Array.isArray(t.artists)) artist = t.artists.map(function(a){return a.name}).join('/');
    else if (t.artist) artist = t.artist;
    var pic = (t.al && t.al.picUrl) || (t.album && t.album.picUrl) || '';
    return { id: String(t.id), name: t.name || '', artist: artist, pic: pic };
  }
  async function fetchPlaylistSongsById(plid) {
    var info = await fetchUpstreamJson('/playlist/detail?id=' + encodeURIComponent(plid));
    var pl = (info && info.playlist) || {};
    var plName = pl.name || '歌单';
    var raw = await fetchUpstreamJson('/playlist/track/all?id=' + encodeURIComponent(plid) + '&limit=200');
    var arr = Array.isArray(raw) ? raw : ((raw && (raw.songs || (raw.data && raw.data.songs))) || []);
    var songs = arr.map(normTrack).filter(function(s){ return s.id && s.name; });
    return { id: String(plid), name: plName, songs: songs };
  }
  async function resolvePlaylistByKeyword(kw) {
    if (/^\\d{4,}$/.test(String(kw))) return fetchPlaylistSongsById(kw);
    var r = await fetchUpstreamJson('/search?keywords=' + encodeURIComponent(kw) + '&type=1000&limit=1');
    var pls = (r && r.result && r.result.playlists) || [];
    if (!pls.length) return null;
    return fetchPlaylistSongsById(pls[0].id);
  }
  /* --- 暂存一张待确认歌单, 返回确认卡片数据 --- */
  function buildPendingPlaylist(name, songs) {
    var list = (songs || []).map(function(s){ return { id: String(s.id), name: s.name||'', artist: s.artist||'', pic: s.pic||'' }; }).filter(function(s){ return s.id; });
    var seen = {}, uniq = [];
    list.forEach(function(s){ if(!seen[s.id]){ seen[s.id]=1; uniq.push(s); } });
    if (!uniq.length) return null;
    state.pendingPlaylist = { name: name || '精选歌单', songs: uniq, ts: Date.now() };
    return { name: state.pendingPlaylist.name, count: uniq.length, songs: uniq.slice(0, 6) };
  }
  /* --- 执行整单替换: 清空队列 + 灌入 + 播放第一首 --- */
  async function applyPlaylistReplace(by, opts) {
    var pend = state.pendingPlaylist;
    if (!pend || !pend.songs || !pend.songs.length) return null;
    var songs = pend.songs;
    /* P9g: 来自 APP 聊天室时只换 APP 歌单，插件本地不动 */
    if (opts && opts.remoteOnly) {
      state.pendingPlaylist = null;
      try {
        var ds0 = {};
        try { ds0 = nativeDriver.status() || {}; } catch (e) {}
        if (ds0.connected && ds0.roomId) {
          var ids0 = songs.map(function (s) { return String(s.id); });
          ltapi.replaceList('ai', ds0.roomId, ids0, { dedupe: false }).then(function () {
            return new Promise(function (res) { setTimeout(res, 2000); });
          }).then(function () {
            return ltapi.reportCommand('ai', ds0.roomId, {
              commandType: 'GOTO', targetSongId: ids0[0], formerSongId: ids0[0],
              progress: 0, playStatus: 'PLAY',
            });
          }).then(function () { console.log('[playlist→room] remoteOnly ok, count=' + ids0.length); })
            .catch(function (e) { console.log('[playlist→room] remoteOnly err:', (e && e.message) || e); });
        }
      } catch (e) {}
      return { count: songs.length, first: songs[0], remoteOnly: true };
    }
    state.playlist = songs.map(function(s){ return Object.assign({ played: false }, s); });
    state.pendingPlaylist = null;
    var first = songs[0];
    var ur = await fetchUpstreamJson('/song/url/v1?id=' + first.id + '&level=exhigh');
    var d = (ur && ur.data && ur.data[0]) || {};
    if (!d.url) { try { ur = await fetchUpstreamJson('/song/url/v1?id=' + first.id + '&level=standard'); d = (ur && ur.data && ur.data[0]) || {}; } catch(e){} }
    var song = {
      id: String(first.id), name: first.name || '未知', artist: first.artist || '',
      pic: first.pic || '', url: d.url || '', duration: d.time || 0,
    };
    if (state.song) pushHistory(state.song);
    state.song = song;
    touchPlaylist(song);
    state.playing = true;
    state.positionMs = 0;
    state.anchorTs = Date.now();
    state._listenAnchor = Date.now();
    state.seq++;
    state.updatedBy = by || 'ai';
    pushState();
    broadcast('song_change', { song: song, playing: true, positionMs: 0 });
    trackSongRepeat(song);
    /* P9f: 换歌单是否推送房间 —— AI 换歌单一定推（AI 操控 APP），
     * 手动（by='用户'）仅 playSync=true 时才推。 */
    var _pushPl = (by === 'ai') || (state.playSync === true);
    if (_pushPl) {
      try {
        var ds = {};
        try { ds = nativeDriver.status() || {}; } catch (e) {}
        if (ds.connected && ds.roomId) {
          (function (roomId) {
            var ids = songs.map(function (s) { return String(s.id); });
            ltapi.replaceList('ai', roomId, ids, { dedupe: false }).then(function (r) {
              console.log('[playlist→room] replaceList ok=' + (r && r.ok) + ' count=' + ids.length);
              /* 延迟回读确认队列已生效 */
              var tries = 0;
              (function check() {
                tries += 1;
                ltapi.syncPlaylist('ai', roomId).then(function (p) {
                  var got = (p && p.songIds) || [];
                  if (got.length >= ids.length || tries >= 5) {
                    console.log('[playlist→room] observed=' + got.length + ' (want ' + ids.length + ')');
                    /* 队列生效后再 GOTO 首曲，让 APP 跟着切 */
                    return ltapi.reportCommand('ai', roomId, {
                      commandType: 'GOTO', targetSongId: ids[0], formerSongId: ids[0],
                      progress: 0, playStatus: 'PLAY',
                    }).then(function (g) { console.log('[playlist→room] GOTO first ok=' + (g && g.ok)); });
                  }
                  return new Promise(function (res) { setTimeout(res, 1500); }).then(check);
                });
              })();
            }).catch(function (e) { console.log('[playlist→room] error:', (e && e.message) || e); });
          })(ds.roomId);
        }
      } catch (e) {}
    }
    return { first: song, count: songs.length };
  }

  /* --- 自定义音源脚本管理 --- */
  if (p === '/source/list' && req.method === 'GET') {
    return json(res, 200, { ok: true, count: customSources.length, sources: customSources.map(function (s) { return { id: s.id, name: s.name, enabled: s.enabled !== false, ts: s.ts, len: (s.script || '').length }; }) });
  }
  if (p === '/source/get' && req.method === 'GET') {
    const gid = u.searchParams.get('id') || '';
    const it = customSources.find(function (s) { return s.id === gid; });
    if (!it) return json(res, 200, { ok: false, error: 'not found' });
    return json(res, 200, { ok: true, source: it });
  }
  if (p === '/source/import' && req.method === 'POST') {
    const b = await readBodyLarge(req, 2e6);
    let script = String(b.script || b.code || b.source || '');
    let name = String(b.name || '').slice(0, 60);
    const _fp = String(b.filePath || b.path || '').trim();
    if (!script.trim() && _fp) {
      const fr = readSourceFile(_fp);
      if (!fr.ok) return json(res, 200, { ok: false, error: fr.error });
      script = fr.content;
      if (!name) name = fr.name;
    }
    if (!script.trim()) return json(res, 200, { ok: false, error: '脚本内容为空' });
    if (!name) name = '未命名音源';
    let id = String(b.id || '').trim();
    if (!id) id = genSourceId();
    const exist = customSources.find(function (s) { return s.id === id; });
    if (exist) { exist.name = name; exist.script = script; exist.enabled = b.enabled !== false; exist.ts = Date.now(); }
    else customSources.unshift({ id: id, name: name, script: script, enabled: b.enabled !== false, ts: Date.now() });
    saveCustomSources();
    return json(res, 200, { ok: true, id: id, count: customSources.length });
  }
  if (p === '/source/readfile' && req.method === 'GET') {
    const rp = u.searchParams.get('path') || '';
    const fr = readSourceFile(rp);
    if (!fr.ok) return json(res, 200, { ok: false, error: fr.error });
    return json(res, 200, { ok: true, name: fr.name, size: fr.size, content: fr.content });
  }
  if (p === '/source/delete' && req.method === 'POST') {
    const b = await readBody(req);
    const did = String(b.id || '');
    const n0 = customSources.length;
    customSources = customSources.filter(function (s) { return s.id !== did; });
    saveCustomSources();
    return json(res, 200, { ok: true, removed: n0 - customSources.length, count: customSources.length });
  }
  if (p === '/source/toggle' && req.method === 'POST') {
    const b = await readBody(req);
    const it = customSources.find(function (s) { return s.id === String(b.id || ''); });
    if (!it) return json(res, 200, { ok: false, error: 'not found' });
    it.enabled = b.enabled !== false;
    saveCustomSources();
    return json(res, 200, { ok: true, id: it.id, enabled: it.enabled });
  }
  if (p === '/source/test' && req.method === 'POST') {
    const b = await readBodyLarge(req, 2e6);
    const songId = String(b.songId || b.mid || b.id || '');
    const ctx0 = { id: songId, mid: songId, midRaw: songId.replace(/^qq_/, ''), name: String(b.name || ''), artist: String(b.artist || ''), quality: String(b.quality || 'exhigh'), br: '320' };
    if (b.script) {
      const u0 = await runCustomScript(String(b.script), ctx0, 8000);
      return json(res, 200, { ok: !!(u0 && /^https?:\/\//.test(u0)), url: u0 || null, mode: 'script' });
    }
    const u1 = await resolveCustomUrl(ctx0);
    return json(res, 200, { ok: !!(u1 && /^https?:\/\//.test(u1)), url: u1 || null, mode: 'sources', tested: customSources.length });
  }
  /* --- 自定义音源优先: 拦截网易云取 URL 请求, 命中直接返回, 否则回落内置 --- */
  if ((p === '/api/song/url/v1' || p === '/api/song/url') && req.method === 'GET') {
    const sid2 = u.searchParams.get('id') || '';
    if (sid2) {
      const lvl = u.searchParams.get('level') || 'exhigh';
      let nm = '', ar = '', du = 0;
      const cur = state.song;
      if (cur && String(cur.id) === String(sid2)) { nm = cur.name || ''; ar = cur.artist || ''; du = cur.duration || 0; }
      else { const pl = (state.playlist || []).find(function (x) { return String(x.id) === String(sid2); }); if (pl) { nm = pl.name || ''; ar = pl.artist || ''; } }
      const cu = await resolveCustomUrl({ id: sid2, mid: sid2, midRaw: String(sid2).replace(/^qq_/, ''), name: nm, artist: ar, quality: lvl, br: (lvl === 'standard' ? '128' : '320') });
      if (cu) return json(res, 200, { code: 200, data: [{ url: cu, id: sid2, time: du }], source: 'custom' });
    }
  }
  /* --- 网易云API代理 --- */
  if (p.startsWith('/api/')) {
    return proxyReq(req, res, p.slice(4), u.search); // /api/search -> /search
  }

  /* --- QQ 音乐搜索 --- */
  if (p === '/qq/search' && req.method === 'GET') {
    var qkw = u.searchParams.get('keywords') || u.searchParams.get('keyword') || '';
    var qlimit = parseInt(u.searchParams.get('limit')) || 20;
    if (!qkw) return json(res, 400, { error: 'missing keywords' });
    var qresult = await qqSearch(qkw, qlimit);
    return json(res, 200, { code: 200, result: { songs: qresult } });
  }

  /* --- QQ 音乐 URL 解析 --- */
  if (p === '/qq/url' && req.method === 'GET') {
    var qmid = u.searchParams.get('id') || '';
    var qquality = u.searchParams.get('level') || u.searchParams.get('quality') || '128k';
    if (!qmid) return json(res, 400, { error: 'missing id' });
    var qurl = await qqResolveUrl(qmid, qquality);
    if (qurl) return json(res, 200, { code: 200, data: [{ url: qurl, id: qmid }] });
    return json(res, 200, { code: -1, data: [{ url: null, id: qmid }], msg: '解析失败' });
  }

  /* --- QQ 音乐热门评论 --- */
  if (p === '/qq/comment' && req.method === 'GET') {
    var qsid = u.searchParams.get('songid') || u.searchParams.get('id') || '';
    if (!qsid) return json(res, 400, { error: 'missing songid' });
    try {
      var commentUrl = 'https://c.y.qq.com/base/fcgi-bin/fcg_global_comment_h5.fcg?g_tk=5381&format=json&inCharset=utf8&outCharset=utf-8&biztype=1&topid=' + encodeURIComponent(qsid) + '&cmd=8&pagenum=0&pagesize=20';
      var cresp = await httpsGetJson(commentUrl, { 'Referer': 'https://y.qq.com/' }, 10000);
      if (!cresp || cresp.status !== 200) return json(res, 200, { hotComments: [] });
      var cd = JSON.parse(cresp.body);
      if (cd.code !== 0) return json(res, 200, { hotComments: [] });
      var hotList = (cd.hot_comment && cd.hot_comment.commentlist) || [];
      var hotComments = [];
      for (var i = 0; i < hotList.length; i++) {
        var c = hotList[i] || {};
        hotComments.push({
          user: { nickname: c.rootcommentnick || c.nick || 'QQ音乐用户' },
          content: c.rootcommentcontent || c.content || '',
          likedCount: c.praisenum || 0
        });
      }
      return json(res, 200, { hotComments: hotComments });
    } catch (e) {
      return json(res, 200, { hotComments: [], error: String(e) });
    }
  }

  /* --- 语音转文字 (前端录音 base64 上传) --- */
  if (p === '/ai/stt' && req.method === 'POST') {
    const b = await readBodyLarge(req, 8e6);
    let b64 = b.audio || b.data || '';
    if (!b64) return json(res, 200, { ok: false, error: '缺少音频数据' });
    b64 = String(b64).replace(/^data:audio\/[^;]+;base64,/, '');
    const r = await transcribeAudio(b64, b.format || 'wav');
    return json(res, 200, r);
  }
  /* ================= P8: 原生一起听 —— AI 工具 REST 端点 =================
   *  统一身份参数 who（默认 ai，可传 human）。全部走 ltapi 函数式接口。
   *  这些端点供插件包 packages/netease_listen.js 的 15 个 AI 工具调用。
   * ---------------------------------------------------------------------- */
  const _nRoom = function () {
    try { const ds = nativeDriver.status(); if (ds && ds.roomId) return ds.roomId; } catch (e) {}
    return state.native.roomId || state.roomId || '';
  };
  const _nChatRoom = function () {
    try { const ds = nativeDriver.status(); if (ds && ds.chatRoomId) return ds.chatRoomId; } catch (e) {}
    return state.native.chatRoomId || '';
  };

  /* 原生建房：POST /native/room/create {who?} */
  if (p === '/native/room/create' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const who = String((b && b.who) || 'ai');
      const r = await ltapi.createRoom(who);
      if (r.ok) {
        state.native.connected = true;
        state.native.lastSyncTs = Date.now();
        state.roomId = r.roomId;
        state.native.roomId = r.roomId;
        if (nativeDriver.syncMode) { try { nativeDriver.syncMode(state.mode); } catch (e) {} }
        pushState('native_create');
      }
      return json(res, r.ok ? 200 : 409, r);
    } catch (e) { return json(res, 500, { ok: false, message: String((e && e.message) || e) }); }
  }

  /* 原生进房/接受邀请：POST /native/accept {who?, roomId, inviterId, refer?} */
  if (p === '/native/accept' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const who = String((b && b.who) || 'ai');
      const r = await ltapi.acceptInvitation(who, String(b && b.roomId || ''), String(b && b.inviterId || ''), b && b.refer);
      if (r.ok) { state.roomId = r.roomId; state.native.connected = true; pushState('native_accept'); }
      return json(res, r.ok ? 200 : 409, r);
    } catch (e) { return json(res, 500, { ok: false, message: String((e && e.message) || e) }); }
  }

  /* 原生房间状态：GET|POST /native/status {who?} */
  if (p === '/native/status' && (req.method === 'GET' || req.method === 'POST')) {
    try {
      const b = req.method === 'POST' ? await readBody(req) : {};
      const who = String((b && b.who) || 'ai');
      const r = await ltapi.statusGet(who);
      return json(res, 200, r);
    } catch (e) { return json(res, 500, { ok: false, message: String((e && e.message) || e) }); }
  }

  /* P9: 房间读消息监听控制与状态：GET/POST /native/roomwatch
   *   body { action?:'start'|'stop'|'status', chatroomId?, roomId? } */
  if (p === '/native/roomwatch' && (req.method === 'GET' || req.method === 'POST')) {
    try {
      const b = req.method === 'POST' ? await readBody(req) : {};
      const action = String((b && b.action) || 'status');
      if (action === 'stop') { roomWatch.stop(); _roomWatchCursor = 0; return json(res, 200, { ok: true, roomWatch: roomWatch.status() }); }
      if (action === 'start') {
        const ds = (function () { try { return nativeDriver.status() || {}; } catch (e) { return {}; } })();
        const roomId = (b && b.roomId) || ds.roomId;
        const chatroomId = (b && b.chatroomId) || ds.chatRoomId;
        const r = await roomWatch.start({ roomId: roomId, chatroomId: chatroomId, nick: (ds.account && ds.account.nickname) || '' });
        _roomWatchCursor = roomWatch.cursor();
        return json(res, 200, { ok: true, result: r, roomWatch: roomWatch.status() });
      }
      return json(res, 200, { ok: true, roomWatch: Object.assign({}, roomWatch.status(), { lastErr: _roomWatchLastErr }) });
    } catch (e) { return json(res, 500, { ok: false, message: String((e && e.message) || e), roomWatch: roomWatch.status() }); }
  }

  /* 原生播放指令（切歌/暂停/继续）：POST /native/play {who?, roomId, action, songId?, progress?} */
  if (p === '/native/play' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const who = String((b && b.who) || 'ai');
      const roomId = _nRoom();
      const action = String((b && b.action) || 'play').toLowerCase();
      const songId = b && b.songId != null ? String(b.songId) : '0';
      const cmd = { targetSongId: songId, formerSongId: songId, progress: b && b.progress != null ? b.progress : 0 };
      if (action === 'pause') { cmd.commandType = 'PAUSE'; cmd.playStatus = 'PAUSE'; }
      else if (action === 'next') { cmd.commandType = 'NEXT'; cmd.playStatus = 'PLAY'; }
      else if (action === 'prev') { cmd.commandType = 'PREV'; cmd.playStatus = 'PLAY'; }
      else if (action === 'goto' || action === 'load') { cmd.commandType = 'GOTO'; cmd.playStatus = 'PLAY'; }
      else { cmd.commandType = 'PLAY'; cmd.playStatus = 'PLAY'; }
      const r = await ltapi.reportCommand(who, roomId, cmd);
      return json(res, r.ok ? 200 : 409, r);
    } catch (e) { return json(res, 500, { ok: false, message: String((e && e.message) || e) }); }
  }

  /* 原生加歌（REPLACE 全量替换）：POST /native/add_song {who?, roomId, songIds|songId, dedupe?} */
  if (p === '/native/add_song' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const who = String((b && b.who) || 'ai');
      const roomId = _nRoom();
      let ids = b && b.songIds;
      if (!Array.isArray(ids)) ids = (b && b.songId != null) ? [b.songId] : [];
      const r = await ltapi.addSongs(who, roomId, ids, { dedupe: !(b && b.dedupe === false) });
      return json(res, r.ok ? 200 : 409, r);
    } catch (e) { return json(res, 500, { ok: false, message: String((e && e.message) || e) }); }
  }

  /* 原生整单替换歌单：POST /native/replace_playlist {who?, roomId, songIds} */
  if (p === '/native/replace_playlist' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const who = String((b && b.who) || 'ai');
      const roomId = _nRoom();
      const list = Array.isArray(b && b.songIds) ? b.songIds : [];
      const r = await ltapi.replaceList(who, roomId, list, {});
      return json(res, r.ok ? 200 : 409, r);
    } catch (e) { return json(res, 500, { ok: false, message: String((e && e.message) || e) }); }
  }

  /* 原生房间内发言：POST /native/say_in_room {who?, roomId, chatroomId?, text, ltType?} */
  if (p === '/native/say_in_room' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const who = String((b && b.who) || 'ai');
      const roomId = _nRoom();
      let chatroomId = b && b.chatroomId;
      if (!chatroomId) {
        const st = await ltapi.statusGet(who);
        const info = (st && st.roomInfo) || {};
        chatroomId = info.chatRoomId || _nChatRoom();
      }
      const svc = new messageLib.MessageService(who);
      const r = await svc.sendToRoom({ chatroomId: chatroomId, text: String((b && b.text) || ''), roomId: roomId, ltType: b && b.ltType });
      return json(res, (r && r.code === 200) ? 200 : 409, r);
    } catch (e) { return json(res, 500, { ok: false, message: String((e && e.message) || e) }); }
  }

  /* 原生读房间（私信历史 + 邀请，房间内聊天无 HTTP 接口）：POST /native/read_room {who?, limit?} */
  if (p === '/native/read_room' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const who = String((b && b.who) || 'ai');
      const svc = new messageLib.MessageService(who);
      const convs = await svc.conversations({ limit: b && b.limit || 30 });
      const invites = await svc.listInvites(inviteLib);
      return json(res, 200, { ok: true, conversations: convs.length, invites: invites, note: '房间内聊天历史无 HTTP 接口，仅能读私信/邀请' });
    } catch (e) { return json(res, 500, { ok: false, message: String((e && e.message) || e) }); }
  }

  /* 列出待处理邀请：POST /native/list_invites {who?} */
  if (p === '/native/list_invites' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const who = String((b && b.who) || 'ai');
      const svc = new messageLib.MessageService(who);
      const invites = await svc.listInvites(inviteLib);
      return json(res, 200, { ok: true, count: invites.length, invites: invites });
    } catch (e) { return json(res, 500, { ok: false, message: String((e && e.message) || e) }); }
  }

  /* 原生退房：POST /native/end {who?, roomId?} */
  if (p === '/native/end' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const who = String((b && b.who) || 'ai');
      const roomId = _nRoom();
      const r = await ltapi.endRoom(who, roomId);
      if (r.ok) { state.native.connected = false; state.native.roomId = ''; pushState('native_end'); }
      return json(res, r.ok ? 200 : 409, r);
    } catch (e) { return json(res, 500, { ok: false, message: String((e && e.message) || e) }); }
  }

  /* 原生心跳存活判定（488=对方关房）：POST /native/heartbeat_checked {who?, roomId?} */
  if (p === '/native/heartbeat_checked' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const who = String((b && b.who) || 'ai');
      const roomId = _nRoom();
      const r = await ltapi.heartbeatChecked(who, roomId, b || {});
      if (!r.alive && r.code === 488) { state.native.connected = false; state.native.roomId = ''; }
      return json(res, 200, r);
    } catch (e) { return json(res, 500, { ok: false, message: String((e && e.message) || e) }); }
  }

  /* 原生同步一次（拉远端 playCommand + 歌单）：POST /native/sync_once {who?, roomId?} */
  if (p === '/native/sync_once' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      const who = String((b && b.who) || 'ai');
      const roomId = _nRoom();
      const r = await ltapi.syncPlaylist(who, roomId);
      return json(res, 200, r);
    } catch (e) { return json(res, 500, { ok: false, message: String((e && e.message) || e) }); }
  }

  /* --- 健康检查/状态 --- */
  if (p === '/health') {
    return json(res, 200, { ok: true, roomId: state.roomId, clients: clients.size });
  }
  if (p === '/state') {
    return json(res, 200, snapshot());
  }

  /* --- 静态文件 --- */
  let file = p === '/' ? '/player.html' : p;
  file = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    res.end(data);
  });
});

setInterval(() => { // 成员超时清理
  const now = Date.now();
  for (const id of Object.keys(state.members)) {
    const m = state.members[id];
    if (now - (m.lastSeen || 0) > 60000) delete state.members[id];
  }
}, 30000);

/* ---------------- 持久化: 房间状态存盘, 重启不丢 ---------------- */

/* ---------------- Operit 角色卡 & 模型配置自动读取 ---------------- */
/* 零依赖解析 Android DataStore protobuf: 提取 key→string 值对 */
const OPERIT_BASE = '/data/user/0/com.ai.assistance.operit/files';
const DATASTORE_DIR = path.join(OPERIT_BASE, 'datastore');
function readPbPref(filename) {
  try {
    const buf = fs.readFileSync(path.join(DATASTORE_DIR, filename));
    const map = {};
    function readVarInt(b, off) { let v = 0, s = 0; while (off < b.length) { const c = b[off++]; v |= (c & 0x7f) << s; s += 7; if (!(c & 0x80)) break; } return [v, off]; }
    function parseEntry(data) {
      let j = 0, key = '', val = '';
      while (j < data.length) {
        const ft = data[j]; j++;
        const [fl, nj] = readVarInt(data, j); j = nj;
        if (j + fl > data.length) break;
        const chunk = data.slice(j, j + fl); j += fl;
        if (ft === 0x0a) key = chunk.toString('utf8');
        else if (ft === 0x12) {
          let k = 0;
          while (k < chunk.length) {
            const wt = chunk[k]; k++;
            const [wl, nk] = readVarInt(chunk, k); k = nk;
            if (wl <= 0 || k + wl > chunk.length) break;
            if (wt === 0x2a) val = chunk.slice(k, k + wl).toString('utf8');
            k += wl;
          }
        }
      }
      return [key, val];
    }
    let i = 0;
    while (i < buf.length) {
      const tag = buf[i]; i++;
      const [len, ni] = readVarInt(buf, i); i = ni;
      if (len <= 0 || i + len > buf.length) break;
      const data = buf.slice(i, i + len); i += len;
      const [key, val] = parseEntry(data);
      if (key) map[key] = val;
    }
    return map;
  } catch (e) { return {}; }
}
function loadOperitConfig() {
  var oc = { endpoint:'', apiKey:'', model:'', systemPrompt:'' };
  try {
    /* 1. 读角色卡: 找 active_character_card_id, 再读对应角色卡设定 */
    const cc = readPbPref('character_cards.preferences_pb');
    const activeId = cc['active_character_card_id'];
    if (activeId) {
      const prefix = 'character_card_' + activeId;
      var setting = cc[prefix + '_character_setting'] || '';
      var otherChat = cc[prefix + '_other_content_chat'] || '';
      var opening = cc[prefix + '_opening_statement'] || '';
      if (setting) {
        oc.systemPrompt = setting;
        if (otherChat) oc.systemPrompt += '\n\n' + otherChat;
      }
    }
    /* 2. 读模型配置: functional_configs 找 CHAT 绑定, 再到 model_configs 找对应配置 */
    const fc = readPbPref('functional_configs.preferences_pb');
    if (fc['function_config_mapping']) {
      try {
        var fcm = JSON.parse(fc['function_config_mapping']);
        var chatBinding = fcm['CHAT'];
        if (chatBinding && chatBinding.configId) {
          const mc = readPbPref('model_configs.preferences_pb');
          var configKey = 'config_' + chatBinding.configId;
          var configJson = mc[configKey];
          if (configJson) {
            var mcObj = JSON.parse(configJson);
            oc.endpoint = mcObj.apiEndpoint || '';
            oc.apiKey = mcObj.apiKey || '';
            /* modelName 可能是逗号分隔的多个, 用 modelIndex 选 */
            var models = (mcObj.modelName || '').split(',').map(function(s){return s.trim()}).filter(Boolean);
            if (models.length) {
              var idx = chatBinding.modelIndex || 0;
              oc.model = models[Math.min(idx, models.length - 1)] || models[0];
            }
          }
        }
      } catch(e) { console.log('[LT] parse model config error:', e.message); }
    }
    /* 3. 读用户记忆档案: 追加到 systemPrompt */
    try {
      var memPath = path.join(OPERIT_BASE, 'memory-space-profiles', 'default', 'user.md');
      var userMd = fs.readFileSync(memPath, 'utf8').trim();
      if (userMd) oc.systemPrompt += '\n\n## 用户画像\n' + userMd;
    } catch(e) {}
  } catch(e) { console.log('[LT] loadOperitConfig error:', e.message); }
  return oc;
}
var operitConfig = loadOperitConfig();
if (operitConfig.systemPrompt) console.log('[LT] loaded Operit character card:', operitConfig.systemPrompt.slice(0, 50));
if (operitConfig.model) console.log('[LT] loaded Operit model config:', operitConfig.model);
/* ---------------- AI 聊天 ---------------- */
const AI_CONFIG_PATH = path.join(__dirname, 'ai_config.json');
let aiConfig = { endpoint:'', apiKey:'', model:'', soundSource:'netease', qqSearchApi:'', qqResolveApis:[], systemPrompt:'你是一个温柔友善的AI助手，正在和用户一起听音乐。用简短自然的语气回复，像聊天一样。' };
try { const v = JSON.parse(fs.readFileSync(AI_CONFIG_PATH, 'utf8')); if (v && typeof v === 'object') aiConfig = Object.assign(aiConfig, v); } catch(e) {}
/* 从 ai_config.json 读取网易云 API 地址配置 */
if (aiConfig.neteaseApi) NETEASE_API = aiConfig.neteaseApi; else NETEASE_API = DEFAULT_NETEASE_API;
if (aiConfig.qqSearchApi) QQ_SEARCH_API = aiConfig.qqSearchApi;
if (Array.isArray(aiConfig.qqResolveApis) && aiConfig.qqResolveApis.length) { var _ri = aiConfig.qqResolveApis.map(normalizeResolveItem).filter(Boolean); if (_ri.length) QQ_RESOLVE_APIS = _ri; }
/* Operit 配置: 仅在用户未自定义时才覆盖 ai_config.json */
if (!aiConfig._userCustomized) {
  if (operitConfig.systemPrompt) aiConfig.systemPrompt = operitConfig.systemPrompt;
  if (operitConfig.endpoint) aiConfig.endpoint = operitConfig.endpoint;
  if (operitConfig.apiKey) aiConfig.apiKey = operitConfig.apiKey;
  if (operitConfig.model) aiConfig.model = operitConfig.model;
} else {
  console.log('[LT] user customized config detected, skip Operit override');
}
function saveAiConfig() { try { fs.writeFileSync(AI_CONFIG_PATH, JSON.stringify(aiConfig, null, 2)); } catch(e) {} }
function callLLM(messages, cb) {
  const body = JSON.stringify({ model: aiConfig.model, messages, max_tokens: 1024, temperature: 0.95, stream: false });
  let endpoint = aiConfig.endpoint;
  if (!endpoint.endsWith('/chat/completions')) { if (endpoint.charAt(endpoint.length-1)==='/') endpoint=endpoint.slice(0,-1); endpoint += '/chat/completions'; }
  const url = new URL(endpoint);
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + aiConfig.apiKey, 'User-Agent': UA, 'Accept': 'application/json' } };
  const req = https.request(url, opts, (resp) => {
    let buf = '';
    resp.on('data', c => buf += c);
    resp.on('end', () => {
      const code = resp.statusCode || 0;
      if (code < 200 || code >= 300) { return cb('LLM HTTP ' + code + ' | ' + String(buf).slice(0, 240)); }
      try { const d = JSON.parse(buf); const text = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content; cb(null, text || ''); } catch(e) { cb(e.message + ' | raw: ' + buf.slice(0, 200)); }
    });
  });
  req.on('error', err => cb(err.message));
  req.write(body); req.end();
}

const STATE_PATH = path.join(__dirname, 'state.json');
function saveState() {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      mode: state.mode,
      playSync: state.playSync,
      song: state.song, playing: state.playing,
      positionMs: state.positionMs, anchorTs: state.anchorTs,
      playlist: state.playlist, history: state.history, playMode: state.playMode,
      favorites: state.favorites,
      meta: state.meta,
    }));
  } catch (e) {}
}
let _saveT = null;
function saveStateDebounced() { clearTimeout(_saveT); _saveT = setTimeout(saveState, 800); }
try { // 启动时恢复
  const sv = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  if (sv && ['local', 'duo', 'solo_ai'].indexOf(sv.mode) >= 0) state.mode = sv.mode;
  if (sv && typeof sv.playSync === 'boolean') state.playSync = sv.playSync;
  if (sv && typeof sv.playMode === 'string' && ['order', 'one', 'random'].indexOf(sv.playMode) >= 0) state.playMode = sv.playMode;
  if (sv && Array.isArray(sv.playlist)) state.playlist = sv.playlist;
  if (sv && Array.isArray(sv.history)) state.history = sv.history;
  if (sv && Array.isArray(sv.favorites)) state.favorites = sv.favorites;
  if (sv && sv.meta && typeof sv.meta === 'object') state.meta = Object.assign(state.meta, sv.meta);
  if (sv && sv.song && sv.song.id) {
    state.song = sv.song;
    if (sv.playing) { // 重启期间按真实流逝时间推进
      const gone = Date.now() - (sv.anchorTs || Date.now());
      state.positionMs = Math.min((sv.song.duration || 0) || Infinity, Math.max(0, (sv.positionMs || 0) + gone));
    } else state.positionMs = sv.positionMs || 0;
    state.playing = false; // 恢复后默认暂停, 由用户继续
    state.anchorTs = Date.now();
    console.log('[LT] restored state:', sv.song.name);
  }
} catch (e) {}
/* 音源保鲜: 落盘恢复的URL会过期(网易CDN/QQ vkey有时效), 启动即异步刷新并广播; 之后每10分钟保鲜 */
async function refreshCurrentUrl() {
  const s = state.song;
  if (!s || !s.id) return;
  try {
    /* 自定义音源优先: 命中则刷新为自定义源 URL (若变化) */
    try {
      const _cu2 = await resolveCustomUrl({ id: s.id, mid: s.id, midRaw: String(s.id).replace(/^qq_/, ''), name: s.name || '', artist: s.artist || '', quality: 'exhigh', br: '320' });
      if (_cu2 && _cu2 !== s.url) {
        s.url = _cu2;
        state.seq++;
        saveStateDebounced();
        pushState('url_refresh');
        console.log('[SRC] url refreshed by custom source:', s.name);
        return;
      }
    } catch (e) {}
    /* QQ 音乐歌曲: id 以 qq_ 开头, 走 QQ 解析链 */
    if (String(s.id).startsWith('qq_')) {
      var qqMid = String(s.id).slice(3);
      var qqUrl = await qqResolveUrl(qqMid, '128k');
      if (qqUrl && qqUrl !== s.url) {
        s.url = qqUrl;
        state.seq++;
        saveStateDebounced();
        pushState('url_refresh');
        console.log('[LT] qq url refreshed:', s.name);
      }
      return;
    }
    /* 网易云歌曲: 走网易云 API */
    const ur = await fetchUpstreamJson('/song/url/v1?id=' + s.id + '&level=exhigh');
    const d0 = (ur && ur.data && ur.data[0]) || {};
    if (d0.url && d0.url !== s.url) {
      s.url = d0.url;
      if (d0.time) s.duration = d0.time;
      state.seq++;
      saveStateDebounced();
      pushState('url_refresh');
      console.log('[LT] url refreshed:', s.name);
    }
  } catch (e) {}
}
refreshCurrentUrl();
setInterval(refreshCurrentUrl, 600000);

/* ---------------- P7: 原生房间 → 本地 state 下行回灌 ----------------
 * driver 在 2s 轮询里对远端播放态做完「时间戳仲裁 + serverSeq 去重」后，
 * 通过 applyRemote / applyRemotePlaylist 把结果落进本地 state 并走标准
 * sync / song_change 事件广播（前端已有消费逻辑，无需新增事件类型）。 */
const _remoteMetaCache = new Map(); // songId -> song 元数据（进程内缓存）
/** 按 id 取整首歌的元数据（歌名/歌手/封面/时长/播放 url），失败降级为空壳 */
async function fetchRemoteSongMeta(id) {
  const sid = String(id);
  if (_remoteMetaCache.has(sid)) return _remoteMetaCache.get(sid);
  let song = null;
  try {
    const dd = await fetchUpstreamJson('/song/detail?ids=' + sid);
    const s0 = dd && dd.songs && dd.songs[0];
    if (s0) {
      song = {
        id: sid,
        name: s0.name || '未知',
        artist: (((s0.ar || s0.artists || [])).map(function (a) { return a.name; }).join('/')) || '',
        pic: (s0.al && s0.al.picUrl) || (s0.album && s0.album.picUrl) || '',
        url: '',
        duration: s0.dt || s0.duration || 0,
      };
    }
  } catch (e) {}
  if (!song) song = { id: sid, name: '未知', artist: '', pic: '', url: '', duration: 0 };
  try {
    let ur = await fetchUpstreamJson('/song/url/v1?id=' + sid + '&level=exhigh');
    let d0 = (ur && ur.data && ur.data[0]) || {};
    if (!d0.url) {
      ur = await fetchUpstreamJson('/song/url/v1?id=' + sid + '&level=standard');
      d0 = (ur && ur.data && ur.data[0]) || {};
    }
    if (d0.url) { song.url = d0.url; song.duration = d0.time || song.duration; }
  } catch (e) {}
  _remoteMetaCache.set(sid, song);
  return song;
}

/** P7: 应用远端的歌 / 播放态 / 进度（driver 已仲裁，这里只负责落地 + 广播） */
async function applyNativeRemote(remote) {
  if (!remote || !remote.songId) return;
  if (state.mode === 'local') return; // 纯本地模式不接管
  /* P9: 播放控制各端独立时（playSync=false），忽略远端播放态，本地自己播自己的。
   * （房间成员/歌单展示仍照常，只是不把 APP 的切歌/暂停打回本地播放器。） */
  if (state.playSync !== true) return;
  const sid = String(remote.songId);
  const changed = !state.song || String(state.song.id) !== sid;
  if (changed) {
    if (state.song) pushHistory(state.song);
    const meta = await fetchRemoteSongMeta(sid);
    if (state.mode === 'local') return; // 抓元数据期间可能已切回本地
    state.song = meta;
    touchPlaylist(meta);
    state.updatedBy = 'native';
  }
  const wasPlaying = state.playing;
  state.playing = !!remote.playing;
  state.positionMs = Math.max(0, Number(remote.positionMs) || 0);
  state.anchorTs = Date.now();
  state._listenAnchor = state.playing ? Date.now() : state._listenAnchor;
  if (wasPlaying && !state.playing) flushListenSeconds();
  state.seq = (state.seq || 0) + 1;
  state.updatedAt = Date.now();
  if (changed) { try { broadcast('song_change', snapshot()); } catch (e) {} }
  pushState('native_downlink');
}

/** P7: 房间真实队列回灌（按 id 序列去重，避免每 2s 重复抓元数据） */
let _lastRemotePlKey = '';
function applyNativeRemotePlaylist(songIds, playMode) {
  if (!songIds || !songIds.length) return;
  if (state.mode === 'local') return;
  /* P9e: 各端独立时（playSync=false），APP 换歌单不回灌插件列表 */
  if (state.playSync !== true) return;
  const key = songIds.join(',');
  if (key === _lastRemotePlKey) return;
  _lastRemotePlKey = key;
  state.playlist = songIds.map(function (id) {
    const sid = String(id);
    const cached = _remoteMetaCache.get(sid);
    return cached ? Object.assign({ played: false }, cached)
                  : { id: sid, name: '', artist: '', pic: '', url: '', duration: 0, played: false };
  });
  if (playMode) {
    const MAP = { ORDER_LOOP: 'order', SINGLE_LOOP: 'one', RANDOM: 'random', ORDER: 'order', LOOP: 'order' };
    if (MAP[playMode]) state.playMode = MAP[playMode];
  }
  state.seq = (state.seq || 0) + 1;
  state.updatedAt = Date.now();
  pushState('native_playlist');
  /* 后台补齐缺失元数据；补齐完成后若队列仍是同一份，则回填一次带元数据的列表 */
  Promise.all(songIds.map(function (id) { return fetchRemoteSongMeta(id); })).then(function () {
    if (String(songIds.join(',')) !== _lastRemotePlKey) return;
    if (state.mode === 'local') return;
    let enriched = false;
    state.playlist.forEach(function (g) {
      const c = _remoteMetaCache.get(String(g.id));
      if (c && (!g.name || g.name === '')) {
        g.name = c.name; g.artist = c.artist; g.pic = c.pic; g.duration = c.duration; enriched = true;
      }
    });
    if (enriched) { state.seq = (state.seq || 0) + 1; pushState('native_playlist_meta'); }
  }).catch(function () {});
}

/* ---------------- P1: 初始化原生驱动（注入宿主依赖）---------------- */
nativeDriver.init({
  snapshot: snapshot,
  pushState: pushState,
  broadcast: broadcast,
  /* P7: 下行回灌入口（供 driver._pullRemote 调用） */
  applyRemote: applyNativeRemote,
  applyRemotePlaylist: applyNativeRemotePlaylist,
  log: function () { console.log.apply(console, ['[native]'].concat([].slice.call(arguments))); },
});
/* 启动时从持久化状态恢复接入模式（state.json 里保存了 state.mode） */
if (state.mode && state.mode !== 'local') {
  nativeDriver.start(state.mode).then(function (st) {
    state.native.enabled = !!st.enabled;
    state.native.connected = !!st.connected;
    console.log('[LT] restored native mode:', state.mode, st && st.connected ? '(connected roomId=' + st.roomId + ')' : '(not connected)');
  }).catch(function (e) { console.log('[LT] restore native mode failed:', e.message); });
}

server.listen(PORT, () => {
  console.log(`[LT] Listen-Together server on http://127.0.0.1:${PORT}`);
});
