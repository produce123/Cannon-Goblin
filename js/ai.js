// 人机难度只由"预测几步"决定：简单 1 步、普通 2 步、困难 4 步。
// 搜索用同一套 alpha-beta + evaluateBoard，难度差异全部来自深度参数。
const AI_DEPTHS = { easy: 1, normal: 2, hard: 4 };

// 单步思考的时间上限：困难模式要算 4 步，但绝不能让手机界面卡住。
// 迭代加深 + 这个预算 = 算得完就继续加深，算不完就退回上一层已经算完的结果。
const AI_TIME_BUDGET_MS = 700;
// 节点上限，兜底防止极端局面下无限呆住（时间检查每 2048 个节点才做一次）。
const AI_NODE_BUDGET = 400000;

const AIPlayer = {
  makeMove(gameState, side, difficulty = 'normal') {
    return this.searchMove(gameState, side, AI_DEPTHS[difficulty] || AI_DEPTHS.normal);
  },

  /**
   * 迭代加深：1 层 → 2 层 → … → maxDepth，返回最后一次**完整**搜索得到的最佳走法。
   * 这样做有两个好处：alpha-beta 能拿上一层的结论当走法顺序，剪枝效率高得多；
   * 时间预算用完时还能退回上一层的结果，而不是一无所获。
   */
  searchMove(gs, side, maxDepth) {
    this.nodes = 0;
    this.aborted = false;
    this.startedAt = Date.now();

    let best = null;
    for (let depth = 1; depth <= maxDepth; depth++) {
      const result = this.searchRoot(gs, side, depth, best);

      if (result.aborted) {
        // 预算用完了：有完整结果就用完整结果，没有就至少出一手（不然人机不动了）
        if (!best && result.move) best = result.move;
        break;
      }

      best = result.move || best;
      if (Math.abs(result.score) >= 100000) break; // 已经算出必胜/必败，不必再深挖
    }

    return best;
  },

  /** 搜根节点这一层。previousBest 先搜，alpha-beta 才剪得动。 */
  searchRoot(gs, side, depth, previousBest) {
    const maximizing = side === CANNON;
    const moves = this.orderMoves(gs, side, this.listMoves(gs, side));
    if (moves.length === 0) return { move: null, score: 0, aborted: false };
    if (previousBest) this.promoteFirst(moves, previousBest);

    let bestScore = maximizing ? -Infinity : Infinity;
    let bestMove = moves[0];

    for (const move of moves) {
      const score = this.minimax(this.applyMove(gs, move, side), depth - 1, -Infinity, Infinity, side);
      if (this.aborted) break;
      if (maximizing ? score > bestScore : score < bestScore) {
        bestScore = score;
        bestMove = move;
      }
    }

    return { move: bestMove, score: bestScore, aborted: this.aborted };
  },

  /**
   * alpha-beta 极小极大。CANONON 取极大、小鬼取极小（evaluateBoard 就是按这个方向写的）。
   * 轮到谁走由 gs.currentTurn 决定，不再额外传参数。
   */
  minimax(gs, depth, alpha, beta, aiSide) {
    if (depth <= 0 || gs.gameOver) return this.evaluateBoard(gs, aiSide);

    if (++this.nodes > AI_NODE_BUDGET ||
        ((this.nodes & 2047) === 0 && Date.now() - this.startedAt > AI_TIME_BUDGET_MS)) {
      this.aborted = true;
      return this.evaluateBoard(gs, aiSide);
    }

    const side = gs.currentTurn;
    const maximizing = side === CANNON;
    // 最后一层不用排序：子节点全是叶子，排了也剪不到，纯浪费时间。
    const moves = depth >= 2
      ? this.orderMoves(gs, side, this.listMoves(gs, side))
      : this.listMoves(gs, side);
    if (moves.length === 0) return this.evaluateBoard(gs, aiSide);

    let best = maximizing ? -Infinity : Infinity;
    for (const move of moves) {
      const score = this.minimax(this.applyMove(gs, move, side), depth - 1, alpha, beta, aiSide);
      if (maximizing) {
        if (score > best) best = score;
        if (best > alpha) alpha = best;
      } else {
        if (score < best) best = score;
        if (best < beta) beta = best;
      }
      if (beta <= alpha || this.aborted) break;
    }
    return best;
  },

  listMoves(gs, side) {
    const moves = [];
    for (const piece of gs.getAllPiecesForSide(side)) {
      for (const move of gs.getAllMoves(piece.r, piece.c)) {
        moves.push({ from: piece, to: move });
      }
    }
    return moves;
  },

  /**
   * 走法排序：先吃子；小鬼再优先"靠近大炮"的走法（围堵的关键）。
   * alpha-beta 的剪枝效果基本全看这个顺序，困难模式敢算 4 步靠的就是它。
   */
  orderMoves(gs, side, moves) {
    const cannons = side === GHOST ? gs.getAllPiecesForSide(CANNON) : null;

    return moves.map((move) => {
      let score = move.to.capture ? 100 : 0;
      if (cannons) {
        let minDist = Infinity;
        for (const cannon of cannons) {
          const dist = Math.abs(move.to.r - cannon.r) + Math.abs(move.to.c - cannon.c);
          if (dist < minDist) minDist = dist;
        }
        score += Math.max(0, 8 - minDist);
      }
      return { move, score };
    }).sort((a, b) => b.score - a.score).map((entry) => entry.move);
  },

  promoteFirst(moves, move) {
    const index = moves.findIndex((m) =>
      m.from.r === move.from.r && m.from.c === move.from.c &&
      m.to.r === move.to.r && m.to.c === move.to.c);
    if (index > 0) moves.unshift(moves.splice(index, 1)[0]);
  },

  /**
   * 复刻 GameState.movePiece 的顺序：先按"走子方"的回合判胜负，再换手。
   * （顺序反了就会把"被堵死"判到错的一方身上。）
   */
  applyMove(gs, move, side) {
    const sim = gs.clone();
    sim.board[move.from.r][move.from.c] = EMPTY;
    sim.board[move.to.r][move.to.c] = side;
    sim.currentTurn = side;
    sim.checkWinCondition();
    if (!sim.gameOver) {
      sim.currentTurn = side === CANNON ? GHOST : CANNON;
    }
    return sim;
  },

  evaluateBoard(gs, aiSide) {
    if (gs.gameOver) {
      if (gs.winner === aiSide) return 100000;
      else return -100000;
    }

    const aiPieces = gs.getAllPiecesForSide(aiSide);
    const oppSide = aiSide === CANNON ? GHOST : CANNON;
    const oppPieces = gs.getAllPiecesForSide(oppSide);

    let score = 0;

    if (aiSide === CANNON) {
      const ghostCount = gs.countGhosts();
      const cannonCount = gs.countCannons();
      score += (ghostCount - cannonCount) * -30;

      for (const cannon of aiPieces) {
        const moves = gs.getAllMoves(cannon.r, cannon.c);
        score += moves.length * 8;

        const captures = gs.getCaptureMoves(cannon.r, cannon.c);
        score += captures.length * 25;

        const centerR = (gs.height - 1) / 2;
        const centerC = (gs.width - 1) / 2;
        const centerDist = Math.abs(cannon.r - centerR) + Math.abs(cannon.c - centerC);
        score -= centerDist * 2;
      }

      for (const ghost of oppPieces) {
        let minDist = Infinity;
        for (const cannon of aiPieces) {
          const dist = Math.abs(ghost.r - cannon.r) + Math.abs(ghost.c - cannon.c);
          if (dist < minDist) minDist = dist;
        }
        score += minDist * 3;

        if (minDist <= 2) score += 10;
      }
    } else {
      const ghostCount = gs.countGhosts();
      const cannonCount = gs.countCannons();
      score += (cannonCount * 100 - ghostCount) * 2;

      let totalCannonMobility = 0;
      let blockedCannons = 0;

      for (const cannon of oppPieces) {
        const moves = gs.getAllMoves(cannon.r, cannon.c);
        totalCannonMobility += moves.length;
        if (moves.length === 0) blockedCannons++;

        const captures = gs.getCaptureMoves(cannon.r, cannon.c);
        totalCannonMobility += captures.length * 2;
      }

      score -= totalCannonMobility * 15;
      score += blockedCannons * 200;

      for (const ghost of aiPieces) {
        let minDist = Infinity;
        let adjacentCannons = 0;
        for (const cannon of oppPieces) {
          const dist = Math.abs(ghost.r - cannon.r) + Math.abs(ghost.c - cannon.c);
          if (dist < minDist) minDist = dist;
          if (dist === 1) adjacentCannons++;
        }
        score += (8 - minDist) * 5;
        score += adjacentCannons * 12;

        const dirs = [[-1,0],[1,0],[0,-1],[0,1]];
        let escapeRoutes = 0;
        for (const [dr, dc] of dirs) {
          const nr = ghost.r + dr;
          const nc = ghost.c + dc;
          if (gs.inBounds(nr, nc) && gs.board[nr][nc] === EMPTY) escapeRoutes++;
        }
        score -= escapeRoutes * 2;
      }

      const centerR = (gs.height - 1) / 2;
      const centerC = (gs.width - 1) / 2;
      for (const cannon of oppPieces) {
        const distToCenter = Math.abs(cannon.r - centerR) + Math.abs(cannon.c - centerC);
        score -= distToCenter * 3;
      }
    }

    return score;
  }
};