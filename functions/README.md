# 可选后端（当前未使用）

这个目录是**旧版联机实现**的服务端代码，前端已经不引用它了。

现在联机走纯 WebRTC 点对点直连（见 `../js/webrtc.js`），不需要任何服务器。
保留这里的代码只是作为"将来如果有了服务器"的备选方案，不影响游戏运行和部署。

## 当初它是怎么工作的

一个 Deno / Supabase Edge Function，用一张 `rooms` 表当房间状态：

| action | 作用 |
|---|---|
| `createRoom` (POST) | 生成 6 位房间号，写入初始棋盘，状态 `waiting` |
| `joinRoom` (GET) | 按房间号加入，状态改为 `playing` |
| `submitMove` (POST) | 服务端校验走子、判定胜负、写回棋盘 |
| `getGameState` (GET) | 前端每 1.5 秒轮询一次拉取最新局面 |

前端靠轮询同步，所以**必须有一台常驻服务器 + 数据库**，还需要公网可达 —— 这正是
现在改用 WebRTC 直连的原因。

## 文件

- `index.ts` — Deno 入口，把 `handler.mjs` 挂到 `serveSite` 上
- `handler.mjs` — 四个 action 的实现（房间号生成、走子校验、胜负判定）
- `adapter.mjs` — 把 Supabase client 与运行环境注入 handler 的适配层

需要 `SUPABASE_URL` 与 `SUPABASE_ANON_KEY` 两个环境变量，以及一张 `rooms` 表。

## 如果要用它

前端已经没有调用方了，需要自己写回 `js/app.js` 里的联机层（`createRoom` / `joinRoom` /
`submitOnlineMove` / 消息同步），并注意它与 WebRTC 版本的接口并不相同。