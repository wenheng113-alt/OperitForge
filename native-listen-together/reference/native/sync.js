'use strict';
/**
 * 本地播放状态 ↔ 网易云房间 的双向同步引擎（轮询方案）。
 *
 * ⚠️ 参考实现，尚未接入 server.js。
 *
 * ── 设计目标（对应需求 Q1 答案 = a）────────────────────────────
 * 「两边互不干扰」指：命令流不打架。AI 与真人的控制指令正确合流，
 * 不会互相覆盖/回滚。本模块用 **单写入队列 + 时间戳仲裁** 实现。
 *
 * ── 上行（本地 → 网易云）────────────────────────────────────
 *   webview/AI 操作 → applyLocal() → 更新本地 state
 *                                  → 节流后上报 play/command/report
 *
 * ── 下行（网易云 → 本地）────────────────────────────────────
 *   每 POLL_INTERVAL_MS 轮询 status/get（+ playlist/get）→ diff
 *                                                     → 覆盖本地 state
 *                                                     → SSE 广播给 webview
 *
 * ── ⚠️ 未验证的关键假设（必须先用双账号实测）──────────────────
 *   实测：房间里**只有自己**时，sync/playlist/get 恒返回空 `{"data":{}}`，
 *   status/get 的 data.status 为 "NOT_CONNECTED"。
 *   试过 roomId / all / needAll / cursor 参数组合，都为空。
 *
 *   假设：**房间里有第二个真实成员后**，playlist/get 才会填充歌单。
 *   若假设成立 → 本模块的下行可用。
 *   若假设不成立 → 下行在 HTTP 层**根本无法观测**（实时同步走 Agora RTC，
 *     roomInfo.agoraChannelId 是证据），此时只能：
 *      (a) 集成 Agora RTC SDK（引入原生依赖，破坏零依赖）
 *      (b) 降级为「AI 只上报、不感知真人操作」
 *   在双账号实测前，不要对外承诺模式 2 的完整双向同步。
 */

const { PATHS } = require('./room.js');

/** 轮询间隔：需求指定 1–3 秒，取中值。 */
const POLL_INTERVAL_MS = 2000;

/** 上行节流：同一首歌的进度上报最快间隔，避免高频打接口触发风控。 */
const UPLOAD_THROTTLE_MS = 3000;

/** 心跳间隔。官方客户端约 20–30s，太慢会掉线。 */
const HEARTBEAT_INTERVAL_MS = 25000;

/**
 * 播放状态机的形状（与 server.js 现有 state 对齐，便于替换）。
 * @typedef {object} PlayState
 * @property {object|null} song
 * @property {boolean} playing
 * @property {number} positionMs
 * @property {number} anchorTs
 * @property {number} seq
 */

/**
 * 当前实时进度。
 * @param {PlayState} st
 * @returns {number}
 */
function currentPos(st) {
  if (!st.playing || !st.anchorTs) return st.positionMs;
  return st.positionMs + (Date.now() - st.anchorTs);
}

/**
 * 把本地状态归一化成可比较的签名，用于 diff 判断是否需要上报。
 * @param {PlayState} st
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
   * @param {import('./room.js').RoomService} options.room
   * @param {PlayState} options.state 共享的本地状态对象（就地修改）
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
    this.consecutiveErrors = 0;
    this.stats = { polls: 0, uploads: 0, remoteApplied: 0, errors: 0 };
  }

  /* ------------------------------------------------------------ 上行 */

  /**
   * 本地发生变更（webview 或 AI 操作）→ 更新状态并上报网易云。
   * 走队列串行，保证 AI 与真人同时操作时不会交叉覆盖。
   * @param {object} change {action, song, position, by}
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
    if (this._knownSongIds && this._knownSongIds.has(id)) return;
    try {
      await this.room.addSongs({ songIds: [id] });
      if (!this._knownSongIds) this._knownSongIds = new Set();
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
      await this.room.playCommand({
        songId: songId,
        progress: progress,
        commandType: st.playing ? 'PLAY_SONG' : 'PAUSE_SONG',
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
      this.log('[sync] status 轮询失败: ' + ((e && e.message) || e));
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
   *
   * ⚠️ 实测（2026-09 真机双人房间）：真实结构是
   *   data.playCommand = { commandType, targetSongId, formerSongId,
   *                        playStatus, progress, serverSeq, userId, anotherUid }
   *   data.playlist.displayList.result = [songId...]   // 注意是 displayList.result
   * 单人房间时 data 为 {}（空），所以必须容错。
   *
   * @private
   * @returns {{currentSongId: string, list: string[], playStatus: string,
   *            commandType: string, seq: number, playMode: string}|null}
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
      const meta = this._knownMeta && this._knownMeta.get(rid);
      st.song = meta || { id: rid, name: '', artist: '', album: '', pic: '', duration: 0 };
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
  SyncEngine: SyncEngine,
};
