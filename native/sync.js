'use strict';
/**
 * ============================================================
 *  native/sync.js — 本地播放状态 ↔ 网易云房间 双向同步引擎（P8 融合）
 * ------------------------------------------------------------
 *  ── 设计目标 ────────────────────────────────────────────────
 *  「两边互不干扰」指命令流不打架：AI 与真人的控制指令正确合流，
 *  不互相覆盖/回滚。本模块用 **单写入队列 + 时间戳仲裁** 实现。
 *
 *  ── 上行（本地 → 网易云）────────────────────────────────────
 *    webview/AI 操作 → applyLocal() → 更新本地 state
 *                                   → 节流后上报 play/command/report
 *
 *  ── 下行（网易云 → 本地）────────────────────────────────────
 *    每 POLL_INTERVAL_MS 轮询 status/get(+playlist/get) → diff
 *                                                     → 覆盖本地 state
 *                                                     → SSE 广播给 webview
 *
 *  ── ✅ 实测结论（v0.4，已推翻早前的悲观假设）────────────────
 *   房间里**有第二个成员后**，sync/playlist/get 返回完整
 *   playCommand + playlist.displayList.result，对方切歌/暂停都能读到，
 *   延迟 1–3 秒。**下行同步走 HTTP 轮询可行，无需 Agora RTC SDK。**
 *   单人房间恒返回 {"data":{}}，这是正常的，不是故障。
 *
 *  ── 本地化适配 ──────────────────────────────────────────────
 *   参考实现依赖 `require('./room.js')` 的 RoomService 实例；
 *   本地是函数式 ltapi（who+roomId 形式）。此处用 RoomAdapter 包装，
 *   对外暴露与参考 RoomService 相同的 status/playlist/playCommand/
 *   addSongs/heartbeat 方法，使 SyncEngine 逻辑零改动。
 *
 *  ⚠️ 语义修正：参考 _pushToRemote 曾发 'PLAY_SONG'/'PAUSE_SONG'，
 *     但服务端只接受 PLAY / PAUSE / GOTO / NEXT / PREV —— 已统一为 PLAY/PAUSE。
 * ============================================================
 */
const identity = require('./identity');
const ltapi = require('./ltapi');

/** 轮询间隔：需求指定 1–3 秒，取中值。 */
const POLL_INTERVAL_MS = 2000;

/** 上行节流：同一首歌的进度上报最快间隔，避免高频打接口触发风控。 */
const UPLOAD_THROTTLE_MS = 3000;

/** 心跳间隔。官方客户端约 20–30s，太慢会掉线。 */
const HEARTBEAT_INTERVAL_MS = 25000;

/**
 * 房间适配器：把本地函数式 ltapi 包成 RoomService 形态。
 * 对外方法返回**原始 eapi 响应对象**（含 .data），与参考实现一致，
 * 这样 SyncEngine._parseRemotePlaylist 无需改动。
 */
class RoomAdapter {
  /**
   * @param {string} who 'ai' | 'human'
   * @param {string} [roomId]
   */
  constructor(who, roomId) {
    this.who = who || 'ai';
    this.roomId = roomId || '';
  }

  /** 内部：带 cookie 的 eapi 请求 + 解析 */
  async _req(path, body) {
    const cookie = identity.readCookie(this.who);
    if (!cookie) throw new Error('no cookie for ' + this.who);
    const r = await ltapi.weapiPost(path, body, cookie);
    try { return JSON.parse(r.text); } catch (e) { return {}; }
  }

  /** 查房间状态（原始响应） */
  status() {
    return this._req(ltapi.PATHS.status, {});
  }

  /** 读房间播放列表（原始响应，含 data.playCommand/playlist） */
  playlist(roomId) {
    return this._req(ltapi.PATHS.playlist, { roomId: roomId || this.roomId });
  }

  /**
   * 上报播放指令。接受 {songId, targetSongId, formerSongId, commandType,
   * playStatus, progress}，内部用 buildCommandInfo 组包。
   */
  async playCommand(o) {
    const opts = o || {};
    const cmd = {
      targetSongId: opts.targetSongId !== undefined ? opts.targetSongId : opts.songId,
      formerSongId: opts.formerSongId !== undefined ? opts.formerSongId : (opts.targetSongId !== undefined ? opts.targetSongId : opts.songId),
      commandType: opts.commandType || 'GOTO',
      playStatus: opts.playStatus || 'PLAY',
      progress: opts.progress || 0,
    };
    const r = await ltapi.reportCommand(this.who, opts.roomId || this.roomId, cmd);
    if (!r.ok) throw new Error(r.message || 'reportCommand failed');
    return r;
  }

  /** 加歌进房间列表（读-去重-整单 REPLACE）
   *  ⚠️ 同步引擎内默认关闭 verify（避免每首阻塞数秒），仅幂等记录 */
  addSongs(o) {
    const opts = o || {};
    return ltapi.addSongs(this.who, opts.roomId || this.roomId, opts.songIds || [], {
      dedupe: opts.dedupe,
      verify: opts.verify === true,
    });
  }

  /** 心跳 */
  heartbeat(o) {
    return ltapi.heartbeat(this.who, o && o.roomId ? o.roomId : this.roomId, o || {});
  }
}

/**
 * 当前实时进度。
 * @param {object} st {playing, positionMs, anchorTs}
 * @returns {number}
 */
function currentPos(st) {
  if (!st.playing || !st.anchorTs) return st.positionMs;
  return st.positionMs + (Date.now() - st.anchorTs);
}

/**
 * 把本地状态归一化成可比较的签名，用于 diff 判断是否需要上报。
 * @param {object} st
 * @returns {string}
 */
function stateSignature(st) {
  const songId = st.song ? String(st.song.id) : '';
  // 进度只取 5 秒粒度，避免每毫秒都判定为"变了"
  const bucket = Math.floor(currentPos(st) / 5000);
  return [songId, st.playing ? '1' : '0', bucket].join('|');
}

/**
 * 同步引擎。
 */
class SyncEngine {
  /**
   * @param {object} options
   * @param {RoomAdapter} options.room 房间适配器
   * @param {object} options.state 共享的本地状态对象（就地修改）
   * @param {(event: string, data: object) => void} [options.broadcast] SSE 广播回调
   * @param {(msg: string) => void} [options.log]
   */
  constructor(options) {
    const o = options || {};
    this.room = o.room;
    this.state = o.state;
    this.broadcast = o.broadcast || function () {};
    this.log = o.log || function () {};
    this.pollTimer = null;
    this.hbTimer = null;
    this.lastUploadAt = 0;
    this.lastSignature = '';
    this.uploadQueue = Promise.resolve(); // 单写入队列：保证命令串行，避免互相覆盖
    this._knownSongIds = new Set();
    this.consecutiveErrors = 0;
    this.stats = { polls: 0, uploads: 0, remoteApplied: 0, errors: 0 };
  }

  /* ------------------------------------------------------------ 上行 */

  /**
   * 本地发生变更（webview 或 AI 操作）→ 更新状态并上报网易云。
   * 走队列串行，保证 AI 与真人同时操作时不会交叉覆盖。
   * @param {object} change {action, song, position, by, autoplay}
   * @returns {Promise<void>}
   */
  applyLocal(change) {
    const self = this;
    this.uploadQueue = this.uploadQueue.then(function () {
      return self._applyLocalInner(change);
    }).catch(function (e) {
      self.stats.errors += 1;
      self.log('[sync] 上报失败: ' + ((e && e.message) || e));
    });
    return this.uploadQueue;
  }

  /**
   * @private
   */
  async _applyLocalInner(change) {
    const st = this.state;
    const now = Date.now();

    switch (change.action) {
      case 'play':
        st.playing = true;
        if (typeof change.position === 'number') st.positionMs = change.position;
        st.anchorTs = now;
        break;
      case 'pause':
        st.positionMs = currentPos(st);
        st.playing = false;
        break;
      case 'seek':
        st.positionMs = Math.max(0, Number(change.position) || 0);
        st.anchorTs = now;
        break;
      case 'load':
        st.song = change.song;
        st.positionMs = typeof change.position === 'number' ? change.position : 0;
        st.anchorTs = now;
        st.playing = change.autoplay !== false;
        // 新歌必须先加入房间列表，否则 playCommand 会被服务端忽略
        if (change.song && change.song.id) {
          await this._addIfMissing(change.song.id);
        }
        break;
      default:
        break;
    }

    st.seq = (st.seq || 0) + 1;
    st.updatedAt = now;
    st.updatedBy = change.by || 'local';

    await this._pushToRemote(change);
    this.broadcast('sync', this.snapshot());
  }

  /**
   * 加歌进房间列表（幂等：已在列表里就跳过）。
   * @private
   */
  async _addIfMissing(songId) {
    const id = String(songId);
    if (this._knownSongIds.has(id)) return;
    try {
      await this.room.addSongs({ songIds: [id] });
      this._knownSongIds.add(id);
      this.stats.uploads += 1;
    } catch (e) {
      this.log('[sync] 加歌失败 songId=' + id + ' ' + ((e && e.message) || e));
    }
  }

  /**
   * 把当前状态上报给网易云房间。
   * @private
   */
  async _pushToRemote(change) {
    const st = this.state;
    const now = Date.now();
    const songId = st.song ? String(st.song.id) : '0';
    const progress = Math.round(currentPos(st));

    // 节流：进度类上报太频繁会被风控，且没有意义
    const isStructural = change.action === 'load' || change.action === 'play' || change.action === 'pause';
    if (!isStructural && now - this.lastUploadAt < UPLOAD_THROTTLE_MS) return;

    try {
      // ⚠️ 服务端只接受 PLAY / PAUSE / GOTO / NEXT / PREV（参考实现曾用
      //    PLAY_SONG/PAUSE_SONG，是非法值，会静默失败 —— 此处已修正）
      await this.room.playCommand({
        songId: songId,
        progress: progress,
        commandType: st.playing ? 'PLAY' : 'PAUSE',
        playStatus: st.playing ? 'PLAY' : 'PAUSE',
      });
      this.lastUploadAt = now;
      this.stats.uploads += 1;
    } catch (e) {
      this.stats.errors += 1;
      this.log('[sync] playCommand 失败: ' + ((e && e.message) || e));
    }
  }

  /* ------------------------------------------------------------ 下行 */

  /**
   * 轮询一次远端状态并合并到本地。
   * @returns {Promise<boolean>} 是否发生了远端变更
   */
  async pollOnce() {
    this.stats.polls += 1;
    let status;
    try {
      status = await this.room.status();
    } catch (e) {
      this.consecutiveErrors += 1;
      this.stats.errors += 1;
      this.log('[sync] status 轮询失���: ' + ((e && e.message) || e));
      return false;
    }
    this.consecutiveErrors = 0;

    const data = (status && status.data) || {};
    const info = data.roomInfo || {};

    // 房间没了（被对方关掉 / 自己掉线）
    if (data.inRoom === false) {
      this.broadcast('native_room', { inRoom: false, reason: '已退出房间' });
      return false;
    }

    this.broadcast('native_room', {
      inRoom: true,
      roomId: info.roomId,
      members: info.roomUsers || [],
      status: data.status || '',
    });

    // 尝试读远端播放状态（歌曲 + 列表 + 播放/暂停）
    let changed = false;
    try {
      const pl = await this.room.playlist();
      const remote = this._parseRemotePlaylist(pl);
      if (remote) changed = this._mergeRemote(remote);
    } catch (e) {
      this.log('[sync] playlist 轮询失败: ' + ((e && e.message) || e));
    }
    return changed;
  }

  /**
   * 从 playlist/get 响应里解析远端播放状态。
   * ⚠️ 真实结构：data.playCommand + data.playlist.displayList.result。
   * 单人房间时 data 为 {}，必须容错。
   * @private
   * @returns {object|null}
   */
  _parseRemotePlaylist(resp) {
    const d = (resp && resp.data) || {};
    if (!Object.keys(d).length) return null; // 单人房间：空

    const pc = d.playCommand || {};
    const pl = d.playlist || {};
    const list = (pl.displayList && pl.displayList.result) || [];
    const currentSongId = pc.targetSongId !== undefined && pc.targetSongId !== null
      ? String(pc.targetSongId)
      : (list.length ? String(list[0]) : '');

    if (!currentSongId && !list.length) return null;
    return {
      currentSongId: currentSongId,
      list: list.map(String),
      playStatus: pc.playStatus || '',
      commandType: pc.commandType || '',
      seq: Number(pc.serverSeq) || 0,
      playMode: pl.playMode || '',
      userId: pc.userId !== undefined ? String(pc.userId) : '',
    };
  }

  /**
   * 把远端歌单差异合并进本地状态。
   * 仲裁规则：远端进度领先时以远端为准；本地刚操作过（1.5s 内）则忽略远端，
   * 避免"自己刚切完歌，轮询又把旧状态打回来"的抖动。
   * @private
   */
  _mergeRemote(remote) {
    const st = this.state;
    if (Date.now() - this.lastUploadAt < 1500) return false;

    const rid = remote.currentSongId;
    if (!rid) return false;

    const localId = st.song ? String(st.song.id) : '';
    const songChanged = rid !== localId;

    // 播放/暂停也要跟随远端（真人在官方客户端按了暂停）
    const wantPlaying = remote.playStatus ? remote.playStatus === 'PLAY' : st.playing;
    const playChanged = wantPlaying !== st.playing;

    if (!songChanged && !playChanged) return false;

    if (songChanged) {
      st.song = { id: rid, name: '', artist: '', album: '', pic: '', duration: 0 };
      st.positionMs = 0;
    }
    if (playChanged) {
      st.playing = wantPlaying;
    }
    st.anchorTs = Date.now();
    st.seq = (st.seq || 0) + 1;
    st.updatedAt = Date.now();
    st.updatedBy = 'remote:' + (remote.userId || 'peer');
    this.stats.remoteApplied += 1;

    this.broadcast('sync', this.snapshot());
    if (songChanged) {
      this.broadcast('song_change', {
        song: st.song, playing: st.playing, positionMs: st.positionMs, by: 'remote',
      });
    }
    return true;
  }

  /* ------------------------------------------------------- 定时器 */

  /** 启动轮询 + 心跳。 */
  start() {
    const self = this;
    if (!this.pollTimer) {
      this.pollTimer = setInterval(function () {
        self.pollOnce().catch(function (e) {
          self.log('[sync] pollOnce 异常: ' + ((e && e.message) || e));
        });
      }, POLL_INTERVAL_MS);
    }
    if (!this.hbTimer) {
      this.hbTimer = setInterval(function () {
        self.room.heartbeat({
          songId: self.state.song ? self.state.song.id : '0',
          progress: Math.round(currentPos(self.state)),
          playStatus: self.state.playing ? 'playing' : 'paused',
        }).catch(function (e) {
          self.log('[sync] 心跳失败: ' + ((e && e.message) || e));
        });
      }, HEARTBEAT_INTERVAL_MS);
    }
    this.log('[sync] 已启动，轮询 ' + POLL_INTERVAL_MS + 'ms / 心跳 ' + HEARTBEAT_INTERVAL_MS + 'ms');
  }

  /** 停止定时器（退出房间时调用）。 */
  stop() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
    this.log('[sync] 已停止');
  }

  /**
   * 给 webview / SSE 用的状态快照。
   * @returns {object}
   */
  snapshot() {
    const st = this.state;
    return {
      type: 'state',
      song: st.song,
      playing: st.playing,
      positionMs: currentPos(st),
      seq: st.seq,
      updatedBy: st.updatedBy,
      native: true,
    };
  }
}

module.exports = {
  POLL_INTERVAL_MS: POLL_INTERVAL_MS,
  UPLOAD_THROTTLE_MS: UPLOAD_THROTTLE_MS,
  HEARTBEAT_INTERVAL_MS: HEARTBEAT_INTERVAL_MS,
  currentPos: currentPos,
  stateSignature: stateSignature,
  RoomAdapter: RoomAdapter,
  SyncEngine: SyncEngine,
};