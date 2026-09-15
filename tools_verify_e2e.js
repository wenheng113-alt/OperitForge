'use strict';
/**
 * tools_verify_e2e.js
 * 端到端：模拟 Operit 调 start_server —— 清空部署目录可部署文件后，
 * 让插件载荷自行 deployServer + 启动 + native 初始化，最后 HTTP 探活。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { execSync } = require('child_process');

const PKG = '/tmp/newpkg_check/packages/netease_listen.js';
const TARGET = '/home/ubuntu/netease_listen';

let code = fs.readFileSync(PKG, 'utf8');
code = code.replace(/const SERVER_DIR = '[^']*';/, "const SERVER_DIR = '" + TARGET + "';");
code += "\n;module.exports.__start = start_server; module.exports.__deploy = deployServer;\n";

function sleepSync(ms) { const s = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(s), 0, 0, ms); }

function httpGet(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, content: d }));
    });
    req.on('error', () => resolve({ statusCode: 0, content: '' }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ statusCode: 0, content: '' }); });
  });
}

const Tools = {
  System: {
    terminal: {
      create: async () => ({ sessionId: 'stub' }),
      exec: async (sid, cmd, timeoutMs) => {
        // 防 pkill 自匹配：宿主 bash 命令行里会出现 pattern 原文，pkill 会连宿主一起杀。
        // 把 'node server.js' 打断成 'node [s]erver.js'，正则仍能匹配真实进程，但不再匹配自身命令行。
        cmd = String(cmd).replace(/pkill -f 'node server\.js'/g, "pkill -f 'node [s]erver.js'");
        let output = '', code = 0;
        try { output = execSync(cmd, { shell: '/bin/bash', encoding: 'utf8', timeout: timeoutMs || 15000 }); }
        catch (e) { code = e.status || 1; output = String(e.stdout || '') + String(e.stderr || ''); }
        return { output: output, exitCode: code };
      },
    },
    sleep: async (ms) => sleepSync(ms),
  },
  Net: { httpGet: (u) => httpGet(u), httpPost: async () => ({}) },
  Chat: {},
};

const sandbox = {
  require, module: { exports: {} }, exports: {}, console,
  Tools, process, setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0,
  Buffer, Date, Math, JSON, parseInt, parseFloat, String, Number, Object, Array, RegExp, Error,
};
sandbox.globalThis = sandbox;

(async () => {
  // 先停旧进程，清空"可部署文件"，保留 credentials/state/config
  console.log('=== 清空可部署文件（保留 credentials/state/config）===');
  try { execSync("pkill -f 'node [s]erver[.]js' 2>/dev/null; sleep 1; echo killed", { shell: '/bin/bash' }); }
  catch (e) { console.log('（清理步骤忽略退出码）'); }
  for (const f of ['server.js', 'public/player.html', 'public/vendor/lottie.min.js', 'public/vendor/disk.png',
    'native/driver.js', 'native/ltapi.js', 'native/identity.js', 'native/crypto.js', 'native/qrlogin.js', 'native/smslogin.js']) {
    try { fs.unlinkSync(path.join(TARGET, f)); } catch (e) {}
  }
  console.log('credentials 保留:', fs.existsSync(path.join(TARGET, 'credentials/ai.cookie.txt')));

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'netease_listen.js' });
  const start_server = sandbox.module.exports.__start;

  console.log('=== 调用 start_server（插件自行部署+启动）===');
  const t0 = Date.now();
  let ret;
  try { ret = await start_server(); } catch (e) { console.log('start_server 抛错: ' + e.message); }
  console.log('返回: ' + JSON.stringify(ret).slice(0, 300) + '  耗时 ' + (Date.now() - t0) + 'ms');

  console.log('=== 部署结果 ===');
  let ok = true;
  for (const f of ['server.js', 'public/player.html', 'native/driver.js', 'native/ltapi.js',
    'native/identity.js', 'native/crypto.js', 'native/qrlogin.js', 'native/smslogin.js']) {
    const p = path.join(TARGET, f);
    const e = fs.existsSync(p), sz = e ? fs.statSync(p).size : -1;
    console.log((e && sz > 0 ? 'OK  ' : 'MISS') + '  ' + f + '  ' + sz);
    if (!e || sz <= 0) ok = false;
  }

  console.log('=== HTTP 探活 ===');
  const h = await httpGet('http://127.0.0.1:18765/health');
  console.log('health: ' + h.statusCode + '  ' + h.content);

  console.log('=== server.log 尾部 ===');
  try {
    const log = execSync('tail -25 ' + TARGET + '/server.log', { encoding: 'utf8' });
    console.log(log);
  } catch (e) { console.log('读 log 失败: ' + e.message); }

  console.log(ok && h.statusCode === 200 ? 'E2E_OK' : 'E2E_FAIL');
  process.exit(ok && h.statusCode === 200 ? 0 : 1);
})();