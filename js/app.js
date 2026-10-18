let currentScreen = 'menu';
let gameMode = null;
let playerSide = CANNON;
let aiDifficulty = 'normal';
let gameState = null;
let editorState = null;
let editorMode = null;
let editorTool = 'cannon';
let selectedPresetLocal = 0;
let selectedPresetAI = 0;
let customPositions = null;
let customSource = null;
let boardElement = null;
let cellSize = 60;

function showScreen(name) {
  AudioManager.playClick();
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screen = document.getElementById('screen-' + name);
  if (screen) {
    screen.classList.add('active');
    currentScreen = name;
  }

  if (name === 'local-setup' || name === 'ai-setup') {
    renderPresetMaps(name === 'local-setup' ? 'local' : 'ai');
  } else if (name === 'online-lobby') {
    renderOnlinePresets();
  }
}

function renderPresetMaps(mode) {
  const container = document.getElementById('preset-maps-' + mode);
  container.innerHTML = '';
  PRESET_MAPS.forEach((map, i) => {
    const btn = document.createElement('button');
    btn.className = 'preset-map-btn' + ((mode === 'local' ? selectedPresetLocal : selectedPresetAI) === i ? ' selected' : '');
    btn.innerHTML = `<span class="map-name">${map.name}</span><span class="map-desc">${map.desc}</span>`;
    btn.onclick = () => {
      AudioManager.playClick();
      if (mode === 'local') {
        selectedPresetLocal = i;
      } else {
        selectedPresetAI = i;
      }
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

  const presetIdx = mode === 'local' ? selectedPresetLocal : selectedPresetAI;
  const preset = PRESET_MAPS[presetIdx];

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
  showScreen(editorMode === 'local' ? 'local-setup' : 'ai-setup');
}

function confirmEditor() {
  AudioManager.playClick();
  customPositions = {
    width: editorState.width,
    height: editorState.height,
    board: editorState.board.map(row => [...row])
  };
  showScreen(editorMode === 'local' ? 'local-setup' : 'ai-setup');
}

function startLocalGame() {
  AudioManager.playClick();
  gameMode = 'local';

  if (customPositions && customSource === 'local') {
    initGameFromCustom();
  } else {
    const preset = PRESET_MAPS[selectedPresetLocal];
    initGameFromPreset(preset);
  }
}

function startAIGame() {
  AudioManager.playClick();
  gameMode = 'ai';

  if (customPositions && customSource === 'ai') {
    initGameFromCustom();
  } else {
    const preset = PRESET_MAPS[selectedPresetAI];
    initGameFromPreset(preset);
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
    const preset = PRESET_MAPS[selectedPresetLocal];
    initGameFromPreset(preset);
  } else if (gameMode === 'ai') {
    const preset = PRESET_MAPS[selectedPresetAI];
    initGameFromPreset(preset);
  } else if (gameMode === 'online') {
    // 局面由房主持有，所以只有房主能直接开新局，加入方发请求。
    if (playerSide === CANNON) {
      sendOnlineRestart();
    } else if (p2p && p2p.isOpen()) {
      p2p.send('restartRequest', {});
      setStatus('已请求房主重开一局…');
    } else {
      setStatus('对手已断开，无法重开');
    }
  }
}

function backToMenu() {
  AudioManager.playClick();
  document.getElementById('game-over-modal').style.display = 'none';
  closeOnlineConnection(true);
  gameState = null;
  resetLobbyPanels();
  showScreen('menu');
}

function confirmQuit() {
  if (confirm('确定要退出当前对局吗？')) {
    AudioManager.playClick();
    closeOnlineConnection(true);
    gameState = null;
    resetLobbyPanels();
    showScreen('menu');
  }
}

/* ---------------- 在线对局：WebRTC 直连（人工转发信令，无需服务器） ---------------- */

let p2p = null;
let onlineInitial = null;       // 房主选定的初始局面 {width, height, board}
let selectedOnlinePreset = 0;

function renderOnlinePresets() {
  const select = document.getElementById('online-preset');
  if (!select || select.options.length) return;
  PRESET_MAPS.forEach((map, i) => {
    const option = document.createElement('option');
    option.value = String(i);
    option.textContent = map.name + ' · ' + map.desc;
    select.appendChild(option);
  });
  select.value = String(selectedOnlinePreset);
  select.onchange = () => { selectedOnlinePreset = Number(select.value); };
}

function presetToInitial(preset) {
  const state = new GameState(preset.width, preset.height);
  for (const [r, c] of preset.cannons) state.placeCannon(r, c);
  for (const [r, c] of preset.ghosts) state.placeGhost(r, c);
  return { width: state.width, height: state.height, board: state.board.map(row => [...row]) };
}

function setLobbyStatus(message) {
  const el = document.getElementById('lobby-status');
  if (el) el.textContent = message || '';
}

function resetLobbyPanels() {
  const actions = document.getElementById('lobby-actions');
  if (actions) actions.style.display = '';
  for (const id of ['relay-panel', 'answer-panel']) {
    const panel = document.getElementById(id);
    if (panel) panel.style.display = 'none';
  }
  const copied = document.getElementById('relay-copied');
  if (copied) copied.textContent = '';
  setLobbyStatus('');
}

function showRelayPanel(code, hint) {
  document.getElementById('lobby-actions').style.display = 'none';
  document.getElementById('relay-panel').style.display = 'block';
  document.getElementById('relay-hint').textContent = hint;
  document.getElementById('relay-output').value = code;
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  // file:// 或纯 http 下的兜底方案
  const box = document.getElementById('relay-output');
  box.removeAttribute('readonly');
  box.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  box.setAttribute('readonly', 'readonly');
  return ok ? Promise.resolve() : Promise.reject(new Error('copy_failed'));
}

function copyRelayCode() {
  AudioManager.playClick();
  const box = document.getElementById('relay-output');
  const tag = document.getElementById('relay-copied');
  copyText(box.value).then(() => {
    tag.textContent = ' ✓ 已复制';
    setTimeout(() => { tag.textContent = ''; }, 1500);
  }).catch(() => {
    box.select();
    tag.textContent = ' 复制失败，请手动全选复制';
  });
}

function backFromRelay() {
  AudioManager.playClick();
  closeOnlineConnection(true);
  resetLobbyPanels();
}

function leaveOnline() {
  AudioManager.playClick();
  closeOnlineConnection(true);
  resetLobbyPanels();
  showScreen('menu');
}

function resetP2P() {
  closeOnlineConnection(false);
  onlineInitial = null;
}

function closeOnlineConnection(notifyPeer) {
  if (p2p) {
    if (notifyPeer && p2p.isOpen()) p2p.send('bye', {});
    p2p.close();
    p2p = null;
  }
}

function peerHandlers() {
  return {
    onOpen: onPeerOpen,
    onMessage: handlePeerMessage,
    onState: (state) => {
      const cs = state.connectionState;
      if (cs === 'failed') {
        setLobbyStatus('直连失败：双方可能都在对称 NAT 后，需要 TURN 中继（见 README）');
        if (gameMode === 'online') setStatus('直连失败：网络无法穿透');
      } else if (cs === 'connecting') {
        setLobbyStatus('正在打通直连…');
      } else if (cs === 'connected') {
        setLobbyStatus('直连已建立');
      }
    },
    onClose: () => {
      if (gameMode === 'online' && gameState && !gameState.gameOver) {
        setStatus('对手已断开连接');
      }
    }
  };
}

function onPeerOpen() {
  setLobbyStatus('直连已建立！');
  // 局面由房主决定并下发，加入方收到 init 后才进入棋盘。
  if (playerSide === CANNON && onlineInitial) {
    p2p.send('init', onlineInitial);
    startOnlineGame(onlineInitial);
  }
}

function handlePeerMessage(message) {
  if (!message || typeof message !== 'object') return;

  switch (message.type) {
    case 'init':
    case 'restart':
      startOnlineGame(message);
      break;
    case 'move':
      applyRemoteMove(message);
      break;
    case 'restartRequest':
      if (playerSide === CANNON) sendOnlineRestart();
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
  setStatus(playerSide === CANNON ? '在线直连 · 你是大炮方 💣' : '在线直连 · 你是小鬼方 👻');
}

function sendOnlineRestart() {
  if (!p2p || !p2p.isOpen() || !onlineInitial) {
    setStatus('对手已断开，无法重开');
    return;
  }
  p2p.send('restart', onlineInitial);
  startOnlineGame(onlineInitial);
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

async function createRoom() {
  AudioManager.playClick();
  if (typeof RTCPeerConnection === 'undefined') {
    alert('当前浏览器不支持 WebRTC，无法直连');
    return;
  }

  resetP2P();
  resetLobbyPanels();
  playerSide = CANNON;
  onlineInitial = presetToInitial(PRESET_MAPS[selectedOnlinePreset]);

  try {
    p2p = new P2PConnection(peerHandlers());
    const offerCode = await p2p.createOffer();
    showRelayPanel(offerCode, '① 把这段邀请码发给对手（QQ / 微信均可）');
    document.getElementById('answer-panel').style.display = 'block';
    setLobbyStatus('等待对手回传应答码…');
  } catch (e) {
    p2p = null;
    alert('生成邀请码失败: ' + e.message);
  }
}

async function joinRoom() {
  AudioManager.playClick();
  if (typeof RTCPeerConnection === 'undefined') {
    alert('当前浏览器不支持 WebRTC，无法直连');
    return;
  }

  const offerCode = document.getElementById('offer-input').value;
  if (!offerCode.trim()) {
    alert('请先粘贴房主发来的邀请码');
    return;
  }

  resetP2P();
  resetLobbyPanels();
  playerSide = GHOST;

  try {
    p2p = new P2PConnection(peerHandlers());
    const answerCode = await p2p.acceptOffer(offerCode);
    showRelayPanel(answerCode, '② 把这段应答码回传房主，等他点「连接对手」…');
    setLobbyStatus('等待房主连接…');
  } catch (e) {
    p2p = null;
    alert('邀请码无效: ' + e.message);
  }
}

async function finishConnection() {
  AudioManager.playClick();
  if (!p2p) {
    alert('请先点「生成邀请码」');
    return;
  }

  const answerCode = document.getElementById('answer-input').value;
  if (!answerCode.trim()) {
    alert('请粘贴对手回传的应答码');
    return;
  }

  try {
    await p2p.acceptAnswer(answerCode);
    setLobbyStatus('应答码已接受，正在打通直连…');
  } catch (e) {
    alert('应答码无效: ' + e.message);
  }
}

async function submitOnlineMove(fromR, fromC, toR, toC) {
  if (!p2p || !p2p.isOpen()) {
    setStatus('尚未与对手建立直连');
    return false;
  }

  const result = gameState.movePiece(toR, toC);
  if (!result) return false;

  result.captured ? AudioManager.playCapture() : AudioManager.playMove();
  renderGameBoard();
  updateGameUI();

  // 双方跑同一套规则，所以只需同步这一手，不必同步整个棋盘。
  p2p.send('move', { fromR, fromC, toR, toC });

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
