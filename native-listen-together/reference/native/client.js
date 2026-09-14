'use strict';
/**
 * 网易云原生请求客户端（按身份发请求）。
 *
 * 与 server.js 现有的 fetchUpstreamJson / proxyReq 的区别：
 *   那两个走本地容器（NeteaseCloudMusicApi），不加密、不携带凭证；
 *   本模块在本地做 eapi/weapi 加密，直接打官方接口 interface.music.163.com，
 *   并按身份（ai / human）注入不同 cookie。
 *
 * ⚠️ 参考实现，尚未接入 server.js。零依赖：只用 node:http/https/crypto。
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const { eapiEncrypt, eapiPathSuffix, weapiEncrypt } = require('./crypto.js');

/** 官方接口入口。 */
const ENDPOINTS = {
  eapiBase: 'https://interface.music.163.com/eapi',
  weapiBase: 'https://music.163.com/weapi',
};

/** 请求头。eapi 用移动端 UA，weapi 用 PC UA。 */
const USER_AGENTS = {
  mobile:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  pc:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const REFERER = 'https://music.163.com/';

/**
 * 设备信息 cookie。
 * 官方客户端总会带这些匿名标识，缺了容易被判定为非常规客户端。
 * appver / os 是关键，weapi 还额外要求 os=pc。
 */
const DEVICE_COOKIE =
  'os=android; appver=9.1.0; osver=13; deviceId=ncm-native-listen; ' +
  'channel=netease; __remember_me=true';

/**
 * 合并 cookie 片段：设备信息在前，登录态在后，重复 key 以后者为准。
 * @param {...string} parts
 * @returns {string}
 */
function mergeCookies() {
  const seen = new Map();
  for (let i = 0; i < arguments.length; i += 1) {
    const part = arguments[i];
    if (!part) continue;
    String(part)
      .split(';')
      .forEach(function (kv) {
        const s = kv.trim();
        if (!s) return;
        const eq = s.indexOf('=');
        if (eq <= 0) return;
        seen.set(s.slice(0, eq).trim(), s);
      });
  }
  return Array.from(seen.values()).join('; ');
}

/**
 * 表单 POST，返回解析后的 JSON。
 * @param {string} url
 * @param {Record<string,string>} form
 * @param {object} opts
 * @returns {Promise<object>}
 */
function postForm(url, form, opts) {
  const o = opts || {};
  const body = new URLSearchParams(form).toString();
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const headers = Object.assign(
    {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
    o.headers || {},
  );

  return new Promise(function (resolve, reject) {
    let settled = false;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: headers,
      },
      function (res) {
        let buf = '';
        res.on('data', function (c) { buf += c; });
        res.on('end', function () {
          if (settled) return;
          settled = true;
          if (res.statusCode !== 200) {
            return reject(
              new Error('HTTP ' + res.statusCode + ' url=' + url + ' body=' + buf.slice(0, 200)),
            );
          }
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(new Error('响应不是 JSON: ' + buf.slice(0, 200)));
          }
        });
      },
    );
    req.on('error', function (e) {
      if (!settled) { settled = true; reject(e); }
    });
    const timeout = o.timeoutMs || 15000;
    req.setTimeout(timeout, function () {
      if (!settled) { settled = true; try { req.destroy(); } catch (e) {} reject(new Error('请求超时')); }
    });
    req.write(body);
    req.end();
  });
}

/**
 * 原生客户端：每个实例绑定一个身份。
 */
class NativeClient {
  /**
   * @param {object} options
   * @param {string} options.cookie 该身份的登录 cookie
   * @param {string} [options.who] 身份标识，仅用于日志
   */
  constructor(options) {
    const o = options || {};
    if (!o.cookie) throw new Error('NativeClient 需要 cookie');
    this.cookie = o.cookie;
    this.who = o.who || 'unknown';
  }

  /**
   * eapi 请求。
   * @param {string} path 形如 /api/xxx
   * @param {Record<string,unknown>} [payload]
   * @param {object} [opts]
   * @returns {Promise<object>}
   */
  async eapiRequest(path, payload, opts) {
    const params = eapiEncrypt(path, payload || {});
    const cookie = mergeCookies(DEVICE_COOKIE, this.cookie);
    return postForm(ENDPOINTS.eapiBase + eapiPathSuffix(path), { params: params }, {
      headers: { Cookie: cookie, 'User-Agent': USER_AGENTS.mobile, Referer: REFERER },
      timeoutMs: (opts && opts.timeoutMs) || 15000,
    });
  }

  /**
   * weapi 请求。cookie 必须带 os=pc。
   * @param {string} path 形如 /msg/private/send
   * @param {Record<string,unknown>} [payload]
   * @param {object} [opts]
   * @returns {Promise<object>}
   */
  async weapiRequest(path, payload, opts) {
    const enc = weapiEncrypt(payload || {});
    // weapi 的 path 不带 /api 前缀
    const suffix = path.replace(/^\/api/, '');
    const cookie = mergeCookies(DEVICE_COOKIE, this.cookie, 'os=pc');
    return postForm(ENDPOINTS.weapiBase + suffix, enc, {
      headers: { Cookie: cookie, 'User-Agent': USER_AGENTS.pc, Referer: REFERER },
      timeoutMs: (opts && opts.timeoutMs) || 15000,
    });
  }

  /** 连通性/登录态自检：拿自己的账号信息。 */
  async probe() {
    return this.eapiRequest('/api/nuser/account/get', {});
  }
}

/**
 * 由身份存储创建客户端。
 * @param {import('./identity.js').IdentityStore} store
 * @param {'ai'|'human'} who
 * @returns {NativeClient}
 */
function clientForIdentity(store, who) {
  const cookie = store.load(who);
  if (!cookie) throw new Error('身份 ' + who + ' 尚未导入 cookie');
  return new NativeClient({ cookie: cookie, who: who });
}

/**
 * 生成一个不会被误认成真实用户的设备 ID（每进程稳定）。
 */
function stableDeviceId() {
  return crypto.createHash('md5').update(String(process.pid) + Date.now()).digest('hex').slice(0, 16);
}

module.exports = {
  ENDPOINTS: ENDPOINTS,
  USER_AGENTS: USER_AGENTS,
  DEVICE_COOKIE: DEVICE_COOKIE,
  mergeCookies: mergeCookies,
  postForm: postForm,
  NativeClient: NativeClient,
  clientForIdentity: clientForIdentity,
  stableDeviceId: stableDeviceId,
};
