const json = (body, status = 200, headers = {}) => Response.json(body, {
  status,
  headers: { "cache-control": "no-store", ...headers },
});

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function createInitialBoard(width, height) {
  const board = [];
  for (let r = 0; r < height; r++) {
    board[r] = [];
    for (let c = 0; c < width; c++) {
      board[r][c] = 0;
    }
  }
  return board;
}

function placeDefaultPieces(board, width, height) {
  const ghostRows = Math.min(3, Math.floor(height / 2));
  for (let r = 0; r < ghostRows; r++) {
    for (let c = 0; c < width; c++) {
      board[r][c] = 2;
    }
  }
  const cannonRow = height - 1;
  const midC = Math.floor(width / 2);
  board[cannonRow][midC - 1] = 1;
  board[cannonRow][midC] = 1;
  return board;
}

export async function handleGame({ request, supabase }) {
  const params = new URL(request.url).searchParams;
  const action = params.get("action");

  if (action === "createRoom") {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    try {
      const body = await request.json();
      const width = Math.max(4, Math.min(15, Number(body?.width) || 6));
      const height = Math.max(4, Math.min(15, Number(body?.height) || 6));

      let board;
      if (body?.board && Array.isArray(body.board)) {
        board = body.board;
      } else {
        board = createInitialBoard(width, height);
        placeDefaultPieces(board, width, height);
      }

      let cannonCount = 0;
      let ghostCount = 0;
      for (let r = 0; r < height; r++) {
        for (let c = 0; c < width; c++) {
          if (board[r][c] === 1) cannonCount++;
          else if (board[r][c] === 2) ghostCount++;
        }
      }

      let code;
      let existing;
      do {
        code = generateRoomCode();
        const { data } = await supabase.from("rooms").select("id").eq("code", code).maybeSingle();
        existing = data;
      } while (existing);

      const { data: room, error } = await supabase.from("rooms").insert({
        code,
        status: "waiting",
        width,
        height,
        board: JSON.stringify(board),
        current_turn: "cannon",
        cannon_count: cannonCount,
        ghost_count: ghostCount,
      }).select("id,code,status,width,height,current_turn,cannon_count,ghost_count").single();

      if (error || !room) return json({ error: "create_failed" }, 503);

      return json({ ok: true, room });
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
  }

  if (action === "joinRoom") {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    const code = params.get("code");
    if (!code || !/^[A-Z0-9]{6}$/.test(code)) return json({ error: "invalid_code" }, 400);

    try {
      const { data: room, error } = await supabase.from("rooms")
        .select("id,code,status,width,height,current_turn,cannon_count,ghost_count,winner")
        .eq("code", code)
        .maybeSingle();

      if (error || !room) return json({ error: "room_not_found" }, 404);

      if (room.status === "waiting") {
        const { error: updateError } = await supabase.from("rooms")
          .update({ status: "playing" })
          .eq("id", room.id);
        if (updateError) return json({ error: "update_failed" }, 503);
        room.status = "playing";
      }

      return json({ ok: true, room });
    } catch {
      return json({ error: "database_request_failed" }, 503);
    }
  }

  if (action === "getGameState") {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    const code = params.get("code");
    if (!code || !/^[A-Z0-9]{6}$/.test(code)) return json({ error: "invalid_code" }, 400);

    try {
      const { data: room, error } = await supabase.from("rooms")
        .select("id,code,status,width,height,board,current_turn,cannon_count,ghost_count,winner,updated_at")
        .eq("code", code)
        .maybeSingle();

      if (error || !room) return json({ error: "room_not_found" }, 404);

      let boardData = room.board;
      if (typeof boardData === "string") {
        try { boardData = JSON.parse(boardData); } catch { boardData = null; }
      }

      return json({
        ok: true,
        room: {
          id: room.id,
          code: room.code,
          status: room.status,
          width: room.width,
          height: room.height,
          board: boardData,
          current_turn: room.current_turn,
          cannon_count: room.cannon_count,
          ghost_count: room.ghost_count,
          winner: room.winner,
          updated_at: room.updated_at,
        }
      });
    } catch {
      return json({ error: "database_request_failed" }, 503);
    }
  }

  if (action === "submitMove") {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    try {
      const body = await request.json();
      const code = body?.roomCode;
      const playerSide = body?.playerSide;
      const fromR = Number(body?.fromR);
      const fromC = Number(body?.fromC);
      const toR = Number(body?.toR);
      const toC = Number(body?.toC);

      if (!code || !/^[A-Z0-9]{6}$/.test(code)) return json({ error: "invalid_code" }, 400);
      if (playerSide !== "cannon" && playerSide !== "ghost") return json({ error: "invalid_side" }, 400);
      if (!Number.isInteger(fromR) || !Number.isInteger(fromC) || !Number.isInteger(toR) || !Number.isInteger(toC)) {
        return json({ error: "invalid_move" }, 400);
      }

      const { data: room, error: roomError } = await supabase.from("rooms")
        .select("id,code,status,width,height,board,current_turn,cannon_count,ghost_count,winner")
        .eq("code", code)
        .maybeSingle();

      if (roomError || !room) return json({ error: "room_not_found" }, 404);
      if (room.status !== "playing") return json({ error: "room_not_playing" }, 400);
      if (room.current_turn !== playerSide) return json({ error: "not_your_turn" }, 400);

      let board;
      if (typeof room.board === "string") {
        try { board = JSON.parse(room.board); } catch { return json({ error: "invalid_board" }, 503); }
      } else {
        board = room.board;
      }

      if (!Array.isArray(board) || !board[fromR] || board[fromR][fromC] === undefined) {
        return json({ error: "invalid_position" }, 400);
      }

      const pieceValue = playerSide === "cannon" ? 1 : 2;
      if (board[fromR][fromC] !== pieceValue) return json({ error: "not_your_piece" }, 400);

      const dr = toR - fromR;
      const dc = toC - fromC;
      const isHorizontal = dr === 0 && Math.abs(dc) === 1;
      const isVertical = dc === 0 && Math.abs(dr) === 1;
      const isCapture = playerSide === "cannon" && Math.abs(dr) + Math.abs(dc) === 2 &&
        ((dr === 0 && Math.abs(dc) === 2) || (dc === 0 && Math.abs(dr) === 2));

      if (!isHorizontal && !isVertical && !isCapture) {
        return json({ error: "invalid_move" }, 400);
      }

      if (isCapture) {
        const midR = fromR + Math.sign(dr);
        const midC = fromC + Math.sign(dc);
        if (board[midR][midC] !== 0 || board[toR][toC] !== 2) {
          return json({ error: "invalid_capture" }, 400);
        }
        board[fromR][fromC] = 0;
        board[toR][toC] = 1;
      } else {
        if (board[toR][toC] !== 0) return json({ error: "target_occupied" }, 400);
        board[fromR][fromC] = 0;
        board[toR][toC] = pieceValue;
      }

      let cannonCount = 0;
      let ghostCount = 0;
      for (let r = 0; r < room.height; r++) {
        for (let c = 0; c < room.width; c++) {
          if (board[r][c] === 1) cannonCount++;
          else if (board[r][c] === 2) ghostCount++;
        }
      }

      let winner = null;
      let status = "playing";

      if (ghostCount <= cannonCount) {
        winner = "cannon";
        status = "finished";
      } else {
        let cannonsBlocked = true;
        for (let r = 0; r < room.height && cannonsBlocked; r++) {
          for (let c = 0; c < room.width && cannonsBlocked; c++) {
            if (board[r][c] === 1) {
              const dirs = [[-1,0],[1,0],[0,-1],[0,1]];
              for (const [ddr, ddc] of dirs) {
                const nr = r + ddr;
                const nc = c + ddc;
                if (nr >= 0 && nr < room.height && nc >= 0 && nc < room.width && board[nr][nc] === 0) {
                  cannonsBlocked = false;
                  break;
                }
              }
              if (playerSide === "cannon") {
                const capDirs = [[-2,0],[2,0],[0,-2],[0,2]];
                for (const [ddr, ddc] of capDirs) {
                  const midR2 = r + Math.sign(ddr);
                  const midC2 = c + Math.sign(ddc);
                  const targetR2 = r + ddr;
                  const targetC2 = c + ddc;
                  if (targetR2 >= 0 && targetR2 < room.height && targetC2 >= 0 && targetC2 < room.width &&
                      midR2 >= 0 && midR2 < room.height && midC2 >= 0 && midC2 < room.width &&
                      board[midR2][midC2] === 0 && board[targetR2][targetC2] === 2) {
                    cannonsBlocked = false;
                    break;
                  }
                }
              }
            }
          }
        }
        if (cannonsBlocked) {
          winner = "ghost";
          status = "finished";
        }
      }

      const nextTurn = playerSide === "cannon" ? "ghost" : "cannon";

      const { error: updateError } = await supabase.from("rooms")
        .update({
          board: JSON.stringify(board),
          current_turn: status === "finished" ? room.current_turn : nextTurn,
          cannon_count: cannonCount,
          ghost_count: ghostCount,
          winner,
          status,
          updated_at: new Date().toISOString(),
        })
        .eq("id", room.id);

      if (updateError) return json({ error: "update_failed" }, 503);

      return json({
        ok: true,
        state: {
          board,
          current_turn: status === "finished" ? room.current_turn : nextTurn,
          cannon_count: cannonCount,
          ghost_count: ghostCount,
          winner,
          status,
        }
      });
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
  }

  return json({ error: "not_found" }, 404);
}
