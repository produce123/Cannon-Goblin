const AIPlayer = {
  makeMove(gameState, side, difficulty = 'normal') {
    const pieces = gameState.getAllPiecesForSide(side);
    if (pieces.length === 0) return null;

    if (difficulty === 'easy') {
      return this.easyAI(gameState, pieces, side);
    } else if (difficulty === 'hard') {
      return this.hardAI(gameState, pieces, side);
    } else {
      return this.normalAI(gameState, pieces, side);
    }
  },

  easyAI(gs, pieces, side) {
    const allMoves = [];
    for (const p of pieces) {
      const moves = gs.getAllMoves(p.r, p.c);
      for (const m of moves) {
        allMoves.push({ from: p, to: m });
      }
    }
    if (allMoves.length === 0) return null;

    const captures = allMoves.filter(m => m.to.capture);
    if (captures.length > 0 && Math.random() < 0.4) {
      return captures[Math.floor(Math.random() * captures.length)];
    }

    return allMoves[Math.floor(Math.random() * allMoves.length)];
  },

  normalAI(gs, pieces, side) {
    if (side === CANNON) {
      return this.cannonAI(gs, pieces);
    } else {
      return this.ghostAI(gs, pieces);
    }
  },

  cannonAI(gs, pieces) {
    let bestCapture = null;
    let bestMoves = [];

    for (const p of pieces) {
      const moves = gs.getAllMoves(p.r, p.c);
      for (const m of moves) {
        if (m.capture) {
          if (!bestCapture) {
            bestCapture = { from: p, to: m };
          }
        }
        bestMoves.push({ from: p, to: m });
      }
    }

    if (bestCapture) {
      return bestCapture;
    }

    if (bestMoves.length === 0) return null;

    const ghosts = gs.getAllPiecesForSide(GHOST);
    let bestScore = -Infinity;
    let bestMove = bestMoves[0];

    for (const m of bestMoves) {
      let score = 0;

      let minDist = Infinity;
      for (const g of ghosts) {
        const dist = Math.abs(m.to.r - g.r) + Math.abs(m.to.c - g.c);
        if (dist < minDist) minDist = dist;
      }
      score += minDist * 2;

      const sim = gs.clone();
      sim.board[m.from.r][m.from.c] = EMPTY;
      sim.board[m.to.r][m.to.c] = CANNON;
      const futureCaptures = sim.getCaptureMoves(m.to.r, m.to.c).length;
      score += futureCaptures * 10;

      const centerR = (gs.height - 1) / 2;
      const centerC = (gs.width - 1) / 2;
      const centerDist = Math.abs(m.to.r - centerR) + Math.abs(m.to.c - centerC);
      score -= centerDist;

      const movesAfter = sim.getNormalMoves(m.to.r, m.to.c).length +
                         sim.getCaptureMoves(m.to.r, m.to.c).length;
      score += movesAfter * 3;

      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
      }
    }

    return bestMove;
  },

  ghostAI(gs, pieces) {
    const cannons = gs.getAllPiecesForSide(CANNON);
    if (cannons.length === 0) return null;

    let bestScore = -Infinity;
    let bestMove = null;

    for (const p of pieces) {
      const moves = gs.getAllMoves(p.r, p.c);
      for (const m of moves) {
        let score = 0;

        for (const cannon of cannons) {
          const distBefore = Math.abs(p.r - cannon.r) + Math.abs(p.c - cannon.c);
          const distAfter = Math.abs(m.r - cannon.r) + Math.abs(m.c - cannon.c);

          if (distAfter < distBefore) score += 5;
          else if (distAfter === distBefore) score += 1;
          else score -= 2;

          if (distAfter <= 2) score += 8;

          const dirs = [[-1,0],[1,0],[0,-1],[0,1]];
          for (const [dr, dc] of dirs) {
            const adjR = m.r + dr;
            const adjC = m.c + dc;
            if (adjR === cannon.r && adjC === cannon.c) {
              score += 10;
            }
          }
        }

        const sim = gs.clone();
        sim.board[p.r][p.c] = EMPTY;
        sim.board[m.r][m.c] = GHOST;

        let cannonsBlocked = 0;
        for (const cannon of cannons) {
          const cannonMoves = sim.getAllMoves(cannon.r, cannon.c);
          if (cannonMoves.length === 0) cannonsBlocked++;
        }
        score += cannonsBlocked * 50;

        let totalCannonMoves = 0;
        for (const cannon of cannons) {
          totalCannonMoves += sim.getAllMoves(cannon.r, cannon.c).length;
        }
        score -= totalCannonMoves * 2;

        const centerR = (gs.height - 1) / 2;
        const centerC = (gs.width - 1) / 2;
        const centerDist = Math.abs(m.r - centerR) + Math.abs(m.c - centerC);
        score -= centerDist * 0.5;

        if (score > bestScore) {
          bestScore = score;
          bestMove = { from: p, to: m };
        }
      }
    }

    if (!bestMove && pieces.length > 0) {
      for (const p of pieces) {
        const moves = gs.getAllMoves(p.r, p.c);
        if (moves.length > 0) {
          bestMove = { from: p, to: moves[0] };
          break;
        }
      }
    }

    return bestMove;
  },

  hardAI(gs, pieces, side) {
    const depth = 3;
    const isMaximizing = side === CANNON;

    let bestScore = isMaximizing ? -Infinity : Infinity;
    let bestMove = null;

    const allMoves = [];
    for (const p of pieces) {
      const moves = gs.getAllMoves(p.r, p.c);
      for (const m of moves) {
        allMoves.push({ from: p, to: m, priority: this.getMovePriority(gs, p, m, side) });
      }
    }

    if (allMoves.length === 0) return null;

    allMoves.sort((a, b) => b.priority - a.priority);

    for (const m of allMoves) {
      const sim = gs.clone();
      sim.board[m.from.r][m.from.c] = EMPTY;
      sim.board[m.to.r][m.to.c] = side;
      sim.currentTurn = side === CANNON ? GHOST : CANNON;
      sim.checkWinCondition();

      const score = this.minimax(sim, depth - 1, -Infinity, Infinity, !isMaximizing, side);

      if (isMaximizing) {
        if (score > bestScore) {
          bestScore = score;
          bestMove = m;
        }
      } else {
        if (score < bestScore) {
          bestScore = score;
          bestMove = m;
        }
      }
    }

    return bestMove;
  },

  getMovePriority(gs, piece, move, side) {
    let priority = 0;
    if (move.capture) priority += 100;
    if (side === CANNON) {
      const captures = gs.getCaptureMoves(move.r, move.c);
      priority += captures.length * 20;
    } else {
      const sim = gs.clone();
      sim.board[piece.r][piece.c] = EMPTY;
      sim.board[move.r][move.c] = GHOST;
      const cannons = gs.getAllPiecesForSide(CANNON);
      for (const cannon of cannons) {
        const moves = sim.getAllMoves(cannon.r, cannon.c);
        if (moves.length === 0) priority += 50;
      }
    }
    return priority;
  },

  minimax(gs, depth, alpha, beta, isMaximizing, aiSide) {
    if (depth === 0 || gs.gameOver) {
      return this.evaluateBoard(gs, aiSide);
    }

    const currentSide = gs.currentTurn;
    const pieces = gs.getAllPiecesForSide(currentSide);

    if (isMaximizing) {
      let maxEval = -Infinity;
      for (const p of pieces) {
        const moves = gs.getAllMoves(p.r, p.c);
        for (const m of moves) {
          const sim = gs.clone();
          sim.board[p.r][p.c] = EMPTY;
          sim.board[m.r][m.c] = currentSide;
          sim.currentTurn = currentSide === CANNON ? GHOST : CANNON;
          sim.checkWinCondition();

          const evalScore = this.minimax(sim, depth - 1, alpha, beta, false, aiSide);
          maxEval = Math.max(maxEval, evalScore);
          alpha = Math.max(alpha, evalScore);
          if (beta <= alpha) break;
        }
        if (beta <= alpha) break;
      }
      return maxEval;
    } else {
      let minEval = Infinity;
      for (const p of pieces) {
        const moves = gs.getAllMoves(p.r, p.c);
        for (const m of moves) {
          const sim = gs.clone();
          sim.board[p.r][p.c] = EMPTY;
          sim.board[m.r][m.c] = currentSide;
          sim.currentTurn = currentSide === CANNON ? GHOST : CANNON;
          sim.checkWinCondition();

          const evalScore = this.minimax(sim, depth - 1, alpha, beta, true, aiSide);
          minEval = Math.min(minEval, evalScore);
          beta = Math.min(beta, evalScore);
          if (beta <= alpha) break;
        }
        if (beta <= alpha) break;
      }
      return minEval;
    }
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
