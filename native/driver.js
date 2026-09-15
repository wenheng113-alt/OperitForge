'use strict';
/**
 * ============================================================
 *  原生一起听驱动（Native Listen-Together Driver）
 * ------------------------------------------------------------
 *  P3/P4 已落地：真实接入网易云「一起听」房间。
 *
 *  2026 实测（见 native/ltapi.js 注释）：
 *    - 建房/进房、房间状态回读、播放指令下发均走 REST（weapi 加密），
 *      **无需 WebSocket/云信长连接**（云信仅用于房间内文字聊天 P5）。
 *
 *  设计目标：
 *    - server.js 的 /control 是天然分流口；
 *    - 本地模式（local）下 state 就是唯一真相，老逻辑一行不动；
 *    - 接入模式（duo / solo_ai）下，房间真相在网易云服务器，
 *      本地 state 退化为「缓存」，由本驱动负责：
 *        ① 向下：把 /control 的动作翻译成原生协议指令（P3，已实现）
 *        ② 向上：把原生房间状态回读进 state（P4，已实现）
 *        ③ 侧车：房间聊天「读」走云信长连接（P5，预留）
 *
 *  依赖注入（由 server.js 调用 init 时传入），避免循环 require：
 *    init({ snapshot, pushState, broadcast, log })
 * ============================================================
 */

/* P2: 双 cookie 身份存取（0600 落盘 + 脱敏） */
const identity = require('./identity');
/* P3: 一起听 REST 协议客户端 */
const ltapi = require('./ltapi');
/* P9q: IM 直发通道（与官方 APP 同源），用于绕开 HTTP 直接下发 PlayCommandMsg */
const imLib = require('./im');
const fs = require('fs');
const path = require('path');

/* P9h: clientSeq 高水位持久化 —— 网易云 APP 按 clientSeq 单调递增去重，
 * 若进程重启后计数回退，新指令会被 APP 当作过期指令静默忽略。
 * 这里把"用过的最大序号"落盘，重启后从该值继续，保证永远递增。 */
const _SEQ_STORE = path.join(__dirname, '..', '.clientseq.json');
function _loadSeqHi() {
  try { return Number(JSON.parse(fs.readFileSync(_SEQ_STORE, 'utf8')).hi) || 0; } catch (e) { return 0; }
}
function _saveSeqHi(v) {
  try { fs.writeFileSync(_SEQ_STORE, JSON.stringify({ hi: Number(v) || 0 }), { mode: 0o600 }); } catch (e) {}
}

/** 合法的接入模式 */
const MODES = ['local', 'duo', 'solo_ai'];

/** 模式 → 所需身份（能力矩阵） */
const MODE_NEEDS = {
  local: [],
  duo: ['ai', 'human'],
  solo_ai: ['ai'],
};

function createDriver() {
  let deps = null;

  const status = {
    mode: 'local',
    enabled: false,
    connected: false,
    roomId: null,
    lastError: null,
    lastSyncTs: 0,
    forwarded: 0,     // 已转发到驱动的 /control 次数
    /* P2: 身份就绪快照（脱敏） */
    identity: null,
    /* P3: 云信/声网房间附属信息（聊天通道用，暂只回显） */
    chatRoomId: null,
    agoraChannelId: null,
    creatorId: null,
    /* P5: 登录账号资料（含头像），接入成功后回读 */
    account: null,
    /* P5: 双身份账号资料（ai/human），前端「两边头像都取」用 */
    accounts: null,
    /* P3: 指令序号（服务端幂等用，单调递增；P9h: 从持久化高水位起步，防重启回退） */
    clientSeq: _loadSeqHi(),
    /* P7: 下行同步仲裁 —— 上次上行时间 + 上次已应用的远端 seq（去重） */
    lastUploadAt: 0,
    lastRemoteSeq: 0,
    lastRemote: null,
    remotePlaylist: [],
    /* P4/P5 预留 */
    syncTimer: null,
    chatListener: null,
  };

  function log() {
    if (deps && typeof deps.log === 'function') {
      deps.log.apply(null, arguments);
    }
  }
  function snapshotOf() {
    try { return deps && deps.snapshot ? deps.snapshot() : null; } catch (e) { return null; }
  }

  return {
    MODES: MODES,

    /** 注入宿主依赖 */
    init(d) {
      deps = d || null;
      log('driver init, deps=' + Object.keys(deps || {}).join(','));
      return this;
    },
    /** 当前驱动状态（供 /mode GET 返回）*/
    status() {
      return {
        mode: status.mode,
        enabled: status.enabled,
        connected: status.connected,
        roomId: status.roomId,
        chatRoomId: status.chatRoomId,
        agoraChannelId: status.agoraChannelId,
        creatorId: status.creatorId,
        account: status.account,
        accounts: status.accounts,
        remoteUsers: status.remoteUsers || [],
        /* P9l: 暴露房间歌单镜像（最近一次 syncOnce 的 displayList），
         * 供 pushSongToRoom 免去「先慢读列表」的 8s 阻塞。 */
        remotePlaylist: status.remotePlaylist || [],
        lastError: status.lastError,
        lastSyncTs: status.lastSyncTs,
        forwarded: status.forwarded,
        identity: identity.status(),
        needs: MODE_NEEDS[status.mode] || [],
      };
    },

    /* ================= P2: 身份（cookie）管理 ================= */
    /** 导入某身份 cookie（who: 'ai'|'human'） */
    importCookie(who, cookie) {
      if (identity.WHOS.indexOf(who) < 0) throw new Error('bad who: ' + who);
      const st = identity.saveCookie(who, cookie);
      log('importCookie', who, 'ok, len=' + st.len);
      return { ok: true, who: who, status: st };
    },
    /** 双身份脱敏状态 */
    cookieStatus() {
      return identity.status();
    },
    /** 读取明文（仅内部/工具用，返回时不做脱敏） */
    readCookie(who) {
      return identity.readCookie(who);
    },
    /** 清除某身份 cookie */
    clearCookie(who) {
      if (who && identity.WHOS.indexOf(who) < 0) throw new Error('bad who: ' + who);
      if (who) return identity.clearCookie(who);
      const r = {};
      identity.WHOS.forEach(function (w) { r[w] = identity.clearCookie(w); });
      return r;
    },
    /** 指定模式所需身份是否齐备，返回缺失列表 */
    missingFor(mode) {
      const need = MODE_NEEDS[mode] || [];
      const have = identity.status();
      return need.filter(function (w) { return !have[w] || !have[w].present; });
    },


    /** 仅同步内部 mode（用于外部切换失败后的状态回滚，无任何副作用） */
    syncMode(m) {
      if (MODES.indexOf(m) >= 0) { status.mode = m; status.enabled = (m !== 'local'); }
      return this.status();
    },

    /**
     * 切到某个接入模式。
     * - local  → 停驱动，回到纯本地
     * - duo    → 真人一起听（需要一个真人 cookie + AI 自己的 cookie）
     * - solo_ai→ 仅 AI 伴听（只需 AI 自己的 cookie）
     */
    async start(mode) {
      if (MODES.indexOf(mode) < 0) throw new Error('bad mode: ' + mode);
      if (mode === 'local') return this.stop();

      status.mode = mode;
      status.enabled = true;
      status.lastError = null;
      log('start requested, mode=' + mode + ' (P2：身份已接入，协议连接待 P3/P4)');

      /* P2: 校验该模式所需身份（cookie）是否齐备 */
      const missing = this.missingFor(mode);
      status.identity = identity.status();
      if (missing.length) {
        status.lastError = '缺少 cookie：' + missing.join('、') + '（请在设置面板导入）';
        status.connected = false;
        log('start blocked, missing cookie:', missing.join(','));
        const st = this.status();
        st.missing = missing;
        st.ok = false;
        return st;
      }

      /* P3: 用 AI 身份 cookie 真实建房/进房，拿到 roomId → connected=true
       * P8-fix: 建房可能因网络抖动 timeout（实测启动时偶发 → connected=false，
       *         导致后续切歌/发言全部「未接入房间」静默失败）。这里最多重试 3 次。 */
      try {
        let res = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            res = await ltapi.createRoom('ai');
          } catch (e) {
            res = { ok: false, message: String((e && e.message) || e) };
          }
          if (res && res.ok && res.roomId) break;
          log('P3 createRoom attempt ' + attempt + ' failed: ' + (res && res.message || 'unknown'));
          if (attempt < 3) await new Promise(function (r) { setTimeout(r, 800 * attempt); });
        }
        if (!res || !res.ok || !res.roomId) {
          status.connected = false;
          status.lastError = '建房失败：' + (res.message || '未知错误');
          log('P3 createRoom failed:', status.lastError);
          const st = this.status();
          st.missing = [];
          st.ok = false;
          return st;
        }
        const info = res.roomInfo || {};
        status.roomId = res.roomId;
        status.chatRoomId = info.chatRoomId || null;
        status.agoraChannelId = info.agoraChannelId || null;
        status.creatorId = info.creatorId || null;
        status.connected = true;
        status.lastSyncTs = Date.now();
        log('P3 room ready:', res.roomId, 'type=' + (res.type || ''), 'users=' + ((info.roomUsers || []).length));
        /* P4: 启动房间状态回读轮询（每 5s 校准本地缓存） */
        this._startSync();
        /* P5: 回读登录账号资料（ai+human 双头像），异步广播，不阻塞接入返回。
         * 注意：duo 模式下 bringHumanIn 需要用到双账号 userId，必须等它完成，
         * 否则会因 status.accounts 为空而返回 step:'accounts'（重启恢复场景实测踩到）。 */
        if (mode === 'duo') {
          await this._loadAccounts();
        } else {
          this._loadAccounts();
        }
        /* P6: duo 模式 → 建房后自动把真人编排进同一房间（只发邀请，accept 留给真人 APP） */
        if (mode === 'duo') {
          try {
            const jr = await this.bringHumanIn();
            log('P6 auto bringHumanIn:', JSON.stringify(jr).slice(0, 220));
            this._autoJoin = jr;
          } catch (e) { log('P6 auto bringHumanIn error:', String((e && e.message) || e)); }
        }
      } catch (e) {
        status.connected = false;
        status.lastError = '建房异常：' + String((e && e.message) || e);
        log('P3 createRoom error:', status.lastError);
        const st = this.status();
        st.missing = [];
        st.ok = false;
        return st;
      }

      const st = this.status();
      st.missing = [];
      st.ok = true;
      st.note = 'P3：已接入一起听房间（roomId=' + status.roomId + '）';
      return st;
    },

    /** P4: 启动/重启房间状态回读轮询
     *  P7: 由 5s 收紧到 2s（对齐参考实现 POLL_INTERVAL_MS），让下行同步足够实时。 */
    _startSync() {
      if (status.syncTimer) { clearInterval(status.syncTimer); status.syncTimer = null; }
      const self = this;
      status.syncTimer = setInterval(function () { self.syncOnce(); }, 2000);
      /* P9h: 先回读一次房间 clientSeq 对齐本地计数，再启动轮询。
       * 否则重启后首条指令用的是归零后的 1，会被 APP 当过期指令忽略。 */
      Promise.resolve()
        .then(function () { return self.syncOnce(); })
        .catch(function () {})
        .then(function () { self.syncOnce(); });
    },

    /** P5: 回读登录账号资料（头像）→ 写入 status 并广播 native_account
     *  2026 扩展：同时回读 ai 与 human 两个身份，供前端「两边头像都取」。
     *  前端映射：ai → 好友位(avby)、human → 用户位(avme)。 */
    async _loadAccounts() {
      try {
        const accounts = {};
        const whos = ['ai', 'human'];
        await Promise.all(whos.map(async function (w) {
          try {
            const r = await ltapi.userAccount(w);
            if (r.ok) accounts[w] = { userId: r.userId, nickname: r.nickname || '', avatarUrl: r.avatarUrl || '' };
          } catch (e) { log('P5 userAccount(' + w + ') error:', String((e && e.message) || e)); }
        }));
        status.accounts = accounts;
        if (accounts.ai) status.account = accounts.ai;
        log('P5 accounts loaded: ai=' + (accounts.ai && accounts.ai.userId) + ' human=' + (accounts.human && accounts.human.userId));
        if (deps && deps.broadcast) {
          try { deps.broadcast('native_account', { account: status.account, accounts: accounts, ts: Date.now() }); } catch (e) {}
        }
        return accounts;
      } catch (e) {
        log('P5 _loadAccounts error:', String((e && e.message) || e));
        return null;
      }
    },

    /** P6: 把真人身份编排进 AI 当前房间（duo 业务流核心）
     *  顺序（2026 实测通关链）：AI 邀请 human → human 若已有自己的房先退房 → human accept → 双方 statusGet=CONNECTED
     *  返回 {ok, step, roomId, users, message} */
    async bringHumanIn(opts) {
      /* P6-fix: autoAccept 默认 false —— 只发邀请、把"接受"留给真人 APP 点卡。
       * 2026 实测：服务端若用 human cookie 代 accept，会立刻消费掉邀请卡
       * （invitationInfo display:true → accept 后 display:false），真人 APP 再点即"失效"。
       * 仅无人值守自检时才传 { autoAccept: true } 由服务端代 accept。 */
      const autoAccept = !!(opts && opts.autoAccept);
      if (!status.connected || !status.roomId) {
        return { ok: false, step: 'precheck', message: '尚未建房（connected=false）' };
      }
      let roomId = status.roomId;
      try {
        const aiAcc = status.accounts && status.accounts.ai;
        const huAcc = status.accounts && status.accounts.human;
        if (!aiAcc || !huAcc) return { ok: false, step: 'accounts', message: '双账号资料未就绪，请稍后重试' };
        const aiUid = aiAcc.userId, huUid = huAcc.userId;

        /* 1) AI 发起邀请（ltType=1，实测唯一可通过的类型；默认值已是 1） */
        let inv = await ltapi.inviteSend('ai', roomId, huUid);
        log('P6 invite ai→human:', JSON.stringify(inv).slice(0, 200));

        /* 1b) 自愈：旧房已失效（如重启后从 state.json 恢复的过期房）→ AI 退旧房、重建新房、重试邀请。
         *     注意 createRoom 在已占房时只会回 ALREADY_IN_ROOM（拿到同一旧房），必须先 endRoom 才能拿到 NEW_ROOM。 */
        if (!inv.ok) {
          log('P6 invite failed, self-heal: end old + recreate. reason=' + (inv.message || ''));
          try { await ltapi.endRoom('ai', roomId); } catch (e) {}
          const nr = await ltapi.createRoom('ai');
          if (nr.ok && nr.roomId) {
            roomId = nr.roomId;
            const info = nr.roomInfo || {};
            status.roomId = roomId;
            status.chatRoomId = info.chatRoomId || status.chatRoomId;
            status.agoraChannelId = info.agoraChannelId || status.agoraChannelId;
            status.creatorId = info.creatorId || status.creatorId;
            status.connected = true;
            status.lastSyncTs = Date.now();
            log('P6 recreated room:', roomId, 'type=' + (nr.type || ''));
            if (deps && deps.pushState) { try { deps.pushState('native_recreate'); } catch (e) {} }
            inv = await ltapi.inviteSend('ai', roomId, huUid);
            log('P6 invite retry:', JSON.stringify(inv).slice(0, 200));
          }
        }
        if (!inv.ok) return { ok: false, step: 'invite', roomId: roomId, message: inv.message || 'invite failed' };

        /* 3) autoAccept 时才由服务端代真人 accept；
         *    默认只发邀请，把"接受"留给真人 APP 点卡（避免消费掉邀请卡）。 */
        let acc = { ok: true, skipped: true };
        if (autoAccept) {
          /* 真人若已有自己的房间，先退房（否则 accept 会返回 ALREADY_IN_ROOM） */
          const stHu0 = await ltapi.statusGet('human', roomId);
          if (stHu0.ok && !stHu0.inRoom) {
            const myRoom = stHu0.roomId || (stHu0.roomInfo && stHu0.roomInfo.roomId);
            if (myRoom) {
              const end = await ltapi.endRoom('human', myRoom);
              log('P6 human end own room:', myRoom, JSON.stringify(end).slice(0, 160));
            }
          }
          acc = await ltapi.acceptInvitation('human', roomId, String(aiUid));
          log('P6 human accept:', JSON.stringify(acc).slice(0, 200));
          if (!acc.ok) {
            return { ok: false, step: 'accept', roomId: roomId, needLeave: !!acc.needLeave, message: acc.message || 'accept failed' };
          }
        } else {
          /* 只邀请模式：等真人 APP 点卡进房。给前端回传邀请卡信息（含 orpheus url）。 */
          try {
            const card = await ltapi.invitationInfo('human', 1);
            log('P6 invite-only, human card:', JSON.stringify(card.inviteMsg || card.raw || {}).slice(0, 200));
          } catch (e) {}
          if (deps && deps.broadcast) {
            try { deps.broadcast('native_invite_sent', { roomId: roomId, inviterId: aiUid, humanUid: huUid, ts: Date.now() }); } catch (e) {}
          }
          return {
            ok: true, step: 'invited', roomId: roomId,
            message: '已向真人发送一起听邀请（等待真人 APP 点卡进房）',
          };
        }

        /* 4) 双方回读，确认同房 */
        const sAi = await ltapi.statusGet('ai', roomId);
        const sHu = await ltapi.statusGet('human', roomId);
        const users = (sAi.roomInfo && sAi.roomInfo.roomUsers) || sAi.users || [];
        status.remoteUsers = users;
        if (deps && deps.broadcast) {
          try { deps.broadcast('native_join', { roomId: roomId, users: users, aiConnected: !!(sAi.inRoom), humanConnected: !!(sHu.inRoom), ts: Date.now() }); } catch (e) {}
        }
        return {
          ok: !!(sAi.inRoom && sHu.inRoom),
          step: 'done',
          roomId: roomId,
          users: users,
          aiConnected: !!sAi.inRoom,
          humanConnected: !!sHu.inRoom,
          status: sAi.status || '',
          message: 'AI 与真人已同房（CONNECTED）',
        };
      } catch (e) {
        const msg = String((e && e.message) || e);
        log('P6 bringHumanIn error:', msg);
        return { ok: false, step: 'error', roomId: roomId, message: msg };
      }
    },

    /** P4: 单次房间状态回读 → 写入本地 state 并广播 */
    async syncOnce() {
      if (!status.connected || !status.roomId) return null;
      /* P9l: 防重入 —— 房间歌单大时单次 syncPlaylist 可能 8s+，
       * 2s 间隔会不断叠加请求，导致 eapi 排队整体变慢（addSongs 被牵连超时）。 */
      if (status._syncing) return null;
      status._syncing = true;
      try {
        const r = await ltapi.statusGet('ai', status.roomId);
        if (!r.ok) { if (r.message) log('P4 statusGet failed:', r.message); return null; }
        status.lastSyncTs = Date.now();
        status.lastError = null;
        if (!r.inRoom) {
          /* 房间已被解散/自己已退出：标记断开并停轮询 */
          status.connected = false;
          log('P4 room no longer active, disconnect');
          if (status.syncTimer) { clearInterval(status.syncTimer); status.syncTimer = null; }
          if (deps && deps.pushState) { try { deps.pushState('native_disconnect'); } catch (e) {} }
          return r;
        }
        /* 更新成员（供 UI 展示参与人数） */
        if (r.roomInfo) {
          status.chatRoomId = r.roomInfo.chatRoomId || status.chatRoomId;
          status.agoraChannelId = r.roomInfo.agoraChannelId || status.agoraChannelId;
        }
        status.remoteUsers = r.users || [];
        /* P7: 追加下行拉取（房间真实播放态 + 歌单 → 回灌本地 state） */
        try { await this._pullRemote(); } catch (e) { log('P7 _pullRemote error:', String((e && e.message) || e)); }
        if (deps && deps.broadcast) {
          try { deps.broadcast('native_sync', { roomId: status.roomId, inRoom: r.inRoom, status: r.status, users: r.users || [], ts: status.lastSyncTs }); } catch (e) {}
        }
        return r;
      } catch (e) {
        log('P4 syncOnce error:', String((e && e.message) || e));
        return null;
      } finally {
        status._syncing = false;   /* P9l: 释放重入锁 */
      }
    },

    /** P7: 下行同步核心 —— 拉取房间真实播放态/歌单，经「时间戳仲裁」后回灌本地 state。
     *  仲裁规则（对齐参考实现 sync.js）：
     *    ① 本地刚上行过（<1500ms）→ 让本地赢，跳过本帧远端
     *    ② 远端 serverSeq 与上次已应用相同 → 无新指令，跳过
     *    ③ 否则应用：交给 deps.applyRemote 写 state + 广播。 */
    async _pullRemote() {
      const p = await ltapi.syncPlaylist('ai', status.roomId);
      if (!p.ok) { if (p.message) log('P7 syncPlaylist failed:', p.message); return null; }
      status.lastPullTs = Date.now();
      /* 歌单（displayList.result）→ 广播，供 UI 显示房间真实队列 */
      status.remotePlaylist = p.songIds || [];
      if (p.songIds && p.songIds.length) {
        if (deps && deps.broadcast) {
          try { deps.broadcast('native_playlist', { songIds: p.songIds, playMode: p.playMode, ts: Date.now() }); } catch (e) {}
        }
        /* P7: 房间真实队列回灌本地 state.playlist（server 侧按 id 序列去重，避免每 2s 重复抓元数据） */
        if (deps && typeof deps.applyRemotePlaylist === 'function') {
          try { deps.applyRemotePlaylist(p.songIds, p.playMode); } catch (e) {}
        }
      }
      const cmd = p.playCommand;
      /* P9h: 关键 —— 从房间回读当前 clientSeq 并抬高本地计数。
       * 网易云 APP 按 clientSeq **单调递增**去重；服务器重启后本地计数归零，
       * 若直接发 1、2… 会被 APP 当成「过期指令」静默忽略（表现为"重启后就不换歌了"）。
       * 这里把本地计数对齐到房间已达的最大值，后续 ++ 必然更大 → APP 一定执行。 */
      if (cmd && typeof cmd.clientSeq === 'number' && cmd.clientSeq > status.clientSeq) {
        status.clientSeq = cmd.clientSeq;
        _saveSeqHi(status.clientSeq);
        log('P3 clientSeq resynced from room:', cmd.clientSeq);
      }
      if (!cmd) return null; // 单人房 / 尚无指令
      /* ② 去重：同一 serverSeq 只应用一次 */
      const rseq = Number(cmd.serverSeq || 0);
      if (rseq && rseq === status.lastRemoteSeq) return null;
      /* ① 本地优先：刚上行 1500ms 内忽略远端 */
      if (Date.now() - status.lastUploadAt < 1500) return null;

      status.lastRemoteSeq = rseq || status.lastRemoteSeq;
      status.lastRemote = cmd;
      const sid = (cmd.targetSongId != null && cmd.targetSongId !== '') ? String(cmd.targetSongId)
                : (cmd.formerSongId != null ? String(cmd.formerSongId) : '');
      const playing = cmd.playStatus
        ? (cmd.playStatus !== 'PAUSE' && cmd.playStatus !== 'PAUSED')
        : !/PAUSE/.test(String(cmd.commandType || ''));
      const remote = {
        songId: sid,
        playing: !!playing,
        positionMs: Number(cmd.progress) || 0,
        commandType: cmd.commandType || '',
        byUserId: cmd.userId || null,
        serverSeq: rseq,
      };
      log('P7 remote apply:', JSON.stringify(remote).slice(0, 200));
      if (deps && typeof deps.applyRemote === 'function') {
        try { deps.applyRemote(remote); } catch (e) { log('P7 applyRemote error:', String((e && e.message) || e)); }
      }
      return remote;
    },

    /** 停驱动，清理 P4/P5 的定时器与长连接 */
    stop() {
      if (status.syncTimer) { clearInterval(status.syncTimer); status.syncTimer = null; }
      if (status.chatListener && typeof status.chatListener.close === 'function') {
        try { status.chatListener.close(); } catch (e) {}
      }
      status.chatListener = null;
      status.enabled = false;
      status.connected = false;
      status.mode = 'local';
      status.roomId = null;
      status.chatRoomId = null;
      status.agoraChannelId = null;
      status.creatorId = null;
      status.remoteUsers = [];
      status.account = null;
      status.accounts = null;
      log('stopped');
      return this.status();
    },

    /**
     * /control 动作转发入口（P3：翻译成原生协议指令并下发）。
     * 返回体兼容 /control 的返回契约：优先返回 snapshot，失败返回说明对象。
     */
    async handleControl(b) {
      status.forwarded++;
      const action = b && b.action;
      const snap = snapshotOf();
      const curSongId = (snap && snap.song && snap.song.id != null) ? String(snap.song.id) : '';
      const curPos = (snap && typeof snap.positionMs === 'number') ? Math.round(snap.positionMs) : 0;

      /* 未真正接入（建房失败/未连接）：明确告知，不下发，避免"假成功" */
      if (!status.connected || !status.roomId) {
        return {
          ok: false, forwarded: true, mode: status.mode, action: action,
          note: '未接入房间（connected=false），指令未下发',
          state: snap,
        };
      }

      /* ---- P3: 动作 → PlayCommand 字段映射（字段名坑：targetSongId ≠ songId）----
       * P9i: clientSeq 必须是**毫秒时间戳**（对齐官方客户端抓包），
       *      用递增小整数会被 APP 当成"远古时间的过期指令"直接忽略
       *      —— 这正是"指令进了房间但 APP 不刷新"的真凶。 */
      const _seqNow = Date.now();
      /* P9ah: clientSeq 用**毫秒**时间戳 —— 对齐《一起听改造计划书 v0.4》§3.4
       * Frida 真机抓包（"clientSeq": 1789390650760，13 位毫秒）。
       * P9s 曾因「PlayCommand.clientSeq 是 Java int32」改秒级，但那只适用云信 IM
       * 通道（Java 反序列化）；HTTP 通道的 commandInfo 是 JSON 字符串，官方实测就是毫秒。 */
      const _clientSeq = _seqNow;
      /* P9y【根因确认·实测验证】指令必须以「用户(human)身份」下发。
       * 对照实验铁证（真人 APP 前台）：
       *   - AI 身份(sendUid=10000000001) 发 GOTO → APP 只弹"对方切歌了"提示，**歌不切**；
       *   - human 身份(sendUid=10000000002) 发 GOTO → APP **真的切歌**（素颜 167827）。
       * 原因：APP 的 u0.v0() 判定 PlayCommand.getUserId()(=sendUid)：
       *   - 若 != 本机登录 uid → 视为"对方发来的"→ 走「提示」路径，且失焦时仅缓存不执行；
       *   - 若 == 本机登录 uid → 视为"我自己操作的"→ 走正常执行路径，真正切歌。
       * 故必须用 human cookie 下发（human 就是 APP 上登录的账号），无 human cookie 才回退 ai。 */
      const _humanUid = (status.accounts && status.accounts.human && Number(status.accounts.human.userId)) || 0;
      let _hasHuman = false;
      try { _hasHuman = !!identity.readCookie('human'); } catch (e) {}
      /* ⚠️ 只要 human cookie 存在就用 human 下发 —— 服务端广播的 sendUid 由 cookie 决定，
       * APP 读的正是广播 sendUid（PlayCommandMsg: setUserId(content.getLong("sendUid"))），
       * 与我们传的 userId 字段无关。故此处不依赖 accounts 是否已加载（避免时序竞态）。 */
      const _sendWho = _hasHuman ? 'human' : 'ai';
      const cmd = {
        clientSeq: _clientSeq,
        /* P9j: 完全对齐官方抓包字段（无 clientTime / ignoreUserId）。
         * serverSeq 必须回填**房间当前值**，否则 APP 可能认为指令不对应当前房间状态。 */
        serverSeq: (status.lastRemote && Number(status.lastRemote.serverSeq)) || 0,
        triggerType: 'MANUAL',
        userId: (_sendWho === 'human' && _humanUid) ? _humanUid : (status.creatorId || undefined),
      };
      let targetSongId = curSongId;
      let progress = curPos;
      /* P8-fix: playStatus 默认**跟随本地真实播放态**，而不是硬编码 'PLAYING'。
       * 旧实现下 seek/next/prev 一律带 playStatus='PLAYING'，
       * 导致「暂停后页面进度上报（seek）」把房间又拉回播放 →
       * 表现为「本地暂停了，网易云 APP 不停」。 */
      let playStatus = (snap && snap.playing) ? 'PLAY' : 'PAUSE';
      switch (action) {
        case 'play':
          cmd.commandType = 'PLAY';
          playStatus = 'PLAY';
          if (typeof b.position === 'number') progress = Math.round(b.position);
          break;
        case 'pause':
          cmd.commandType = 'PAUSE';
          playStatus = 'PAUSE';
          break;
        case 'seek':
          cmd.commandType = 'GOTO';
          /* playStatus 保持跟随 snap（暂停中 seek 不应把房间拉回播放） */
          progress = Math.round(Number(b.position != null ? b.position : b.positionMs) || curPos);
          break;
        case 'load':
          /* P9i: 切歌必须用 **GOTO**（官方客户端抓包实证）；
           *      'PLAY' 只切换播放状态，不会让 APP 跳到指定歌曲 →
           *      表现为"指令成功、房间 target 变了，但 APP 不刷新"。 */
          cmd.commandType = 'GOTO';
          if (b.song && b.song.id != null) targetSongId = String(b.song.id);
          cmd.formerSongId = curSongId;
          progress = (typeof b.position === 'number') ? Math.round(b.position) : 0;
          playStatus = (b.autoplay === false) ? 'PAUSE' : 'PLAY';
          break;
        case 'next':
          cmd.commandType = 'NEXT';
          break;
        case 'prev':
          cmd.commandType = 'PREV';
          break;
        case 'toggle':
          cmd.commandType = snap && snap.playing ? 'PAUSE' : 'PLAY';
          playStatus = (cmd.commandType === 'PAUSE') ? 'PAUSE' : 'PLAY';
          break;
        default:
          return {
            ok: false, forwarded: true, mode: status.mode, action: action,
            note: '未支持的动作：' + action + '，指令未下发', state: snap,
          };
      }
      if (targetSongId) cmd.targetSongId = targetSongId;
      if (cmd.formerSongId === undefined) cmd.formerSongId = curSongId;
      cmd.progress = progress;
      cmd.playStatus = playStatus;

      const r = await ltapi.reportCommand(_sendWho, status.roomId, cmd);
      if (r.ok) {
        status.lastError = null;
        _saveSeqHi(status.clientSeq);
        /* P7: 记录上行时间 —— 之后 1500ms 内的远端帧让本地赢，
         * 避免"刚点的歌"被房间里的旧播放态立刻回滚（对齐 sync.js 仲裁）。 */
        status.lastUploadAt = Date.now();
        log('P3 command sent(' + _sendWho + '):', cmd.commandType, 'song=' + targetSongId, 'seq=' + cmd.clientSeq);
        /* P4: 下发后回读校准（异步，不阻塞响应） */
        const self = this;
        setTimeout(function () { self.syncOnce(); }, 500);
        return {
          ok: true, forwarded: true, mode: status.mode, action: action,
          commandType: cmd.commandType, roomId: status.roomId, clientSeq: cmd.clientSeq,
          note: 'P3：指令已下发到一起听房间', state: snap,
        };
      }
      status.lastError = r.message || '指令下发失败';
      log('P3 command failed:', cmd.commandType, status.lastError);
      return {
        ok: false, forwarded: true, mode: status.mode, action: action,
        note: '指令下发失败：' + status.lastError, state: snap,
      };
    },
  };
}

module.exports = { createDriver, MODES };
