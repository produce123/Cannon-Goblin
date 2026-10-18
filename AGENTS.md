# 工作区说明（给 AI agent 的项目上下文）

## 项目是什么

`大炮轰小鬼 / Cannon Goblin`：一个**零依赖、零构建**的纯静态网页棋盘游戏。
不对称对抗：大炮方（💣，远程吃子）对小鬼方（👻，数量围堵）。

## 目录结构

```
index.html          全部界面（菜单 / 设置 / 地图编辑器 / 联机大厅 / 棋盘 / 规则），
                    单页面切换靠 .screen.active，不用路由
css/style.css       全部样式，配色走 :root 的 CSS 变量
js/game.js          PRESET_MAPS 预设地图、EMPTY/CANNON/GHOST 常量、GameState 规则引擎
js/ai.js            AIPlayer：easy（随机）/ normal（启发式）/ hard（minimax 深度 3）
js/audio.js         AudioManager：WebAudio 合成音效，无音频资源文件
js/webrtc.js        联机层：SDP <-> 可粘贴文本码的编解码 + P2PConnection
js/app.js           界面控制、屏幕切换、点击处理、以及联机对局的收发逻辑
functions/          可选的旧版服务端后端（Supabase Edge Function），前端已不再引用
tests/game.test.mjs node:test 用例：信令编解码 + 规则一致性
tests/browser/      无头浏览器 E2E（起临时静态服务 + 三个 iframe 跑真实 index.html）
```

## 关键约定

- **无模块、无打包器、无 npm 依赖。** 所有 js 都是经典 `<script>` 全局脚本，
  加载顺序在 `index.html` 底部固定：`audio → game → ai → webrtc → app`。
  新增文件必须同步加进 `index.html`，并且不能依赖 `import`/`export`。
- **没有构建步骤。** 改完直接刷新页面即可；`index.html` 可直接被 GitHub Pages 托管。
- 函数通过 `onclick="..."` 内联调用，所以这些函数必须是**全局函数声明**。
- 界面文案用中文，注释也用中文。
- 保持"能少写就少写"：没有引入框架、状态库、CSS 预处理器或依赖，请不要顺手加进来。

## 联机（WebRTC）要点

玩家没有公网 IP，也没有服务器，所以：

- **信令靠人工转发**：房主 `createOffer()` 出邀请码 → 对方 `acceptOffer()` 出应答码 →
  房主 `acceptAnswer()`。三段代码由玩家经聊天工具传递，全程没有信令服务器。
- **只有 STUN，没有 TURN**（见 `js/webrtc.js` 的 `ICE_SERVERS`）。
  双方都在对称 NAT 后时会连不上，这是已知限制，不是 bug。
- **同步策略：只同步一手棋，不同步整个棋盘。** 双方用同一套 `GameState` 本地重放，
  因此 `js/game.js` 的规则必须在两端完全一致。
  ⚠️ **改动 `GameState` 的走子/吃子/胜负规则时，必须保证它在两端表现完全相同**，
  否则联机双方会静默不同步。`tests/game.test.mjs` 里有一条"双方本地重放后局面一致"
  的不变量用例，改规则后请务必跑它。
- 房主固定执大炮方并由房主决定初始地图；`init` / `restart` 消息携带棋盘。
- 消息协议（JSON，走 `RTCDataChannel`）：`init` / `restart` / `move` / `restartRequest` / `bye`。
- `js/webrtc.js` 向外暴露三个全局：`CannonSignaling`（编解码）、`CannonWebRTC`、`P2PConnection`。
  ⚠️ **app.js 用的是裸全局 `P2PConnection`**，改 webrtc.js 的导出时要同步（历史上这里漏过，
  导致点「生成邀请码」静默失败）。E2E 会覆盖这条路径。

## 怎么验证

```bash
node --check js/app.js          # 语法检查（逐个文件）
node --test tests/game.test.mjs # 单元用例
node tests/browser/run.mjs      # 无头浏览器 E2E（自动找 Chrome/Edge）
```

`tests/browser/run.mjs` 会起临时静态服务并用无头浏览器跑 `tests/browser/handshake.html`：
三个同源 iframe 各加载一份真实 `index.html`，走完「邀请码 → 应答码 → 开局 → 双方走子同步
→ 两条重开路径 → 本地/人机冒烟」，并收集 iframe 内被吞掉的 async 报错。
**改动联机或界面流程后必须跑它**；它捕到过真实 bug。

浏览器 E2E 用 `node:test` 之外的方式跑，所以要单独一条命令（不在 `tests/` 目录里递归执行）。

本地起静态服务器推荐（`file://` 下 WebRTC 与剪贴板 API 可能被浏览器限制）：

```bash
npx serve .        # 或 python -m http.server 8000
```

## 发布

- 仓库：GitHub `produce123/Cannon-Goblin`（公开）
- 托管：GitHub Pages，源为 `main` 分支根目录
- 线上地址：https://produce123.github.io/Cannon-Goblin/

推送即部署，Pages 会在 1 分钟左右刷新。