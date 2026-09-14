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
 *   ✅ sync/list/command/report（加歌）      **v0.4 已跑通**，见下
 *   ✅ 整单替换（换歌单）                     **v0.4 已跑通**
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
 *   ✅ **加歌/换歌单（v0.4 已跑通）**：走 sync/list/command/report，
 *      载荷是 **commandType:'REPLACE' + 完整 displayList**（不是 ADD 增量）。
 *      旧实现用 operationType:'ADD' 是**错的语义**，所以一直假成功。
 *      详见 buildPlaylistParam 的注释。
 *
 *   ⚠️ **playCommand 的读取路径**：在 `data.playCommand`，
 *      **不在** `data.playlist.playCommand`。读错位置会永远拿到 undefined。
 *
 *   ⚠️ `result:true` 不代表性变更成功；必须**回读 playlist/get 做 diff** 才作数。
 *
 *   ⚠️ 心跳接口名在官方是拼错的 `heatbeat`，但 eapi 路径实测为
 *      `heartbeat`（本项目验证可用）；对方关房时心跳会返回 **488**
 *      （= 已由对方结束）→ 应清空本地 roomId 重找邀请。
 *
 *   roomInfo 里的 agoraChannelId 说明**语音**走 Agora；**房间内文字发言**
 *   实测可走 HTTP（`/api/middle/im/chatroom/send`，见 message.js），
 *   但**读取**房间聊天历史无 HTTP 接口。**播放状态同步是纯 HTTP**。
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
 * 构造播放列表变更指令（JSON 字符串）。
 *
 * ✅ v0.4 已跑通 —— 这是「加减歌」的唯一正确形态。
 *
 * ⚠️ 核心认知：**房间列表没有"加一首"的语义**，只有
 *    「用一份完整列表 REPLACE 掉旧的」。想加歌 = 读当前列表 → 追加 → 整份发回。
 *
 * 官方客户端抓包得到的真实载荷（Frida hook okhttp Request$Builder.build）：
 *   {
 *     "anchorPosition": 2,
 *     "anchorSongId": "3395220104",
 *     "clientSeq": 1789389529015,
 *     "commandType": "REPLACE",          <- 关键：REPLACE，不是 ADD
 *     "displayList": ["...完整列表..."],   <- 关键：必须全量
 *     "randomList": [],
 *     "version": [{"userId":10000000002,"version":10}]   <- 取现值直接回传
 *   }
 *
 * 旧实现（v0.3，❌ 从未生效）用的是：
 *   { operationType:'ADD', songIds:[id], clientSeq, clientTime }
 *   —— 语义错了（ADD 增量），所以服务端一律假成功 result:true。
 *
 * 实测验证（双账号真机）：
 *   15 → 17 首（追加 2 首）   ✅
 *   17 → 77 首（整单替换）    ✅ 真人客户端刷新手看到
 *
 * @param {object} o
 * @param {Array<string|number>} o.displayList 完整歌单（必须全量！）
 * @param {Array<{userId:number,version:number,outerId?:*}>} o.version 当前版本数组
 * @param {string|number} [o.anchorSongId] 锚点歌（默认取列表最后一首）
 * @param {number} [o.anchorPosition] 锚点下标（默认取列表最后一个下标）
 * @returns {string}
 */
function buildPlaylistParam(o) {
  const t = stamp();
  const list = (o.displayList || []).map(String);
  const anchorSongId = o.anchorSongId != null
    ? String(o.anchorSongId)
    : (list.length ? list[list.length - 1] : '');
  const anchorPosition = o.anchorPosition != null
    ? o.anchorPosition
    : Math.max(0, list.length - 1);
  return JSON.stringify({
    anchorPosition: anchorPosition,
    anchorSongId: anchorSongId,
    clientSeq: t,
    commandType: o.commandType || 'REPLACE',
    displayList: list,
    randomList: [],
    // version 直接回传服务端当前值即可（实测无需 +1）
    version: o.version || [],
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
   *
   * ⚠️ 路径坑：`playCommand` 在 **`data.playCommand`**，
   *    不在 `data.playlist.playCommand`。读错会永远拿到 undefined。
   *
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
      rawData: d,
      code: resp && resp.code,
    };
  }

  /**
   * 把歌**加进**房间列表（v0.4 已跑通）。
   *
   * 实现方式：读当前列表 → 追加新歌 → 整份 REPLACE 回去。
   * 因为房间列表没有"加一首"的语义，只有全量替换。
   *
   * @param {object} o
   * @param {Array<string|number>} o.songIds 要追加的歌
   * @param {string} [o.roomId]
   * @param {boolean} [o.dedupe=true] 已在列表里的歌是否跳过
   * @returns {Promise<{resp: object, before: number, after: number, added: Array<string>}>}
   */
  async addSongs(o) {
    const opts = o || {};
    const roomId = opts.roomId || this.roomId;
    const cur = await this.current(roomId);
    const before = cur.list.map(String);
    const incoming = (opts.songIds || []).map(String);
    const dedupe = opts.dedupe !== false;
    const fresh = dedupe ? incoming.filter((id) => !before.includes(id)) : incoming;

    if (!fresh.length) {
      return { resp: null, before: before.length, after: before.length, added: [] };
    }

    const displayList = before.concat(fresh);
    const resp = await this.replaceList({
      roomId: roomId,
      displayList: displayList,
      version: cur.version,
      anchorSongId: fresh[fresh.length - 1],
      anchorPosition: displayList.length - 1,
    });
    return { resp: resp, before: before.length, after: displayList.length, added: fresh };
  }

  /**
   * 用一份**完整列表**替换房间歌单（v0.4 已跑通）。
   * 「换歌单」和「加歌」都走这个方法。
   *
   * ⚠️ 返回 `result:true` **不代表生效** —— 必须回读 `current()` 比对长度才作数。
   *
   * @param {object} o
   * @param {Array<string|number>} o.displayList 完整列表（全量）
   * @param {Array} [o.version] 当前 version 数组（不传会自动读一次）
   * @param {string} [o.roomId]
   * @returns {Promise<object>}
   */
  async replaceList(o) {
    const opts = o || {};
    const roomId = opts.roomId || this.roomId;
    let version = opts.version;
    if (!version) {
      const cur = await this.current(roomId);
      version = cur.version;
    }
    return this.client.eapiRequest(PATHS.listCommand, {
      roomId: roomId,
      playlistParam: opts.rawPlaylistParam || buildPlaylistParam({
        displayList: opts.displayList,
        version: version,
        anchorSongId: opts.anchorSongId,
        anchorPosition: opts.anchorPosition,
      }),
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
