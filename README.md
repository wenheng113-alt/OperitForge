# 🎵 一起听 (Listen Together)

仿网易云音乐「一起听」插件 — 与 AI 实时同步听歌，支持网易云 + QQ音乐双音源。

零依赖，Node.js >= 16 即可运行。

---

## ✨ 功能特性

### 🎶 双音源支持
- **网易云音乐**：搜索、点歌、URL 解析、歌词、热门评论
- **QQ音乐**：搜索、点歌、URL 解析、热门评论
- 切歌时自动刷新音源 URL（网易云刷新 CDN 链接，QQ 刷新 vkey），不会卡住
- QQ 搜索使用 POST 请求 + URL 并行竞速解析，点歌流程服务端异步解析，速度大幅提升

### 🤖 AI 一起听
- AI 可远程控制播放（暂停/播放/切歌/查进度/调音量）
- AI 可搜索歌曲并点歌播放
- AI 可读取房间状态：当前歌曲、播放进度、歌单列表、**相距距离**、**听歌时长**
- AI 可在播放器页面上与 AI 聊天，触发爱心粒子动画
- 支持配置自定义 AI 模型（Endpoint / API Key / 模型名 / 系统提示词）
- 配置保护：用户手动修改后重启不会被 Operit 配置覆盖，需主动「重载」才恢复

### 🎧 播放器界面
- 仿网易云音乐「一起听」UI，头像重叠布局
- 黑胶唱片旋转动画，支持滑动切歌（轨道推挤换碟动画）
- 歌词同步显示，支持点击进入歌词全文模式
- 歌单列表管理，支持顺序/单曲循环/随机播放
- 热门评论（网易云 + QQ音乐双通道）
- 聊天页面，与 AI 互发消息，爱心粒子动画
- 自定义头像（点击头像上传，Canvas 裁剪 256px）

### 🎨 装扮库
- **唱片盘片**：10+ 预设盘片（玫瑰金、深海蓝、森林绿、落日橙、星夜紫、银月白、樱花粉、流金岁月、霓虹彩虹、光晕系列），支持上传自定义盘片图片
- **背景主题**：5 种预设背景色 + 上传自定义背景图，支持模糊度和亮度调节

### ⏱️ 听歌时长记录
- 自动累计真实播放秒数，暂停/切歌时固化增量
- 显示为小时（保留 1 位小数），如「一起听了 12.5 小时」
- 支持手动校准：弹窗留空则自动累计，填写则校准到指定值后继续涨
- AI 可通过 `get_status` 直接读取距离和时长

### 📡 其他
- SSE 实时同步，多端播放进度一致
- 房间状态持久化（重启不丢歌单、距离、听歌时长）
- 网易云 API 地址可配置（需 NodeJS 版 [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)）
- 心跳保活，自动清理超时成员

---

## 🚀 使用方法

1. 启动服务器：`node server.js`（默认端口 18765）
2. 浏览器打开 `http://127.0.0.1:18765/`
3. 点击右下角「⋮」按钮配置 AI 模型和网易云 API 地址
4. 搜索歌曲，开始一起听

### 配置说明

| 配置项 | 说明 |
|--------|------|
| API 地址 (Endpoint) | AI 模型的 API 地址，如 `https://api.example.com/v1` |
| API Key | 模型 API Key |
| 模型名 | 如 `gpt-4o` / `glm-5.2` |
| 系统提示词 | AI 角色卡，用户自定义后重启不会被覆盖 |
| 网易云 API 地址 | NodeJS 版 NeteaseCloudMusicApi 服务地址，如 `http://xx.xx.xx.xx:3000` |

---

## 📁 文件结构

```
netease_listen/
├── server.js                  # 服务端（信令 + API 代理 + AI 聊天）
├── public/
│   ├── player.html            # 前端播放器页面
│   └── vendor/
│       ├── disk.png           # 默认唱片盘片
│       └── lottie.min.js      # Lottie 动画库
├── ai_config.json             # AI 模型配置（自动生成）
├── state.json                 # 房间状态持久化（自动生成）
└── chat_log.json              # 聊天记录（自动生成）
```

---

## 🔧 技术细节

- **零依赖**：纯 Node.js 内置模块（http/https/fs），无需 npm install
- **SSE 同步**：Server-Sent Events 实现实时状态广播
- **QQ 音乐 URL 解析**：3 个源并行竞速，谁先返回用谁，超时 8s
- **QQ 音乐评论**：旧版评论 API `c.y.qq.com/base/fcgi-bin/fcg_global_comment_h5.fcg`
- **听歌时长**：`meta.listenSeconds` 存真实秒数，`currentListenSeconds()` 实时计算，`listenHoursStr()` 换算显示
- **配置保护**：`ai_config.json` 的 `_userCustomized` 标志，启动时检测，用户改过则跳过 Operit 覆盖

---

## 📄 License

MIT
