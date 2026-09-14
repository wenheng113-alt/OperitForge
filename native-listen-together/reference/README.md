# 参考代码（native 一起听）

> ⚠️ **这些文件不在 `netease-listen/` 仓库里，也尚未接入 `server.js`。**
> 它们是交给第三方开发者的参考实现，可直接搬进项目。

配套文档：上级目录 `PLAN-native.md`（计划书 v0.5）

---

## 快速自检

```bash
cd reference
node selftest.js
```

预期输出：**通过 63 / 失败 0**

自检是离线的（不发网络请求），但会**尽量**读取以下外部 fixture 做逐字节比对；
读不到时自动跳过该组，不算失败：

- `/ncm-mcp-server/node/test/fixtures/eapi-vectors.json`（eapi 真实抓包向量）
- `/ncm-mcp-server/node/test/fixtures/real-invite.json`（真实邀请私信）

---

## 文件说明

| 文件 | 职责 |
|---|---|
| `native/crypto.js` | eapi（AES-128-ECB + md5）与 weapi（双 AES-CBC + 裸 RSA）加密 |
| `native/client.js` | 按身份发请求的 HTTP 客户端（`NativeClient`） |
| `native/identity.js` | 双身份 cookie 存取（`IdentityStore`），0600 落盘、脱敏 |
| `native/room.js` | 一起听房间操作（`RoomService`）：建房/进房/心跳/切歌/加歌/关房 |
| `native/invite.js` | 邀请私信解析（`parseInvite` / `extractInvites`） |
| `native/sync.js` | 本地状态 ↔ 网易云房间 双向同步引擎（`SyncEngine`，轮询） |
| `native/mode.js` | 三个模式的状态机与能力矩阵（`ModeManager`） |
| `native/message.js` | 私信收发（`MessageService`）：发私信 / 会话列表 / 捞邀请 |
| `native/im.js` | **房间聊天**（`RoomChatService`）：云信登录 / 实时收 / 拉历史 / 发言 |

---

## 依赖

核心模块**零依赖** —— 只用 Node 内置模块：`crypto` / `http` / `https` / `fs` / `path`。
Node >= 16 即可（与现有项目一致）。

**唯一例外是 `native/im.js`**（读房间聊天）：它需要官方云信 SDK

```bash
npm install nim-web-sdk-ng        # 实测 10.11.0 可用
```

SDK 是浏览器产物，在 Node 里跑要先补浏览器全局对象：

```js
const im = require('./native/im.js');
im.installBrowserGlobals();       // ⚠️ 必须在 import SDK 之前
```

若 SDK 不在常规位置，用 `NIM_SDK_DIR` 环境变量或 `enter({ sdkDir })` 指定。
Node 18+ 自带 `WebSocket`，无需额外 polyfill。

---

## 最小用法示例

```js
const { IdentityStore } = require('./native/identity.js');
const { NativeClient } = require('./native/client.js');
const { RoomService } = require('./native/room.js');
const { ModeManager } = require('./native/mode.js');
const { SyncEngine } = require('./native/sync.js');

// 1. 导入 cookie
const store = new IdentityStore();              // 默认落在 ../credentials/
store.save('ai',    '<AI 账号 cookie>');        // 必须含 MUSIC_U 与 __csrf
store.save('human', '<真人账号 cookie>');

// 2. 选模式
const modes = new ModeManager({ store });
modes.set('duo');                               // 缺 cookie 会抛错并指明缺哪个

// 3. 建房 / 进房
const client = new NativeClient({ cookie: store.load('ai'), who: 'ai' });
const room = new RoomService(client);
const created = await room.create();
console.log(created.roomId, created.type);      // NEW_ROOM | ALREADY_IN_ROOM

// 4. 加歌 + 切歌
await room.addSongs({ songIds: ['186016'] });
await room.playCommand({ songId: '186016', progress: 0 });

// 5. 开同步（轮询 2s + 心跳 25s）
const state = { song: null, playing: false, positionMs: 0, anchorTs: 0, seq: 0 };
const sync = new SyncEngine({ room, state, broadcast: (e, d) => { /* 推 SSE */ } });
sync.start();

// 6. 收尾
sync.stop();
await room.end();
```

---

## ✅ 真机实测结果（2026-09，双账号）

已用两个真实账号进同一房间验证：

| 能力 | 结果 |
|---|---|
| 收到对方切歌事件 | ✅ `serverSeq` 变化，`targetSongId` 跟着变 |
| 播放 / 暂停 | ✅ `playStatus` 真实翻转 PLAY→PAUSE→PLAY |
| 下一曲 / 上一曲 | ✅ `commandType` 被服务端回显 |
| 切歌（GOTO） | ✅ 生效 |
| 拉播放列表 | ✅ 拿到 `displayList.result` |
| **加歌（ADD）** | ❌ **未跑通**，见下 |

**⚠️ 字段名坑（会静默失败）**：官方用 **`targetSongId` / `formerSongId`**，
不是 `songId`。用 `songId` 时接口返回 `result:true` 但状态纹丝不动。

**⚠️ 加歌未跑通，且三个同类开源项目也都没解决**：

| 项目 | 加歌 |
|---|---|
| `1049376904-crypto/ncm-mcp-server` | ❌ 假成功（`result:true`，列表不变） |
| `wuxiandudang-hash/ncm-listen-together` | ❌ 明确不做（"谁放歌在你的 app 里"） |
| `pop410/music_partner` | — 与一起听无关（ST 网页版同步插件） |

三者用的是**同一个载荷**（`operationType`+`songIds`+`clientSeq`），
穷举 20+ 种形态全部失败。**替代方案：AI 只用 GOTO 切房间已有的歌。**

另：手机端**证书绑定（cert pinning）+ 无 root**，抓不到官方客户端请求，
指望抓包破解这条路已断。

**交叉印证**：`ncm-listen-together` 独立得出与本案一致的结论 ——
邀请藏在私信收件箱、`type:23`、`nativeUrl` 需 `decodeURIComponent` 两次；
房间聊天走网易云信 NIM 私有协议、HTTP 够不着（它明确放弃）。
它还提供了两个本项目未覆盖的边界：**对方关房时心跳返回 488**、
**换歌回调应节流 90 秒**。前者已补进 `room.js`（`heartbeatChecked`）。

## ⚠️ 使用前必读

1. **单人房间读不到歌单**：`sync/playlist/get` 在只有自己时返回空 `{}`，
   必须房间里有第二个成员才能读到状态。参考代码已做容错。

2. **cookie 是真实凭证**：`credentials/` 必须进 `.gitignore`。
   `IdentityStore` 已做 0600 落盘，但**绝不会**阻止你把它提交上去。

3. **风控风险**：逆向协议高频调用有封号风险。参考代码内置了节流
   （非结构性操作 3s、轮询 2s），但请勿进一步调高频率。

4. **协议改动风险**：所有常量与路径来自当前版本客户端抓包，
   网易云改协议后需要重新抓包更新 `crypto.js` 与 `room.js` 的 `PATHS`。

---

## 已验证 / 未验证

**已验证（真实 cookie 打真实服务器）**：
`probe` / `room/create` / `addSongs` / `playCommand` / `heartbeat` / `status` / `playlist` / `end`

**已验证（离线）**：
eapi 加密对 6 条真实向量逐字节一致；weapi 双层加解密往返；邀请解析对真实 fixture 一致；
cookie 0600 落盘；模式矩阵；同步队列串行与仲裁；空歌单容错。

**未验证**：
真人建房路径、双账号同房的歌单可见性、真人操作的下行可观测性、
`anotherDeviceInfo` 语义、是否存在独立 push 通道。
