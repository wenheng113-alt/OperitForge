'use strict';
/**
 * 网易云 eapi / weapi 请求体加密 —— 逆向自官方客户端抓包。
 *
 * ⚠️ 参考实现：本文件尚未接入 server.js，供二次开发参考。
 * 依赖仅 node:crypto，符合项目「零依赖」约束。
 *
 * eapi 格式：
 *   digest = md5("nobody" + path + "use" + body + "md5forencrypt")
 *   data   = path + "-36cd479b6b5-" + body + "-36cd479b6b5-" + digest
 *   params = HEX(AES-128-ECB(PKCS7(data), key="e82ckenh8dichen8")).toUpperCase()
 *   提交到 https://interface.music.163.com/eapi<path 去掉 /api 前缀>
 *
 * weapi 格式：
 *   first     = BASE64(AES-128-CBC(body, key="0CoJUm6Qyw8W8jud", iv="0102030405060708"))
 *   params    = BASE64(AES-128-CBC(first, secKey, iv))
 *   encSecKey = RSA(secKey)   // 明文反转 + 裸模幂，非 PKCS#1
 *
 * ── 关键坑（实测踩过，务必保留）────────────────────────────────
 * Node 的 createCipheriv 默认会自动 PKCS#7 填充，而官方客户端是「手工填充」。
 * 若不关掉自动填充，就会变成「手工填充 + 自动填充」的双重填充，
 * 密文长度直接错一截，服务端解密失败（表现为空响应 / 400）。
 * 所以下面所有 AES 一律 setAutoPadding(false)，只保留手工填充。
 */
const crypto = require('crypto');

/* ------------------------------------------------------------------ 常量 */

/** eapi：AES-128-ECB 固定密钥。 */
const EAPI_KEY = Buffer.from('e82ckenh8dichen8', 'utf8');

/** eapi：请求体拼接用的魔术分隔符。 */
const EAPI_SEPARATOR = '-36cd479b6b5-';

/** weapi：第一层 AES-128-CBC 的固定密钥与 IV。 */
const WEAPI_KEY = Buffer.from('0CoJUm6Qyw8W8jud', 'utf8');
const WEAPI_IV = Buffer.from('0102030405060708', 'utf8');

/** weapi：RSA 公钥指数，固定 65537。 */
const WEAPI_PUBKEY_E = 0x10001n;

/**
 * weapi：RSA 模数（1024 位）。
 * 官方用的是「无填充裸 RSA」：明文反转后直接做模幂，没有 PKCS#1 结构，
 * 因此 node:crypto 的 publicEncrypt 用不了，必须自己算大数幂。
 */
const WEAPI_MODULUS = BigInt(
  '0x' +
    '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a' +
    '876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114a' +
    'f6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef5274' +
    '1d546b8e289dc6935b3ece0462db0a22b8e7',
);

/** weapi：随机 secKey 的字符表。 */
const WEAPI_SECKEY_ALPHABET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** weapi：随机 secKey 长度，固定 16。 */
const WEAPI_SECKEY_LENGTH = 16;

/* ------------------------------------------------------------ 填充与 AES */

/**
 * PKCS#7 填充到 16 字节对齐。
 * 恰好对齐时也要补满一个整块（补 16 个 0x10），这是 PKCS#7 的规定。
 * @param {Buffer} data
 * @returns {Buffer}
 */
function pkcs7Pad(data) {
  const padLength = 16 - (data.length % 16);
  return Buffer.concat([data, Buffer.alloc(padLength, padLength)]);
}

/**
 * 去掉 PKCS#7 填充（解密后用，主要供自检与调试）。
 * @param {Buffer} data
 * @returns {Buffer}
 */
function pkcs7Unpad(data) {
  if (data.length === 0) return data;
  const padLength = data[data.length - 1];
  if (padLength < 1 || padLength > 16 || padLength > data.length) return data;
  return data.subarray(0, data.length - padLength);
}

/**
 * AES 裸加密（关闭自动填充），返回原始字节。
 * @param {Buffer} data 已手工填充到 16 字节对齐的数据
 * @param {Buffer} key
 * @param {Buffer|null} iv ECB 传 null
 * @param {string} algorithm
 * @returns {Buffer}
 */
function aesEncryptRaw(data, key, iv, algorithm) {
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/**
 * AES-128-ECB 加密，输出大写 hex（eapi 需要的格式）。
 * @param {Buffer} data 明文，内部会做 PKCS#7 填充
 * @param {Buffer} key
 * @returns {string}
 */
function aesEcbHex(data, key) {
  return aesEncryptRaw(pkcs7Pad(data), key, null, 'aes-128-ecb')
    .toString('hex')
    .toUpperCase();
}

/**
 * AES-128-CBC 加密，输出 base64（weapi 需要的格式）。
 * @param {Buffer} data 明文，内部会做 PKCS#7 填充
 * @param {Buffer} key
 * @param {Buffer} iv
 * @returns {string}
 */
function aesCbcBase64(data, key, iv) {
  return aesEncryptRaw(pkcs7Pad(data), key, iv, 'aes-128-cbc').toString('base64');
}

/**
 * AES-128-CBC 解密并去填充（仅用于自检，服务端用不到）。
 * @param {string} base64Text
 * @param {Buffer} key
 * @param {Buffer} iv
 * @returns {Buffer}
 */
function aesCbcDecryptBase64(base64Text, key, iv) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  const raw = Buffer.concat([
    decipher.update(Buffer.from(base64Text, 'base64')),
    decipher.final(),
  ]);
  return pkcs7Unpad(raw);
}

/* ------------------------------------------------------------------ eapi */

/**
 * 把 payload 序列化成 eapi 需要的紧凑 JSON。
 * 传字符串时原样使用（供 raw 覆盖用法）。
 * @param {Record<string, unknown>|string} payload
 * @returns {string}
 */
function encodeEapiBody(payload) {
  if (typeof payload === 'string') return payload;
  const body = Object.assign({}, payload || {});
  // 官方要求 body 里必须带 header，缺了会返回空响应或 400。
  if (body.header === undefined || body.header === null) body.header = '{}';
  return JSON.stringify(body);
}

/**
 * 计算 eapi 摘要。
 * @param {string} path 形如 /api/xxx 的原始路径
 * @param {string} body 紧凑 JSON 字符串
 * @returns {string} 32 位小写 hex
 */
function eapiDigest(path, body) {
  return crypto
    .createHash('md5')
    .update('nobody' + path + 'use' + body + 'md5forencrypt', 'utf8')
    .digest('hex');
}

/**
 * 生成 eapi 的 params。
 * @param {string} path 传 /api/xxx 形式（不是 /eapi/xxx）
 * @param {Record<string, unknown>|string} payload
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
 * eapi base 已含 /eapi，所以要剥掉 /api 前缀：
 *   /api/listen/together/heartbeat -> /listen/together/heartbeat
 * @param {string} path
 * @returns {string}
 */
function eapiPathSuffix(path) {
  return path.indexOf('/api') === 0 ? path.slice(4) : path;
}

/* ----------------------------------------------------------------- weapi */

/**
 * 大数模幂：base^exp mod modulus（平方-乘法）。
 * 1024 位密钥下 <1ms，足够快。
 * @param {bigint} base
 * @param {bigint} exp
 * @param {bigint} modulus
 * @returns {bigint}
 */
function modPow(base, exp, modulus) {
  let result = 1n;
  let b = base % modulus;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

/**
 * 把字符串按 UTF-8 编码、反转字节序，读成大端整数。
 * @param {string} text
 * @returns {bigint}
 */
function reversedBytesToBigInt(text) {
  const bytes = Buffer.from(text, 'utf8');
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    value = (value << 8n) | BigInt(bytes[i]);
  }
  return value;
}

/**
 * 网易云式 RSA 加密（裸模幂，无 PKCS#1 填充）。
 * @param {string} text 一般是 16 位 secKey
 * @returns {string} 256 位 hex（可能有前导 0）
 */
function rsaEncrypt(text) {
  const message = reversedBytesToBigInt(text);
  const encrypted = modPow(message, WEAPI_PUBKEY_E, WEAPI_MODULUS);
  return encrypted.toString(16).padStart(256, '0');
}

/**
 * 生成随机 secKey。
 * 用 crypto.randomInt 而非 Math.random，避免弱随机。
 * @param {number} [length]
 * @returns {string}
 */
function randomSecKey(length) {
  const len = length || WEAPI_SECKEY_LENGTH;
  let key = '';
  for (let i = 0; i < len; i += 1) {
    key += WEAPI_SECKEY_ALPHABET[crypto.randomInt(WEAPI_SECKEY_ALPHABET.length)];
  }
  return key;
}

/**
 * 生成 weapi 的 params 与 encSecKey。
 * @param {Record<string, unknown>} payload
 * @returns {{params: string, encSecKey: string}}
 */
function weapiEncrypt(payload) {
  const body = Buffer.from(JSON.stringify(payload || {}), 'utf8');
  const secKey = randomSecKey();
  const first = aesCbcBase64(body, WEAPI_KEY, WEAPI_IV);
  const params = aesCbcBase64(Buffer.from(first, 'utf8'), Buffer.from(secKey, 'utf8'), WEAPI_IV);
  return { params: params, encSecKey: rsaEncrypt(secKey) };
}

module.exports = {
  EAPI_KEY: EAPI_KEY,
  EAPI_SEPARATOR: EAPI_SEPARATOR,
  WEAPI_KEY: WEAPI_KEY,
  WEAPI_IV: WEAPI_IV,
  pkcs7Pad: pkcs7Pad,
  pkcs7Unpad: pkcs7Unpad,
  aesEcbHex: aesEcbHex,
  aesCbcBase64: aesCbcBase64,
  aesCbcDecryptBase64: aesCbcDecryptBase64,
  encodeEapiBody: encodeEapiBody,
  eapiDigest: eapiDigest,
  eapiEncrypt: eapiEncrypt,
  eapiPathSuffix: eapiPathSuffix,
  modPow: modPow,
  reversedBytesToBigInt: reversedBytesToBigInt,
  rsaEncrypt: rsaEncrypt,
  randomSecKey: randomSecKey,
  weapiEncrypt: weapiEncrypt,
};
