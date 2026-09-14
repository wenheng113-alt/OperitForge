'use strict';
/**
 * 双身份（AI / 真人）cookie 存取。
 *
 * 语义（来自需求）：
 *   - ai    : 真人给 AI 注册的网易云账号的 cookie（"aicookie"）
 *   - human : 真人自己的真实网易云账号 cookie
 *
 * 安全约定：
 *   - 落盘 0600，目录 0700
 *   - 绝不写进 git（.gitignore 必须包含 credentials/）
 *   - 对外只给脱敏摘要（maskCookie），不回显原文
 *
 * ⚠️ 参考实现，尚未接入 server.js。
 */
const fs = require('fs');
const path = require('path');

/** 两个身份。 */
const IDENTITIES = ['ai', 'human'];

/** cookie 里必须有这两项，缺了网易云一律当未登录。 */
const REQUIRED_COOKIE_FIELDS = ['MUSIC_U', '__csrf'];

/**
 * 解析 cookie 字符串为键值对。
 * @param {string} cookie
 * @returns {Record<string,string>}
 */
function parseCookie(cookie) {
  const out = {};
  String(cookie || '')
    .split(';')
    .forEach(function (part) {
      const i = part.indexOf('=');
      if (i <= 0) return;
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k) out[k] = v;
    });
  return out;
}

/**
 * 归一化 cookie：去空白、去首尾分号、保留原始顺序。
 * @param {string} cookie
 * @returns {string}
 */
function normalizeCookie(cookie) {
  return String(cookie || '')
    .replace(/\s+/g, ' ')
    .split(';')
    .map(function (s) { return s.trim(); })
    .filter(Boolean)
    .join('; ');
}

/**
 * 找出缺失的必需字段。
 * @param {string} cookie
 * @returns {string[]}
 */
function missingCookieFields(cookie) {
  const kv = parseCookie(cookie);
  return REQUIRED_COOKIE_FIELDS.filter(function (f) { return !kv[f]; });
}

/**
 * 脱敏：只保留每个值的前 4 位，用于日志和 UI 回显。
 * @param {string} cookie
 * @returns {string}
 */
function maskCookie(cookie) {
  const kv = parseCookie(cookie);
  const keys = Object.keys(kv);
  if (!keys.length) return '(empty)';
  return keys
    .map(function (k) {
      const v = kv[k];
      return k + '=' + (v.length <= 4 ? '****' : v.slice(0, 4) + '****');
    })
    .join('; ');
}

/**
 * 双身份 cookie 存储。
 */
class IdentityStore {
  /**
   * @param {object} [options]
   * @param {string} [options.dir] 凭证目录，默认 <项目>/credentials
   */
  constructor(options) {
    const opts = options || {};
    this.dir = opts.dir || path.join(__dirname, '..', 'credentials');
  }

  /**
   * 某个身份的 cookie 文件路径。
   * @param {string} who
   * @returns {string}
   */
  fileFor(who) {
    if (IDENTITIES.indexOf(who) < 0) throw new Error('未知身份: ' + who);
    return path.join(this.dir, who + '.cookie.txt');
  }

  /**
   * 保存 cookie。
   * @param {string} who
   * @param {string} cookie
   * @returns {{who: string, length: number, masked: string}}
   */
  save(who, cookie) {
    const norm = normalizeCookie(cookie);
    const missing = missingCookieFields(norm);
    if (missing.length) {
      throw new Error('cookie 缺少必需字段: ' + missing.join(', '));
    }
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.fileFor(who);
    fs.writeFileSync(file, norm, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch (e) { /* 平台不支持就跳过 */ }
    return { who: who, length: norm.length, masked: maskCookie(norm) };
  }

  /**
   * 读取 cookie，不存在返回 null。
   * @param {string} who
   * @returns {string|null}
   */
  load(who) {
    try {
      const v = fs.readFileSync(this.fileFor(who), 'utf8').trim();
      return v || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 是否已导入。
   * @param {string} who
   * @returns {boolean}
   */
  has(who) {
    return !!this.load(who);
  }

  /**
   * 两个身份的脱敏状态，供 UI / AI 工具回显。
   * @returns {{ai: object, human: object}}
   */
  status() {
    const self = this;
    const out = {};
    IDENTITIES.forEach(function (who) {
      const c = self.load(who);
      out[who] = c
        ? { imported: true, length: c.length, masked: maskCookie(c) }
        : { imported: false };
    });
    return out;
  }

  /**
   * 删除某个身份的 cookie。
   * @param {string} who
   * @returns {boolean}
   */
  remove(who) {
    try { fs.unlinkSync(this.fileFor(who)); return true; } catch (e) { return false; }
  }
}

module.exports = {
  IDENTITIES: IDENTITIES,
  REQUIRED_COOKIE_FIELDS: REQUIRED_COOKIE_FIELDS,
  parseCookie: parseCookie,
  normalizeCookie: normalizeCookie,
  missingCookieFields: missingCookieFields,
  maskCookie: maskCookie,
  IdentityStore: IdentityStore,
};
