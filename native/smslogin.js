'use strict';
/**
 * ============================================================
 *  native/smslogin.js — 网易云短信验证码登录（P2 扩展）
 * ------------------------------------------------------------
 *  纯 API 实现：零 npm 依赖（node 内置 https + 自研 crypto.weapi）。
 *
 *  流程（三步）：
 *    1) send(who, phone)         → GET /api/sms/captcha/sent 发送验证码
 *    2) verify(who, phone, code) → POST /weapi/login/cellphone（加密）校验并登录
 *    3) 成功时 Set-Cookie 下发 MUSIC_U → 经 identity.saveCookie 落盘 0600
 *
 *  2026 实测结论：
 *    - /api/sms/captcha/sent   GET 存活（真发短信！必须节流）
 *    - /api/sms/captcha/verify GET 存活（可单独校验验证码）
 *    - /api/login/cellphone    GET 已废弃（401 ENC）→ 必须走 weapi 加密
 *
 *  风控要点：
 *    - 同手机号约 60s 才能重发一次 → 后端记录 lastSentAt 节流
 *    - 同 IP 限流 → 前端倒计时 + 后端冷却
 *    - 网易单点登录互斥 → 短信登录会顶掉该账号其它在线会话
 * ============================================================
 */
const https = require('https');
const crypto = require('./crypto');
const identity = require('./identity');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HOST = 'music.163.com';
const REFERER = 'https://music.163.com/';
/** 重发冷却（毫秒） */
const COOLDOWN_MS = 60000;

/** who → 会话（内存态，不落盘） */
const sessions = {};

/* ---------- 通用请求 ---------- */

function httpsGet(path, headers) {
  return new Promise(function (resolve, reject) {
    const req = https.request({
      host: HOST, port: 443, path: path, method: 'GET',
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
        resolve({ status: res.statusCode, headers: res.headers, setCookie: res.headers['set-cookie'] || [], text: data });
      });
    });
    req.on('timeout', function () { req.destroy(new Error('request timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function httpsPostForm(path, form, headers) {
  return new Promise(function (resolve, reject) {
    const body = Object.keys(form).map(function (k) { return k + '=' + encodeURIComponent(form[k]); }).join('&');
    const req = https.request({
      host: HOST, port: 443, path: path, method: 'POST',
      headers: Object.assign({
        'User-Agent': UA,
        'Referer': REFERER,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      }, headers || {}),
      timeout: 15000,
    }, function (res) {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        resolve({ status: res.statusCode, headers: res.headers, setCookie: res.headers['set-cookie'] || [], text: data });
      });
    });
    req.on('timeout', function () { req.destroy(new Error('request timeout')); });
    req.on('error', reject);
    req.write(body);
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

/** 生成最终 cookie（含 MUSIC_U，强制补 os=pc，与 qrlogin 一致） */
function finalizeCookie(jar) {
  const parts = [];
  ['MUSIC_U', 'MUSIC_A', '__csrf', 'NMTID', '__remember_me'].forEach(function (k) {
    if (jar[k]) parts.push(k + '=' + jar[k]);
  });
  parts.push('os=pc');
  return parts.join('; ');
}

/* ---------- 校验与工具 ---------- */

/** 手机号格式校验（11 位大陆号） */
function normalizePhone(phone) {
  const p = String(phone || '').replace(/[\s-]/g, '');
  if (!/^1[3-9]\d{9}$/.test(p)) throw new Error('手机号格式不正确');
  return p;
}

function getSession(who) {
  if (identity.WHOS.indexOf(who) < 0) throw new Error('bad who: ' + who);
  let s = sessions[who];
  if (!s) { s = sessions[who] = { phone: '', lastSentAt: 0, status: 'idle', lastMsg: '' }; }
  return s;
}

/* ---------- 对外能力 ---------- */

/**
 * 第一步：发送验证码。
 * @returns {ok, who, phone, message, cooldownMs}
 */
async function send(who, phone) {
  const s = getSession(who);
  const p = normalizePhone(phone);

  const elapsed = Date.now() - (s.lastSentAt || 0);
  if (s.lastSentAt && elapsed < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
    return { ok: false, who: who, phone: p, cooldown: true, waitSeconds: wait, message: '操作过于频繁，请 ' + wait + ' 秒后再试' };
  }

  const r = await httpsGet(
    '/api/sms/captcha/sent?cellphone=' + encodeURIComponent(p) + '&ctcode=86',
    { Cookie: jarToHeader(s.jar || {}) }
  );
  let j = {};
  try { j = JSON.parse(r.text); } catch (e) {}

  const code = (j && typeof j.code === 'number') ? j.code : 0;
  if (code === 200) {
    s.phone = p;
    s.lastSentAt = Date.now();
    s.status = 'sent';
    s.lastMsg = '验证码已发送';
    return { ok: true, who: who, phone: p, cooldownMs: COOLDOWN_MS, message: '验证码已发送，请查收短信' };
  }

  /* 错误细化 */
  let msg = (j && j.message) || '发送失败';
  if (code === 400) msg = '手机号不符合规范';
  else if (code === 501 || /频繁|太多/.test(String(msg))) msg = '发送过于频繁，请稍后再试';
  return { ok: false, who: who, phone: p, code: code, message: msg };
}

/**
 * 第二步：校验验证码并登录（weapi 加密换 cookie）。
 * @returns {ok, who, phone, code, message, saved?, identity?}
 */
async function verify(who, phone, captcha) {
  const s = getSession(who);
  const p = normalizePhone(phone);
  const c = String(captcha || '').trim();
  if (!/^\d{4,8}$/.test(c)) throw new Error('验证码格式不正确');

  const body = crypto.weapi({
    phone: p,
    countrycode: '86',
    captcha: c,
    rememberLogin: 'true',
  });
  const form = {
    params: body.params,
    encSecKey: body.encSecKey,
  };

  const r = await httpsPostForm(
    '/weapi/login/cellphone?csrf_token=',
    form,
    { Cookie: jarToHeader(s.jar || {}) }
  );
  const jar = mergeCookies(s.jar || (s.jar = {}), r.setCookie);

  let j = {};
  try { j = JSON.parse(r.text); } catch (e) {}

  const code = (j && typeof j.code === 'number') ? j.code : 0;
  const out = { ok: false, who: who, phone: p, code: code, message: (j && j.message) || '登录失败' };

  if (code === 200) {
    const cookie = finalizeCookie(jar);
    if (!/MUSIC_U=/.test(cookie)) {
      out.message = '登录成功但未拿到 MUSIC_U，请重试';
      return out;
    }
    const st = identity.saveCookie(who, cookie);
    out.ok = true;
    out.message = '登录成功';
    out.saved = true;
    out.cookieStatus = st;
    out.identity = identity.status();
    delete sessions[who];
    return out;
  }

  /* 错误细化 */
  if (code === 503) out.message = '验证码错误或已过期';
  else if (code === 400) out.message = '手机号格式不正确';
  else if (code === 501) out.message = '该手机号未注册网易云账号';
  else if (code === 502 || /密码|风险/.test(String(out.message))) out.message = '账号存在风控，请稍后再试或用扫码登录';
  return out;
}

/** 仅校验验证码（不登录，调试用；走 GET sms/captcha/verify） */
async function checkCode(who, phone, captcha) {
  const s = getSession(who);
  const p = normalizePhone(phone);
  const c = String(captcha || '').trim();
  const r = await httpsGet(
    '/api/sms/captcha/verify?cellphone=' + encodeURIComponent(p) + '&ctcode=86&captcha=' + encodeURIComponent(c),
    { Cookie: jarToHeader(s.jar || {}) }
  );
  let j = {};
  try { j = JSON.parse(r.text); } catch (e) {}
  return { ok: !!(j && j.code === 200), code: (j && j.code) || 0, message: (j && j.message) || '' };
}

/** 会话状态（供 UI 回显） */
function sessionStatus(who) {
  const s = sessions[who];
  if (!s) return { active: false };
  const elapsed = Date.now() - (s.lastSentAt || 0);
  return {
    active: true,
    who: who,
    phone: s.phone ? (s.phone.slice(0, 3) + '****' + s.phone.slice(-4)) : '',
    status: s.status,
    message: s.lastMsg,
    cooldownLeft: s.lastSentAt && elapsed < COOLDOWN_MS ? Math.ceil((COOLDOWN_MS - elapsed) / 1000) : 0,
  };
}

/** 取消 / 清理会话 */
function cancel(who) {
  if (who) { delete sessions[who]; }
  else { Object.keys(sessions).forEach(function (k) { delete sessions[k]; }); }
  return { ok: true };
}

module.exports = {
  send: send, verify: verify, checkCode: checkCode,
  sessionStatus: sessionStatus, cancel: cancel,
  finalizeCookie: finalizeCookie, COOLDOWN_MS: COOLDOWN_MS,
};