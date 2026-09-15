'use strict';
/**
 * tools_verify_pkg_v2.js
 * 校验 /tmp/nl_pkg_new/packages/netease_listen.js 载荷结构：
 *  - 10 个载荷键齐全
 *  - jobs 含 native 目录
 *  - 就绪阈值 >= 10
 *  - n_driver 解码后与源 native/driver.js 逐字节一致
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const F = '/tmp/nl_pkg_new/packages/netease_listen.js';
const s = fs.readFileSync(F, 'utf8');

const KEYS = ['server', 'player', 'lottie', 'disk',
  'n_driver', 'n_ltapi', 'n_identity', 'n_crypto', 'n_qrlogin', 'n_smslogin'];

console.log('=== 载荷键检查 ===');
let allOk = true;
for (const k of KEYS) {
  const re = new RegExp('(^|\\n)' + k + ':"');
  const hit = re.test(s);
  console.log((hit ? 'OK  ' : 'MISS') + '  ' + k);
  if (!hit) allOk = false;
}

console.log('=== 锚点文本检查 ===');
const checks = [
  ['jobs 含 native 目录', /SERVER_DIR\s*\+\s*'\/native\//.test(s)],
  ['阈值 >= 10', /trim\(\)\)\s*>=\s*10\)\s*return false/.test(s)],
  ['mkdir 含 native', /\$\{SERVER_DIR\}\/native && rm -f/.test(s)],
];
for (const [name, ok] of checks) {
  console.log((ok ? 'OK  ' : 'MISS') + '  ' + name);
  if (!ok) allOk = false;
}

// 解码 n_driver 与源文件比对
function extractB64(src, key) {
  const idx = src.indexOf('\n' + key + ':"');
  if (idx < 0) return null;
  const start = idx + ('\n' + key + ':"').length;
  const end = src.indexOf('"', start);
  return src.slice(start, end);
}

console.log('=== native 解码比对 ===');
const natRoot = path.join(ROOT, 'native');
const map = {
  n_driver: 'driver.js',
  n_ltapi: 'ltapi.js',
  n_identity: 'identity.js',
  n_crypto: 'crypto.js',
  n_qrlogin: 'qrlogin.js',
  n_smslogin: 'smslogin.js',
};
for (const [key, file] of Object.entries(map)) {
  const b64 = extractB64(s, key);
  if (!b64) { console.log('MISS ' + key); allOk = false; continue; }
  const dec = Buffer.from(b64, 'base64');
  const orig = fs.readFileSync(path.join(natRoot, file));
  const same = Buffer.compare(dec, orig) === 0;
  console.log((same ? 'OK  ' : 'DIFF') + '  ' + key + ' -> ' + file +
    ' dec=' + dec.length + ' orig=' + orig.length);
  if (!same) allOk = false;
}

console.log(allOk ? 'PKG_VERIFY_OK' : 'PKG_VERIFY_FAIL');
