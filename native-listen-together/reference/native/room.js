'use strict';
/**
 * 一起听房间操作（eapi 写操作 + 只读查询）。
 *
 * ⚠️ 参考实现，尚未接入 server.js。
 *
 * ── 已实测验证（真实 cookie 打真实服务器，双账号）──────────────
 *   ✅ room/create                          建房，返回完整 roomInfo
 *   ✅ play/invitation/accept               接受邀请进房（需 roomId+inviterId）
 *   ✅ play/command/report                  切歌/暂停/播放，serverSeq 真实推进
 *   ✅ heartbeat                            心跳，缺 4 字段会 400
 *   ✅ status/get                           查房间状态（含 roomUsers）
 *   ✅ end/v2                               关房
 *   ✅ sync/playlist/get                    双人房间返回完整状态（单人时空）
 *   ❌ sync/list/command/report（加歌）      假成功，列表不变 —— 详见下
 *
 * ── 关键实测结论（务必读）────────────────────────────────────
 *   ⚠️ **下行同步可行，走 HTTP 轮询**（早前"只有 Agora"的推断已被推翻）：
 *      房间里有第二个成员后，sync/playlist/get 返回完整 playCommand +
 *      playlist.displayList.result，对方切歌/暂停都能读到，延迟 1–3 秒。
 *      单人房间恒返回 {"data":{}}，这是正常的，不是故障。
 *
 *   ⚠️ **字段名坑（会静默失败）**：切歌必须用 targetSongId / formerSongId，
 *      **不是 songId**。用 songId 时接口照样返回 result:true，但 serverSeq
 *      纹丝不动 —— 典型的假成功。见 buildCommandInfo。
 *
 *   ⚠️ **加歌（sync/list/command/report）实测无效**：返回 result:true
 *      但列表恒定不变。穷举 20+ 种载荷形态（operationType / songIds /
 *      displayList / version 协商）全部失败。三个同类开源项目也都
 *      没解决。**结论：AI 只 GOTO 切房间已有的歌，加歌交给真人侧。**
 *
 *   ⚠️ `result:true` 不代表性变更成功；只有 `result:false` 是明确拒绝。
 *
 *   ⚠️ 心跳接口名在官方是拼错的 `heatbeat`，但 eapi 路径实测为
 *      `heartbeat`（本项目验证可用）；对方关房时心跳会返回 **488**
 *      （= 已由对方结束）→ 应清空本地 roomId 重找邀请。
 *
 *   roomInfo 里的 agoraChannelId / chatRoomId 说明**语音与房间内聊天**
 *   走 Agora + 网易云信通道（HTTP 够不着）；但**播放状态同步是纯 HTTP**。
 */

/** 一起听接口路径（全部实测存在）。 */
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

/** 心跳默认进度（毫秒），带个非零值更像正常客户端。 */
const DEFAULT_PROGRESS = 30000;

/** 空房间存活时间：roomInfo.waitMs 实测为 120000（2 分钟没人加入自动解散）。 */
const DEFAULT_WAIT_MS = 120000;

/** 房间有效期：roomInfo.effectiveDurationMs 实测 1800000（30 分钟）。 */
const DEFAULT_EFFECTIVE_MS = 1800000;

/**
 * 当前毫秒时间戳，同时用作 clientSeq / clientTime。
 * 官方客户端这两个值就是同一个数。
 */
function stamp() {
  return Date.now();
}

/**
 * 构造切歌指令。
 * ⚠️ 返回的是 JSON 字符串，不是对象 —— 塞进 payload 时是「字符串套 JSON」，
 *    序列化错了服务端会静默忽略（返回 200 但没生效）。
 *
 * ⚠️⚠️ 字段名实测修正（2026-09 真机双人房间验证）：
 *    官方 playCommand 用的是 **targetSongId / formerSongId**，
 *    **不是 songId**。用 songId 时接口照样返回 result:true，
 *    但房间状态纹丝不动（serverSeq 不推进）—— 典型的静默失败。
 *    对照实验：用 targetSongId 时 serverSeq 每次都推进，commandType 被原样回显。
 *
 * 实测被服务端接受的 commandType：
 *   PLAY / PAUSE（切换播放状态，改的是 playStatus）
 *   GOTO（跳到指定 targetSongId）
 *   NEXT / PREV（下一首 / 上一首）
 * 服务端会把你发的 commandType 原样回显到房间状态里，因此不要发怪值。
 *
 * @param {object} o
 * @param {string|number} o.targetSongId 目标歌曲 ID
 * @param {string|number} [o.formerSongId] 切换前的歌曲 ID
 * @param {string} [o.commandType] PLAY / PAUSE / GOTO / NEXT / PREV
 * @param {string} [o.playStatus] PLAY / PAUSE
 * @param {number} [o.progress]
 * @returns {string}
 */
function buildCommandInfo(o) {
  const t = stamp();
  const target = String(o.targetSongId !== undefined ? o.targetSongId : o.songId);
  const former = String(
    o.formerSongId !== undefined ? o.formerSongId : target,
  );
  return JSON.stringify({
    commandType: o.commandType || 'GOTO',
    targetSongId: target,
    formerSongId: former,
    playStatus: o.playStatus || 'PLAY',
    progress: o.progress || 0,
    clientSeq: t,
    clientTime: t,
  });
}

/**
 * 构造播放列表变更指令（同样是 JSON 字符串）。
 *
 * ⚠️⚠️ 实测结论（2026-09 真机双人房间）：**ADD 加歌尚未跑通**，请勿直接使用。
 *
 * 观测到的房间列表真实结构（从 sync/playlist/get 读回）：
 *   { displayList: { changed, result:[songId...], rcmdSongIds:[] },
 *     randomList:  { changed, result:[] },
 *     songIdWithAlgList: null,
 *     playMode: 'ORDER_LOOP', listMode: '', listModeParam: null,
 *     replace: false,
 *     version: [{ userId, version, outerId }] }      <-- 每用户版本号
 *
 * 试过的形态与结果：
 *   { operationType:'ADD', songIds:[id] }                    -> result:true，列表不变
 *   { operationType:'ADD', songId:id }                       -> result:true，列表不变
 *   { operationType:'ADD_SONG' / 'INSERT' }                  -> result:true，列表不变
 *   { operationType:'ADD', displayList:{result:[...]} }      -> **result:false**（被拒）
 *   带 version 数组的 displayList 形态                        -> result:false（被拒）
 *
 * 注意 `result:true` 是**假成功**（和 songId 那个坑一样，接口收下但不生效）；
 * 只有 `result:false` 是明确的拒绝信号。
 *
 * 推测：房间列表变更依赖 `version` 的每用户版本协商（乐观锁），
 * 需要带上**正确的 version 值**才可能被接受。当前实现未打通，
 * 建议抓一次「官方客户端加歌」的完整请求来确定 version 与字段形态。
 *
 * @param {object} o
 * @param {Array<string|number>} o.songIds
 * @param {string} [o.operationType]
 * @returns {string}
 */
function buildPlaylistParam(o) {
  const t = stamp();
  return JSON.stringify({
    operationType: o.operationType || 'ADD',
    songIds: (o.songIds || []).map(String),
    clientSeq: t,
    clientTime: t,
  });
}

/**
 * 从 status/get 响应里提取房间信息。
 * @param {object} resp
 * @returns {object|null}
 */
function pickRoomInfo(resp) {
  const d = (resp && resp.data) || {};
  return d.roomInfo || null;
}

/**
 * 房间服务：所有方法都要传 client（决定用哪个身份操作）。
 */
class RoomService {
  /**
   * @param {import('./client.js').NativeClient} client
   * @param {object} [options]
   * @param {string} [options.roomId] 已记录的房间号
   */
  constructor(client, options) {
    this.client = client;
    this.roomId = (options && options.roomId) || '';
  }

  /**
   * 建房。已在房间里时官方返回 type=ALREADY_IN_ROOM（不会重复建）。
   * @returns {Promise<{roomId: string, type: string, roomInfo: object}>}
   */
  async create() {
    const resp = await this.client.eapiRequest(PATHS.create, {});
    const info = pickRoomInfo(resp);
    if (info && info.roomId) this.roomId = info.roomId;
    return {
      roomId: (info && info.roomId) || '',
      type: ((resp && resp.data) || {}).type || '',
      roomInfo: info,
      raw: resp,
    };
  }

  /**
   * 接受邀请进房。
   * ⚠️ roomId 与 inviterId 必须同时给，缺一个会被拒。
   * @param {object} o
   * @param {string} o.roomId
   * @param {string|number} o.inviterId
   * @param {string|number} [o.refer]
   * @returns {Promise<object>}
   */
  async accept(o) {
    const resp = await this.client.eapiRequest(PATHS.accept, {
      roomId: o.roomId,
      inviterId: String(o.inviterId),
      listenTogetherRefer: String(o.refer === undefined ? '1' : o.refer),
    });
    if (resp && resp.code === 200) this.roomId = o.roomId;
    return resp;
  }

  /**
   * 查房间状态（这是唯一能观测到房间成员的接口）。
   * @returns {Promise<object>}
   */
  status() {
    return this.client.eapiRequest(PATHS.status, {});
  }

  /**
   * 房间成员列表（从 status 里取）。
   * @returns {Promise<Array<object>>}
   */
  async members() {
    const info = pickRoomInfo(await this.status());
    return (info && info.roomUsers) || [];
  }

  /**
   * 是否在房间里。
   * @returns {Promise<boolean>}
   */
  async inRoom() {
    const resp = await this.status();
    return !!((resp && resp.data) || {}).inRoom;
  }

  /**
   * 读房间播放列表。
   * ⚠️ 单人房间实测恒为空对象，别据此判断"没歌"。
   * @param {string} [roomId]
   * @returns {Promise<object>}
   */
  playlist(roomId) {
    return this.client.eapiRequest(PATHS.playlist, { roomId: roomId || this.roomId });
  }

  /**
   * 心跳保活。
   * ⚠️ 四个字段缺一个就 400。
   * @param {object} [o]
   * @returns {Promise<object>}
   */
  heartbeat(o) {
    const opts = o || {};
    return this.client.eapiRequest(PATHS.heartbeat, {
      roomId: opts.roomId || this.roomId,
      songId: String(opts.songId === undefined ? '0' : opts.songId),
      playStatus: opts.playStatus || 'playing',
      progress: String(opts.progress === undefined ? DEFAULT_PROGRESS : opts.progress),
    });
  }

  /**
   * 心跳 + 房间存活判定。
   *
   * 官方客户端在**对方关房**时心跳会返回 `488`（= 已由对方结束）。
   * 这时必须清空本地 roomId，下一轮重新去收件箱找新邀请，
   * 否则会死守一个已经没了的房间。
   *
   * @param {object} [o]
   * @returns {Promise<{alive: boolean, code: number, reason: string, raw: object}>}
   */
  async heartbeatChecked(o) {
    let resp;
    try {
      resp = await this.heartbeat(o);
    } catch (e) {
      // 网络错误不判定为"房间没了"，避免抖动误清
      return { alive: true, code: 0, reason: 'network_error', raw: null, error: e };
    }
    const code = Number((resp && resp.code) || 0);
    if (code === 488) {
      return { alive: false, code: 488, reason: 'ended_by_peer', raw: resp };
    }
    if (code && code !== 200) {
      return { alive: false, code: code, reason: 'room_gone', raw: resp };
    }
    return { alive: true, code: code || 200, reason: 'ok', raw: resp };
  }

  /**
   * 上报切歌。只能切到已在房间列表里的歌。
   * @param {object} o
   * @returns {Promise<object>}
   */
  playCommand(o) {
    const opts = o || {};
    return this.client.eapiRequest(PATHS.playCommand, {
      roomId: opts.roomId || this.roomId,
      commandInfo: opts.rawCommandInfo || buildCommandInfo(opts),
    });
  }

  /**
   * 暂停 / 恢复。走同一条 play/command/report，靠 commandType 区分。
   * @param {boolean} paused
   * @param {object} [o]
   * @returns {Promise<object>}
   */
  setPaused(paused, o) {
    const opts = o || {};
    return this.playCommand({
      targetSongId: opts.songId || (opts.targetSongId || '0'),
      formerSongId: opts.songId || (opts.targetSongId || '0'),
      commandType: paused ? 'PAUSE' : 'PLAY',
      playStatus: paused ? 'PAUSE' : 'PLAY',
      roomId: opts.roomId,
    });
  }

  /**
   * 下一首 / 上一首。
   * @param {'next'|'prev'} dir
   * @param {object} [o]
   * @returns {Promise<object>}
   */
  skip(dir, o) {
    const opts = o || {};
    const songId = opts.songId || opts.targetSongId || '0';
    return this.playCommand({
      targetSongId: songId,
      formerSongId: songId,
      commandType: dir === 'prev' ? 'PREV' : 'NEXT',
      roomId: opts.roomId,
    });
  }

  /**
   * 读房间当前播放状态（播放列表 + 播放指令）。
   * 这是下行的核心：实测双人房间能读到真人的操作。
   * @param {string} [roomId]
   * @returns {Promise<{playCommand: object, list: Array, playMode: string, raw: object}>}
   */
  async current(roomId) {
    const resp = await this.playlist(roomId);
    const d = (resp && resp.data) || {};
    const pl = d.playlist || {};
    return {
      playCommand: d.playCommand || {},
      list: (pl.displayList && pl.displayList.result) || [],
      playMode: pl.playMode || '',
      version: pl.version || [],
      raw: pl,
      code: resp && resp.code,
    };
  }

  /**
   * 把歌加进房间列表。
   * 注意：加完对方可能需要重进 App 才能看到（实测经验）。
   * @param {object} o
   * @returns {Promise<object>}
   */
  addSongs(o) {
    const opts = o || {};
    return this.client.eapiRequest(PATHS.listCommand, {
      roomId: opts.roomId || this.roomId,
      playlistParam: opts.rawPlaylistParam || buildPlaylistParam(opts),
    });
  }

  /**
   * 退出/关闭房间。
   * @param {string} [roomId]
   * @returns {Promise<object>}
   */
  async end(roomId) {
    const resp = await this.client.eapiRequest(PATHS.end, { roomId: roomId || this.roomId });
    if (resp && resp.code === 200) this.roomId = '';
    return resp;
  }
}

module.exports = {
  PATHS: PATHS,
  DEFAULT_PROGRESS: DEFAULT_PROGRESS,
  DEFAULT_WAIT_MS: DEFAULT_WAIT_MS,
  DEFAULT_EFFECTIVE_MS: DEFAULT_EFFECTIVE_MS,
  buildCommandInfo: buildCommandInfo,
  buildPlaylistParam: buildPlaylistParam,
  pickRoomInfo: pickRoomInfo,
  RoomService: RoomService,
};
