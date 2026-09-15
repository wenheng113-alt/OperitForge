'use strict';
/**
 * ============================================================
 *  native/qrlogin.js — 网易云扫码登录（P2 扩展）
 * ------------------------------------------------------------
 *  纯 API 实现：无浏览器桥、无 npm 依赖（只用 node 内置 https）。
 *
 *  流程：
 *    1) begin(who)  → 申请 unikey，得到二维码内容 + 登录 URL
 *    2) poll(who)   → 轮询状态机：
 *         800 = 二维码过期
 *         801 = 等待扫码
 *         802 = 已扫码待确认
 *         803 = 授权成功（此时 Set-Cookie 下发 MUSIC_U）
 *    3) 803 时把 cookie 写入 identity（0600 落盘），供原生协议使用
 *
 *  接口（老版 api 通道，2026 实测仍可用）：
 *    GET  /api/login/qrcode/unikey?type=1
 *    GET  /api/login/qrcode/client/login?key=<unikey>&type=1
 *
 *  注意（PLAN 坑④）：weapi 使用的 cookie 必须带 os=pc，
 *  否则部分接口鉴权失败 —— 写入时强制补齐。
 * ============================================================
 */
const https = require('https');
const identity = require('./identity');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HOST = 'music.163.com';
const REFERER = 'https://music.163.com/';

/** who → 会话（内存态，不落盘） */
const sessions = {};

/** 通用 GET */
function httpsGet(path, headers) {
  return new Promise(function (resolve, reject) {
    const req = https.request({
      host: HOST,
      port: 443,
      path: path,
      method: 'GET',
      headers: Object.assign({
        'User-Agent': UA,
        'Referer': REFERER,
        'Accept': 'application/json, text/plain, */*',
      }, headers || {}),
      timeout: 15000,
    }, function (res) {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          setCookie: res.headers['set-cookie'] || [],
          text: data,
        });
      });
    });
    req.on('timeout', function () { req.destroy(new Error('request timeout')); });
    req.on('error', reject);
    req.end();
  });
}

/** 合并 Set-Cookie 到 jar */
function mergeCookies(jar, setCookies) {
  (setCookies || []).forEach(function (line) {
    const kv = String(line).split(';')[0];
    const i = kv.indexOf('=');
    if (i < 0) return;
    const k = kv.slice(0, i).trim();
    const v = kv.slice(i + 1).trim();
    if (k) jar[k] = v;
  });
  return jar;
}

/** jar → Cookie 头 */
function jarToHeader(jar) {
  return Object.keys(jar).map(function (k) { return k + '=' + jar[k]; }).join('; ');
}

/**
 * 从 jar 生成最终写入的 cookie 串。
 * 关键：必须含 MUSIC_U；强制补 os=pc（PLAN 坑④）。
 */
function finalizeCookie(jar) {
  const parts = [];
  ['MUSIC_U', 'MUSIC_A', '__csrf', 'NMTID', '__remember_me'].forEach(function (k) {
    if (jar[k]) parts.push(k + '=' + jar[k]);
  });
  parts.push('os=pc');
  return parts.join('; ');
}

function getSession(who) {
  if (identity.WHOS.indexOf(who) < 0) throw new Error('bad who: ' + who);
  let s = sessions[who];
  if (!s) { s = sessions[who] = { key: null, jar: {}, createdAt: 0, status: 'idle', lastMsg: '' }; }
  return s;
}

/**
 * 第一步：申请二维码。
 * @returns {ok, who, unikey, url, qrUrl, expiresIn}
 */
async function begin(who) {
  const s = getSession(who);
  const r = await httpsGet('/api/login/qrcode/unikey?type=1', { Cookie: jarToHeader(s.jar) });
  let j = {};
  try { j = JSON.parse(r.text); } catch (e) {}
  if (!j || !j.unikey) throw new Error('unikey 申请失败：' + String(r.text || '').slice(0, 120));

  s.key = j.unikey;
  s.jar = mergeCookies({}, r.setCookie);
  s.createdAt = Date.now();
  s.status = 'waiting';
  s.lastMsg = '等待扫码';

  return {
    ok: true,
    who: who,
    unikey: s.key,
    /** 二维码内容（用扫码 App 扫这个） */
    qrUrl: 'https://music.163.com/login?codekey=' + s.key,
    /** 手机端可直接点开的登录页 */
    url: 'https://music.163.com/login?codekey=' + s.key,
    expiresIn: 240,
    status: s.status,
    message: s.lastMsg,
  };
}

/**
 * 第二步：轮询状态机。命中 803 时自动写入 identity。
 * @returns {ok, who, code, status, message, done, saved?, identity?}
 */
async function poll(who) {
  const s = getSession(who);
  if (!s.key) throw new Error('尚未申请二维码，请先 begin');

  const r = await httpsGet(
    '/api/login/qrcode/client/login?key=' + encodeURIComponent(s.key) + '&type=1',
    { Cookie: jarToHeader(s.jar) }
  );
  /* 累积 cookie（NMTID 等，803 时含 MUSIC_U） */
  mergeCookies(s.jar, r.setCookie);

  let j = {};
  try { j = JSON.parse(r.text); } catch (e) {}
  const code = (j && typeof j.code === 'number') ? j.code : 0;

  const MAP = {
    800: { status: 'expired', message: '二维码已过期，请刷新' },
    801: { status: 'waiting', message: '等待扫码' },
    802: { status: 'scanned', message: '已扫码，请在手机上确认' },
    803: { status: 'ok', message: '登录成功' },
  };
  const m = MAP[code] || { status: 'unknown', message: (j && j.message) || ('未知状态 ' + code) };

  s.status = m.status;
  s.lastMsg = m.message;

  const out = {
    ok: true,
    who: who,
    code: code,
    status: m.status,
    message: m.message,
    done: code === 803,
  };

  if (code === 803) {
    const cookie = finalizeCookie(s.jar);
    if (!/MUSIC_U=/.test(cookie)) {
      out.ok = false;
      out.message = '授权成功但未拿到 MUSIC_U，请重试';
      return out;
    }
    const st = identity.saveCookie(who, cookie);
    out.saved = true;
    out.cookieStatus = st;
    out.identity = identity.status();
    /* 清理会话，避免 key 复用 */
    delete sessions[who];
  } else if (code === 800) {
    delete sessions[who];
  }

  return out;
}

/** 取消 / 清理会话 */
function cancel(who) {
  if (who) { delete sessions[who]; }
  else { Object.keys(sessions).forEach(function (k) { delete sessions[k]; }); }
  return { ok: true };
}

/** 当前会话状态（供 UI 回显，不含敏感 cookie） */
function sessionStatus(who) {
  const s = sessions[who];
  if (!s) return { active: false };
  return {
    active: !!s.key,
    who: who,
    status: s.status,
    message: s.lastMsg,
    ageMs: s.createdAt ? (Date.now() - s.createdAt) : 0,
  };
}

module.exports = { begin: begin, poll: poll, cancel: cancel, sessionStatus: sessionStatus, finalizeCookie: finalizeCookie };
