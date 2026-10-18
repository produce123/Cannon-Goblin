let currentScreen = 'menu';
let gameMode = null;
let playerSide = CANNON;
let aiDifficulty = 'normal';
let gameState = null;
let editorState = null;
let editorMode = null;
let editorTool = 'cannon';
let customPositions = null;
let customSource = null;
let boardElement = null;
let cellSize = 60;

// 本地 / 人机 / 在线三种模式共用同一套"预设 + 自定义"状态，按模式下标取用。
const selectedPreset = { local: 0, ai: 0, online: 0 };
const SETUP_SCREEN = { local: 'local-setup', ai: 'ai-setup', online: 'online-ready' };

function showScreen(name) {
  AudioManager.playClick();
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screen = document.getElementById('screen-' + name);
  if (screen) {
    screen.classList.add('active');
    currentScreen = name;
  }

  const presetMode = { 'local-setup': 'local', 'ai-setup': 'ai', 'online-ready': 'online' }[name];
  if (presetMode) renderPresetMaps(presetMode);
}

function renderPresetMaps(mode) {
  const container = document.getElementById('preset-maps-' + mode);
  if (!container) return;
  container.innerHTML = '';
  PRESET_MAPS.forEach((map, i) => {
    const btn = document.createElement('button');
    btn.className = 'preset-map-btn' + (selectedPreset[mode] === i ? ' selected' : '');
    btn.innerHTML = `<span class="map-name">${map.name}</span><span class="map-desc">${map.desc}</span>`;
    btn.onclick = () => {
      AudioManager.playClick();
      selectedPreset[mode] = i;
      renderPresetMaps(mode);
      document.getElementById('board-width-' + mode).value = map.width;
      document.getElementById('board-height-' + mode).value = map.height;
      document.getElementById('cannon-count-' + mode).value = map.cannons.length;
      document.getElementById('ghost-count-' + mode).value = map.ghosts.length;
    };
    container.appendChild(btn);
  });
}

function selectSide(side) {
  AudioManager.playClick();
  playerSide = side === 'cannon' ? CANNON : GHOST;
  document.getElementById('side-cannon').classList.toggle('selected', side === 'cannon');
  document.getElementById('side-ghost').classList.toggle('selected', side === 'ghost');
}

function selectDifficulty(diff) {
  AudioManager.playClick();
  aiDifficulty = diff;
  document.querySelectorAll('.difficulty-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('diff-' + diff).classList.add('selected');
}

function showEditor(mode) {
  AudioManager.playClick();
  editorMode = mode;
  const w = parseInt(document.getElementById('board-width-' + mode).value) || 6;
  const h = parseInt(document.getElementById('board-height-' + mode).value) || 6;

  editorState = new GameState(w, h);
  customSource = mode;

  const preset = PRESET_MAPS[selectedPreset[mode]];

  if (preset.width === w && preset.height === h) {
    for (const [r, c] of preset.cannons) editorState.placeCannon(r, c);
    for (const [r, c] of preset.ghosts) editorState.placeGhost(r, c);
  }

  editorTool = 'cannon';
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tool-cannon').classList.add('active');

  renderEditorBoard();
  showScreen('editor');
}

function selectTool(tool) {
  AudioManager.playClick();
  editorTool = tool;
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tool-' + tool).classList.add('active');
}

/**
 * 按容器的真实可用空间算格子边长。
 *
 * ⚠️ 这里曾经用 window.innerWidth 减一个魔数来估算，在手机上会算大：
 * 棋盘是 flex 子项（flex-shrink 默认为 1），可用宽度不够时棋盘会被压扁，
 * 而画布是 width:100%（跟着一起缩放）、格子却是按 px 绝对定位的（不跟着动），
 * 于是棋子相对网格整体偏移、越靠边越明显 —— 这就是"手机端棋子对不上十字交点"。
 * 所以：宽度必须量容器的内容盒，且棋盘在 CSS 里设为 flex:none（不可压缩）。
 */
function fitCellSize(wrapper, w, h, maxCell) {
  const style = getComputedStyle(wrapper);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const availW = (wrapper.clientWidth || window.innerWidth) - padX;

  // 高度不能量 wrapper：它是 flex:1，高度取决于棋盘自身，量它就成了循环计算。
  // 改成"视口高度 - 棋盘以外的部分"。
  let chrome = padY;
  const container = wrapper.parentElement;
  if (container) {
    for (const child of container.children) {
      if (child !== wrapper) chrome += child.getBoundingClientRect().height;
    }
    const containerStyle = getComputedStyle(container);
    chrome += parseFloat(containerStyle.paddingTop) + parseFloat(containerStyle.paddingBottom);
  }
  const availH = window.innerHeight - chrome;

  return Math.max(16, Math.min(Math.floor(availW / w), Math.floor(availH / h), maxCell));
}

/**
 * 铺好一块棋盘：设尺寸、画网格、生成 w×h 个格子，返回 cells[r][c]。
 * 位图按 DPR 放大再缩放回来，网格在高分屏上才清晰（之后都用 CSS 像素坐标画）。
 */
function buildBoard(board, w, h, cs) {
  cellSize = cs;
  document.documentElement.style.setProperty('--cell-size', cs + 'px');
  board.style.width = (w * cs) + 'px';
  board.style.height = (h * cs) + 'px';
  board.innerHTML = '';

  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.className = 'board-canvas';
  canvas.width = Math.round(w * cs * dpr);
  canvas.height = Math.round(h * cs * dpr);
  board.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawGridLines(ctx, w, h, cs);

  const cells = [];
  for (let r = 0; r < h; r++) {
    const row = [];
    for (let c = 0; c < w; c++) {
      const cell = document.createElement('div');
      cell.className = 'board-cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      cell.style.width = cs + 'px';
      cell.style.height = cs + 'px';
      cell.style.left = (c * cs) + 'px';
      cell.style.top = (r * cs) + 'px';
      board.appendChild(cell);
      row.push(cell);
    }
    cells.push(row);
  }
  return cells;
}

/** 往格子里放棋子（或空点）。返回放进去的棋子元素，空点返回 null。 */
function placePieceInCell(cell, piece, cs) {
  if (piece === EMPTY) {
    const dot = document.createElement('div');
    dot.className = 'cell-dot';
    cell.appendChild(dot);
    return null;
  }
  const element = document.createElement('div');
  element.className = 'piece ' + (piece === CANNON ? 'cannon' : 'ghost');
  element.textContent = piece === CANNON ? '💣' : '👻';
  element.style.fontSize = Math.floor(cs * 0.45) + 'px';
  cell.appendChild(element);
  return element;
}

function renderEditorBoard() {
  const board = document.getElementById('editor-board');
  const w = editorState.width;
  const h = editorState.height;
  const cs = fitCellSize(board.parentElement, w, h, 60);
  const cells = buildBoard(board, w, h, cs);

  let cannonCount = 0;
  let ghostCount = 0;

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const piece = editorState.getPiece(r, c);
      if (piece === CANNON) cannonCount++;
      else if (piece === GHOST) ghostCount++;
      placePieceInCell(cells[r][c], piece, cs);

      cells[r][c].onclick = () => {
        AudioManager.playClick();
        if (editorTool === 'cannon') {
          editorState.board[r][c] = editorState.board[r][c] === CANNON ? EMPTY : CANNON;
        } else if (editorTool === 'ghost') {
          editorState.board[r][c] = editorState.board[r][c] === GHOST ? EMPTY : GHOST;
        } else {
          editorState.board[r][c] = EMPTY;
        }
        renderEditorBoard();
      };
    }
  }

  document.getElementById('editor-cannon-count').textContent = cannonCount;
  document.getElementById('editor-ghost-count').textContent = ghostCount;
}

function drawGridLines(ctx, w, h, cs) {
  ctx.strokeStyle = '#8b6914';
  ctx.lineWidth = 1;

  const pad = cs / 2;

  for (let r = 0; r < h; r++) {
    ctx.beginPath();
    ctx.moveTo(pad, r * cs + pad);
    ctx.lineTo((w - 1) * cs + pad, r * cs + pad);
    ctx.stroke();
  }
  for (let c = 0; c < w; c++) {
    ctx.beginPath();
    ctx.moveTo(c * cs + pad, pad);
    ctx.lineTo(c * cs + pad, (h - 1) * cs + pad);
    ctx.stroke();
  }

  ctx.fillStyle = '#5a4510';
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      ctx.beginPath();
      ctx.arc(c * cs + pad, r * cs + pad, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function backFromEditor() {
  AudioManager.playClick();
  showScreen(SETUP_SCREEN[editorMode] || 'menu');
}

function confirmEditor() {
  AudioManager.playClick();
  customPositions = {
    width: editorState.width,
    height: editorState.height,
    board: editorState.board.map(row => [...row])
  };
  showScreen(SETUP_SCREEN[editorMode] || 'menu');
}

function startLocalGame() {
  AudioManager.playClick();
  gameMode = 'local';

  if (customPositions && customSource === 'local') {
    initGameFromCustom();
  } else {
    initGameFromPreset(PRESET_MAPS[selectedPreset.local]);
  }
}

function startAIGame() {
  AudioManager.playClick();
  gameMode = 'ai';

  if (customPositions && customSource === 'ai') {
    initGameFromCustom();
  } else {
    initGameFromPreset(PRESET_MAPS[selectedPreset.ai]);
  }
}

function initGameFromPreset(preset) {
  gameState = new GameState(preset.width, preset.height);
  for (const [r, c] of preset.cannons) gameState.placeCannon(r, c);
  for (const [r, c] of preset.ghosts) gameState.placeGhost(r, c);
  showScreen('game');
  renderGameBoard();
  updateGameUI();
  checkAIFirstMove();
}

function initGameFromCustom() {
  if (!customPositions) return;
  gameState = new GameState(customPositions.width, customPositions.height);
  gameState.board = customPositions.board.map(row => [...row]);
  showScreen('game');
  renderGameBoard();
  updateGameUI();
  checkAIFirstMove();
}

function checkAIFirstMove() {
  if (gameMode === 'ai' && gameState.currentTurn !== playerSide) {
    scheduleAIMove(500);
  }
}

function renderGameBoard() {
  const board = document.getElementById('game-board');
  const w = gameState.width;
  const h = gameState.height;
  const cs = fitCellSize(board.parentElement, w, h, 80);
  const cells = buildBoard(board, w, h, cs);

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const cell = cells[r][c];
      const pieceElement = placePieceInCell(cell, gameState.getPiece(r, c), cs);

      if (pieceElement && gameState.selectedPiece &&
          gameState.selectedPiece.r === r && gameState.selectedPiece.c === c) {
        pieceElement.classList.add('selected');
      }

      const isValidMove = gameState.validMoves.find(m => m.r === r && m.c === c);
      if (isValidMove) {
        cell.classList.add(isValidMove.capture ? 'capture-highlight' : 'highlight');
      }

      if (gameState.lastMove && gameState.lastMove.toR === r && gameState.lastMove.toC === c) {
        cell.classList.add('last-move');
      }

      cell.onclick = () => handleCellClick(r, c);
    }
  }
}

function handleCellClick(r, c) {
  if (gameState.gameOver) return;

  if (gameMode === 'ai' && gameState.currentTurn !== playerSide) return;
  if (gameMode === 'online' && gameState.currentTurn !== playerSide) return;

  const piece = gameState.getPiece(r, c);

  if (gameState.selectedPiece) {
    const isValidMove = gameState.validMoves.find(m => m.r === r && m.c === c);
    if (isValidMove) {
      if (gameMode === 'online') {
        submitOnlineMove(gameState.selectedPiece.r, gameState.selectedPiece.c, r, c);
        return;
      }

      const result = gameState.movePiece(r, c);
      if (result) {
        if (result.captured) {
          AudioManager.playCapture();
        } else {
          AudioManager.playMove();
        }
        renderGameBoard();
        updateGameUI();

        if (gameState.gameOver) {
          handleGameOver();
          return;
        }

        if (gameMode === 'ai' && gameState.currentTurn !== playerSide) {
          scheduleAIMove(400);
        }
        return;
      }
    }

    if (piece === gameState.currentTurn) {
      AudioManager.playSelect();
      gameState.selectPiece(r, c);
      renderGameBoard();
      return;
    }

    gameState.deselectPiece();
    renderGameBoard();
    return;
  }

  if (piece === gameState.currentTurn) {
    AudioManager.playSelect();
    if (gameState.selectPiece(r, c)) {
      renderGameBoard();
    } else {
      setStatus('该棋子无法移动');
    }
  }
}

/**
 * 安排电脑走子。困难档会占着主线程算 1.5 秒，所以先把"思考中"画到屏幕上，
 * 等浏览器真的绘完这一帧（两层 rAF）再开始算，否则看起来就像卡死了。
 */
function scheduleAIMove(delay = 500) {
  setTimeout(() => {
    setStatus('🤔 电脑思考中…');
    requestAnimationFrame(() => requestAnimationFrame(doAIMove));
  }, delay);
}

function doAIMove() {
  if (gameState.gameOver) return;

  const aiSide = gameState.currentTurn;
  const move = AIPlayer.makeMove(gameState, aiSide, aiDifficulty);

  if (!move) {
    gameState.currentTurn = gameState.currentTurn === CANNON ? GHOST : CANNON;
    gameState.checkWinCondition();
    if (gameState.gameOver) {
      handleGameOver();
      return;
    }
    renderGameBoard();
    updateGameUI();
    return;
  }

  gameState.selectPiece(move.from.r, move.from.c);
  const result = gameState.movePiece(move.to.r, move.to.c);

  if (result) {
    if (result.captured) {
      AudioManager.playCapture();
    } else {
      AudioManager.playMove();
    }
  }

  renderGameBoard();
  updateGameUI();

  if (gameState.gameOver) {
    handleGameOver();
  }
}

function updateGameUI() {
  const turnText = document.getElementById('turn-text');
  const turnInd = document.getElementById('turn-indicator');
  const ghostRem = document.getElementById('ghost-remaining');
  const cannonRem = document.getElementById('cannon-remaining');

  if (gameState.currentTurn === CANNON) {
    turnText.textContent = '💣 大炮方回合';
    turnInd.className = 'turn-indicator cannon-turn';
  } else {
    turnText.textContent = '👻 小鬼方回合';
    turnInd.className = 'turn-indicator ghost-turn';
  }

  ghostRem.textContent = '👻 ×' + gameState.countGhosts();
  cannonRem.textContent = '💣 ×' + gameState.countCannons();
}

function setStatus(msg) {
  document.getElementById('game-status').textContent = msg;
  setTimeout(() => {
    document.getElementById('game-status').textContent = '';
  }, 2000);
}

function handleGameOver() {
  const modal = document.getElementById('game-over-modal');
  const title = document.getElementById('game-over-title');
  const message = document.getElementById('game-over-message');

  if (gameState.winner === CANNON) {
    title.textContent = '💣 大炮方获胜！';
    message.textContent = '大炮成功消灭了足够多的小鬼！';
    if (gameMode === 'ai') {
      playerSide === CANNON ? AudioManager.playWin() : AudioManager.playLose();
    } else if (gameMode === 'online') {
      playerSide === CANNON ? AudioManager.playWin() : AudioManager.playLose();
    } else {
      AudioManager.playWin();
    }
  } else {
    title.textContent = '👻 小鬼方获胜！';
    message.textContent = '小鬼成功围堵了所有大炮！';
    if (gameMode === 'ai') {
      playerSide === GHOST ? AudioManager.playWin() : AudioManager.playLose();
    } else if (gameMode === 'online') {
      playerSide === GHOST ? AudioManager.playWin() : AudioManager.playLose();
    } else {
      AudioManager.playWin();
    }
  }

  modal.style.display = 'flex';
}

function restartGame() {
  AudioManager.playClick();
  document.getElementById('game-over-modal').style.display = 'none';
  gameState = null;

  if (gameMode === 'local') {
    initGameFromPreset(PRESET_MAPS[selectedPreset.local]);
  } else if (gameMode === 'ai') {
    initGameFromPreset(PRESET_MAPS[selectedPreset.ai]);
  } else if (gameMode === 'online') {
    // 局面由房主持有，所以只有房主能直接开新局，加入方发请求。
    if (isOnlineHost()) {
      startOnlineMatch();
    } else if (room && room.isReady()) {
      room.send('restartRequest', {});
      setStatus('已请求房主重开一局…');
    } else {
      setStatus('对手已断开，无法重开');
    }
  }
}

function backToMenu() {
  AudioManager.playClick();
  document.getElementById('game-over-modal').style.display = 'none';
  closeRoom(true);
  gameState = null;
  showLobbyEntry();
  showScreen('menu');
}

function confirmQuit() {
  if (confirm('确定要退出当前对局吗？')) {
    AudioManager.playClick();
    closeRoom(true);
    gameState = null;
    showLobbyEntry();
    showScreen('menu');
  }
}

/* ---------------- 在线对局：公共 MQTT 房间 + 优先走 WebRTC 直连 ---------------- */

let room = null;
let onlineInitial = null;       // 房主本局采用的初始局面 {width, height, board}
let onlineHostSide = 'cannon';  // 房主执哪一方；加入方自动取另一方
let onlineReadyInfo = null;     // 准备界面上的房间号 / 通路，中途换通路时要跟着更新

/** 房主才能决定局面和重开（局面在他手里）。 */
function isOnlineHost() {
  return !!room && room.role === 'host';
}

/** 房主换边：本地立刻生效，并同步给加入方。 */
function chooseOnlineSide(side) {
  AudioManager.playClick();
  if (!isOnlineHost()) return;
  applyOnlineSide(side);
  room.send('side', { hostSide: onlineHostSide });
}

/** 统一算"我执哪一方"：房主听自己的选择，加入方永远取另一方。 */
function applyOnlineSide(hostSide) {
  onlineHostSide = hostSide === 'ghost' ? 'ghost' : 'cannon';
  const mySide = isOnlineHost()
    ? onlineHostSide
    : (onlineHostSide === 'cannon' ? 'ghost' : 'cannon');
  playerSide = mySide === 'cannon' ? CANNON : GHOST;
  renderOnlineSide();
}

function renderOnlineSide() {
  for (const button of document.querySelectorAll('#side-select .side-btn')) {
    button.classList.toggle('selected', button.dataset.side === onlineHostSide);
  }
  const role = document.getElementById('ready-role');
  if (role) {
    role.textContent = playerSide === CANNON ? '💣 你是大炮方（先手）' : '👻 你是小鬼方（后手）';
  }
}

function presetToInitial(preset) {
  const state = new GameState(preset.width, preset.height);
  for (const [r, c] of preset.cannons) state.placeCannon(r, c);
  for (const [r, c] of preset.ghosts) state.placeGhost(r, c);
  return { width: state.width, height: state.height, board: state.board.map(row => [...row]) };
}

/** 房主在准备界面选定的初始局面（预设地图，或编辑过的自定义局面）。 */
function currentOnlineInitial() {
  if (customPositions && customSource === 'online') {
    return {
      width: customPositions.width,
      height: customPositions.height,
      board: customPositions.board.map(row => [...row])
    };
  }
  return presetToInitial(PRESET_MAPS[selectedPreset.online]);
}

function setLobbyStatus(message) {
  const el = document.getElementById('lobby-status');
  if (el) el.textContent = message || '';
}

function showLobbyEntry() {
  const actions = document.getElementById('lobby-actions');
  if (actions) actions.style.display = '';
  const panel = document.getElementById('room-panel');
  if (panel) panel.style.display = 'none';
}

function closeRoom(notify) {
  if (room) {
    room.close(notify);
    room = null;
  }
}

function resetRoom() {
  closeRoom(false);
}

function roomHandlers() {
  return {
    onStatus: (status) => {
      if (status.phase === 'connecting') {
        setLobbyStatus('正在连接中转服务器 ' + status.index + '/' + status.total + '…');
      } else if (status.phase === 'waiting') {
        setLobbyStatus('房间已创建，等待对手加入…');
      } else if (status.phase === 'joining') {
        setLobbyStatus('正在寻找房间 ' + status.code + '…');
      } else if (status.phase === 'negotiating') {
        setLobbyStatus('已找到对手，正在尝试直连…');
      } else if (status.phase === 'transport') {
        // 半路换通路（典型是直连断了自动改走中继）：界面上的模式得跟着说实话。
        updateReadyTransport(status.mode);
        setStatus(status.mode === 'relay' ? '直连中断，已自动切到中转模式' : '已切到直连模式');
      }
    },
    onReady: showReadyScreen,
    onMessage: handlePeerMessage,
    onError: (error) => {
      resetRoom();
      showLobbyEntry();
      setLobbyStatus(error.message);
      alert(error.message);
    },
    onClosed: (reason) => {
      // 还在准备界面（没开局）时也要说清楚，不然用户对着一个点不动的"开始游戏"发呆。
      if (currentScreen === 'online-ready') updateReadyTransport(null, reason);
      if (gameMode === 'online' && gameState && !gameState.gameOver) setStatus(reason);
    }
  };
}

async function createRoom() {
  AudioManager.playClick();
  resetRoom();
  showLobbyEntry();
  setLobbyStatus('正在连接中转服务器…');

  try {
    room = new CannonRoom.GameRoom(roomHandlers());
    const code = await room.host();
    document.getElementById('room-code-display').textContent = code;
    document.getElementById('lobby-actions').style.display = 'none';
    document.getElementById('room-panel').style.display = 'block';
    setLobbyStatus('房间已创建，等待对手加入…');
  } catch (error) {
    resetRoom();
    setLobbyStatus(error.message);
    alert(error.message);
  }
}

async function joinRoom() {
  AudioManager.playClick();
  const input = document.getElementById('room-code-input');
  const code = CannonRoom.normalizeRoomCode(input.value);
  input.value = code;

  if (code.length !== 6) {
    alert('请输入 6 位房间号');
    return;
  }

  resetRoom();
  showLobbyEntry();
  setLobbyStatus('正在加入房间 ' + code + '…');

  try {
    room = new CannonRoom.GameRoom(roomHandlers());
    await room.join(code);
  } catch (error) {
    resetRoom();
    setLobbyStatus(error.message);
    alert(error.message);
  }
}

/** 剪贴板在 file:// 或纯 http 下不可用，退回 execCommand。 */
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', 'readonly');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(input);
  return ok ? Promise.resolve() : Promise.reject(new Error('copy_failed'));
}

function copyRoomCode() {
  AudioManager.playClick();
  const code = document.getElementById('room-code-display').textContent.trim();
  const tag = document.getElementById('room-code-copied');
  copyText(code).then(() => {
    tag.textContent = ' ✓ 已复制';
    setTimeout(() => { tag.textContent = ''; }, 1500);
  }).catch(() => {
    tag.textContent = ' 复制失败，请手动记下';
  });
}

function cancelRoom() {
  AudioManager.playClick();
  resetRoom();
  showLobbyEntry();
  setLobbyStatus('');
}

function leaveOnline() {
  AudioManager.playClick();
  resetRoom();
  showLobbyEntry();
  setLobbyStatus('');
  showScreen('menu');
}

function enterOnline() {
  AudioManager.playClick();
  resetRoom();
  showLobbyEntry();
  setLobbyStatus('');
  const input = document.getElementById('room-code-input');
  if (input) input.value = '';
  showScreen('online-lobby');
}

/* 连上之后双方都先到准备界面：房主选自己执哪一方 + 选地图，加入方等待。 */
function showReadyScreen(info) {
  const isHost = info.role === 'host';
  // 站位：房主听自己的选择，加入方用最近一次收到的（默认大炮方）。
  // 不能在这里把加入方的站位重置成默认值 —— 房主的 side 消息可能已经到了，会被覆盖掉。
  applyOnlineSide(onlineHostSide);

  onlineReadyInfo = { code: info.code, transport: info.transport };
  renderReadyMeta();
  document.getElementById('ready-host-panel').style.display = isHost ? '' : 'none';
  document.getElementById('ready-guest-panel').style.display = isHost ? 'none' : '';
  document.getElementById('ready-start-btn').style.display = isHost ? '' : 'none';

  // 房主把当前站位同步一次，这样后进来的（或重进的）加入方一进来就是对的。
  if (isHost) room.send('side', { hostSide: onlineHostSide });

  showScreen('online-ready');
}

/** 准备界面顶部的"房间 + 通路"。通路会在对局中途变（直连断了改中继），所以要能重画。 */
function renderReadyMeta() {
  if (!onlineReadyInfo) return;
  const meta = document.getElementById('ready-meta');
  meta.textContent = onlineReadyInfo.transport
    ? '房间 ' + onlineReadyInfo.code + ' · ' + (onlineReadyInfo.transport === 'p2p' ? '直连模式' : '中转模式')
    : '房间 ' + onlineReadyInfo.code + ' · ' + (onlineReadyInfo.note || '对手已断开');
}

function updateReadyTransport(mode, note) {
  if (!onlineReadyInfo) return;
  if (note) onlineReadyInfo.note = note;
  if (mode === onlineReadyInfo.transport) return;
  onlineReadyInfo.transport = mode;
  renderReadyMeta();
}

/** 房主开始对局：把选定的站位和局面一起下发给加入方，双方同时进棋盘。 */
function startOnlineMatch() {
  AudioManager.playClick();
  if (!isOnlineHost()) return;
  if (!room.isReady()) {
    alert('对手还没有进来');
    return;
  }
  onlineInitial = currentOnlineInitial();
  room.send('start', { ...onlineInitial, hostSide: onlineHostSide });
  startOnlineGame(onlineInitial);
}

function leaveReady() {
  AudioManager.playClick();
  resetRoom();
  showLobbyEntry();
  setLobbyStatus('');
  showScreen('menu');
}

function handlePeerMessage(message) {
  if (!message || typeof message !== 'object') return;

  switch (message.type) {
    case 'side':
      // 房主换边，加入方跟着换（自己的执子方永远是房主的对面）。
      if (!isOnlineHost()) applyOnlineSide(message.hostSide);
      break;
    case 'start':
      startOnlineGame(message);
      break;
    case 'move':
      applyRemoteMove(message);
      break;
    case 'restartRequest':
      // 重开由房主决定（局面在他手里），并重新下发一次。
      if (isOnlineHost()) startOnlineMatch();
      break;
    case 'bye':
      // 对手离开：房间（房主这边）还开着，同一个房间号可以再进人。
      setStatus(isOnlineHost()
        ? '对手已离开，房间还开着：让他用同一个房间号再进就行'
        : '房主已离开房间');
      break;
    default:
      break;
  }
}

function startOnlineGame(data) {
  if (!data || !Array.isArray(data.board) || !data.board.length) return;
  // 开局时房主会把站位再带一次，加入方据此确定自己执哪一方。
  if (data.hostSide) applyOnlineSide(data.hostSide);

  gameState = new GameState(data.width, data.height);
  gameState.board = data.board.map(row => [...row]);
  gameMode = 'online';
  document.getElementById('game-over-modal').style.display = 'none';
  showScreen('game');
  renderGameBoard();
  updateGameUI();
  setStatus(playerSide === CANNON ? '在线对局 · 你是大炮方 💣' : '在线对局 · 你是小鬼方 👻');
}

function applyRemoteMove(message) {
  if (!gameState || gameState.gameOver) return;

  // 只有轮到对手时才接受对手走子，否则说明状态已不同步，直接忽略。
  const expectedSide = playerSide === CANNON ? GHOST : CANNON;
  if (gameState.currentTurn !== expectedSide) return;

  if (!gameState.selectPiece(message.fromR, message.fromC)) return;
  const result = gameState.movePiece(message.toR, message.toC);
  if (!result) {
    gameState.deselectPiece();
    return;
  }

  result.captured ? AudioManager.playCapture() : AudioManager.playMove();
  renderGameBoard();
  updateGameUI();

  if (gameState.gameOver) handleGameOver();
}

function submitOnlineMove(fromR, fromC, toR, toC) {
  if (!room || !room.isReady()) {
    setStatus('尚未与对手建立连接');
    return false;
  }

  const result = gameState.movePiece(toR, toC);
  if (!result) return false;

  result.captured ? AudioManager.playCapture() : AudioManager.playMove();
  renderGameBoard();
  updateGameUI();

  // 双方跑同一套规则，所以只需同步这一手，不必同步整个棋盘。
  room.send('move', { fromR, fromC, toR, toC });

  if (gameState.gameOver) handleGameOver();
  return true;
}

window.addEventListener('resize', () => {
  if (currentScreen === 'editor' && editorState) {
    renderEditorBoard();
  } else if (currentScreen === 'game' && gameState) {
    renderGameBoard();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  renderPresetMaps('local');
  renderPresetMaps('ai');
});
