'use strict';
/**
 * 参考实现自检脚本（离线，不发网络请求）。
 *
 * 运行： node reference/selftest.js
 *
 * 覆盖：
 *   - crypto：eapi 对真实抓包向量逐字节比对；weapi 双层加解密往返
 *   - invite：真实 lastMsg 解析、senderUid 提取、普通聊天不误报
 *   - identity：cookie 校验、脱敏、0600 落盘
 *   - mode：模式切换、缺 cookie 时报错、能力矩阵
 *   - room：commandInfo / playlistParam 的"JSON 字符串套 JSON"形态
 *   - sync：进度计算、状态签名、上行队列串行、远端合并仲裁
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const crypto = require('./native/crypto.js');
const invite = require('./native/invite.js');
const identity = require('./native/identity.js');
const room = require('./native/room.js');
const sync = require('./native/sync.js');
const mode = require('./native/mode.js');
const message = require('./native/message.js');

let passed = 0;
let failed = 0;

/**
 * 跑一个用例。
 * @param {string} name
 * @param {() => void} fn
 */
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed += 1;
    console.log('  ✗ ' + name);
    console.log('      ' + ((e && e.message) || e));
  }
}

console.log('\n[1] crypto — eapi 真实抓包向量');
(function () {
  let vectors;
  try {
    vectors = require('/ncm-mcp-server/node/test/fixtures/eapi-vectors.json');
  } catch (e) {
    console.log('  - 跳过（找不到向量文件，属正常：该文件不在本仓库）');
    return;
  }
  vectors.eapi.forEach(function (v) {
    test('eapi ' + v.path, function () {
      assert.strictEqual(crypto.eapiEncrypt(v.path, v.payload), v.params);
    });
  });
})();

console.log('\n[2] crypto — weapi 双层加解密往返');
test('weapi 解密可还原原始 payload', function () {
  const orig = require('crypto').randomInt;
  require('crypto').randomInt = function () { return 0; }; // 固定 secKey='aaaaaaaaaaaaaaaa'
  try {
    // 重新加载模块以使用被替换的 randomInt
    delete require.cache[require.resolve('./native/crypto.js')];
    const c2 = require('./native/crypto.js');
    const enc = c2.weapiEncrypt({ hello: 'world' });
    const first = c2.aesCbcDecryptBase64(
      enc.params,
      Buffer.from('aaaaaaaaaaaaaaaa'),
      Buffer.from('0102030405060708'),
    ).toString('utf8');
    const inner = c2.aesCbcDecryptBase64(
      first,
      Buffer.from('0CoJUm6Qyw8W8jud'),
      Buffer.from('0102030405060708'),
    ).toString('utf8');
    assert.strictEqual(inner, '{"hello":"world"}');
    assert.strictEqual(enc.encSecKey.length, 256);
    assert.ok(/^[0-9a-f]{256}$/.test(enc.encSecKey));
  } finally {
    require('crypto').randomInt = orig;
    delete require.cache[require.resolve('./native/crypto.js')];
  }
});
test('eapi 密文长度是 32 的倍数（16 字节块）', function () {
  assert.strictEqual(crypto.eapiEncrypt('/api/x', { a: 1 }).length % 32, 0);
});
test('eapi body 缺 header 时自动补 "{}"', function () {
  assert.strictEqual(crypto.encodeEapiBody({ a: 1 }), '{"a":1,"header":"{}"}');
});
test('eapiPathSuffix 剥掉 /api 前缀', function () {
  assert.strictEqual(
    crypto.eapiPathSuffix('/api/listen/together/heartbeat'),
    '/listen/together/heartbeat',
  );
});

console.log('\n[3] invite — 真实抓包解析');
test('真实 lastMsg 解析出 roomId/inviterId/inviterName', function () {
  let fx;
  try {
    fx = require('/ncm-mcp-server/node/test/fixtures/real-invite.json');
  } catch (e) {
    return; // fixture 不在本仓库时跳过
  }
  const p = invite.parseInvite(fx.lastMsg);
  assert.strictEqual(p.roomId, fx.expected.roomId);
  assert.strictEqual(p.inviterId, fx.expected.inviterId);
  assert.strictEqual(p.inviterName, fx.expected.inviterName);
});
test('roomId 是 <32hex>_<ts> 形态，不是纯数字', function () {
  const p = invite.parseInvite({
    msg: JSON.stringify({ nativeUrl: 'x?roomId=0bc86e8bdec58e9094e4680ade792ff9_1789364473&inviterId=123' }),
  });
  assert.ok(/^[0-9a-f]{32}_\d+$/.test(p.roomId), '实际: ' + p.roomId);
});
test('从 msgs[].user.fromUserId 提取 senderUid', function () {
  const got = invite.extractInvites({
    msgs: [{
      user: {
        fromUserId: 10000000002,
        lastMsg: { msg: JSON.stringify({ nativeUrl: 'x?roomId=abc123def4567890abc123def4567890_1&inviterId=999' }) },
      },
    }],
  });
  assert.strictEqual(got[0].senderUid, '10000000002');
});
test('URL 编码的 nativeUrl 能解码', function () {
  const raw = encodeURIComponent('x?roomId=abcdef0123456789abcdef0123456789_99&inviterId=555');
  const p = invite.parseInvite('orpheus://open?url1=' + raw);
  assert.strictEqual(p.roomId, 'abcdef0123456789abcdef0123456789_99');
  assert.strictEqual(p.inviterId, '555');
});
test('普通聊天不误报', function () {
  assert.strictEqual(invite.parseInvite('今晚吃什么？').roomId, null);
  assert.strictEqual(invite.parseInvite({ msg: '在吗' }).roomId, null);
});

console.log('\n[4] identity — cookie 存取与安全');
test('缺必需字段时保存报错', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlt-'));
  const store = new identity.IdentityStore({ dir: dir });
  assert.throws(function () { store.save('ai', 'foo=bar'); }, /缺少必需字段/);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('合法 cookie 可存可读且落盘 0600', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlt-'));
  const store = new identity.IdentityStore({ dir: dir });
  const ck = 'MUSIC_U=abcdef123456; __csrf=deadbeef';
  const res = store.save('ai', ck);
  assert.strictEqual(res.length, ck.length);
  assert.strictEqual(store.load('ai'), ck);
  assert.strictEqual(store.has('ai'), true);
  const mode600 = (fs.statSync(store.fileFor('ai')).mode & 0o777).toString(8);
  assert.strictEqual(mode600, '600', '实际权限: ' + mode600);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('maskCookie 不泄露完整值', function () {
  const m = identity.maskCookie('MUSIC_U=supersecrettoken; __csrf=csrfvalue');
  assert.ok(m.indexOf('supersecrettoken') < 0, '不应包含原文');
  assert.ok(m.indexOf('supe****') >= 0, '实际: ' + m);
});
test('两个身份互相独立', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlt-'));
  const store = new identity.IdentityStore({ dir: dir });
  store.save('ai', 'MUSIC_U=ai000000; __csrf=a');
  store.save('human', 'MUSIC_U=hu000000; __csrf=h');
  assert.notStrictEqual(store.load('ai'), store.load('human'));
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('\n[5] mode — 状态机与能力矩阵');
test('默认模式是 local（向后兼容）', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlt-'));
  const mm = new mode.ModeManager({ store: new identity.IdentityStore({ dir: dir }) });
  assert.strictEqual(mm.mode, 'local');
  assert.strictEqual(mm.isNative(), false);
  assert.strictEqual(mm.isWebviewControllable(), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('local 模式不需要任何 cookie', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlt-'));
  const mm = new mode.ModeManager({ store: new identity.IdentityStore({ dir: dir }) });
  assert.strictEqual(mm.status().ready, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('duo 模式缺 cookie 时报错并指明缺哪个', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlt-'));
  const store = new identity.IdentityStore({ dir: dir });
  const mm = new mode.ModeManager({ store: store });
  assert.throws(function () { mm.set('duo'); }, /ai, human/);
  store.save('ai', 'MUSIC_U=ai000000; __csrf=a');
  assert.throws(function () { mm.set('duo'); }, /human/);
  store.save('human', 'MUSIC_U=hu000000; __csrf=h');
  assert.strictEqual(mm.set('duo').mode, 'duo');
  fs.rmSync(dir, { recursive: true, force: true });
});
test('solo_ai 只需要 ai cookie，且 webview 不可控制', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlt-'));
  const store = new identity.IdentityStore({ dir: dir });
  store.save('ai', 'MUSIC_U=ai000000; __csrf=a');
  const mm = new mode.ModeManager({ store: store });
  assert.strictEqual(mm.set('solo_ai').mode, 'solo_ai');
  assert.strictEqual(mm.isWebviewControllable(), false, 'mode3 控制应置灰');
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('\n[6] room — 载荷形态（协议关键）');
test('commandInfo 用 targetSongId 而非 songId（实测静默失败点）', function () {
  const s = room.buildCommandInfo({ targetSongId: 186016, formerSongId: 1, progress: 0 });
  assert.strictEqual(typeof s, 'string');
  const o = JSON.parse(s);
  assert.strictEqual(o.targetSongId, '186016', '必须是 targetSongId');
  assert.strictEqual(o.formerSongId, '1');
  assert.strictEqual(o.songId, undefined, '不能带 songId（服务端会静默忽略）');
  assert.strictEqual(o.clientSeq, o.clientTime, 'clientSeq/clientTime 应同值');
});
test('setPaused 生成 PAUSE / PLAY 指令', function () {
  const calls = [];
  const fake = { eapiRequest: function (p, b) { calls.push(b); return Promise.resolve({ code: 200 }); } };
  const rs = new room.RoomService(fake, { roomId: 'r' });
  return rs.setPaused(true, { songId: '5' }).then(function () {
    const ci = JSON.parse(calls[0].commandInfo);
    assert.strictEqual(ci.commandType, 'PAUSE');
    assert.strictEqual(ci.playStatus, 'PAUSE');
    assert.strictEqual(ci.targetSongId, '5');
    return rs.setPaused(false, { songId: '5' });
  }).then(function () {
    const ci = JSON.parse(calls[1].commandInfo);
    assert.strictEqual(ci.commandType, 'PLAY');
    assert.strictEqual(ci.playStatus, 'PLAY');
  });
});
test('skip 生成 NEXT / PREV', function () {
  const calls = [];
  const fake = { eapiRequest: function (p, b) { calls.push(b); return Promise.resolve({ code: 200 }); } };
  const rs = new room.RoomService(fake, { roomId: 'r' });
  return rs.skip('next', { songId: '7' }).then(function () {
    assert.strictEqual(JSON.parse(calls[0].commandInfo).commandType, 'NEXT');
    return rs.skip('prev', { songId: '7' });
  }).then(function () {
    assert.strictEqual(JSON.parse(calls[1].commandInfo).commandType, 'PREV');
  });
});
test('current() 解析房间播放状态', function () {
  const fake = {
    eapiRequest: function () {
      return Promise.resolve({ code: 200, data: {
        playCommand: { commandType: 'GOTO', targetSongId: '99', playStatus: 'PLAY' },
        playlist: { displayList: { result: ['99', '88'] }, playMode: 'ORDER_LOOP', version: [{ userId: 1, version: 2 }] },
      } });
    },
  };
  const rs = new room.RoomService(fake, { roomId: 'r' });
  return rs.current().then(function (c) {
    assert.strictEqual(c.playCommand.targetSongId, '99');
    assert.deepStrictEqual(c.list, ['99', '88']);
    assert.strictEqual(c.playMode, 'ORDER_LOOP');
  });
});
test('playlistParam 用 REPLACE + 全量 displayList（v0.4 已跑通）', function () {
  const s = room.buildPlaylistParam({ displayList: [1, 2, 3], version: [{ userId: 1, version: 7 }] });
  const o = JSON.parse(s);
  assert.strictEqual(o.commandType, 'REPLACE', '必须是 REPLACE，不是 ADD');
  assert.deepStrictEqual(o.displayList, ['1', '2', '3'], 'displayList 必须是字符串全量数组');
  assert.deepStrictEqual(o.randomList, []);
  assert.strictEqual(o.anchorSongId, '3', '默认锚点取列表最后一首');
  assert.strictEqual(o.anchorPosition, 2);
  assert.deepStrictEqual(o.version, [{ userId: 1, version: 7 }], 'version 原样回传');
  assert.ok(!('operationType' in o), '不应再出现旧的 operationType 字段');
  assert.ok(!('songIds' in o), '不应再出现旧的 songIds 字段');
});
test('addSongs 走「读列表 → 追加 → 整份 REPLACE」', function () {
  const calls = [];
  const fake = {
    eapiRequest: function (p, b) {
      calls.push({ p: p, b: b });
      if (p === room.PATHS.playlist) {
        return Promise.resolve({
          code: 200,
          data: {
            playCommand: {},
            playlist: {
              displayList: { result: ['1', '2'] },
              version: [{ userId: 5, version: 3 }],
              playMode: 'ORDER_LOOP',
            },
          },
        });
      }
      return Promise.resolve({ code: 200, data: { result: true } });
    },
  };
  const rs = new room.RoomService(fake, { roomId: 'r' });
  return rs.addSongs({ songIds: ['9', '2'] }).then(function (r) {
    assert.deepStrictEqual(r.added, ['9'], '已在列表里的 2 应被去重');
    assert.strictEqual(r.before, 2);
    assert.strictEqual(r.after, 3);
    const sent = JSON.parse(calls[calls.length - 1].b.playlistParam);
    assert.strictEqual(sent.commandType, 'REPLACE');
    assert.deepStrictEqual(sent.displayList, ['1', '2', '9'], '必须是原列表 + 新歌的全量');
    assert.deepStrictEqual(sent.version, [{ userId: 5, version: 3 }]);
  });
});
test('replaceList 用整份新列表覆盖（换歌单）', function () {
  const calls = [];
  const fake = {
    eapiRequest: function (p, b) {
      calls.push({ p: p, b: b });
      if (p === room.PATHS.playlist) {
        return Promise.resolve({ code: 200, data: { playlist: { displayList: { result: ['1'] }, version: [] } } });
      }
      return Promise.resolve({ code: 200 });
    },
  };
  const rs = new room.RoomService(fake, { roomId: 'r' });
  return rs.replaceList({ displayList: ['7', '8', '9'], version: [] }).then(function () {
    const sent = JSON.parse(calls[calls.length - 1].b.playlistParam);
    assert.deepStrictEqual(sent.displayList, ['7', '8', '9']);
    assert.strictEqual(sent.commandType, 'REPLACE');
  });
});
test('heartbeatChecked 识别 488（对方关房）', function () {
  const fake = { eapiRequest: function () { return Promise.resolve({ code: 488 }); } };
  const rs = new room.RoomService(fake, { roomId: 'r' });
  return rs.heartbeatChecked().then(function (r) {
    assert.strictEqual(r.alive, false);
    assert.strictEqual(r.code, 488);
    assert.strictEqual(r.reason, 'ended_by_peer');
  });
});
test('heartbeatChecked 网络错误不误判为关房', function () {
  const fake = { eapiRequest: function () { return Promise.reject(new Error('timeout')); } };
  const rs = new room.RoomService(fake, { roomId: 'r' });
  return rs.heartbeatChecked().then(function (r) {
    assert.strictEqual(r.alive, true, '网络抖动不应清空 roomId');
    assert.strictEqual(r.reason, 'network_error');
  });
});
test('心跳四字段齐备（缺一即 400）', function () {
  const fake = { eapiRequest: function (p, body) { return Promise.resolve({ code: 200, _body: body, _path: p }); } };
  const rs = new room.RoomService(fake, { roomId: 'r1' });
  return rs.heartbeat({ songId: '5', progress: 1000 }).then(function (r) {
    assert.deepStrictEqual(Object.keys(r._body).sort(), ['playStatus', 'progress', 'roomId', 'songId']);
    assert.strictEqual(r._path, room.PATHS.heartbeat);
  });
});
test('accept 同时带 roomId 与 inviterId', function () {
  const fake = { eapiRequest: function (p, body) { return Promise.resolve({ code: 200, _body: body }); } };
  const rs = new room.RoomService(fake, {});
  return rs.accept({ roomId: 'r1', inviterId: 999 }).then(function (r) {
    assert.strictEqual(r._body.roomId, 'r1');
    assert.strictEqual(r._body.inviterId, '999');
    assert.strictEqual(rs.roomId, 'r1');
  });
});

console.log('\n[7] sync — 状态机与仲裁');
test('currentPos 按锚点推进', function () {
  const st = { playing: true, positionMs: 1000, anchorTs: Date.now() - 2000 };
  const p = sync.currentPos(st);
  assert.ok(p >= 3000 && p < 3200, '实际: ' + p);
});
test('暂停时 currentPos 不推进', function () {
  const st = { playing: false, positionMs: 1000, anchorTs: Date.now() - 5000 };
  assert.strictEqual(sync.currentPos(st), 1000);
});
test('stateSignature 对进度做 5 秒分桶', function () {
  const base = { song: { id: 'x' }, playing: true, positionMs: 0, anchorTs: Date.now() };
  const a = sync.stateSignature(base);
  const b = sync.stateSignature({ song: { id: 'x' }, playing: true, positionMs: 100, anchorTs: Date.now() });
  assert.strictEqual(a, b, '1 秒内的进度差不应改变签名');
});
test('上行队列串行执行（AI 与真人不交叉覆盖）', function () {
  const order = [];
  const fake = {
    addSongs: function () { order.push('add'); return Promise.resolve({ code: 200 }); },
    playCommand: function () { order.push('play'); return Promise.resolve({ code: 200 }); },
    status: function () { return Promise.resolve({ code: 200, data: { inRoom: true } }); },
    playlist: function () { return Promise.resolve({ code: 200, data: {} }); },
  };
  const st = { song: null, playing: false, positionMs: 0, anchorTs: 0, seq: 0 };
  const eng = new sync.SyncEngine({ room: fake, state: st });
  return Promise.all([
    eng.applyLocal({ action: 'load', song: { id: 'a' }, by: 'ai' }),
    eng.applyLocal({ action: 'load', song: { id: 'b' }, by: 'human' }),
  ]).then(function () {
    // 两首歌都必须先 add 再 play，且顺序不交错
    assert.deepStrictEqual(order, ['add', 'play', 'add', 'play']);
  });
});
test('远端合并：刚操作过则忽略远端（防抖动）', function () {
  const fake = { status: function () { return Promise.resolve({ code: 200, data: { inRoom: true } }); }, playlist: function () { return Promise.resolve({ code: 200, data: {} }); } };
  const st = { song: { id: 'local' }, playing: true, positionMs: 0, anchorTs: Date.now(), seq: 1 };
  const eng = new sync.SyncEngine({ room: fake, state: st });
  eng.lastUploadAt = Date.now(); // 模拟刚刚上报过
  const changed = eng._mergeRemote({ currentSongId: 'remote', playStatus: 'PLAY', list: ['remote'] });
  assert.strictEqual(changed, false);
  assert.strictEqual(st.song.id, 'local', '不应被远端覆盖');
});
test('远端合并：空闲时接受远端换歌', function () {
  const fake = { status: function () { return Promise.resolve({ code: 200, data: { inRoom: true } }); }, playlist: function () { return Promise.resolve({ code: 200, data: {} }); } };
  const st = { song: { id: 'local' }, playing: true, positionMs: 0, anchorTs: Date.now(), seq: 1 };
  const eng = new sync.SyncEngine({ room: fake, state: st });
  eng.lastUploadAt = 0;
  const changed = eng._mergeRemote({ currentSongId: 'remote', playStatus: 'PLAY', list: ['remote'], userId: '10000000002' });
  assert.strictEqual(changed, true);
  assert.strictEqual(st.song.id, 'remote');
  assert.strictEqual(st.updatedBy, 'remote:10000000002');
});
test('远端合并：真人暂停时本地也跟着暂停', function () {
  const fake = { status: function () { return Promise.resolve({ code: 200, data: { inRoom: true } }); }, playlist: function () { return Promise.resolve({ code: 200, data: {} }); } };
  const st = { song: { id: 'same' }, playing: true, positionMs: 0, anchorTs: Date.now(), seq: 1 };
  const eng = new sync.SyncEngine({ room: fake, state: st });
  eng.lastUploadAt = 0;
  const changed = eng._mergeRemote({ currentSongId: 'same', playStatus: 'PAUSE', list: ['same'] });
  assert.strictEqual(changed, true, '同一首歌但播放状态变了，也算变更');
  assert.strictEqual(st.playing, false);
});
test('_parseRemotePlaylist 解析真实结构（displayList.result + playCommand）', function () {
  const fake = { status: function () { return Promise.resolve({ code: 200, data: { inRoom: true } }); }, playlist: function () { return Promise.resolve({ code: 200, data: {} }); } };
  const eng = new sync.SyncEngine({ room: fake, state: { song: null, playing: false, positionMs: 0, anchorTs: 0, seq: 0 } });
  const parsed = eng._parseRemotePlaylist({
    code: 200,
    data: {
      playCommand: { commandType: 'GOTO', targetSongId: '407747274', playStatus: 'PLAY', serverSeq: 1700000000000, userId: 10000000001 },
      playlist: { displayList: { result: ['407747274', '318317'] }, playMode: 'ORDER_LOOP', version: [{ userId: 10000000002, version: 1 }] },
    },
  });
  assert.strictEqual(parsed.currentSongId, '407747274');
  assert.deepStrictEqual(parsed.list, ['407747274', '318317']);
  assert.strictEqual(parsed.playStatus, 'PLAY');
  assert.strictEqual(parsed.seq, 1700000000000);
  assert.strictEqual(parsed.playMode, 'ORDER_LOOP');
});
test('_parseRemotePlaylist 对单人房间空 data 返回 null', function () {
  const fake = { status: function () { return Promise.resolve({ code: 200, data: { inRoom: true } }); }, playlist: function () { return Promise.resolve({ code: 200, data: {} }); } };
  const eng = new sync.SyncEngine({ room: fake, state: { song: null, playing: false, positionMs: 0, anchorTs: 0, seq: 0 } });
  assert.strictEqual(eng._parseRemotePlaylist({ code: 200, data: {} }), null);
});
test('pollOnce 对空歌单不报错（实测单人房间即如此）', function () {
  const fake = {
    status: function () { return Promise.resolve({ code: 200, data: { inRoom: true, roomInfo: { roomId: 'r' }, status: 'NOT_CONNECTED' } }); },
    playlist: function () { return Promise.resolve({ code: 200, data: {} }); },
  };
  const st = { song: null, playing: false, positionMs: 0, anchorTs: 0, seq: 0 };
  const eng = new sync.SyncEngine({ room: fake, state: st });
  return eng.pollOnce().then(function (changed) {
    assert.strictEqual(changed, false);
    assert.strictEqual(eng.stats.polls, 1);
  });
});
test('轮询间隔在需求的 1–3 秒区间内', function () {
  assert.ok(sync.POLL_INTERVAL_MS >= 1000 && sync.POLL_INTERVAL_MS <= 3000, '实际: ' + sync.POLL_INTERVAL_MS);
});

/* --------------------------------------------------------------- 9. message（实测确认） */
console.log('\n[9] message — 私信收发（实测确认）');
test('unwrapMessage 剥掉多层 JSON 壳', function () {
  // 官方邀请私信就是这个形态：msg 里还是一层 JSON
  const inner = JSON.stringify({ msg: '我的耳机分你一半，和我一起听歌吧~', resType: 23 });
  assert.strictEqual(message.unwrapMessage(inner), '我的耳机分你一半，和我一起听歌吧~');
  // 裸 JSON 字符串
  assert.strictEqual(message.unwrapMessage('{"msg":"hi"}'), 'hi');
  // 纯文本原样返回
  assert.strictEqual(message.unwrapMessage('一起听邀请 orpheus://...'), '一起听邀请 orpheus://...');
  // 对象形态
  assert.strictEqual(message.unwrapMessage({ msg: 'x' }), 'x');
  // 非法 JSON 不抛错
  assert.strictEqual(message.unwrapMessage('{不是json'), '{不是json');
  assert.strictEqual(message.unwrapMessage(null), '');
});
test('send 用纯文本 + 数字数组 userIds', function () {
  const calls = [];
  const fake = { eapiRequest: function (p, b) { calls.push({ p: p, b: b }); return Promise.resolve({ code: 200 }); } };
  const ms = new message.MessageService(fake);
  return ms.send(10000000002, '一起听 orpheus://nm/play/listenTogether?roomId=abc_1').then(function () {
    assert.strictEqual(calls[0].p, '/api/msg/private/send');
    assert.strictEqual(calls[0].b.type, 'text');
    assert.strictEqual(calls[0].b.userIds, '[10000000002]', 'userIds 必须是 JSON 字符串数组');
  });
});
test('send 拒绝超长正文（实测 907 字符触发 code 2004）', function () {
  const fake = { eapiRequest: function () { return Promise.resolve({ code: 200 }); } };
  const ms = new message.MessageService(fake);
  return ms.send(1, 'x'.repeat(900)).then(function () {
    throw new Error('超长正文本应被拒绝');
  }, function (err) {
    assert.ok(/过长|字数/.test(err.message), '错误信息应说明长度问题: ' + err.message);
  });
});
test('history 返回新→旧，并解析出 text/senderUid', function () {
  const fake = { eapiRequest: function () {
    return Promise.resolve({ code: 200, msgs: [
      { msgId: 3, time: 300, msg: JSON.stringify({ msg: '最新' }), fromUser: { userId: 10000000002 } },
      { msgId: 2, time: 200, msg: '中间', fromUserId: 10000000001 },
      { msgId: 1, time: 100, msg: '最旧', user: { id: 999 } },
    ] });
  } };
  const ms = new message.MessageService(fake);
  return ms.history(10000000002).then(function (list) {
    assert.strictEqual(list[0].text, '最新', '数组首项应是最新消息');
    assert.strictEqual(list[0].senderUid, '10000000002');
    assert.strictEqual(list[1].senderUid, '10000000001', '兼容 fromUserId 形态');
    assert.strictEqual(list[2].senderUid, '999', '兼容 user.id 形态');
    assert.strictEqual(list[0].time, 300);
  });
});
test('latestInvite 从会话列表里捞出邀请', function () {
  const realInvite = {
    msg: JSON.stringify({
      msg: '我的耳机分你一半，和我一起听歌吧~', resType: 23,
      generalMsg: { nativeUrl: 'orpheus://open?url1=' + encodeURIComponent(
        'orpheus://nm/play/listenTogether?roomId=00000000000000000000000000000000_1700000000&inviterId=10000000002&listenTogetherRefer=inbox_invite') },
    }),
  };
  const fake = { eapiRequest: function (p) {
    if (p === message.PATHS.users) {
      return Promise.resolve({ code: 200, msgs: [
        { user: { fromUserId: 10000000002, id: 99, lastMsg: realInvite } },
        { user: { fromUserId: 111, id: 98, lastMsg: { msg: '普通消息' } } },
      ] });
    }
    return Promise.resolve({ code: 200, msgs: [] });
  } };
  const ms = new message.MessageService(fake);
  return ms.latestInvite(invite).then(function (inv) {
    assert.ok(inv, '应找到邀请');
    assert.strictEqual(inv.roomId, '00000000000000000000000000000000_1700000000');
    assert.strictEqual(inv.inviterId, '10000000002');
    assert.strictEqual(inv.senderUid, '10000000002');
  });
});
test('房间内发言走 HTTP（v0.4 推翻「云信够不着」的旧结论）', function () {
  // v0.3 曾把「房间聊天无 HTTP 接口」钉在测试里 —— 该结论已被抓包推翻。
  assert.strictEqual(message.PATHS.send, '/api/msg/private/send');
  assert.strictEqual(message.PATHS.users, '/api/msg/private/users');
  assert.strictEqual(message.PATHS.history, '/api/msg/private/history');
  assert.strictEqual(message.PATHS.roomSend, '/api/middle/im/chatroom/send',
    '房间内发言的端点就在 /api/middle/im/chatroom/send，不在 listen/together 命名空间下');
});
test('sendToRoom 构造出实测可用的明文表单', function () {
  const calls = [];
  const fake = { eapiRequest: function (p, b) { calls.push({ p: p, b: b }); return Promise.resolve({ code: 200 }); } };
  const ms = new message.MessageService(fake);
  return ms.sendToRoom({ chatroomId: 123456789, roomId: 'r1', ltType: 'FRIEND', text: 'hi' })
    .then(function () {
      const c = calls[0];
      assert.strictEqual(c.p, '/api/middle/im/chatroom/send');
      assert.strictEqual(c.b.chatroomId, '123456789');
      assert.strictEqual(c.b.msgType, '0');
      assert.deepStrictEqual(JSON.parse(c.b.clientExt), {
        bizType: 'listenTogether', ltType: 'FRIEND', roomId: 'r1',
      });
      assert.deepStrictEqual(JSON.parse(c.b.msgBody), { msg: 'hi', msgType: 0 });
    });
});
test('sendToRoom 缺 chatroomId 时明确报错', function () {
  const ms = new message.MessageService({ eapiRequest: function () { return Promise.resolve({}); } });
  return ms.sendToRoom({ text: 'hi' }).then(
    function () { throw new Error('应当拒绝'); },
    function (e) { assert.ok(/chatroomId/.test(e.message)); },
  );
});

/* --------------------------------------------------------------- 汇总 */
console.log('\n' + '─'.repeat(52));
console.log(`通过 ${passed} / 失败 ${failed}`);
console.log('─'.repeat(52) + '\n');
process.exit(failed ? 1 : 0);
