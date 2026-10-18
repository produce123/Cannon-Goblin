# 工作区说明（给 AI agent 的项目上下文）

## 项目是什么

`大炮轰小鬼 / Cannon Goblin`：一个**零依赖、零构建**的纯静态网页棋盘游戏。
不对称对抗：大炮方（💣，远程吃子）对小鬼方（👻，数量围堵）。

## 目录结构

```
index.html          全部界面（菜单 / 设置 / 地图编辑器 / 联机大厅 / 准备界面 / 棋盘 / 规则），
                    单页面切换靠 .screen.active，不用路由
css/style.css       全部样式，配色走 :root 的 CSS 变量
js/game.js          PRESET_MAPS 预设地图、EMPTY/CANNON/GHOST 常量、GameState 规则引擎
js/ai.js            AIPlayer：easy（随机）/ normal（启发式）/ hard（minimax 深度 3）
js/audio.js         AudioManager：WebAudio 合成音效，无音频资源文件
js/mqtt.js          极简 MQTT 3.1.1 over WebSocket 客户端（报文编解码 + MqttClient），零依赖手写
js/room.js          联机房间层：房间号、公共 broker 容错、信令、WebRTC 优先 + 中继降级
js/app.js           界面控制、屏幕切换、点击处理、以及联机对局的收发逻辑
functions/          可选的旧版服务端后端（Supabase Edge Function），前端已不再引用
tests/game.test.mjs node:test 用例：MQTT 报文编解码 + 房间号/话题/sid + 规则一致性
tests/browser/      无头浏览器 E2E（run.mjs 起临时静态服务 + 内置 MQTT broker，online.html 是用例页）
```

## 关键约定

- **无模块、无打包器、无 npm 依赖。** 所有 js 都是经典 `<script>` 全局脚本，
  加载顺序在 `index.html` 底部固定：`audio → game → ai → mqtt → room → app`。
  新增文件必须同步加进 `index.html`，并且不能依赖 `import`/`export`。
- **没有构建步骤。** 改完直接刷新页面即可；`index.html` 可直接被 GitHub Pages 托管。
- 函数通过 `onclick="..."` 内联调用，所以这些函数必须是**全局函数声明**。
- 界面文案用中文，注释也用中文。
- 保持"能少写就少写"：没有引入框架、状态库、CSS 预处理器或依赖，请不要顺手加进来。

## 联机要点（重要，别改错）

玩家没有公网 IP，也没有服务器，所以联机分两层，`js/room.js` 是唯一入口：

- **公共 MQTT broker 当房间与信令通道。** 双方都只是"往外连"，与 NAT 无关，
  因此手机 5G / 校园网 / 运营商网络都能建连。broker 列表在 `js/mqtt.js` 的
  `DEFAULT_BROKERS`，按顺序尝试（EMQX → HiveMQ → mqtt-dashboard），可用
  `?brokers=wss://...` 覆盖（支持逗号分隔多个，也方便自建）。
- **对局数据优先走 WebRTC DataChannel**，直连打不通时由**房主单方面决定**改用 MQTT 中继，
  并通过 `transport` 消息广播，保证两端行为一致（不会一端直连一端中继）。
  ⚠️ 免费公共 TURN 已经不可用（实测 `openrelay.metered.ca` 域名失效、0 个 relay 候选），
  **不要**把"打不通"的兜底方案改回 TURN。
- **房间号是 6 位短码**，字母表 `ABCDEFGHJKMNPQRSTUVWXYZ23456789`（刻意排除 0/O/1/I/L）。
  加入方输入后自动归一化（转大写、剔除字母表外字符）。
- **话题方向必须是单向的**：房主订阅 `<root>/<code>/g2h` 发布 `/h2g`，加入方相反。
  同一个人绝不能既订阅又发布同一话题，否则自己会收到自己发的消息。
- **公共话题上可能还有别人在听**：房主发出的信令都带**加入方的 `sid`**，加入方丢弃
  `sid` 对不上的消息。多出来的加入方会收到定向的 `busy`，房里的对手不会被打扰。
  改信令时务必保留这个定向机制（`_publish` 里有说明）。
- **同步策略：只同步一手棋，不同步整个棋盘。** 双方用同一套 `GameState` 本地重放，
  因此 `js/game.js` 的规则必须在两端完全一致。
  ⚠️ **改动 `GameState` 的走子/吃子/胜负规则时，必须保证它在两端表现完全相同**，
  否则联机双方会静默不同步。`tests/game.test.mjs` 里有一条"双方本地重放后局面一致"
  的不变量用例，改规则后请务必跑它。
- 房主固定执大炮方（先手），加入方执小鬼方；**地图由房主在准备界面决定**
  （预设 / 自定义尺寸 / 编辑器自由摆放），点开始才把局面下发给加入方。
- 消息协议（JSON）：信令 `join` / `busy` / `offer` / `answer` / `transport`；
  对局 `start`（携带棋盘）/ `move` / `restartRequest` / `bye`。
- **全局只暴露命名空间，不暴露裸全局**：`js/mqtt.js` → `CannonMqtt`，
  `js/room.js` → `CannonRoom`（`CannonRoom.GameRoom` / `CannonRoom.normalizeRoomCode` …）。
  ⚠️ app.js 必须走命名空间。历史上这里漏过两次（裸 `P2PConnection`、裸 `normalizeRoomCode`），
  后果是内联 onclick 里的 async 报错被静默吞掉、点按钮毫无反应。E2E 覆盖这些路径。
- 调试用 URL 参数：`?transport=relay` 强制走中继，`?brokers=` 换 broker。

## 怎么验证

```bash
node --check js/app.js          # 语法检查（逐个文件）
node --test tests/game.test.mjs # 单元用例
node tests/browser/run.mjs      # 无头浏览器 E2E（自动找 Chrome/Edge，自带内置 MQTT broker）
E2E_PUBLIC=1 node tests/browser/run.mjs   # 同上，但改走真实的公共 broker（验证真实链路）
```

`tests/browser/run.mjs` 会起临时静态服务 + 内置极简 MQTT broker，用无头浏览器跑
`tests/browser/online.html`：多个同源 iframe 各加载一份真实 `index.html`，走完
「建房 → 房间号进房 → 双方准备界面 → 房主选地图开局 → 双方走子同步 → 两条重开路径
→ 第三人抢号被拒 → 强制中继模式再来一遍 → 本地/人机冒烟」，并收集 iframe 内被吞掉的
async 报错，失败时还会把各页的 alert / 异常 / 状态一起打出来。
**改动联机或界面流程后必须跑它**；它已经捕到过两个真实 bug（见上面的裸全局警告，
以及内置 broker 的 CONNACK 忘了套 WebSocket 帧）。

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