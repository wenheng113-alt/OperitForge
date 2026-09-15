'use strict';
/**
 * tools_verify_freshinstall.js
 * 全新安装场景验证：用 Node 桩模拟 Operit Tools，加载新载荷，
 * 把 SERVER_DIR 重定向到临时目录，实跑 deployServer(true)，
 * 验证它能一并写出 server/player/lottie/disk + 6 个 native。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const PKG = '/tmp/newpkg_check/packages/netease_listen.js';
const NATIVE_SRC = '/data/user/0/com.ai.assistance.operit/files/workspace/0b64e418-1e3c-474c-ac69-5d982078c232/p1/netease-listen/native';
const TARGET = '/tmp/nl_fresh_test';

let code = fs.readFileSync(PKG, 'utf8');

// 1) 重定向 SERVER_DIR
code = code.replace(/const SERVER_DIR = '[^']*';/, "const SERVER_DIR = '" + TARGET + "';");
if (code.indexOf("const SERVER_DIR = '" + TARGET + "'") < 0) {
  console.log('FAIL: SERVER_DIR 重定向失败');
  process.exit(1);
}

// 2) 暴露 deployServer
code += "\n;module.exports.__deployServer = deployServer;\n";

// 3) Tools 桩
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

const Tools = {
  System: {
    terminal: {
      create: async () => ({ sessionId: 'stub' }),
      exec: async (sid, cmd, timeoutMs) => {
        let output = '', code = 0;
        try {
          output = execSync(cmd, { shell: '/bin/bash', encoding: 'utf8', timeout: timeoutMs || 15000 });
        } catch (e) {
          code = e.status || 1;
          output = String(e.stdout || '') + String(e.stderr || '');
        }
        return { output: output, exitCode: code };
      },
    },
    sleep: async (ms) => sleepSync(ms),
  },
  Net: { httpGet: async () => ({ statusCode: 0, content: '' }), httpPost: async () => ({}) },
  Chat: {},
};

const sandbox = {
  require, module: { exports: {} }, exports: {}, console,
  Tools, globalThis: {}, process,
  setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0,
  Buffer, Date, Math, JSON, parseInt, parseFloat, String, Number, Object, Array, RegExp, Error,
};
sandbox.globalThis = sandbox;

(async () => {
  // 清空目标，模拟全新安装
  execSync('rm -rf ' + TARGET + ' && mkdir -p ' + TARGET);

  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'netease_listen.js' });

  const deployServer = sandbox.module.exports.__deployServer;
  if (typeof deployServer !== 'function') {
    console.log('FAIL: 未取到 deployServer');
    process.exit(1);
  }

  console.log('=== 执行 deployServer(true) 到 ' + TARGET + ' ===');
  const t0 = Date.now();
  const ret = await deployServer(true);
  console.log('deployServer 返回: ' + ret + '，耗时 ' + (Date.now() - t0) + 'ms');

  console.log('=== 落地文件 ===');
  const expect = [
    'server.js', 'public/player.html', 'public/vendor/lottie.min.js', 'public/vendor/disk.png',
    'native/driver.js', 'native/ltapi.js', 'native/identity.js',
    'native/crypto.js', 'native/qrlogin.js', 'native/smslogin.js',
  ];
  let ok = true;
  for (const f of expect) {
    const p = path.join(TARGET, f);
    const exists = fs.existsSync(p);
    const size = exists ? fs.statSync(p).size : -1;
    console.log((exists && size > 0 ? 'OK  ' : 'MISS') + '  ' + f + '  ' + size);
    if (!exists || size <= 0) ok = false;
  }

  console.log('=== native 与源逐字节比对 ===');
  const map = { 'driver.js': 1, 'ltapi.js': 1, 'identity.js': 1, 'crypto.js': 1, 'qrlogin.js': 1, 'smslogin.js': 1 };
  for (const f of Object.keys(map)) {
    const a = fs.readFileSync(path.join(TARGET, 'native', f));
    const b = fs.readFileSync(path.join(NATIVE_SRC, f));
    const same = Buffer.compare(a, b) === 0;
    console.log((same ? 'OK  ' : 'DIFF') + '  native/' + f + '  ' + a.length);
    if (!same) ok = false;
  }

  // server.js 语法校验
  try {
    execSync('node --check ' + TARGET + '/server.js');
    console.log('OK    server.js 语法');
  } catch (e) { console.log('FAIL  server.js 语法'); ok = false; }

  console.log(ok ? 'FRESH_INSTALL_OK' : 'FRESH_INSTALL_FAIL');
  process.exit(ok ? 0 : 1);
})();