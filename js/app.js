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

function renderEditorBoard() {
  const board = document.getElementById('editor-board');
  const w = editorState.width;
  const h = editorState.height;
  const maxW = Math.min(window.innerWidth - 40, 500);
  const maxH = Math.min(window.innerHeight - 300, 500);
  const cs = Math.floor(Math.min(maxW / w, maxH / h, 60));
  cellSize = cs;
  document.documentElement.style.setProperty('--cell-size', cs + 'px');

  board.style.width = (w * cs) + 'px';
  board.style.height = (h * cs) + 'px';
  board.innerHTML = '';

  const canvas = document.createElement('canvas');
  canvas.className = 'board-canvas';
  canvas.width = w * cs;
  canvas.height = h * cs;
  board.appendChild(canvas);
  drawGridLines(canvas, w, h, cs);

  let cannonCount = 0;
  let ghostCount = 0;

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const cell = document.createElement('div');
      cell.className = 'board-cell';
      cell.style.width = cs + 'px';
      cell.style.height = cs + 'px';
      cell.style.left = (c * cs) + 'px';
      cell.style.top = (r * cs) + 'px';

      const piece = editorState.getPiece(r, c);
      if (piece === CANNON) {
        cannonCount++;
        const p = document.createElement('div');
        p.className = 'piece cannon';
        p.textContent = '💣';
        p.style.fontSize = Math.floor(cs * 0.45) + 'px';
        cell.appendChild(p);
      } else if (piece === GHOST) {
        ghostCount++;
        const p = document.createElement('div');
        p.className = 'piece ghost';
        p.textContent = '👻';
        p.style.fontSize = Math.floor(cs * 0.45) + 'px';
        cell.appendChild(p);
      } else {
        const dot = document.createElement('div');
        dot.className = 'cell-dot';
        cell.appendChild(dot);
      }

      cell.onclick = () => {
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

      board.appendChild(cell);
    }
  }

  document.getElementById('editor-cannon-count').textContent = cannonCount;
  document.getElementById('editor-ghost-count').textContent = ghostCount;
}

function drawGridLines(canvas, w, h, cs) {
  const ctx = canvas.getContext('2d');
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
    setTimeout(doAIMove, 500);
  }
}

function renderGameBoard() {
  const board = document.getElementById('game-board');
  const w = gameState.width;
  const h = gameState.height;

  const maxW = Math.min(window.innerWidth - 24, 600);
  const maxH = Math.min(window.innerHeight - 160, 600);
  const cs = Math.floor(Math.min(maxW / w, maxH / h, 80));
  cellSize = cs;
  document.documentElement.style.setProperty('--cell-size', cs + 'px');

  board.style.width = (w * cs) + 'px';
  board.style.height = (h * cs) + 'px';
  board.innerHTML = '';

  const canvas = document.createElement('canvas');
  canvas.className = 'board-canvas';
  canvas.width = w * cs;
  canvas.height = h * cs;
  board.appendChild(canvas);
  drawGridLines(canvas, w, h, cs);

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const cell = document.createElement('div');
      cell.className = 'board-cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      cell.style.width = cs + 'px';
      cell.style.height = cs + 'px';
      cell.style.left = (c * cs) + 'px';
      cell.style.top = (r * cs) + 'px';

      const piece = gameState.getPiece(r, c);
      if (piece === CANNON) {
        const p = document.createElement('div');
        p.className = 'piece cannon';
        p.textContent = '💣';
        p.style.fontSize = Math.floor(cs * 0.45) + 'px';
        cell.appendChild(p);
      } else if (piece === GHOST) {
        const p = document.createElement('div');
        p.className = 'piece ghost';
        p.textContent = '👻';
        p.style.fontSize = Math.floor(cs * 0.45) + 'px';
        cell.appendChild(p);
      } else {
        const dot = document.createElement('div');
        dot.className = 'cell-dot';
        cell.appendChild(dot);
      }

      if (gameState.selectedPiece && gameState.selectedPiece.r === r && gameState.selectedPiece.c === c) {
        const p = cell.querySelector('.piece');
        if (p) p.classList.add('selected');
      }

      const isValidMove = gameState.validMoves.find(m => m.r === r && m.c === c);
      if (isValidMove) {
        cell.classList.add(isValidMove.capture ? 'capture-highlight' : 'highlight');
      }

      if (gameState.lastMove) {
        if ((gameState.lastMove.toR === r && gameState.lastMove.toC === c)) {
          cell.classList.add('last-move');
        }
      }

      cell.onclick = () => handleCellClick(r, c);
      board.appendChild(cell);
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
          setTimeout(doAIMove, 400);
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
    if (playerSide === CANNON) {
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

/* 连上之后双方都先到准备界面：房主选地图，加入方等待。 */
function showReadyScreen(info) {
  const isHost = info.role === 'host';
  playerSide = isHost ? CANNON : GHOST;

  document.getElementById('ready-role').textContent =
    playerSide === CANNON ? '💣 你是大炮方（先手）' : '👻 你是小鬼方';
  document.getElementById('ready-meta').textContent =
    '房间 ' + info.code + ' · ' + (info.transport === 'p2p' ? '直连模式' : '中转模式');
  document.getElementById('ready-host-panel').style.display = isHost ? '' : 'none';
  document.getElementById('ready-guest-panel').style.display = isHost ? 'none' : '';
  document.getElementById('ready-start-btn').style.display = isHost ? '' : 'none';

  showScreen('online-ready');
}

/** 房主开始对局：把选定的局面下发给加入方，双方同时进棋盘。 */
function startOnlineMatch() {
  AudioManager.playClick();
  if (!room || !room.isReady()) {
    alert('对手还没有进来');
    return;
  }
  onlineInitial = currentOnlineInitial();
  room.send('start', onlineInitial);
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
    case 'start':
      startOnlineGame(message);
      break;
    case 'move':
      applyRemoteMove(message);
      break;
    case 'restartRequest':
      // 重开由房主（大炮方）决定，并重新下发一次局面。
      if (playerSide === CANNON) startOnlineMatch();
      break;
    case 'bye':
      setStatus('对手已离开对局');
      break;
    default:
      break;
  }
}

function startOnlineGame(data) {
  if (!data || !Array.isArray(data.board) || !data.board.length) return;

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
