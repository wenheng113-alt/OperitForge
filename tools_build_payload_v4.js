'use strict';
/**
 * tools_build_payload_v4.js — 稳健版
 * 直接解析 toolpkg 源码里的 `const PAYLOAD={...}` 对象，更新 server/player/native，
 * 再重新序列化回源码。避免依赖 jobs/files 文本锚点。
 *
 * 输入：/tmp/pkgx/packages/netease_listen.js（当前 1.0.7）
 * 输出：/tmp/nl_pkg_v4/
 */
const fs = require('fs');
const path = require('path');

const ROOT = '/data/user/0/com.ai.assistance.operit/files/workspace/0b64e418-1e3c-474c-ac69-5d982078c232/p1/netease-listen';
const PKG_SRC = '/tmp/pkgx/packages/netease_listen.js';
const OUT_DIR = '/tmp/nl_pkg_v4';

function b64(p) { return fs.readFileSync(p).toString('base64'); }

let src = fs.readFileSync(PKG_SRC, 'utf8');
const before = src.length;

/* ---- 1) 提取 PAYLOAD 对象字面量并 eval ---- */
const start = src.indexOf('const PAYLOAD=');
if (start < 0) throw new Error('PAYLOAD not found');
const objStart = src.indexOf('{', start);
// 找匹配的结束 '}'（考虑字符串内的 } —— 这里用简单的括号计数，字符串只含 base64 无 {}）
let depth = 0, objEnd = -1, inStr = false, q = '';
for (let i = objStart; i < src.length; i++) {
  const ch = src[i];
  if (inStr) {
    if (ch === '\\') { i++; continue; }
    if (ch === q) { inStr = false; }
    continue;
  }
  if (ch === '"' || ch === "'") { inStr = true; q = ch; continue; }
  if (ch === '{') depth++;
  else if (ch === '}') { depth--; if (depth === 0) { objEnd = i; break; } }
}
if (objEnd < 0) throw new Error('PAYLOAD end not found');
const objLit = src.slice(objStart, objEnd + 1);
const PAYLOAD = eval('(' + objLit + ')');
console.log('parsed PAYLOAD keys:', Object.keys(PAYLOAD).join(','));
console.log('existing native keys:', Object.keys(PAYLOAD.native || {}).join(','));

/* ---- 2) 更新 server / player ---- */
PAYLOAD.server = b64(path.join(ROOT, 'server.js'));
PAYLOAD.player = b64(path.join(ROOT, 'public/player.html'));

/* ---- 3) 更新 native：键名 = 文件名 ---- */
const NATIVE_FILES = [
  'crypto.js', 'driver.js', 'identity.js', 'ltapi.js', 'message.js',
  'qrlogin.js', 'smslogin.js', 'invite.js', 'sync.js', 'im.js', 'roomwatch.js',
];
const native = {};
// 先保留已有的其它键（若有不在列表中的，按原名保留）
Object.keys(PAYLOAD.native || {}).forEach((k) => {
  if (NATIVE_FILES.indexOf(k) < 0) native[k] = PAYLOAD.native[k];
});
NATIVE_FILES.forEach((f) => {
  const p = path.join(ROOT, 'native', f);
  if (fs.existsSync(p)) native[f] = b64(p);
  else console.log('  !! missing native file:', f);
});
PAYLOAD.native = native;
console.log('new native keys:', Object.keys(native).join(','));

/* ---- 4) 重新序列化 PAYLOAD ---- */
const newLit = JSON.stringify(PAYLOAD);
src = src.slice(0, objStart) + newLit + src.slice(objEnd + 1);

/* ---- 5) 就绪阈值：need = files.length 已动态，无需改文本。
 *         在「清理残留进程」前插入 nim 安装（best-effort） ---- */
const bootAnchor = "  // 清理可能占用端口的残留进程";
if (src.indexOf(bootAnchor) >= 0 && src.indexOf('nl_nim_install.log') < 0) {
  const nimStep = `  // 读房间消息依赖 nim-web-sdk-ng（浏览器产物）。best-effort：装失败只影响读消息。
  try {
    const hasSdk = await sh(\`test -d \${SERVER_DIR}/node_modules/nim-web-sdk-ng && echo YES || echo NO\`, 8000);
    if (!hasSdk || String(hasSdk.output).indexOf('YES') < 0) {
      await sh(\`cd \${SERVER_DIR} && (npm install nim-web-sdk-ng@10.11.0 --no-audit --no-fund --registry=https://registry.npmmirror.com > /tmp/nl_nim_install.log 2>&1 &) ; echo NIM_INSTALL_STARTED\`, 8000);
    }
  } catch (e) {}
`;
  src = src.replace(bootAnchor, nimStep + bootAnchor);
}

/* ---- 6) 写盘 ---- */
fs.mkdirSync(path.join(OUT_DIR, 'packages'), { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, 'ui/listen_together'), { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, 'ui/listen_card'), { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'packages/netease_listen.js'), src);

for (const f of ['manifest.json', 'main.js']) {
  fs.copyFileSync(path.join('/tmp/pkgx', f), path.join(OUT_DIR, f));
}
fs.copyFileSync('/tmp/pkgx/ui/listen_together/index.ui.js', path.join(OUT_DIR, 'ui/listen_together/index.ui.js'));
fs.copyFileSync('/tmp/pkgx/ui/listen_card/index.ui.js', path.join(OUT_DIR, 'ui/listen_card/index.ui.js'));

console.log('BUILD_V4_OK');
console.log('src size:', before, '->', src.length);
console.log('serverB64:', PAYLOAD.server.length, 'playerB64:', PAYLOAD.player.length);