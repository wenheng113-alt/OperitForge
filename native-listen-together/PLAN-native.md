# 网易云「原生一起听」改造计划书 v0.4

> 交付给第三方开发者实施。**本计划书与参考代码均未改动 `netease-listen/` 任何文件。**
>
> 参考代码在 `reference/`，自检通过 **53/53**，并已用真实 cookie 完成端到端实测
> （建房 → 邀请 → 真人加入 → 双向同步 → 关房，全流程跑通）。
>
> **v0.4 关键更新（重大突破，全部经双账号真机实测）**：
> 1. **加歌 / 换整个歌单** ✅ 已跑通 —— v0.3 判定的"不在 HTTP 层"**被推翻**（见 3.4）
> 2. **AI 切歌 → 真人官方客户端实时跟随** ✅ 已验证
> 3. **房间内发言** ✅ 已跑通 —— v0.3 判定的"走云信长连接够不着"**被推翻**（见 3.5）
> 4. **`playCommand` 读取路径**修正（旧代码读错位置，见 3.4）
>
> v0.3 的两个"否定性结论"都被证伪，教训已记录在 3.4「历史教训」一节：
> **遇到"接口存在但写入不生效"，先抓一次官方客户端的真实请求，不要继续黑盒穷举。**

---

## 0. 一句话目标

让插件从「有画面的假一起听」，变成**真正接入网易云一起听房间**的实现：
AI 用 aicookie、真人用真 cookie，双方在**网易云官方房间服务器**里同步。

---

## 1. 需求对齐

| 项 | 结论 |
|---|---|
| 目标 | 接入网易云原生一起听（走 eapi 加密协议） |
| 「集成网易云 SDK」的含义 | 官方**没有**公开的一起听 SDK。此处指逆向出的 **eapi/weapi 加密协议**；首次拉取的那套第三方逆向成果即当作"官方 SDK"使用 |
| aicookie | 真人为 AI 注册的网易云账号；**手动粘贴 cookie 字符串**导入 |
| 真人 cookie | 用户自己的真实网易云 cookie |
| 模式 4 | **不做**（仅真人=直接用官方客户端；仅 AI 无真人=无意义） |
| 建房方向 | **两种都要**：真人建房邀请 AI ＋ AI 建房真人加入 |
| 下行同步 | **先做 1–3 秒轮询**，不引入 Agora RTC 原生依赖 |
| Q1「互不干扰」 | 指**命令流不打架**（单写入队列 + 时间戳仲裁），而非两边各放各的 |

### 三个模式

| | 模式名 | cookie 需求 | webview | 走网易协议 |
|---|---|---|---|---|
| **1** | `local` 原本模式 | 无 | 可控制 | ❌ 否 |
| **2** | `duo` AI+真人 | `ai` + `human` | 可控制 | ✅ 是 |
| **3** | `solo_ai` 仅 AI | 仅 `ai` | **置灰只读** | ✅ 是 |

**兼容性要求**：模式 1 是现有行为，**必须零改动**；默认模式设为 `local`，老用户升级后行为不变。

---

## 2. 现状与改造点

### 现状架构

```
Operit 插件 ──Tools.Net──> Node :18765 ──/api/*──> NeteaseCloudMusicApi 容器
                                         ──/qq/*──> QQ 音乐
                             └──SSE──> webview (player.html)
```

关键事实（已 grep 确认）：

- `server.js` / `player.html` **全仓库零 cookie 处理**
- `proxyReq()` 只是裸转发，不注入任何凭证
- `/control` 直接改本地 `state`，本地状态是唯一真相

### 改造后

```
                        ┌─ 模式1: /api/* → 容器（一字不改）
Node :18765 ────────────┤
                        └─ 模式2/3: native/ → interface.music.163.com
                                        ↑ 按身份注入 cookie（ai / human）
                                        ↑ sync.js 轮询 + 上报
```

---

## 3. ⚠️ 关键技术发现（决定方案可行性）

这一节是**实测结论**，不是推测。请务必读完再动手。

### 3.1 已实测可用的接口 ✅

| 接口 | 作用 | 实测结果 |
|---|---|---|
| `/api/listen/together/room/create` | **建房** | `code:200`，返回完整 `roomInfo`；重复调用返回 `type:ALREADY_IN_ROOM` |
| `/api/listen/together/play/invitation/accept` | 接受邀请 | 已实现（roomId + inviterId 必须同给） |
| `/api/listen/together/end/v2` | 关房 | `code:200`，`success:true` |
| `/api/listen/together/heartbeat` | 心跳 | `code:200`，四字段缺一即 400 |
| `/api/listen/together/status/get` | 查状态 | `code:200`，含 `roomUsers` 成员列表 |
| `/api/listen/together/sync/list/command/report` | 加/删歌 | `code:200` |
| `/api/listen/together/play/command/report` | 切歌 | `code:200` |
| `/api/listen/together/sync/playlist/get` | 读歌单 | 接口存在，但见 3.2 |

### 3.2 ✅ 下行同步可行（**双账号真机实测已推翻早前推断**）

> 早前用**单人房间**测试时，`sync/playlist/get` 恒返回空 `{}`、`status` 是
> `NOT_CONNECTED`，因此推断"HTTP 层观测不到"。**双人房间实测证明这个推断是错的。**

**2026-09 真机双账号实测（房间内 2 人）**：

| 观测项 | 结果 |
|---|---|
| `status/get` → `status` | `NOT_CONNECTED` → **`CONNECTED`**（2 人时） |
| `status/get` → `roomUsers` | **2 人**，能拿到对方 uid / 昵称 / 头像 |
| `sync/playlist/get` → `data` | **非空！** 含完整 `playCommand` + `playlist` |
| 对方切歌能否观测到 | ✅ **能**，`serverSeq` 变化、`targetSongId` 跟着变 |
| 我发指令对方能否收到 | ✅ **能**，`playStatus` 从 PLAY → PAUSE → PLAY 真实翻转 |

**真实下行结构**（务必按此解析）：

```js
data.playCommand = {
  userId, commandType,          // PLAY / PAUSE / GOTO / NEXT / PREV
  targetSongId, formerSongId,   // 注意：不是 songId！
  playStatus,                   // PLAY / PAUSE
  progress, serverSeq,          // serverSeq 单调递增，是"有变更"的可靠信号
  anotherUid, outerId
}
data.playlist.displayList.result = [songId, ...]   // 注意是 displayList.result
data.playlist.playMode = 'ORDER_LOOP'
data.playlist.version = [{ userId, version, outerId }]
```

**关键修正 —— 字段名坑（会静默失败）**：

官方的切歌指令用 **`targetSongId` / `formerSongId`**，**不是 `songId`**。
用 `songId` 时接口**照样返回 `result:true`**，但房间状态**纹丝不动**
（`serverSeq` 不推进）—— 典型的假成功。换成 `targetSongId` 后
`serverSeq` 每次都推进、`commandType` 被原样回显。

同理 `result:true` 不代表性变更成功；只有 `result:false` 是明确的拒绝信号。

### 3.3 关于 Agora RTC 的修正

`roomInfo.agoraChannelId` 确实存在，`roomRTCType: "yunxin"` 说明**语音/信令**
走第三方 RTC 通道（网易云信）。但：

- **播放状态同步（歌单、切歌、播放/暂停）完全可以通过 HTTP 轮询拿到** —— 已实测。
- Agora/云信通道只承担**实时语音与低延迟信令**，不是状态同步的唯一途径。

**结论：轮询方案成立，无需集成 Agora 原生依赖。**

### 3.4 ✅ 加歌 / 换歌单 / 切歌 —— 全部跑通（v0.4 重大突破）

| 项目 | 状态 |
|---|---|
| 切歌 GOTO / NEXT / PREV | ✅ 已跑通 |
| 播放 / 暂停 PLAY / PAUSE | ✅ 已跑通（`playStatus` 真实翻转） |
| 读播放列表 | ✅ 已跑通 |
| **加歌进房间列表** | ✅ **已跑通（v0.4 新增）** |
| **整单替换（换歌单）** | ✅ **已跑通（v0.4 新增）** |
| **AI 切歌 → 真人客户端实时跟随** | ✅ **已跑通（v0.4 新增）** |

> **v0.3 曾判定「加歌不在 HTTP 层」——该结论已被推翻。**
> 加歌**就是** HTTP 的 `sync/list/command/report`，此前失败纯粹是
> **载荷字段形态错误**（用了 `operationType:'ADD'` 增量语义）。
> 详见下方「破解过程」。

#### 🔑 正确的载荷形态（照抄官方客户端抓包）

**加歌 / 换歌单 —— `sync/list/command/report`，明文表单（不要用 `params=` 加密）：**

```json
{
  "commandType": "REPLACE",
  "displayList": ["...原列表全部歌曲...", "...新加的歌..."],
  "anchorPosition": 2,
  "anchorSongId": "3395220104",
  "clientSeq": 1789389529015,
  "randomList": [],
  "version": [{"userId": 10000000002, "version": 10}]
}
```

**切歌 —— `play/command/report`，明文表单：**

```json
{
  "clientSeq": 1789390650760,
  "commandType": "GOTO",
  "formerSongId": "30431371",
  "playStatus": "PLAY",
  "progress": 0,
  "serverSeq": 1789390572195,
  "targetSongId": "29753852",
  "triggerType": "MANUAL",
  "userId": 10000000001
}
```

**表单字段名**：`roomId` + `playlistParam`（列表命令）/ `commandInfo`（播放命令），
值为**上述 JSON 的字符串**，整体以**明文 FormBody** 提交。

#### 与旧实现的四个关键差异（这就是全部根因）

| 字段 | 旧实现（❌ 失败） | 官方抓包（✅ 成功） |
|---|---|---|
| `commandType` | `ADD`（增量语义） | **`REPLACE`**（全量替换） |
| `displayList` | **只放新歌** | **完整列表**（原列表 + 新歌） |
| `anchorPosition` / `anchorSongId` | 缺失 | **必须带上** |
| `version` | 缺失 / 盲目穷举 | **取服务端现值 +1，随请求回传** |
| 编码 | 曾试 `params=` 加密 | **明文表单**即被接受 |

> **一句话**：房间列表没有"加一首"的语义，只有
> **「用一份完整列表替换掉旧的」**。想加歌 = 读当前列表 → 追加 → 整份 REPLACE 回去。

#### 下游读取的关键坑：`playCommand` 不在 `playlist` 里

`playlist/get` 的响应结构是：

```
data.playCommand   <- 播放指令在这里（旧代码读错成 data.playlist.playCommand，永远是 undefined）
data.playlist      <- displayList / version / playMode ...
```

这一点曾导致"切歌成功但读不到"的误判。**旧实现的 `current()` 必须修正。**

#### 破解过程（方法可复用）

v0.3 的结论建立在**纯 HTTP 黑盒爆破**上（318 端点 + 40 余种载荷形态），
全部失败。v0.4 换用 **Frida 动态抓包**（root 真机 + `frida-server` 16.7.19）
后一次定位，关键经验：

1. **Frida 17+ 已移除内置 Java bridge**，必须用 **16.x**，否则 `Java is not defined`。
2. **hook 点选 `okhttp3.Request$Builder.build`** 即可拿到**请求明文** ——
   网易云的 eapi 拦截器会**先用明文 FormBody 构造请求、再由拦截器加密成 `params=`**，
   因此 `build()` 会被调用两次，**两次都能抓到，明文那次就是真实载荷**。
3. **不要同时 hook 太多点**：实测同时挂 `APICryptor` + okhttp + libc 时
   agent 会在 ~2 秒内被销毁（`script has been destroyed`，疑为反调试），
   **单独挂 okhttp 完全稳定**。
4. `javax.crypto.Cipher.doFinal` 全程**零命中** —— 请求加密走 **native**
   （`libcaesar.so` 的 `Java_..._APICryptor_native_1encrypt_1m`），
   hook Java 加密层是**无效方向**，不要在这上面浪费时间。

#### 实测验证记录（v0.4，双账号真机）

| 动作 | 发起方 | 结果 |
|---|---|---|
| 加 2 首（孤勇者 / 起风了） | AI 号（柠檬汁） | ✅ 15 → 17 首，曲目详情核对无误 |
| 整单替换为「喜欢的音乐」 | AI 号 | ✅ 17 → **77 首**，**真人客户端刷新手看到** |
| GOTO 到列表第 21 首 | AI 号 | ✅ 服务端 `targetSongId` 更新，`userId`=AI 号 |
| **真人客户端跟随** | — | ✅ **真人手机实时切到 AI 指定的歌（用户确认）** |

> 这三条合起来意味着：**模式 2 / 模式 3 的「AI 点歌」完全可行**，
> 不再需要"加歌必须由真人操作"的降级方案。

#### 历史教训：为什么 v0.3 会得出错误结论（值得记录）

v0.3 判定「加歌不在 HTTP 层」，现在回看，**每一步推理都踩在假象上**，
把这段留下来是为了避免后来者重走：

| 当年的观察 | 真实原因 |
|---|---|
| 发 `operationType:'ADD'` 返回 `result:true` 但列表不变 | 该接口对**无法解析的载荷也回 `result:true`**，属"假成功"；正确语义是 `REPLACE` 全量替换 |
| 连自己的 `version` 都不递增 | 因为服务端**确实没受理** —— 载荷字段名/语义就是错的 |
| 穷举 40+ 形态全失败 | 穷举的是 `operationType` 家族，**从未试过 `commandType:'REPLACE'` + 全量 `displayList`** |
| 爆破 318 端点只有 3 个存在 | 端点本来就找对了（就是 `sync/list/command/report`），**错的是载荷** |
| 上游 MCP `add_song` 也无效 | 上游用的是同一套错误载荷，**它确实从未被真正验证过** |
| 真人客户端能改、我不能改 | 与权限无关；真人客户端发的是**正确的 REPLACE 载荷** |

**核心教训**：`result:true` 在这个接口上**完全不可信**，
不能用它判断写入是否被受理。**唯一的判据是回读 `playlist/get` 做逐字段 diff。**

**方法论教训**：纯黑盒爆破在"载荷语义未知"时会陷入
「形态穷举 → 假成功 → 误判为通道问题」的死循环。
本次是靠 **Frida 抓官方客户端真实请求**一跳出坑 ——
**遇到"接口存在但写入不生效"，优先抓一次官方客户端的真实请求，而不是继续穷举。**

#### 三个同类开源项目交叉验证（均未解决加歌）

| 项目 | 加歌能力 | 说明 |
|---|---|---|
| `1049376904-crypto/ncm-mcp-server`（上游） | ❌ 无效 | `operationType:'ADD'+songIds`，实测假成功 |
| `wuxiandudang-hash/ncm-listen-together` | ❌ **明确不做** | README 写「不控制播放。谁放歌、放什么，在你的 app 里」 |
| `pop410/music_partner` | — | 是 SillyTavern 网页版播放状态同步插件，与一起听无关 |

**`ncm-listen-together` 的独立佐证**（另一个团队从零破的）：

- 邀请在私信收件箱、`type:23`、`generalMsg.nativeUrl`、**要 `decodeURIComponent` 两次**
  → 与本项目 `invite.js` 的发现**完全一致**，交叉印证。
- 心跳**接口名拼错**为 `heatbeat`（源码注释特别标注）。
- 对方关房时心跳返回 **488**（= 已由对方结束）→ 应清空本地 roomId 重找邀请。
  **这是本项目尚未覆盖的边界情况，建议补进 `sync.js`。**
- 换歌回调**节流 90 秒**，避免 AI 每首都说话。**同样值得借鉴。**
- ~~「房间聊天是网易云信私有长连接，HTTP 够不着」~~
  → **本项目 v0.4 已推翻**：房间聊天走 **HTTP** 的
  `POST /api/middle/im/chatroom/send`（见 3.5），并非够不着。
  该团队的"明确不做"结论**至少对聊天这一项是错的**。

**三个仓库对「加歌」用的是同一个错误载荷**（`operationType` + `songIds`），
所以**没有任何一个提供了可用实现** —— 这不是"行业难题"，
而是**大家都没去抓一次官方客户端的真实请求**。
v0.4 已给出可用解（见本节开头）。

#### 旧版「GOTO 到列表外的歌可顺带加歌」的说明

早期记录过：

```
A) GOTO 到【列表内】的歌 -> target 变了  ★切歌成功
B) GOTO 到【列表外】的歌 -> target 不变  （被静默拒绝，但返回 result:true）
C) NEXT / PAUSE         -> 生效，serverSeq 推进
```

**B 依然成立**：`play/command/report` 的 GOTO **不会**把列表外的歌加进去。
但现在这**不再是限制** —— 想加歌就调 `sync/list/command/report` 的
`REPLACE`（见本节开头），两者是**不同接口、各司其职**：

- **改列表** → `sync/list/command/report`（`playlistParam`, `commandType:'REPLACE'`）
- **改播放** → `play/command/report`（`commandInfo`, `commandType:'GOTO'/'NEXT'/'PAUSE'`）


### 3.5 ✅ 私信收发可行 / ✅ 房间内**发**言可行（读不可行）

> **v0.4 修正**：v0.3 曾判定「房间内聊天没有 HTTP 接口，走云信长连接」——
> **该结论错误**。Frida 抓包显示房间聊天**就是 HTTP**，只是端点名字
> 不在 `listen/together/*` 命名空间下，所以早期按关键词爆破全部 404。

**房间内发言（✅ 可用，明文表单）：**

```
POST https://interface3.music.163.com/api/middle/im/chatroom/send
  chatroomId = 123456789                      <- 取自 roomInfo.chatRoomId
  msgType    = 0
  clientExt  = {"bizType":"listenTogether","ltType":"FRIEND","roomId":"<roomId>"}
  msgBody    = {"msg":"要说的内容","msgType":0}
```

实测返回 `{"code":200,"data":{"result":true,...}}`，**真人客户端可见**。

> **注意**：`roomInfo.roomRTCType === "yunxin"` 只表示**房间基于云信通道**，
> **不代表消息只能走云信私有协议**。服务端提供了 HTTP 转发入口。
> 这是本项目推翻的第二个"看起来像定论"的结论。

**❌ 但「读」房间聊天历史仍无解**：`/api/middle/im/chatroom/{history,messages,get}`
与 `/api/chatroom/message/get` **全部 404**。也就是说：

- **AI → 房间发言**：✅ 可以（上面那条）
- **读房间里的聊天**：❌ 不行（要读只能集成云信 SDK）

**对本项目的实际影响（重要）**：
模式 2/3 里 AI 要"听真人说了什么"，**不能靠读房间聊天**，
只能靠**私信**（`/api/msg/private/*`，读写都通）或**房间状态变化**
（`playCommand` / `displayList` 轮询）。**产品设计必须按这个约束来。**

**但私信是纯 HTTP 的，且实测收发都通**：

| 能力 | 接口 | 实测 |
|---|---|---|
| 发私信 | `/api/msg/private/send` | ✅ `code:200`，对方真收到 |
| 会话列表 | `/api/msg/private/users` | ✅ 含 `lastMsg` 摘要 |
| 聊天历史 | `/api/msg/private/history` | ✅ 完整双向历史 |

**用途**：邀请传递（把 `orpheus://` 深链私信给对方）、
AI 想对真人说句话、状态通知。**这是模式 2/3 里 AI 与真人唯一的
文本交互通道。**

#### ⚠️ 三个必须记住的坑

1. **`history` 是新→旧排序**，`msgs[0]` 才是最新的。
   按「最后一条最新」读会误判成「没发出去」——实测因此白排查了一轮。
2. **富卡片会被降级**。照抄官方邀请卡片（`resType:23` + `generalMsg`）
   发出去，对方客户端显示「当前版本无法显示该信息，请在应用市场下载
   最新版app」。**发纯文本 + 深链最稳。**
3. **正文可能二次 JSON 嵌套**：`msg` 字段本身是
   `{"msg":"...","resType":23}` 字符串，要先 `JSON.parse` 再取 `.msg`。
4. **长度上限**：907 字符的卡片触发 `code 2004`「发送字数超过限制」。
   建议控制在 700 字符内。

> 已实现为 `reference/native/message.js`（含 `unwrapMessage` 剥壳 +
> `latestInvite` 捞邀请），6 条测试覆盖。

### 3.6 房间生命周期（实测）

- `roomInfo.waitMs = 120000` → 空房间 **2 分钟没人加入自动解散**
- `roomInfo.effectiveDurationMs = 1800000` → 房间有效期 **30 分钟**
- 建房后未邀请任何人时，房间会自行消失（实测：调用 `status/get` 时已 `inRoom:false`）

---

## 4. 协议要点（踩坑清单）

这些都是**实测踩过**的，写错任何一个都会静默失败：

1. **双重填充**：Node 的 `createCipheriv` 默认自动 PKCS#7 填充，官方是手工填充。
   必须 `setAutoPadding(false)`，否则密文长度错一截、服务端解密失败（空响应/400）。
2. **`commandInfo` / `playlistParam` 是 JSON 字符串，不是对象**。
   塞进 payload 时是"字符串套 JSON"，序列化错了服务端返回 200 但**不生效**。
3. **心跳四字段**（`roomId`/`songId`/`playStatus`/`progress`）缺一即 400。
4. **接受邀请**必须同时带 `roomId` + `inviterId`。
5. **eapi body 必须含 `header` 字段**（缺了返回空响应或 400），且 JSON 要紧凑序列化。
6. **邀请解析**（两处致命）：
   - `roomId` 形态是 `<32位hex>_<10位时间戳>`，用 `\d+` **永远匹配不到**
   - 邀请被 **URL 编码**且藏在 `msgs[].user.lastMsg`，需深扫 + 解码
7. **`lastMsg` 是对象**（`{msgId,msg,type}`），真正的 JSON 正文在 `.msg` 里。
8. **`inviterId` ≠ 发信人**：`inviterId` 是房间发起人（实测可能就是自己），
   真正发私信的人在 `msgs[].user.fromUserId`，需单独作为 `senderUid` 返回。
9. **weapi 的 cookie 必须带 `os=pc`**；RSA 是裸模幂，`publicEncrypt` 用不了。
10. **eapi 的私信历史参数是 `userId`**，容器接口是 `uid`，两者不通用。

---

## 5. 参考代码（`reference/`）

已写好并自检通过，可直接搬进项目：

| 文件 | 行数 | 职责 | 验证状态 |
|---|---|---|---|
| `native/crypto.js` | ~300 | eapi/weapi 加解密 | ✅ eapi 6/6 真实向量逐字节一致；weapi 双层往返正确 |
| `native/client.js` | ~230 | 按身份发请求 | ✅ 真实 cookie 调通 |
| `native/identity.js` | ~190 | 双 cookie 存取 | ✅ 0600 落盘、脱敏、互不干扰 |
| `native/room.js` | ~290 | 房间全套操作 | ✅ 真实 cookie 端到端跑通 |
| `native/invite.js` | ~210 | 邀请解析 | ✅ 真实抓包 fixture 解析一致 |
| `native/sync.js` | ~330 | 双向同步（轮询） | ✅ 队列串行/仲裁/空歌单容错 |
| `native/mode.js` | ~195 | 模式状态机 | ✅ 能力矩阵、缺 cookie 报错 |
| `native/message.js` | ~200 | 私信收发 | ✅ 真实收发双通；富卡片降级坑已记录 |
| `selftest.js` | ~430 | 离线自检 | ✅ **53/53 通过** |

**真实 cookie 端到端实测输出**：

```
1) probe()   code=200  uid=10000000001  昵称=测试用户A
2) 建房      type=NEW_ROOM  roomId=bedf9a7c..._1789375461
             agoraChannelId=832295296406188032
3) 加歌/切歌  code=200 / code=200
4) 心跳/状态  code=200 / inRoom=true / 成员=1
5) 轮询歌单   code=200  data={}          ← 单人房间为空（双人房间非空，见 3.2）
6) 关房      success=true  关闭后 inRoom=false

--- 双账号真机复测（第二个账号加入后）---
7) status    NOT_CONNECTED -> CONNECTED  成员=2
8) 下行      playlist/get 非空；对方切歌 serverSeq 推进 ✓
9) 上行      暂停/播放/下一曲 -> playStatus 真实翻转 ✓
10) 私信     发 code=200 对方收到；收 双向历史可读 ✓
11) 加歌     REPLACE + 全量 displayList -> 15→17 首 ✓（v0.4）
12) 换歌单   REPLACE 整单 -> 17→77 首，真人客户端刷新可见 ✓（v0.4）
13) 切歌     GOTO -> targetSongId 更新，真人手机实时跟随 ✓（v0.4）
14) 房间发言 /api/middle/im/chatroom/send -> code=200，真人可见 ✓（v0.4）
```

**运行自检**：

```bash
cd reference && node selftest.js
```

---

## 6. 模块设计

### 6.1 新增文件

建议目录（放进 `netease-listen/`）：

```
netease-listen/
├── native/
│   ├── crypto.js      # eapi/weapi
│   ├── client.js      # 按身份请求
│   ├── identity.js    # 双 cookie
│   ├── room.js        # 房间操作
│   ├── invite.js      # 邀请解析
│   ├── sync.js        # 轮询同步引擎
│   ├── mode.js        # 模式状态机
│   └── index.js       # barrel
├── credentials/       # 运行时生成，必须 gitignore
│   ├── ai.cookie.txt
│   └── human.cookie.txt
```

### 6.2 改动文件

| 文件 | 改动 | 风险 |
|---|---|---|
| `server.js` | 加 `/native/*` 路由；`/control` 按模式分流；SSE 加原生事件 | 🔴 高，须保证模式 1 零回归 |
| `public/player.html` | cookie 导入面板、模式选择器、模式 3 控制置灰 | 🟡 中 |
| `packages/netease_listen.js` | 新增 AI 工具 | 🟡 中 |
| `.gitignore` | **必须加 `credentials/`** | 🔴 泄露风险 |

### 6.3 新增 AI 工具（草案）

| 工具 | 说明 |
|---|---|
| `import_cookie` | 导入 ai / human cookie（`who` + `cookie`） |
| `cookie_status` | 查看两个身份是否已导入（脱敏） |
| `set_mode` | 切换 local / duo / solo_ai |
| `get_mode` | 查看模式与就绪状态 |
| `native_create_room` | AI 建房 |
| `native_join` | 接受邀请进房 |
| `native_status` | 房间成员 + 在房状态 |
| `native_play` | 上报切歌 |
| `native_add_song` | 加歌进房间列表（`REPLACE` 全量语义，v0.4 已可用） |
| `native_replace_playlist` | 整单替换（换歌单），v0.4 新增 |
| `native_say_in_room` | 在房间里发一条文字消息，v0.4 新增 |
| `list_invites` | 从私信里解析邀请 |
| `accept_invite` | 接受指定邀请 |
| `native_end` | 关房 |

### 6.4 同步仲裁规则（`sync.js`）

| 场景 | 处理 |
|---|---|
| 本地操作（真人在 webview / AI 决策） | 进**单写入队列**串行执行 → 更新本地 state → 节流上报 |
| 轮询发现远端变更 | 覆盖本地 state → SSE 广播 |
| **刚上报过（1.5s 内）** | **忽略远端**，防止"自己刚切完歌又被旧状态打回来"的抖动 |
| 加歌幂等 | 已在当前列表则跳过；**写前必须重读列表**（`REPLACE` 是全量覆盖，读到旧列表会冲掉真人的新歌） |
| 节流 | 非结构性操作 3s 内不重复上报，降低风控概率 |

---

## 7. 分期实施

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P0** | ~~双账号验证下行假设~~ **已完成** | ✅ 下行可行，字段名已修正 |
| **P1** | 搬 `crypto/client/room/invite` | 自检 35/35；真实 cookie 调通只读接口 |
| **P2** | `identity` + cookie 导入（服务端+UI+工具） | 落盘 0600；UI 脱敏回显 |
| **P3** | `mode` 状态机 | **模式 1 行为零变化**；缺 cookie 有明确报错 |
| **P4** | `sync` + **模式 3 先通** | AI 进房切歌，官方客户端跟着变 |
| **P5** | 模式 2（webview 当播放器 + 双身份） | 两边同房互操作，无抖动 |
| **P6** | 建房双方向 + 打包 .toolpkg + 文档 | 端到端可用 |

> **建议 P4 先于 P5**：模式 3 只有一个控制端，同步逻辑简单得多，先把协议跑稳。

**打包提醒**：`.toolpkg` 内嵌的是 **base64 载荷**（已核实解出的 `server.js`/`player.html`
与仓库源码逐字节一致）。**改完源码必须重新打包**，否则插件部署的还是旧代码。

---

## 8. 风险清单

| 风险 | 等级 | 说明与对策 |
|---|---|---|
| ~~下行无法观测~~ | ✅ 已排除 | 实测可行（`data.playCommand` + `displayList`） |
| ~~加歌无解~~ | ✅ **v0.4 已解决** | 正确载荷为 `commandType:'REPLACE'` + 全量 `displayList`（见 3.4），双账号实测通过 |
| ~~手机抓包不可行~~ | ✅ **v0.4 已解决** | **root 真机 + Frida 16.7.19 hook `okhttp3.Request$Builder.build`** 即可拿到请求明文，无需解证书绑定（见 3.4「破解过程」） |
| **cookie 泄露** | 🔴 高 | 两个真实凭证落盘。必须 0600 + `credentials/` 进 gitignore + 脱敏回显 |
| **风控/封号** | 🔴 高 | 逆向协议高频调用有风险，aicookie 又是新号。对策：限频、可一键关闭、轮询取 2–3s 而非 1s。**注意 `REPLACE` 是整单覆盖，误发会清空真人歌单，务必先读后写** |
| **整单替换的破坏性** | 🟠 中 | `REPLACE` 语义是**全量覆盖**：若读到的列表已过期，会把真人的新歌冲掉。对策：每次写前**立即重读一次**，写完回读校验；AI 只做追加，不做删除 |
| **模式 1 回归** | 🟡 中 | 改造面大，必须保住现有 17 个工具行为不变；建议加回归测试 |
| **Agora 无法集成** | 🟡 中 | 若必须实时，需引入原生依赖，与零依赖冲突，需重新评估 |
| **心跳断则掉线** | 🟡 中 | 需要进程守护/自动重连；心跳间隔建议 25s |
| **.toolpkg 忘记重打包** | 🟡 中 | 改源码不重打包 = 上线旧代码 |

---

## 9. 尚未验证 / 需要补充的信息

1. ✅ ~~双账号同房时 `playlist/get` 是否非空~~ **已验证：非空**
2. 🔴 **真人建房后，邀请链接的生成方式**（实测的是 AI 建房；"真人建房邀请 AI"这条路径待抓包）
3. ✅ ~~真人切歌时 AI 能否观测到~~ **已验证：能**（`serverSeq` + `targetSongId`）
4. ✅ ~~加歌的正确载荷（含 version 语义）~~ **v0.4 已解决**，见 3.4
5. ✅ ~~房间内聊天能否走 HTTP~~ **已验证：能发不能读**，见 3.5
6. 🟡 `status/get` 的 `anotherDeviceInfo` / `anotherFollowStatus` 语义（疑似同账号多端跟随，非房间内同步）
7. 🟡 **读房间聊天历史**（v0.4 确认无 HTTP 接口，需云信 SDK）—— 若 AI 必须"听懂"真人发言才需要
8. 🟡 `REPLACE` 的**并发语义**：两个成员同时改列表时，服务端如何合并/冲突？`version` 是否是乐观锁？
9. 🟡 直播/一起听是否存在**独立的 push 通道**（WebSocket / 长轮询 CDN 地址）—— 若有可替代轮询，降低延迟与风控

---

## 10. 附：本次实测的接口探测记录

**存在（200）**：`room/create`、`end/v2`、`heartbeat`、`status/get`、`sync/playlist/get`、
`play/command/report`、`sync/list/command/report`、`play/invitation/accept`

**不存在（404）**：
`sync/poll`、`sync/get`、`sync/status/get`、`sync/playlist/report`、`sync/command/get`、
`sync/notify`、`sync/notify/get`、`sync/seq/get`、`sync/song/get`、`sync/progress/get`、
`sync/message/get`、`notify/get`、`command/get`、`play/status/get`、`play/status/report`、
`play/command/get`、`play/progress/report`、`song/current/get`、`current/song/get`、
`room/sync`、`room/info`、`room/get`、`room/enter`、`room/join`、`room/connect`、
`room/report`、`room/token/get`、`room/song/get`、`room/user/list`、`members/get`、
`member/list`、`message/get`、`connect`、`enter`、`join`、`rtc/connect`、`rtc/token`,
`report`、`report/status`、`invite`、`room/invite`、`qrcode`、`share/get`、
`invitation/list`、`play/invitation/list`、`play/invitation/reject`、`play/invitation/send`、
`create`、`playlist/get`

### 10.1 抓包实录：`middle/im` 与 `listen/together` 的真实端点

**本次 Frida 抓包新发现的端点**（早期关键词爆破全部漏掉）：

| 端点 | 方法 | 作用 |
|---|---|---|
| `/api/middle/im/chatroom/send` | POST | **房间内发言**（明文表单） |
| `/eapi/listen/together/heartbeat` | POST | 心跳（含 `playlistVersion`） |
| `/eapi/listen/together/privilege/get` | POST | 权限查询 |
| `/eapi/listen/together/common/liked/song/report` | POST | 红心上报 |
| `/eapi/listen/together/relation/statistics/get/v2` | POST | 一起听统计 |
| `/eapi/listen/together/user/gps/report` | POST | 位置上报 |

> **教训**：早期按 `listen|together|playlist` 关键词做 URL 过滤，
> 直接漏掉了 `middle/im/chatroom/*`。**爆破命名空间不如抓一次真实请求。**

### 10.2 复现抓包的最短路径（root 真机 + Frida）

给后来者的**可复用操作手册**：

```bash
# 1) 装 Frida 16（⚠️ 17+ 已移除 Java bridge，会报 'Java' is not defined）
pip3 install --break-system-packages "frida==16.7.19" "frida-tools<14"

# 2) 推 frida-server 16 到手机（需 root）
adb push frida-server-16.7.19-android-arm64 /data/local/tmp/frida-server16
adb shell "su -c 'chmod 755 /data/local/tmp/frida-server16; /data/local/tmp/frida-server16 &'"

# 3) frida-server 只监听 127.0.0.1，必须走 adb forward
adb forward tcp:27042 tcp:27042

# 4) attach 到**已在运行**的进程（不要 spawn，会打断真人的房间）
#    脚本核心只有 20 行：
```

```js
Java.perform(function () {
  var RB = Java.use('okhttp3.Request$Builder');
  RB.build.implementation = function () {
    var req = this.build();
    var u = req.url().toString();
    if (u.indexOf('163.com') === -1) return req;
    var b = req.body();
    if (b && b.getClass().getName().indexOf('FormBody') !== -1) {
      var fb = Java.cast(b, Java.use('okhttp3.FormBody'));
      var out = [];
      for (var i = 0; i < fb.size(); i++) out.push(fb.name(i) + '=' + fb.value(i));
      send(req.method() + ' ' + u + '\n  ' + out.join(' & '));
    }
    return req;
  };
});
```

**五个必须知道的坑（本次踩过）**：

| 坑 | 现象 | 解法 |
|---|---|---|
| Frida 17 | `ReferenceError: 'Java' is not defined` | 降到 **16.7.19**（客户端与服务端版本要一致） |
| 同时 hook 多个点 | agent 约 2 秒后 `script has been destroyed`（疑反调试） | **一次只 hook 一个点**；单独 hook okhttp 完全稳定 |
| hook `Cipher.doFinal` | 全程零命中 | 请求加密走 **native**（`libcaesar.so`），**不要**在 Java 加密层浪费时间 |
| 只 hook `Request$Builder.build` 之外 | 拿不到明文 | eapi 拦截器会**先用明文 FormBody 建一次、再加密成 `params=` 重建**，`build()` 被调用两次，**明文那次就是真实载荷** |
| 用 `head`/管道看输出 | 看不到日志（缓冲） | 直接写文件 + `tail -f`，或让 hook 结果落盘再读 |

**Frida 是否可被检测**：网易云 9.3.85 **没有**主动反 Frida 的硬检测
（纯心跳脚本可长期存活），但**同时挂多个 hook 会触发异常**。
纯真机 root + attach 的模式，本项目实测**稳定可用**。

---

## 11. 许可证与来源

- 现有项目 `netease-listen`：MIT（原作者）
- eapi/weapi 协议与邀请解析：来自首次拉取的第三方逆向成果，已在此重写为
  CommonJS 零依赖版本，并补充了实测发现的修复
- 参考代码可自由并入本仓库（MIT 兼容）

---

**计划书结束。** v0.4 已打通全部核心能力（建房 / 邀请 / 加歌 / 换歌单 / 切歌 / 房间发言），
实施时请以 **3.4 节抓包得到的载荷形态**为准，不要再用旧的 `operationType:ADD`。
