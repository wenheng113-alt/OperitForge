'use strict';
/**
 * ============================================================
 *  native/crypto.js — 网易云 weapi 加密（P2 扩展 / 短信登录用）
 * ------------------------------------------------------------
 *  背景（2026 实测）：
 *    老版明文接口 /api/login/cellphone 已强制加密，
 *    直接 GET 返回 {"code":401,"msg":"无权限访问. ENC"}。
 *    故短信登录的「换 cookie」一步必须走 weapi 加密通道。
 *
 *  实现：纯 Node 内置 crypto + BigInt，零 npm 依赖。
 *    - AES-128-CBC 双重加密（固定 nonce 密钥 + 随机 secKey）
 *    - RSA（textbook，无填充）加密 secKey：反转 → hex → 模幂
 *
 *  weapi 输出：{ params, encSecKey }，POST 到 /weapi/xxx?csrf_token=...
 * ============================================================
 */
const crypto = require('crypto');

/** weapi 固定参数（网易公开常量，与官方前端一致） */
const NONCE = '0CoJUm6Qyw8W8jud';
const IV = '0102030405060708';
const PUBKEY = '010001';
const MODULUS =
  '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725' +
  '152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e031' +
  '2ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b4' +
  '24d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';

/** 16 位随机密钥（小写字母+数字） */
function createSecretKey(size) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let key = '';
  const buf = crypto.randomBytes(size);
  for (let i = 0; i < size; i++) key += chars[buf[i] % chars.length];
  return key;
}

/** AES-128-CBC 加密 → base64 */
function aesEncrypt(text, key) {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(IV));
  return Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()]).toString('base64');
}

/**
 * RSA 加密（无填充，网易专用）：
 *   明文反转 → utf8 转 hex → BigInt → (m^e mod n) → 256 位 hex
 */
function rsaEncrypt(text) {
  const reversed = text.split('').reverse().join('');
  const hex = Buffer.from(reversed, 'utf8').toString('hex');
  const base = BigInt('0x' + hex);
  const exp = BigInt('0x' + PUBKEY);
  const mod = BigInt('0x' + MODULUS);
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  let out = result.toString(16);
  while (out.length < 256) out = '0' + out;
  return out;
}

/**
 * 把对象加密成 weapi 请求体。
 * @param {object} obj 明文参数
 * @returns {{params:string, encSecKey:string}}
 */
function weapi(obj) {
  const text = JSON.stringify(obj || {});
  const secKey = createSecretKey(16);
  const params = aesEncrypt(aesEncrypt(text, NONCE), secKey);
  const encSecKey = rsaEncrypt(secKey);
  return { params: params, encSecKey: encSecKey };
}

/* ==================================================================
 * eapi 加密（2026-09 新增）
 * ------------------------------------------------------------------
 *  背景：一起听全部接口在官方客户端走 **eapi 移动端协议**，
 *  我们此前全程走 weapi PC 协议（os=pc + PC UA），
 *  导致邀请卡缺少移动端版本语义，真人 APP 点卡提示「对方版本较低」。
 *
 *  eapi 格式（逆向官方客户端 + 参考实现 cross-check）：
 *    digest = md5("nobody" + path + "use" + body + "md5forencrypt")
 *    plain  = path + "-36cd479b6b5-" + body + "-36cd479b6b5-" + digest
 *    params = HEX(AES-128-ECB(PKCS7(plain), key="e82ckenh8dichen8")).toUpperCase()
 *    提交到 https://interface.music.163.com/eapi<path 去掉 /api 前缀>
 *
 *  ⚠️ 关键坑：官方是「手工 PKCS#7 填充」，而 Node createCipheriv
 *     默认还会自动填充一次 → 双重填充 → 密文长度错 → 空响应/400。
 *     故所有 AES 一律 setAutoPadding(false)，只保留手工填充。
 * ================================================================== */

/** eapi：AES-128-ECB 固定密钥 */
const EAPI_KEY = Buffer.from('e82ckenh8dichen8', 'utf8');
/** eapi：请求体拼接用的魔术分隔符 */
const EAPI_SEPARATOR = '-36cd479b6b5-';

/** PKCS#7 手工填充到 16 字节对齐（恰好对齐时也补满一整块） */
function pkcs7Pad(data) {
  const padLength = 16 - (data.length % 16);
  return Buffer.concat([data, Buffer.alloc(padLength, padLength)]);
}

/** AES 裸加密（关闭自动填充），返回原始字节 */
function aesEncryptRaw(data, key, iv, algorithm) {
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/** AES-128-ECB 加密 → 大写 hex（eapi 需要的格式），内部做 PKCS#7 填充 */
function aesEcbHex(data, key) {
  return aesEncryptRaw(pkcs7Pad(data), key, null, 'aes-128-ecb')
    .toString('hex')
    .toUpperCase();
}

/** 把 payload 序列化成 eapi 需要的紧凑 JSON（body 必须带 header） */
function encodeEapiBody(payload) {
  if (typeof payload === 'string') return payload;
  const body = Object.assign({}, payload || {});
  if (body.header === undefined || body.header === null) body.header = '{}';
  return JSON.stringify(body);
}

/** 计算 eapi 摘要：md5("nobody"+path+"use"+body+"md5forencrypt") */
function eapiDigest(path, body) {
  return crypto
    .createHash('md5')
    .update('nobody' + path + 'use' + body + 'md5forencrypt', 'utf8')
    .digest('hex');
}

/**
 * 生成 eapi 的 params。
 * @param {string} path 传 /api/xxx 形式（不是 /eapi/xxx）
 * @param {object|string} payload
 * @returns {string} 大写 hex 密文
 */
function eapiEncrypt(path, payload) {
  const body = encodeEapiBody(payload);
  const digest = eapiDigest(path, body);
  const plain = path + EAPI_SEPARATOR + body + EAPI_SEPARATOR + digest;
  return aesEcbHex(Buffer.from(plain, 'utf8'), EAPI_KEY);
}

/**
 * 把 /api/xxx 转成 eapi 实际请求路径。
 * eapi base 已含 /eapi，故剥掉 /api 前缀：
 *   /api/listen/together/heartbeat -> /listen/together/heartbeat
 */
function eapiPathSuffix(path) {
  return path.indexOf('/api') === 0 ? path.slice(4) : path;
}

module.exports = {
  // weapi（保留：短信登录 smslogin.js 仍在用）
  weapi: weapi,
  aesEncrypt: aesEncrypt,
  rsaEncrypt: rsaEncrypt,
  createSecretKey: createSecretKey,
  // eapi（新增）
  EAPI_KEY: EAPI_KEY,
  EAPI_SEPARATOR: EAPI_SEPARATOR,
  pkcs7Pad: pkcs7Pad,
  aesEcbHex: aesEcbHex,
  encodeEapiBody: encodeEapiBody,
  eapiDigest: eapiDigest,
  eapiEncrypt: eapiEncrypt,
  eapiPathSuffix: eapiPathSuffix,
};
