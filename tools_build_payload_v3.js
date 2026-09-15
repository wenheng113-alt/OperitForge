'use strict';
/**
 * tools_build_payload_v3.js
 * 把 server.js + public/player.html + native/*.js（11 个）回灌进 toolpkg 源码载荷，
 * 并给 deployServer 追加 nim-web-sdk-ng 的 best-effort 自动安装（读房间消息用）。
 *
 * 输入：/tmp/pkgx（已解包的当前 toolpkg，含 1.0.7 的 packages/netease_listen.js）
 * 输出：/tmp/nl_pkg_v3/  （之后 zip 打包为 com.bailey.netease_listen.toolpkg）
 */
const fs = require('fs');
const path = require('path');

const ROOT = '/data/user/0/com.ai.assistance.operit/files/workspace/0b64e418-1e3c-474c-ac69-5d982078c232/p1/netease-listen';
const PKG_SRC = '/tmp/pkgx/packages/netease_listen.js';
const OUT_DIR = '/tmp/nl_pkg_v3';

/** native 文件 → 载荷键名（键名任意，部署时按 jobs 映射写盘） */
const NATIVE = [
  ['n_driver', 'driver.js'],
  ['n_ltapi', 'ltapi.js'],
  ['n_identity', 'identity.js'],
  ['n_crypto', 'crypto.js'],
  ['n_qrlogin', 'qrlogin.js'],
  ['n_smslogin', 'smslogin.js'],
  ['n_invite', 'invite.js'],
  ['n_message', 'message.js'],
  ['n_sync', 'sync.js'],
  ['n_im', 'im.js'],
  ['n_roomwatch', 'roomwatch.js'],
];

function b64(p) { return fs.readFileSync(p).toString('base64'); }

let src = fs.readFileSync(PKG_SRC, 'utf8');
const before = src.length;

/** 替换 PAYLOAD 里 <key>:"<b64>" 的值 */
function swap(key, val) {
  const anchor = key + ':"';
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error('anchor not found: ' + key);
  const s = i + anchor.length;
  const e = src.indexOf('"', s);
  if (e < 0) throw new Error('end quote not found: ' + key);
  src = src.slice(0, s) + val + src.slice(e);
}

swap('server', b64(path.join(ROOT, 'server.js')));
swap('player', b64(path.join(ROOT, 'public/player.html')));

/* 把 native 各键逐个写入（已存在则替换，不存在则追加在 disk 后） */
NATIVE.forEach(([k, f]) => {
  const val = b64(path.join(ROOT, 'native', f));
  const anchor = k + ':"';
  if (src.indexOf(anchor) >= 0) {
    swap(k, val);
  } else {
    const diskAnchor = 'disk:"';
    const i = src.indexOf(diskAnchor);
    const s = i + diskAnchor.length;
    const e = src.indexOf('"', s);
    src = src.slice(0, e + 1) + ',\n' + k + ':"' + val + '"' + src.slice(e + 1);
  }
});

/* jobs / files：把旧 6 native 列表整体替换为 11 native */
const jobsOld = `  const jobs = [
    ['server', SERVER_DIR + '/server.js'],
    ['player', SERVER_DIR + '/public/player.html'],
    ['lottie', SERVER_DIR + '/public/vendor/lottie.min.js'],
    ['disk',   SERVER_DIR + '/public/vendor/disk.png'],
    ['n_driver',   SERVER_DIR + '/native/driver.js'],
    ['n_ltapi',    SERVER_DIR + '/native/ltapi.js'],
    ['n_identity', SERVER_DIR + '/native/identity.js'],
    ['n_crypto',   SERVER_DIR + '/native/crypto.js'],
    ['n_qrlogin',  SERVER_DIR + '/native/qrlogin.js'],
    ['n_smslogin', SERVER_DIR + '/native/smslogin.js']
  ];`;
const jobsNew = `  const jobs = [
    ['server', SERVER_DIR + '/server.js'],
    ['player', SERVER_DIR + '/public/player.html'],
    ['lottie', SERVER_DIR + '/public/vendor/lottie.min.js'],
    ['disk',   SERVER_DIR + '/public/vendor/disk.png'],
    ['n_driver',    SERVER_DIR + '/native/driver.js'],
    ['n_ltapi',     SERVER_DIR + '/native/ltapi.js'],
    ['n_identity',  SERVER_DIR + '/native/identity.js'],
    ['n_crypto',    SERVER_DIR + '/native/crypto.js'],
    ['n_qrlogin',   SERVER_DIR + '/native/qrlogin.js'],
    ['n_smslogin',  SERVER_DIR + '/native/smslogin.js'],
    ['n_invite',    SERVER_DIR + '/native/invite.js'],
    ['n_message',   SERVER_DIR + '/native/message.js'],
    ['n_sync',      SERVER_DIR + '/native/sync.js'],
    ['n_im',        SERVER_DIR + '/native/im.js'],
    ['n_roomwatch', SERVER_DIR + '/native/roomwatch.js']
  ];`;
if (!src.includes(jobsOld)) throw new Error('jobs anchor NOT found (layout changed)');
src = src.replace(jobsOld, jobsNew);

const filesOld = `  const files = [
    SERVER_DIR + '/server.js',
    SERVER_DIR + '/public/player.html',
    SERVER_DIR + '/public/vendor/lottie.min.js',
    SERVER_DIR + '/public/vendor/disk.png',
    SERVER_DIR + '/native/driver.js',
    SERVER_DIR + '/native/ltapi.js',
    SERVER_DIR + '/native/identity.js',
    SERVER_DIR + '/native/crypto.js',
    SERVER_DIR + '/native/qrlogin.js',
    SERVER_DIR + '/native/smslogin.js'
  ];`;
const filesNew = `  const files = [
    SERVER_DIR + '/server.js',
    SERVER_DIR + '/public/player.html',
    SERVER_DIR + '/public/vendor/lottie.min.js',
    SERVER_DIR + '/public/vendor/disk.png',
    SERVER_DIR + '/native/driver.js',
    SERVER_DIR + '/native/ltapi.js',
    SERVER_DIR + '/native/identity.js',
    SERVER_DIR + '/native/crypto.js',
    SERVER_DIR + '/native/qrlogin.js',
    SERVER_DIR + '/native/smslogin.js',
    SERVER_DIR + '/native/invite.js',
    SERVER_DIR + '/native/message.js',
    SERVER_DIR + '/native/sync.js',
    SERVER_DIR + '/native/im.js',
    SERVER_DIR + '/native/roomwatch.js'
  ];`;
if (!src.includes(filesOld)) throw new Error('files anchor NOT found');
src = src.replace(filesOld, filesNew);

/* 就绪阈值 10 → 15 */
const chkOld = 'parseInt(String(c.output).trim()) >= 10) return false;';
const chkNew = 'parseInt(String(c.output).trim()) >= 15) return false;';
if (src.includes(chkOld)) src = src.replace(chkOld, chkNew);

/* 在「就绪校验」之前插入 nim-web-sdk-ng best-effort 安装（读房间消息依赖） */
const bootAnchor = "  // 清理可能占用端口的残留进程";
const nimStep = `  // 读房间消息依赖 nim-web-sdk-ng（浏览器产物，Node 里跑需它）。best-effort：
  // 装失败不影响 HTTP 侧功能，只是读不到真人房间消息。
  try {
    const hasSdk = await sh(\`test -d \${SERVER_DIR}/node_modules/nim-web-sdk-ng && echo YES || echo NO\`, 8000);
    if (!hasSdk || String(hasSdk.output).indexOf('YES') < 0) {
      await sh(\`cd \${SERVER_DIR} && (npm install nim-web-sdk-ng@10.11.0 --no-audit --no-fund --registry=https://registry.npmmirror.com > /tmp/nl_nim_install.log 2>&1 &) ; echo NIM_INSTALL_STARTED\`, 8000);
    }
  } catch (e) {}
`;
if (!src.includes(bootAnchor)) throw new Error('boot anchor not found');
src = src.replace(bootAnchor, nimStep + bootAnchor);

/* mkdir 保证 native 目录存在 */
const mkdirOld = '`mkdir -p ${SERVER_DIR}/public/vendor && rm -f /tmp/nl_*.part`';
const mkdirNew = '`mkdir -p ${SERVER_DIR}/public/vendor ${SERVER_DIR}/native && rm -f /tmp/nl_*.part`';
if (src.includes(mkdirOld)) src = src.replace(mkdirOld, mkdirNew);

/* 写盘 */
fs.mkdirSync(path.join(OUT_DIR, 'packages'), { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, 'ui/listen_together'), { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, 'ui/listen_card'), { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'packages/netease_listen.js'), src);

const tproot = '/tmp/pkgx';
for (const f of ['manifest.json', 'main.js']) {
  fs.copyFileSync(path.join(tproot, f), path.join(OUT_DIR, f));
}
fs.copyFileSync(path.join(tproot, 'ui/listen_together/index.ui.js'), path.join(OUT_DIR, 'ui/listen_together/index.ui.js'));
fs.copyFileSync(path.join(tproot, 'ui/listen_card/index.ui.js'), path.join(OUT_DIR, 'ui/listen_card/index.ui.js'));

console.log('BUILD_V3_OK');
console.log('src size:', before, '->', src.length);
for (const [k, f] of NATIVE) console.log('   ', k, f, fs.statSync(path.join(ROOT, 'native', f)).size);
