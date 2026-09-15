'use strict';
/**
 * ============================================================
 *  native/identity.js — 双 cookie 存取（P2 阶段）
 * ------------------------------------------------------------
 *  职责：
 *    - 保存 / 读取 / 清除两个身份（ai / human）的网易云 cookie
 *    - 落盘位置：credentials/ai.cookie.txt、credentials/human.cookie.txt
 *    - 权限：目录 0700，文件 0600（凭据严禁入库，已加入 .gitignore）
 *    - 对外只暴露「脱敏」状态，明文只在读取时供内部协议使用
 *
 *  与参考实现（reference/native/identity.js ~190 行）对齐：
 *    0600 落盘、脱敏、双身份互不干扰。
 * ============================================================
 */
const fs = require('fs');
const path = require('path');

/** 凭据目录（运行时生成，必须 gitignore） */
const CRED_DIR = path.join(__dirname, '..', 'credentials');
/** 身份 → 文件名 */
const FILES = { ai: 'ai.cookie.txt', human: 'human.cookie.txt' };
/** 合法身份 */
const WHOS = ['ai', 'human'];

function ensureDir() {
  try { fs.mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 }); } catch (e) {}
  try { fs.chmodSync(CRED_DIR, 0o700); } catch (e) {}
}

function pathFor(who) {
  if (WHOS.indexOf(who) < 0) throw new Error('bad who: ' + who);
  return path.join(CRED_DIR, FILES[who]);
}

/** 脱敏：只保留头尾少量字符，中间省略（用于 UI 回显 / 日志） */
function maskCookie(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.length <= 16) return s.slice(0, 2) + '****';
  return s.slice(0, 8) + '……' + s.slice(-6);
}

/** 保存某身份的 cookie（覆盖写入，强制 0600） */
function saveCookie(who, cookie) {
  const c = String(cookie || '').trim();
  if (!c) throw new Error('empty cookie');
  ensureDir();
  const f = pathFor(who);
  fs.writeFileSync(f, c, { mode: 0o600 });
  try { fs.chmodSync(f, 0o600); } catch (e) {}
  return oneStatus(who);
}

/** 读取某身份的 cookie 明文（内部协议用，勿外泄） */
function readCookie(who) {
  try { return fs.readFileSync(pathFor(who), 'utf8').trim(); } catch (e) { return ''; }
}

/** 单个身份的脱敏状态 */
function oneStatus(who) {
  let raw = '';
  let st = null;
  try {
    raw = fs.readFileSync(pathFor(who), 'utf8').trim();
    st = fs.statSync(pathFor(who));
  } catch (e) {}
  const present = !!raw;
  let mode = null;
  if (st) mode = '0' + (st.mode & 0o777).toString(8);
  return {
    present: present,
    len: raw.length,
    masked: present ? maskCookie(raw) : '',
    mode: mode,
    updatedAt: st ? st.mtimeMs : 0,
  };
}

/** 两个身份的整体状态（供 /native/cookie/status 与 UI 回显） */
function status() {
  return { ai: oneStatus('ai'), human: oneStatus('human'), dir: CRED_DIR };
}

/** 清除某身份的 cookie */
function clearCookie(who) {
  try { fs.unlinkSync(pathFor(who)); } catch (e) {}
  return oneStatus(who);
}

module.exports = { WHOS, saveCookie, readCookie, status, clearCookie, maskCookie };
