'use strict';
/**
 * tools_build_payload_v2.js
 * 把项目新版 server.js + public/player.html + native/*.js 回灌进 toolpkg 源码，
 * 生成携带「完整 native」的新载荷包。产出到 /tmp/nl_pkg_new/。
 * 之后由 pack 步骤打包为 com.bailey.netease_listen.toolpkg。
 */
const fs = require('fs');
const path = require('path');

const ROOT = '/data/user/0/com.ai.assistance.operit/files/workspace/0b64e418-1e3c-474c-ac69-5d982078c232/p1/netease-listen';
const PKG_SRC = '/tmp/tp/packages/netease_listen.js';
const OUT_DIR = '/tmp/nl_pkg_new';

/** 原生模块 → 载荷键名（部署时写到 SERVER_DIR/native/<file>） */
const NATIVE = [
  ['n_driver', 'driver.js'],
  ['n_ltapi', 'ltapi.js'],
  ['n_identity', 'identity.js'],
  ['n_crypto', 'crypto.js'],
  ['n_qrlogin', 'qrlogin.js'],
  ['n_smslogin', 'smslogin.js'],
];

function b64(p) { return fs.readFileSync(p).toString('base64'); }

let src = fs.readFileSync(PKG_SRC, 'utf8');
const before = src.length;

// 1) 替换 server / player 两个 base64 载荷
const serverB64 = b64(path.join(ROOT, 'server.js'));
const playerB64 = b64(path.join(ROOT, 'public/player.html'));
function swap(key, val) {
  const anchor = key + ':"';
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error('anchor not found: ' + key);
  const s = i + anchor.length;
  const e = src.indexOf('"', s);
  if (e < 0) throw new Error('end quote not found: ' + key);
  src = src.slice(0, s) + val + src.slice(e);
}
swap('server', serverB64);
swap('player', playerB64);

// 2) 在 disk:"..." 后追加 native 各键
const natParts = NATIVE.map(([k, f]) => `\n${k}:"${b64(path.join(ROOT, 'native', f))}"`).join(',');
const diskAnchor = 'disk:"';
{
  const i = src.indexOf(diskAnchor);
  if (i < 0) throw new Error('disk anchor not found');
  const s = i + diskAnchor.length;
  const e = src.indexOf('"', s);
  if (e < 0) throw new Error('disk end quote not found');
  // 在当前 disk 值的收尾引号后插入 ,\nkey:"..."
  src = src.slice(0, e + 1) + ',' + natParts + src.slice(e + 1);
}

// 3) mkdir 增加 native 目录
const mkdirOld = '`mkdir -p ${SERVER_DIR}/public/vendor && rm -f /tmp/nl_*.part`';
const mkdirNew = '`mkdir -p ${SERVER_DIR}/public/vendor ${SERVER_DIR}/native && rm -f /tmp/nl_*.part`';
if (!src.includes(mkdirOld)) throw new Error('mkdir anchor not found');
src = src.replace(mkdirOld, mkdirNew);

// 4) jobs 数组扩展到 10 项
const jobsOld = `  const jobs = [
    ['server', SERVER_DIR + '/server.js'],
    ['player', SERVER_DIR + '/public/player.html'],
    ['lottie', SERVER_DIR + '/public/vendor/lottie.min.js'],
    ['disk',   SERVER_DIR + '/public/vendor/disk.png']
  ];`;
const jobsNew = `  const jobs = [
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
if (!src.includes(jobsOld)) throw new Error('jobs anchor not found');
src = src.replace(jobsOld, jobsNew);

// 4.5) files 数组同步扩展到 10 项（与 jobs 对齐，否则判空阈值永不成立、每次全量重部署）
const filesOld = `  const files = [
    SERVER_DIR + '/server.js',
    SERVER_DIR + '/public/player.html',
    SERVER_DIR + '/public/vendor/lottie.min.js',
    SERVER_DIR + '/public/vendor/disk.png'
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
    SERVER_DIR + '/native/smslogin.js'
  ];`;
if (!src.includes(filesOld)) throw new Error('files anchor not found');
src = src.replace(filesOld, filesNew);

// 4.6) pkill 防自匹配：宿主 shell 的命令行里会出现 pattern 原文，pkill -f 会连宿主自身一起杀掉（自杀）。
//      改用字符类 [s]erver —— 正则仍匹配 "node server.js"，但宿主命令行里的字面量 "node [s]erver.js" 不再被匹配。
const pk1Old = "pkill -f 'node server.js' 2>/dev/null; sleep 0.5; echo cleaned";
const pk1New = "pkill -f 'node [s]erver.js' 2>/dev/null; sleep 0.5; echo cleaned";
if (!src.includes(pk1Old)) throw new Error('pkill#1 anchor not found');
src = src.replace(pk1Old, pk1New);

const pk2Old = 'pkill -f "node server.js" ; echo done';
const pk2New = 'pkill -f "node [s]erver.js" ; echo done';
if (!src.includes(pk2Old)) throw new Error('pkill#2 anchor not found');
src = src.replace(pk2Old, pk2New);

// 5) 就绪校验阈值 4 → 10
const chkOld = 'parseInt(String(c.output).trim()) >= 4) return false;';
const chkNew = 'parseInt(String(c.output).trim()) >= 10) return false;';
if (!src.includes(chkOld)) throw new Error('check anchor not found');
src = src.replace(chkOld, chkNew);

// 6) 写出
fs.mkdirSync(path.join(OUT_DIR, 'packages'), { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, 'ui/listen_together'), { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, 'ui/listen_card'), { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'packages/netease_listen.js'), src);
for (const f of ['manifest.json', 'main.js']) {
  fs.copyFileSync(path.join('/tmp/tp', f), path.join(OUT_DIR, f));
}
fs.copyFileSync('/tmp/tp/ui/listen_together/index.ui.js', path.join(OUT_DIR, 'ui/listen_together/index.ui.js'));
fs.copyFileSync('/tmp/tp/ui/listen_card/index.ui.js', path.join(OUT_DIR, 'ui/listen_card/index.ui.js'));

console.log('BUILD_OK');
console.log('src size:', before, '->', src.length);
console.log('serverB64:', serverB64.length, 'playerB64:', playerB64.length);
for (const [k, f] of NATIVE) console.log('  ', k, f, fs.statSync(path.join(ROOT, 'native', f)).size);
