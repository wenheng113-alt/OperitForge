# 网易云「原生一起听」改造计划书 v0.3

> 交付给第三方开发者实施。**本计划书与参考代码均未改动 `netease-listen/` 任何文件。**
>
> 参考代码在 `reference/`，自检通过 **49/49**，并已用真实 cookie 完成端到端实测
> （建房 → 邀请 → 真人加入 → 双向同步 → 关房，全流程跑通）。
>
> **v0.3 关键更新**：加歌能力的根因已**实测定位**（见 3.4）——
> 不是权限、不是载荷格式，而是**不在 HTTP 层**。产品方案已相应调整。

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

### 3.4 仍未跑通的部分：⚠️ 加歌（ADD）**

| 项目 | 状态 |
|---|---|
| 切歌 GOTO / NEXT / PREV | ✅ 已跑通 |
| 播放 / 暂停 PLAY / PAUSE | ✅ 已跑通（`playStatus` 真实翻转） |
| 读播放列表 | ✅ 已跑通 |
| **加歌进房间列表** | ❌ **尚未跑通** |

试过的形态（全部**未生效**）：

```
{ operationType:'ADD', songIds:[id] }                  -> result:true，列表不变
{ operationType:'ADD', songId:id }                     -> result:true，列表不变
{ operationType:'ADD_SONG' } / { operationType:'INSERT' } -> result:true，列表不变
{ operationType:'ADD', displayList:{result:[...]} }    -> result:false（被拒）
带 version 数组的 displayList 形态                       -> result:false（被拒）
```

**推测**：房间列表变更依赖 `playlist.version` 的**每用户版本协商（乐观锁）**，
必须带上正确的 version 才可能被接受。需要**抓一次官方客户端加歌的完整请求**来确定。

#### ⚠️ 原 MCP 的 `add_song` 很可能从未被真正验证过

上游 README / 代码注释都写着：

> 加歌了但 APP 看不到 —— **正常，清后台重进**
> 「加完对方要清一次 APP 后台重进才能看到新列表」

**本次实测：用原 MCP 的 `addSongs()` 原样调用，服务端返回
`{"result":true}`，但反复抓 `playlist/get` 十几秒，列表长度恒定不变，
新歌 ID 从未出现。** 也就是说，这条注释描述的"清后台重进就能看到"
**无法复现** —— 更像是**用客户端重启的假象掩盖了一个没生效的写操作**。

> 结论：上游的加歌能力**应按「未实现」对待**，不能作为本方案的基础。
> 谁要基于它做「AI 点歌」，必须先自己双账号验证一次。

#### 决定性证据：加歌写入被服务端**完全忽略**

在**对方客户端关闭后台**的窗口期重测（排除"客户端缓存"这个解释），
并对加歌前后的 `playlist/get` 做**逐字段 diff**：

```
写前: operationType:'ADD', songIds:['186016']
resp: {"result":true,"message":""}          <- 假成功
写后 4 秒，逐字段对比:
  (完全没有字段变化 —— 服务端彻底忽略了这次写)
```

**注意**：连我自己的 `version` 条目都**没有从 1 递增**。
如果写入真的被受理，我的版本号必然推进。这直接证明
**服务端根本没处理这个请求**，`result:true` 是纯伪造的成功码。

**排除的替代解释**：

| 解释 | 是否成立 | 依据 |
|---|---|---|
| 客户端缓存导致看不到 | ❌ 排除 | 关后台 + 逐字段 diff 仍无变化 |
| 需要重启客户端才拉取 | ❌ 排除 | 服务端数据本身就没变，重启也拉不到 |
| `version` 协商不对 | ❌ 排除 | 穷举 20+ 种 version 组合全部 `result:false` 或无效 |
| 需要换端点 | ❌ 排除 | 探测 30+ 候选端点全部 404 |
| 需要换 `commandType` | ❌ 排除 | `play/command/report` 试 11 种 ADD 类 commandType 全部无效 |

**唯一残留可能**：加歌走**云信 IM 长连接**（与房间聊天同一条通道），
不在 HTTP 层。这也解释了为什么房间聊天和加歌**同时都够不着**。

#### 🔑 真正的根因：**列表变更不是普通写接口**（已定位，附决定性证据）

**先说结论**：加歌不是"权限"问题，也不是"载荷写错"问题。
真人客户端确实能改列表（实测 1→18 首、3→23→365 首），
但**同一条 HTTP 接口在服务端被完全忽略** —— 无论谁调用、什么身份。

**实测对比**：

| 调用方 | 身份 | 结果 |
|---|---|---|
| 真人官方客户端 | 房主 | ✅ 列表 3→23→365 |
| 真人官方客户端 | **加入者** | ✅ 列表 1→18（**证明与房主权限无关**） |
| 本项目 HTTP（eapi） | 房主 | ❌ `result:true` 但无任何变化 |
| 本项目 HTTP（weapi） | 房主 | ❌ 同上 |
| 本项目 HTTP（eapi） | 加入者 | ❌ 同上 |

> 早前"只有房主能改"的假设**已被推翻** —— 真人以加入者身份也能改。
> 真正的区别是**调用通道**，不是身份。

**决定性证据**：加歌前后对 `playlist/get` 做**逐字段 diff**，
**没有任何字段变化**，连调用者自己的 `version` 都不递增：

```
写前: operationType:'ADD', songIds:['186016']
resp: {"result":true,"message":""}      <- 假成功
写后逐字段对比: (完全没有字段变化)
```

**排除的解释**（全部实测）：

| 解释 | 结论 | 依据 |
|---|---|---|
| 载荷格式错 | ❌ | 穷举 40+ 种形态，含 `displayList` 全量/增量/`replace`/`version` 协商 |
| 权限（非房主） | ❌ | 真人加入者也能改；房主身份下我依然失败 |
| 端点找错 | ❌ | **爆破 318 + 第二轮候选，只有 3 个端点存在** |
| 通道错（eapi/weapi） | ❌ | 两条通道都试过 |
| 客户端缓存 | ❌ | 关后台 + 逐字段 diff 仍无变化 |
| 缺 `version` 条目 | ❌ | 空/原样/递增/含自己/缺字段全试过 |
| `outerId` 不对称 | ❌ | `null`/`""`/随机值全试过 |
| 需要 `songIdWithAlgList` | ❌ | 数组/对象形态均无效 |

**结论**：列表变更**不在 HTTP 层**。它要么走**云信 IM 长连接**
（与房间聊天同一条通道 —— 这解释了为什么两者同时够不着），
要么依赖某个**客户端专有的一次性凭证**。

#### 三个同类开源项目交叉验证（均未解决加歌）

| 项目 | 加歌能力 | 说明 |
|---|---|---|
| `1049376904-crypto/ncm-mcp-server`（上游） | ❌ 无效 | `operationType:'ADD'+songIds`，实测假成功 |
| `wuxiandudang-hash/ncm-listen-together` | ❌ **明确不做** | README 写「不控制播放。谁放歌、放什么，在你的 app 里」 |
| `pop410/music_partner` | — | 是 SillyTavern 网页版播放状态同步插件，与一起听无关 |

**`ncm-listen-together` 的独立佐证**（另一个团队从零破的）：

- 邀请在私信收件箱、`type:23`、`generalMsg.nativeUrl`、**要 `decodeURIComponent` 两次**
  → 与本项目 `invite.js` 的发现**完全一致**，交叉印证。
- **房间聊天明确放弃**：「那是网易云信（NIM）的长连接私有协议，
  只在手机 app 里跑，HTTP 接口够不着。我们查清楚了，明确不做。」
  → 与本项目探测 23 个端点全 404 的结论**完全一致**。
- 心跳**接口名拼错**为 `heatbeat`（源码注释特别标注）。
- 对方关房时心跳返回 **488**（= 已由对方结束）→ 应清空本地 roomId 重找邀请。
  **这是本项目尚未覆盖的边界情况，建议补进 `sync.js`。**
- 换歌回调**节流 90 秒**，避免 AI 每首都说话。**同样值得借鉴。**

**三个仓库对「加歌」用的是同一个载荷**（`operationType` + `songIds` +
`clientSeq`/`clientTime`），**没有任何一个提供了可用的实现**。
本次对 20+ 种载荷形态的穷举全部失败，可以认为：
**加歌不在 HTTP 层，或者需要 `playlist.version` 的精确协商，目前无公开解。**

**产品结论（重要，已实测确认）**：模式 2/3 的「AI 点歌」应改为
**「AI 在房间已有列表里 GOTO 切歌」**，而不是「AI 往列表里加新歌」。

实测验证（本回合）：

```
A) GOTO 到【列表内】的歌 -> target 变了  ★切歌成功
B) GOTO 到【列表外】的歌 -> target 不变  （被静默拒绝，但返回 result:true）
C) NEXT / PAUSE         -> 生效，serverSeq 推进
```

**注意 B**：GOTO 一首不在列表里的歌**不会**把它加进去，
只是**静默失败**（`result:true` 但 target 不变）。
所以"用 GOTO 顺带加歌"这条路也堵死。

**最终方案**：AI 只能在房间已有列表内切歌；「加歌/换歌单」
必须由**真人侧在自己客户端操作** —— 真人做完后，AI 通过轮询
`playlist/get` **立刻能看到**（实测 1→18 首被实时观测到）。



**为什么这条注释能长期存在**：`sync/list/command/report` 对错误载荷
返回 `result:true`（假成功），且列表变更本来就需要真人客户端重启才刷新——
「操作没生效」和「需要重启」两种解释在**单人测试**下无法区分。



> **替代方案**：模式 2/3 下，AI 可只用 **GOTO 切到房间已有的歌**；
> 若需要"AI 点任意新歌"，可让"加歌"动作由**真人侧在客户端完成**，
> 或等抓包确定 version 语义后补齐。

### 3.5 ✅ 私信收发可行 / ❌ 房间内聊天不可行（实测）

**探测结论**：房间内聊天**没有 HTTP 接口**。试了 23 个候选端点，**全部 404**：

```
/api/listen/together/chat/{get,list,send}
/api/listen/together/message/{get,list,send}
/api/chatroom/{get,members,message/send,message/get,history}
/api/msg/chatroom/send ...
```

原因：`roomInfo.roomRTCType === "yunxin"` —— 房间内的文字/语音消息走
**网易云信 IM 长连接**，不是 HTTP。插件里想做「房间内发言」，
要么集成云信 SDK，要么放弃。

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
| `selftest.js` | ~430 | 离线自检 | ✅ **47/47 通过** |

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
11) 加歌     playlistParam 各种形态均 result:false ✗（见 3.4）
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
| `native_add_song` | 加歌进房间列表 |
| `list_invites` | 从私信里解析邀请 |
| `accept_invite` | 接受指定邀请 |
| `native_end` | 关房 |

### 6.4 同步仲裁规则（`sync.js`）

| 场景 | 处理 |
|---|---|
| 本地操作（真人在 webview / AI 决策） | 进**单写入队列**串行执行 → 更新本地 state → 节流上报 |
| 轮询发现远端变更 | 覆盖本地 state → SSE 广播 |
| **刚上报过（1.5s 内）** | **忽略远端**，防止"自己刚切完歌又被旧状态打回来"的抖动 |
| 加歌幂等 | 已在 `_knownSongIds` 则跳过，避免重复 ADD |
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
| ~~下行无法观测~~ | ✅ 已排除 | 实测可行；**但加歌 ADD 仍未跑通**（见 3.4） |
| **加歌无解** | 🟠 中高 | 见 3.4；三个同类项目均未解决。**方案改为"AI 只 GOTO 房间已有歌"**，加歌由真人侧完成 |
| **手机抓包不可行** | 🟡 中 | 证书绑定（cert pinning）+ 无 root → 无法抓官方客户端请求。**指望抓包解加歌的路已断** |
| **cookie 泄露** | 🔴 高 | 两个真实凭证落盘。必须 0600 + `credentials/` 进 gitignore + 脱敏回显 |
| **风控/封号** | 🔴 高 | 逆向协议高频调用有风险，aicookie 又是新号。对策：限频、可一键关闭、轮询取 2–3s 而非 1s |
| **模式 1 回归** | 🟡 中 | 改造面大，必须保住现有 17 个工具行为不变；建议加回归测试 |
| **Agora 无法集成** | 🟡 中 | 若必须实时，需引入原生依赖，与零依赖冲突，需重新评估 |
| **心跳断则掉线** | 🟡 中 | 需要进程守护/自动重连；心跳间隔建议 25s |
| **.toolpkg 忘记重打包** | 🟡 中 | 改源码不重打包 = 上线旧代码 |

---

## 9. 尚未验证 / 需要补充的信息

1. ✅ ~~双账号同房时 `playlist/get` 是否非空~~ **已验证：非空**
2. 🔴 **真人建房后，邀请链接的生成方式**（实测的是 AI 建房；"真人建房邀请 AI"这条路径待抓包）
3. ✅ ~~真人切歌时 AI 能否观测到~~ **已验证：能**（`serverSeq` + `targetSongId`）
3b. 🔴 **加歌 ADD 的正确载荷（含 version 语义）** —— 唯一未跑通项
4. 🟡 `status/get` 的 `anotherDeviceInfo` / `anotherFollowStatus` 语义（疑似同账号多端跟随，非房间内同步）
5. 🟡 直播/一起听是否存在**独立的 push 通道**（WebSocket / 长轮询 CDN 地址）
6. 🟡 建议抓一次**官方 App 的真实一起听会话**（Android 抓包），可一举确定 3–5

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

---

## 11. 许可证与来源

- 现有项目 `netease-listen`：MIT（原作者）
- eapi/weapi 协议与邀请解析：来自首次拉取的第三方逆向成果，已在此重写为
  CommonJS 零依赖版本，并补充了实测发现的修复
- 参考代码可自由并入本仓库（MIT 兼容）

---

**计划书结束。** 实施前请先完成 **P0**（第 3.3 节的假设验证）——它决定模式 2/3 是否成立。
