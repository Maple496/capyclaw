"""棋类游戏确定性代码生成（BoardGameNode 专用）。

模型只输出一个棋类 spec（genre / 标题 / 配色 / 模式 / 难度 / 标签），
本模块生成完整、可运行的 ``Work.register`` 单文件代码。支持：
gomoku（五子棋）、tictactoe（井字棋）、connect4（四子棋）、reversi（黑白棋）。
不支持围棋/象棋/跳棋等复杂棋类——由意图预检明确拒绝，不冒充。
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict

DEFAULT = {
    "genre": "gomoku",
    "title": "棋类游戏",
    "mode": "pvp",
    "difficulty": 1,
    "bg": "#0b1020",
    "fg": "#e5e7eb",
    "accent": "#22d3ee",
    "labels": {"player": "黑棋", "item": "白棋"},
    "instructions": "点击棋盘落子",
}
_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
_GENRES = ("gomoku", "tictactoe", "connect4", "reversi",
           "connect6", "dotsandboxes", "hex", "checkers")
_LABELS = {
    "gomoku": ("黑棋", "白棋"),
    "tictactoe": ("X", "O"),
    "connect4": ("红方", "黄方"),
    "reversi": ("黑棋", "白棋"),
    "connect6": ("黑棋", "白棋"),
    "dotsandboxes": ("玩家1", "玩家2"),
    "hex": ("红方", "蓝方"),
    "checkers": ("红方", "黑方"),
}


def _color(value: Any, fallback: str) -> str:
    text = str(value or "").strip()
    return text if _HEX_RE.fullmatch(text) else fallback


def _text(value: Any, fallback: str, limit: int) -> str:
    text = str(value or "").strip()
    return (text or fallback)[:limit]


def _int(value: Any, fallback: int, low: int, high: int) -> int:
    try:
        num = int(value)
    except (TypeError, ValueError):
        num = fallback
    return max(low, min(high, num))


def _js(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def normalize_spec(spec: Dict[str, Any]) -> Dict[str, Any]:
    genre = str(spec.get("genre") or "gomoku").strip().lower()
    if genre not in _GENRES:
        genre = "gomoku"
    labels = spec.get("labels") if isinstance(spec.get("labels"), dict) else {}
    default_labels = _LABELS[genre]
    return {
        "genre": genre,
        "title": _text(spec.get("title"), DEFAULT["title"], 40),
        "mode": "ai" if str(spec.get("mode") or "").lower() == "ai" else "pvp",
        "difficulty": _int(spec.get("difficulty"), 1, 1, 3),
        "bg": _color(spec.get("bg"), DEFAULT["bg"]),
        "fg": _color(spec.get("fg"), DEFAULT["fg"]),
        "accent": _color(spec.get("accent"), DEFAULT["accent"]),
        "labels": {
            "player": _text(labels.get("player"), default_labels[0], 8),
            "item": _text(labels.get("item"), default_labels[1], 8),
        },
        "instructions": _text(spec.get("instructions"),
                              DEFAULT["instructions"], 80),
    }


_GOMOKU = r'''Work.register({
  mount(ctx) {
    const stage = ctx.stage;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
    stage.appendChild(canvas);
    const g = canvas.getContext('2d');
    let W = 1, H = 1, DPR = 1, raf = 0, aiTimer = 0;
    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      const r = stage.getBoundingClientRect();
      W = Math.max(1, Math.floor(r.width)); H = Math.max(1, Math.floor(r.height));
      canvas.width = Math.floor(W * DPR); canvas.height = Math.floor(H * DPR);
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    resize();
    const BG = __BG__, FG = __FG__, AC = __ACCENT__;
    const TITLE = __TITLE__, INSTR = __INSTR__, P1 = __PLAYER__, P2 = __ITEM__;
    const MODE = __MODE__, DIFF = __DIFF__;
    const SIZE = 15;
    let cell = 1, ox = 0, oy = 0;
    let board = [], turn = 1, state = 'ready', last = null, winLine = null;
    function layout() {
      const pad = Math.max(18, Math.min(W, H) * 0.09);
      cell = Math.min((W - 2 * pad) / (SIZE - 1), (H - 2 * pad) / (SIZE - 1));
      ox = (W - cell * (SIZE - 1)) / 2; oy = (H - cell * (SIZE - 1)) / 2;
    }
    function reset() {
      clearTimeout(aiTimer);
      board = [];
      for (let i = 0; i < SIZE; i++) board.push(new Array(SIZE).fill(0));
      turn = 1; state = 'ready'; last = null; winLine = null; layout();
    }
    function start() { reset(); state = 'play'; }
    function check(x, y, p) {
      const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
      for (let d = 0; d < dirs.length; d++) {
        const dx = dirs[d][0], dy = dirs[d][1], line = [{ x: x, y: y }];
        for (let s = -1; s <= 1; s += 2) {
          let nx = x + dx * s, ny = y + dy * s;
          while (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[nx][ny] === p) {
            line.push({ x: nx, y: ny }); nx += dx * s; ny += dy * s;
          }
        }
        if (line.length >= 5) return line;
      }
      return null;
    }
    function scoreCell(x, y, p) {
      const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
      let total = 0;
      for (let d = 0; d < dirs.length; d++) {
        const dx = dirs[d][0], dy = dirs[d][1];
        let count = 1, open = 0;
        for (let s = -1; s <= 1; s += 2) {
          let nx = x + dx * s, ny = y + dy * s;
          while (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[nx][ny] === p) {
            count++; nx += dx * s; ny += dy * s;
          }
          if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[nx][ny] === 0) open++;
        }
        total += count >= 5 ? 1e6 : count === 4 ? (open ? 1e4 : 1000)
          : count === 3 ? (open === 2 ? 1000 : open === 1 ? 100 : 0)
          : count === 2 ? (open === 2 ? 100 : open === 1 ? 10 : 0) : 1;
      }
      return total;
    }
    function aiMove() {
      if (state !== 'play' || turn !== 2) return;
      let best = null, bestScore = -1;
      for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) {
        if (board[x][y]) continue;
        const own = scoreCell(x, y, 2), opp = scoreCell(x, y, 1);
        const score = own * (DIFF >= 2 ? 1.1 : 0.8) + opp * (DIFF >= 2 ? 0.95 : 0.6) + Math.random() * 0.01;
        if (score > bestScore) { bestScore = score; best = { x: x, y: y }; }
      }
      if (best) place(best.x, best.y);
    }
    function maybeAI() {
      if (MODE === 'ai' && state === 'play' && turn === 2) {
        clearTimeout(aiTimer);
        aiTimer = setTimeout(aiMove, 260);
      }
    }
    function place(x, y) {
      if (state !== 'play' || board[x][y] !== 0) return;
      board[x][y] = turn; last = { x: x, y: y };
      const line = check(x, y, turn);
      if (line) { winLine = line; state = 'win'; }
      else { turn = 3 - turn; maybeAI(); }
    }
    function draw() {
      g.fillStyle = BG; g.fillRect(0, 0, W, H);
      drawPanel(ox - cell * 0.8, oy - cell * 0.8,
        cell * (SIZE - 1) + cell * 1.6, cell * (SIZE - 1) + cell * 1.6,
        'rgba(120,72,40,0.32)', 'rgba(255,255,255,0.1)');
      g.strokeStyle = FG; g.lineWidth = 1;
      for (let i = 0; i < SIZE; i++) {
        const a = ox + i * cell, b = oy + i * cell;
        g.beginPath(); g.moveTo(ox, b); g.lineTo(ox + (SIZE - 1) * cell, b); g.stroke();
        g.beginPath(); g.moveTo(a, oy); g.lineTo(a, oy + (SIZE - 1) * cell); g.stroke();
      }
      g.fillStyle = FG;
      const stars = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]];
      for (let i = 0; i < stars.length; i++) {
        g.beginPath(); g.arc(ox + stars[i][0] * cell, oy + stars[i][1] * cell, Math.max(2, cell * 0.08), 0, Math.PI * 2); g.fill();
      }
      for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) {
        if (!board[x][y]) continue;
        drawStone(ox + x * cell, oy + y * cell, cell * 0.42,
          board[x][y] === 1 ? '#111111' : '#f8fafc', FG);
      }
      if (last) {
        g.save(); g.shadowColor = AC; g.shadowBlur = 14;
        g.beginPath(); g.arc(ox + last.x * cell, oy + last.y * cell, cell * 0.48, 0, Math.PI * 2);
        g.strokeStyle = AC; g.lineWidth = 2; g.stroke(); g.restore();
      }
      if (winLine) {
        const a = winLine[0], b = winLine[winLine.length - 1];
        g.save(); g.shadowColor = AC; g.shadowBlur = 18;
        g.beginPath(); g.moveTo(ox + a.x * cell, oy + a.y * cell); g.lineTo(ox + b.x * cell, oy + b.y * cell);
        g.strokeStyle = AC; g.lineWidth = 4; g.stroke(); g.restore();
      }
      textC(TITLE, W / 2, Math.max(24, oy - 20), Math.max(16, Math.min(28, W * 0.045)), FG, true);
      textC(state === 'ready' ? INSTR : ('当前：' + (turn === 1 ? P1 : P2) + ' · ' + P1 + ' / ' + P2),
        W / 2, Math.max(44, oy - 2), 14, AC, false);
      if (state !== 'play') {
        drawOverlay(state === 'ready' ? '准备开局' : (state === 'win' ? '五连获胜' : '棋局结束'),
          MODE === 'ai' ? '人机对战 · ' + INSTR : INSTR, '点击 / 空格开始');
      }
      g.textAlign = 'left';
    }
    function loop() { draw(); raf = requestAnimationFrame(loop); }
    function onPointer(e) {
      const r = canvas.getBoundingClientRect();
      if (state !== 'play') { start(); return; }
      if (MODE === 'ai' && turn === 2) return;
      const x = Math.round((e.clientX - r.left - ox) / cell);
      const y = Math.round((e.clientY - r.top - oy) / cell);
      if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) place(x, y);
    }
    function onKey(e) {
      if ((e.key === ' ' || e.key === 'Enter') && state !== 'play') { start(); e.preventDefault(); }
    }
    window.addEventListener('keydown', onKey); window.addEventListener('resize', resize);
    canvas.addEventListener('pointerdown', onPointer);
    reset(); raf = requestAnimationFrame(loop);
    return { destroy: function () { cancelAnimationFrame(raf); clearTimeout(aiTimer); window.removeEventListener('resize', resize); window.removeEventListener('keydown', onKey); } };
  }
});'''

_TICTACTOE = r'''Work.register({
  mount(ctx) {
    const stage = ctx.stage;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
    stage.appendChild(canvas);
    const g = canvas.getContext('2d');
    let W = 1, H = 1, DPR = 1, raf = 0, aiTimer = 0;
    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      const r = stage.getBoundingClientRect();
      W = Math.max(1, Math.floor(r.width)); H = Math.max(1, Math.floor(r.height));
      canvas.width = Math.floor(W * DPR); canvas.height = Math.floor(H * DPR);
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    resize();
    const BG = __BG__, FG = __FG__, AC = __ACCENT__;
    const TITLE = __TITLE__, INSTR = __INSTR__, P1 = __PLAYER__, P2 = __ITEM__;
    const MODE = __MODE__, DIFF = __DIFF__;
    const N = 3;
    let cell = 1, ox = 0, oy = 0, board = [], turn = 1, state = 'ready', winLine = null;
    function layout() {
      const pad = Math.max(30, Math.min(W, H) * 0.12);
      cell = Math.min((W - 2 * pad) / N, (H - 2 * pad) / N);
      ox = (W - cell * N) / 2; oy = (H - cell * N) / 2;
    }
    function reset() {
      clearTimeout(aiTimer); board = [];
      for (let i = 0; i < N * N; i++) board.push(0);
      turn = 1; state = 'ready'; winLine = null; layout();
    }
    function start() { reset(); state = 'play'; }
    function lines() { return [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]; }
    function winner() {
      const ls = lines();
      for (let i = 0; i < ls.length; i++) {
        const a = ls[i][0], b = ls[i][1], c = ls[i][2];
        if (board[a] && board[a] === board[b] && board[a] === board[c]) return [a, b, c];
      }
      return null;
    }
    function emptyCells() { const out = []; for (let i = 0; i < 9; i++) if (!board[i]) out.push(i); return out; }
    function aiMove() {
      if (state !== 'play' || turn !== 2) return;
      const empties = emptyCells(); if (!empties.length) return;
      let pick = -1;
      if (DIFF >= 2) {
        for (let i = 0; i < empties.length; i++) { board[empties[i]] = 2; if (winner()) { pick = empties[i]; board[empties[i]] = 0; break; } board[empties[i]] = 0; }
        if (pick < 0) for (let i = 0; i < empties.length; i++) { board[empties[i]] = 1; if (winner()) { pick = empties[i]; board[empties[i]] = 0; break; } board[empties[i]] = 0; }
      }
      if (pick < 0) pick = empties[Math.floor(Math.random() * empties.length)];
      place(pick);
    }
    function maybeAI() {
      if (MODE === 'ai' && state === 'play' && turn === 2) { clearTimeout(aiTimer); aiTimer = setTimeout(aiMove, 220); }
    }
    function place(i) {
      if (state !== 'play' || board[i]) return;
      board[i] = turn; const line = winner();
      if (line) { winLine = line; state = 'win'; }
      else if (!emptyCells().length) { state = 'over'; }
      else { turn = 3 - turn; maybeAI(); }
    }
    function drawMark(i, p) {
      const x = ox + (i % N) * cell, y = oy + Math.floor(i / N) * cell;
      g.save();
      g.shadowColor = p === 1 ? AC : FG; g.shadowBlur = 12;
      g.strokeStyle = p === 1 ? AC : FG; g.lineWidth = Math.max(3, cell * 0.08);
      if (p === 1) {
        const m = cell * 0.24;
        g.beginPath(); g.moveTo(x + m, y + m); g.lineTo(x + cell - m, y + cell - m);
        g.moveTo(x + cell - m, y + m); g.lineTo(x + m, y + cell - m); g.stroke();
      } else {
        g.beginPath(); g.arc(x + cell / 2, y + cell / 2, cell * 0.3, 0, Math.PI * 2); g.stroke();
      }
      g.restore();
      g.lineWidth = 1;
    }
    function draw() {
      g.fillStyle = BG; g.fillRect(0, 0, W, H);
      drawPanel(ox - cell * 0.3, oy - cell * 0.3, cell * N + cell * 0.6,
        cell * N + cell * 0.6, 'rgba(255,255,255,0.035)',
        'rgba(255,255,255,0.1)');
      g.strokeStyle = FG; g.lineWidth = 2;
      for (let i = 1; i < N; i++) {
        g.beginPath(); g.moveTo(ox + i * cell, oy); g.lineTo(ox + i * cell, oy + N * cell); g.stroke();
        g.beginPath(); g.moveTo(ox, oy + i * cell); g.lineTo(ox + N * cell, oy + i * cell); g.stroke();
      }
      g.lineWidth = 1;
      for (let i = 0; i < 9; i++) if (board[i]) drawMark(i, board[i]);
      if (winLine) {
        const a = winLine[0], b = winLine[2];
        g.save(); g.shadowColor = AC; g.shadowBlur = 18;
        g.beginPath(); g.moveTo(ox + (a % N + 0.5) * cell, oy + (Math.floor(a / N) + 0.5) * cell);
        g.lineTo(ox + (b % N + 0.5) * cell, oy + (Math.floor(b / N) + 0.5) * cell);
        g.strokeStyle = AC; g.lineWidth = 5; g.stroke(); g.restore();
      }
      textC(TITLE, W / 2, Math.max(24, oy - 20), Math.max(16, Math.min(28, W * 0.045)), FG, true);
      textC(state === 'ready' ? INSTR : ('当前：' + (turn === 1 ? P1 : P2)),
        W / 2, Math.max(44, oy - 2), 14, AC, false);
      if (state !== 'play') {
        drawOverlay(state === 'ready' ? '点击开始' : (state === 'win' ? '获胜' : '平局'),
          MODE === 'ai' ? '人机对战 · ' + INSTR : INSTR, '点击 / 空格开始');
      }
      g.textAlign = 'left';
    }
    function loop() { draw(); raf = requestAnimationFrame(loop); }
    function onPointer(e) {
      if (state !== 'play') { start(); return; }
      if (MODE === 'ai' && turn === 2) return;
      const r = canvas.getBoundingClientRect();
      const x = Math.floor((e.clientX - r.left - ox) / cell), y = Math.floor((e.clientY - r.top - oy) / cell);
      if (x >= 0 && x < N && y >= 0 && y < N) place(y * N + x);
    }
    function onKey(e) { if ((e.key === ' ' || e.key === 'Enter') && state !== 'play') { start(); e.preventDefault(); } }
    window.addEventListener('keydown', onKey); window.addEventListener('resize', resize);
    canvas.addEventListener('pointerdown', onPointer);
    reset(); raf = requestAnimationFrame(loop);
    return { destroy: function () { cancelAnimationFrame(raf); clearTimeout(aiTimer); window.removeEventListener('resize', resize); window.removeEventListener('keydown', onKey); } };
  }
});'''

_CONNECT4 = r'''Work.register({
  mount(ctx) {
    const stage = ctx.stage;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
    stage.appendChild(canvas);
    const g = canvas.getContext('2d');
    let W = 1, H = 1, DPR = 1, raf = 0, aiTimer = 0;
    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      const r = stage.getBoundingClientRect();
      W = Math.max(1, Math.floor(r.width)); H = Math.max(1, Math.floor(r.height));
      canvas.width = Math.floor(W * DPR); canvas.height = Math.floor(H * DPR);
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    resize();
    const BG = __BG__, FG = __FG__, AC = __ACCENT__;
    const TITLE = __TITLE__, INSTR = __INSTR__, P1 = __PLAYER__, P2 = __ITEM__;
    const MODE = __MODE__, DIFF = __DIFF__;
    const COLS = 7, ROWS = 6;
    let cell = 1, ox = 0, oy = 0, board = [], turn = 1, state = 'ready', winLine = null;
    function layout() {
      const pad = Math.max(18, Math.min(W, H) * 0.08);
      cell = Math.min((W - 2 * pad) / COLS, (H - 2 * pad) / ROWS);
      ox = (W - cell * COLS) / 2; oy = (H - cell * ROWS) / 2;
    }
    function reset() {
      clearTimeout(aiTimer); board = [];
      for (let c = 0; c < COLS; c++) { board.push([]); for (let r = 0; r < ROWS; r++) board[c].push(0); }
      turn = 1; state = 'ready'; winLine = null; layout();
    }
    function start() { reset(); state = 'play'; }
    function check(x, y, p) {
      const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
      for (let d = 0; d < dirs.length; d++) {
        const dx = dirs[d][0], dy = dirs[d][1], line = [{ x: x, y: y }];
        for (let s = -1; s <= 1; s += 2) {
          let nx = x + dx * s, ny = y + dy * s;
          while (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS && board[nx][ny] === p) {
            line.push({ x: nx, y: ny }); nx += dx * s; ny += dy * s;
          }
        }
        if (line.length >= 4) return line;
      }
      return null;
    }
    function dropRow(col) { for (let r = ROWS - 1; r >= 0; r--) if (!board[col][r]) return r; return -1; }
    function aiMove() {
      if (state !== 'play' || turn !== 2) return;
      const cols = []; for (let c = 0; c < COLS; c++) if (dropRow(c) >= 0) cols.push(c);
      if (!cols.length) return;
      let pick = cols[Math.floor(Math.random() * cols.length)];
      if (DIFF >= 2) {
        for (let i = 0; i < cols.length; i++) {
          const c = cols[i], r = dropRow(c); board[c][r] = 2;
          if (check(c, r, 2)) { pick = c; board[c][r] = 0; break; }
          board[c][r] = 0;
        }
        for (let i = 0; i < cols.length; i++) {
          const c = cols[i], r = dropRow(c); board[c][r] = 1;
          if (check(c, r, 1)) { pick = c; board[c][r] = 0; break; }
          board[c][r] = 0;
        }
      }
      drop(pick);
    }
    function maybeAI() { if (MODE === 'ai' && state === 'play' && turn === 2) { clearTimeout(aiTimer); aiTimer = setTimeout(aiMove, 260); } }
    function drop(col) {
      if (state !== 'play' || col < 0 || col >= COLS) return;
      const row = dropRow(col); if (row < 0) return;
      board[col][row] = turn; const line = check(col, row, turn);
      if (line) { winLine = line; state = 'win'; }
      else if (board.every(function (c) { return c.every(Boolean); })) state = 'over';
      else { turn = 3 - turn; maybeAI(); }
    }
    function draw() {
      drawBackdrop();
      fillRR(ox, oy, cell * COLS, cell * ROWS, 18, '#1d4ed8',
        'rgba(255,255,255,0.12)');
      for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
        const x = ox + c * cell + cell / 2, y = oy + r * cell + cell / 2;
        g.beginPath(); g.arc(x, y, cell * 0.39, 0, Math.PI * 2);
        g.fillStyle = '#0b1a4a'; g.fill();
        if (board[c][r]) {
          drawStone(x, y, cell * 0.34,
            board[c][r] === 1 ? '#ef4444' : '#facc15',
            'rgba(255,255,255,0.55)');
        }
      }
      if (winLine) {
        const a = winLine[0], b = winLine[winLine.length - 1];
        g.save(); g.shadowColor = AC; g.shadowBlur = 18;
        g.beginPath(); g.moveTo(ox + (a.x + 0.5) * cell, oy + (a.y + 0.5) * cell);
        g.lineTo(ox + (b.x + 0.5) * cell, oy + (b.y + 0.5) * cell);
        g.strokeStyle = AC; g.lineWidth = 5; g.stroke(); g.restore();
      }
      textC(TITLE, W / 2, Math.max(24, oy - 20), Math.max(16, Math.min(28, W * 0.045)), FG, true);
      textC(state === 'ready' ? INSTR : ('当前：' + (turn === 1 ? P1 : P2)),
        W / 2, Math.max(44, oy - 2), 14, AC, false);
      if (state !== 'play') {
        drawOverlay(state === 'ready' ? '点击开始' : (state === 'win' ? '四连获胜' : '平局'),
          MODE === 'ai' ? '人机对战 · ' + INSTR : INSTR, '点击 / 空格开始');
      }
      g.textAlign = 'left';
    }
    function loop() { draw(); raf = requestAnimationFrame(loop); }
    function onPointer(e) {
      if (state !== 'play') { start(); return; }
      if (MODE === 'ai' && turn === 2) return;
      const r = canvas.getBoundingClientRect();
      const col = Math.floor((e.clientX - r.left - ox) / cell);
      if (col >= 0 && col < COLS) drop(col);
    }
    function onKey(e) { if ((e.key === ' ' || e.key === 'Enter') && state !== 'play') { start(); e.preventDefault(); } }
    window.addEventListener('keydown', onKey); window.addEventListener('resize', resize);
    canvas.addEventListener('pointerdown', onPointer);
    reset(); raf = requestAnimationFrame(loop);
    return { destroy: function () { cancelAnimationFrame(raf); clearTimeout(aiTimer); window.removeEventListener('resize', resize); window.removeEventListener('keydown', onKey); } };
  }
});'''

_REVERSI = r'''Work.register({
  mount(ctx) {
    const stage = ctx.stage;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
    stage.appendChild(canvas);
    const g = canvas.getContext('2d');
    let W = 1, H = 1, DPR = 1, raf = 0, aiTimer = 0;
    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      const r = stage.getBoundingClientRect();
      W = Math.max(1, Math.floor(r.width)); H = Math.max(1, Math.floor(r.height));
      canvas.width = Math.floor(W * DPR); canvas.height = Math.floor(H * DPR);
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    resize();
    const BG = __BG__, FG = __FG__, AC = __ACCENT__;
    const TITLE = __TITLE__, INSTR = __INSTR__, P1 = __PLAYER__, P2 = __ITEM__;
    const MODE = __MODE__, DIFF = __DIFF__;
    const N = 8, DIRS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    let cell = 1, ox = 0, oy = 0, board = [], turn = 1, state = 'ready';
    function layout() {
      const pad = Math.max(16, Math.min(W, H) * 0.07);
      cell = Math.min((W - 2 * pad) / N, (H - 2 * pad) / N);
      ox = (W - cell * N) / 2; oy = (H - cell * N) / 2;
    }
    function reset() {
      clearTimeout(aiTimer); board = [];
      for (let i = 0; i < N; i++) board.push(new Array(N).fill(0));
      board[3][3] = 2; board[4][4] = 2; board[3][4] = 1; board[4][3] = 1;
      turn = 1; state = 'ready'; layout();
    }
    function start() { reset(); state = 'play'; maybeAI(); }
    function flipsFor(x, y, p) {
      if (board[x][y]) return [];
      const out = [];
      for (let d = 0; d < DIRS.length; d++) {
        const dx = DIRS[d][0], dy = DIRS[d][1], line = [];
        let nx = x + dx, ny = y + dy;
        while (nx >= 0 && nx < N && ny >= 0 && ny < N && board[nx][ny] === 3 - p) { line.push({ x: nx, y: ny }); nx += dx; ny += dy; }
        if (line.length && nx >= 0 && nx < N && ny >= 0 && ny < N && board[nx][ny] === p) out.push.apply(out, line);
      }
      return out;
    }
    function legal(p) {
      const out = [];
      for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) {
        const f = flipsFor(x, y, p); if (f.length) out.push({ x: x, y: y, flips: f });
      }
      return out;
    }
    function score() {
      let a = 0, b = 0;
      for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) { if (board[x][y] === 1) a++; else if (board[x][y] === 2) b++; }
      return [a, b];
    }
    function place(x, y) {
      if (state !== 'play') return;
      const moves = legal(turn); const hit = moves.find(function (m) { return m.x === x && m.y === y; });
      if (!hit) return;
      board[x][y] = turn;
      for (let i = 0; i < hit.flips.length; i++) board[hit.flips[i].x][hit.flips[i].y] = turn;
      if (legal(3 - turn).length) turn = 3 - turn;
      else if (legal(turn).length) { /* 对方无子可下，继续本方 */ }
      else state = 'over';
      maybeAI();
    }
    function aiMove() {
      if (state !== 'play' || turn !== 2) return;
      const moves = legal(2); if (!moves.length) return;
      let pick = moves[Math.floor(Math.random() * moves.length)];
      if (DIFF >= 2) { for (let i = 0; i < moves.length; i++) if (moves[i].flips.length > pick.flips.length) pick = moves[i]; }
      place(pick.x, pick.y);
    }
    function maybeAI() { if (MODE === 'ai' && state === 'play' && turn === 2) { clearTimeout(aiTimer); aiTimer = setTimeout(aiMove, 280); } }
    function draw() {
      drawBackdrop();
      fillRR(ox, oy, cell * N, cell * N, 18, '#15803d',
        'rgba(255,255,255,0.12)');
      for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) {
        const cx = ox + x * cell + cell / 2, cy = oy + y * cell + cell / 2;
        if (board[x][y]) {
          drawStone(cx, cy, cell * 0.38,
            board[x][y] === 1 ? '#111111' : '#f8fafc',
            'rgba(255,255,255,0.35)');
        } else {
          g.beginPath(); g.arc(cx, cy, cell * 0.38, 0, Math.PI * 2);
          g.fillStyle = '#166534'; g.fill();
          g.strokeStyle = '#14532d'; g.lineWidth = 1; g.stroke();
        }
      }
      if (state === 'play' && !(MODE === 'ai' && turn === 2)) {
        const moves = legal(turn);
        for (let i = 0; i < moves.length; i++) {
          const cx = ox + moves[i].x * cell + cell / 2, cy = oy + moves[i].y * cell + cell / 2;
          g.save(); g.shadowColor = AC; g.shadowBlur = 10;
          g.beginPath(); g.arc(cx, cy, cell * 0.1, 0, Math.PI * 2); g.fillStyle = AC; g.fill(); g.restore();
        }
      }
      const sc = score();
      textC(TITLE, W / 2, Math.max(24, oy - 20), Math.max(16, Math.min(28, W * 0.045)), FG, true);
      textC(P1 + ' ' + sc[0] + ' : ' + sc[1] + ' ' + P2 + ' · ' + (turn === 1 ? P1 : P2),
        W / 2, Math.max(44, oy - 2), 14, AC, false);
      if (state !== 'play') {
        drawOverlay(state === 'ready' ? '点击开始' : '棋局结束',
          MODE === 'ai' ? '人机对战 · ' + INSTR : INSTR, '点击 / 空格开始');
      }
      g.textAlign = 'left';
    }
    function loop() { draw(); raf = requestAnimationFrame(loop); }
    function onPointer(e) {
      if (state !== 'play') { start(); return; }
      if (MODE === 'ai' && turn === 2) return;
      const r = canvas.getBoundingClientRect();
      const x = Math.floor((e.clientX - r.left - ox) / cell), y = Math.floor((e.clientY - r.top - oy) / cell);
      if (x >= 0 && x < N && y >= 0 && y < N) place(x, y);
    }
    function onKey(e) { if ((e.key === ' ' || e.key === 'Enter') && state !== 'play') { start(); e.preventDefault(); } }
    window.addEventListener('keydown', onKey); window.addEventListener('resize', resize);
    canvas.addEventListener('pointerdown', onPointer);
    reset(); raf = requestAnimationFrame(loop);
    return { destroy: function () { cancelAnimationFrame(raf); clearTimeout(aiTimer); window.removeEventListener('resize', resize); window.removeEventListener('keydown', onKey); } };
  }
});'''

_CONNECT6 = r'''Work.register({
  mount(ctx) {
    const stage = ctx.stage;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
    stage.appendChild(canvas);
    const g = canvas.getContext('2d');
    let W = 1, H = 1, DPR = 1, raf = 0, aiTimer = 0;
    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      const r = stage.getBoundingClientRect();
      W = Math.max(1, Math.floor(r.width)); H = Math.max(1, Math.floor(r.height));
      canvas.width = Math.floor(W * DPR); canvas.height = Math.floor(H * DPR);
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    resize();
    const BG = __BG__, FG = __FG__, AC = __ACCENT__;
    const TITLE = __TITLE__, INSTR = __INSTR__, P1 = __PLAYER__, P2 = __ITEM__;
    const MODE = __MODE__, DIFF = __DIFF__;
    const SIZE = 19;
    let cell = 1, ox = 0, oy = 0, board = [], turn = 1, left = 1, state = 'ready', last = [], winLine = null;
    function layout() {
      const pad = Math.max(14, Math.min(W, H) * 0.06);
      cell = Math.min((W - 2 * pad) / (SIZE - 1), (H - 2 * pad) / (SIZE - 1));
      ox = (W - cell * (SIZE - 1)) / 2; oy = (H - cell * (SIZE - 1)) / 2;
    }
    function reset() {
      clearTimeout(aiTimer); board = [];
      for (let i = 0; i < SIZE; i++) board.push(new Array(SIZE).fill(0));
      turn = 1; left = 1; state = 'ready'; last = []; winLine = null; layout();
    }
    function start() { reset(); state = 'play'; }
    function check(x, y, p) {
      const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
      for (let d = 0; d < dirs.length; d++) {
        const dx = dirs[d][0], dy = dirs[d][1], line = [{ x: x, y: y }];
        for (let s = -1; s <= 1; s += 2) {
          let nx = x + dx * s, ny = y + dy * s;
          while (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[nx][ny] === p) {
            line.push({ x: nx, y: ny }); nx += dx * s; ny += dy * s;
          }
        }
        if (line.length >= 6) return line;
      }
      return null;
    }
    function scoreCell(x, y, p) {
      const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
      let total = 0;
      for (let d = 0; d < dirs.length; d++) {
        const dx = dirs[d][0], dy = dirs[d][1];
        let count = 1, open = 0;
        for (let s = -1; s <= 1; s += 2) {
          let nx = x + dx * s, ny = y + dy * s;
          while (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[nx][ny] === p) {
            count++; nx += dx * s; ny += dy * s;
          }
          if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[nx][ny] === 0) open++;
        }
        total += count >= 6 ? 1e6 : count === 5 ? (open ? 1e4 : 1000)
          : count === 4 ? (open === 2 ? 1000 : open === 1 ? 100 : 0)
          : count === 3 ? (open === 2 ? 100 : open === 1 ? 10 : 0) : 1;
      }
      return total;
    }
    function aiMove() {
      if (state !== 'play' || turn !== 2 || left <= 0) return;
      let best = null, bestScore = -1;
      for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) {
        if (board[x][y]) continue;
        const score = scoreCell(x, y, 2) * (DIFF >= 2 ? 1.1 : 0.8) + scoreCell(x, y, 1) * (DIFF >= 2 ? 0.95 : 0.6) + Math.random() * 0.01;
        if (score > bestScore) { bestScore = score; best = { x: x, y: y }; }
      }
      if (best) place(best.x, best.y);
    }
    function maybeAI() {
      if (MODE === 'ai' && state === 'play' && turn === 2 && left > 0) {
        clearTimeout(aiTimer); aiTimer = setTimeout(aiMove, 240);
      }
    }
    function place(x, y) {
      if (state !== 'play' || board[x][y]) return;
      board[x][y] = turn; last.push({ x: x, y: y });
      const line = check(x, y, turn);
      if (line) { winLine = line; state = 'win'; return; }
      left--;
      if (left <= 0) { turn = 3 - turn; left = 2; last = []; maybeAI(); }
    }
    function draw() {
      g.fillStyle = BG; g.fillRect(0, 0, W, H);
      drawPanel(ox - cell * 0.7, oy - cell * 0.7,
        cell * (SIZE - 1) + cell * 1.4, cell * (SIZE - 1) + cell * 1.4,
        'rgba(120,72,40,0.32)', 'rgba(255,255,255,0.1)');
      g.strokeStyle = FG; g.lineWidth = 1;
      for (let i = 0; i < SIZE; i++) {
        const a = ox + i * cell, b = oy + i * cell;
        g.beginPath(); g.moveTo(ox, b); g.lineTo(ox + (SIZE - 1) * cell, b); g.stroke();
        g.beginPath(); g.moveTo(a, oy); g.lineTo(a, oy + (SIZE - 1) * cell); g.stroke();
      }
      for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) {
        if (!board[x][y]) continue;
        drawStone(ox + x * cell, oy + y * cell, cell * 0.42,
          board[x][y] === 1 ? '#111111' : '#f8fafc', FG);
      }
      for (let i = 0; i < last.length; i++) {
        g.save(); g.shadowColor = AC; g.shadowBlur = 14;
        g.beginPath(); g.arc(ox + last[i].x * cell, oy + last[i].y * cell, cell * 0.5, 0, Math.PI * 2);
        g.strokeStyle = AC; g.lineWidth = 2; g.stroke(); g.restore();
      }
      if (winLine) {
        const a = winLine[0], b = winLine[winLine.length - 1];
        g.save(); g.shadowColor = AC; g.shadowBlur = 18;
        g.beginPath(); g.moveTo(ox + a.x * cell, oy + a.y * cell); g.lineTo(ox + b.x * cell, oy + b.y * cell);
        g.strokeStyle = AC; g.lineWidth = 4; g.stroke(); g.restore();
      }
      textC(TITLE, W / 2, Math.max(20, oy - 18), Math.max(14, Math.min(24, W * 0.04)), FG, true);
      textC(state === 'ready' ? INSTR : ('当前：' + (turn === 1 ? P1 : P2) + ' · 本回合剩余 ' + left),
        W / 2, Math.max(38, oy - 2), 13, AC, false);
      if (state !== 'play') {
        drawOverlay(state === 'ready' ? '点击 / 空格开始' : '六连获胜',
          MODE === 'ai' ? '人机对战 · ' + INSTR : INSTR, '点击 / 空格开始');
      }
      g.textAlign = 'left';
    }
    function loop() { draw(); raf = requestAnimationFrame(loop); }
    function onPointer(e) {
      const r = canvas.getBoundingClientRect();
      if (state !== 'play') { start(); return; }
      if (MODE === 'ai' && turn === 2) return;
      const x = Math.round((e.clientX - r.left - ox) / cell), y = Math.round((e.clientY - r.top - oy) / cell);
      if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) place(x, y);
    }
    function onKey(e) { if ((e.key === ' ' || e.key === 'Enter') && state !== 'play') { start(); e.preventDefault(); } }
    window.addEventListener('keydown', onKey); window.addEventListener('resize', resize);
    canvas.addEventListener('pointerdown', onPointer);
    reset(); raf = requestAnimationFrame(loop);
    return { destroy: function () { cancelAnimationFrame(raf); clearTimeout(aiTimer); window.removeEventListener('resize', resize); window.removeEventListener('keydown', onKey); } };
  }
});'''

_DOTS = r'''Work.register({
  mount(ctx) {
    const stage = ctx.stage;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
    stage.appendChild(canvas);
    const g = canvas.getContext('2d');
    let W = 1, H = 1, DPR = 1, raf = 0, aiTimer = 0;
    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      const r = stage.getBoundingClientRect();
      W = Math.max(1, Math.floor(r.width)); H = Math.max(1, Math.floor(r.height));
      canvas.width = Math.floor(W * DPR); canvas.height = Math.floor(H * DPR);
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    resize();
    const BG = __BG__, FG = __FG__, AC = __ACCENT__;
    const TITLE = __TITLE__, INSTR = __INSTR__, P1 = __PLAYER__, P2 = __ITEM__;
    const MODE = __MODE__, DIFF = __DIFF__;
    const D = 6, B = 5;
    let cell = 1, ox = 0, oy = 0, h = [], v = [], box = [], turn = 1, state = 'ready', scores = [0, 0];
    function layout() {
      const pad = Math.max(24, Math.min(W, H) * 0.1);
      cell = Math.min((W - 2 * pad) / (D - 1), (H - 2 * pad) / (D - 1));
      ox = (W - cell * (D - 1)) / 2; oy = (H - cell * (D - 1)) / 2;
    }
    function reset() {
      clearTimeout(aiTimer); h = []; v = []; box = [];
      for (let y = 0; y < D; y++) { h.push([]); for (let x = 0; x < B; x++) h[y].push(0); }
      for (let y = 0; y < B; y++) { v.push([]); for (let x = 0; x < D; x++) v[y].push(0); box.push([]); for (let x = 0; x < B; x++) box[y].push(0); }
      turn = 1; state = 'ready'; scores = [0, 0]; layout();
    }
    function start() { reset(); state = 'play'; }
    function boxDone(x, y) { return h[y][x] && h[y + 1][x] && v[y][x] && v[y][x + 1]; }
    function claim() {
      let got = 0;
      for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) {
        if (!box[y][x] && boxDone(x, y)) { box[y][x] = turn; scores[turn - 1]++; got++; }
      }
      return got;
    }
    function placeEdge(kind, x, y) {
      if (state !== 'play') return;
      if (kind === 'h' && h[y][x]) return;
      if (kind === 'v' && v[y][x]) return;
      if (kind === 'h') h[y][x] = 1; else v[y][x] = 1;
      const got = claim();
      if (!got) turn = 3 - turn;
      if (scores[0] + scores[1] >= B * B) state = 'over';
      maybeAI();
    }
    function aiMove() {
      if (state !== 'play' || turn !== 2) return;
      const edges = [];
      for (let y = 0; y < D; y++) for (let x = 0; x < B; x++) if (!h[y][x]) edges.push(['h', x, y]);
      for (let y = 0; y < B; y++) for (let x = 0; x < D; x++) if (!v[y][x]) edges.push(['v', x, y]);
      if (!edges.length) return;
      let pick = edges[Math.floor(Math.random() * edges.length)];
      if (DIFF >= 2) {
        let best = -1;
        for (let i = 0; i < edges.length; i++) {
          const e = edges[i];
          if (e[0] === 'h') h[e[2]][e[1]] = 1; else v[e[2]][e[1]] = 1;
          let cnt = 0;
          for (let yy = 0; yy < B; yy++) for (let xx = 0; xx < B; xx++) if (!box[yy][xx] && boxDone(xx, yy)) cnt++;
          if (e[0] === 'h') h[e[2]][e[1]] = 0; else v[e[2]][e[1]] = 0;
          if (cnt > best) { best = cnt; pick = e; }
        }
      }
      placeEdge(pick[0], pick[1], pick[2]);
    }
    function maybeAI() { if (MODE === 'ai' && state === 'play' && turn === 2) { clearTimeout(aiTimer); aiTimer = setTimeout(aiMove, 240); } }
    function distSeg(px, py, x1, y1, x2, y2) {
      const dx = x2 - x1, dy = y2 - y1;
      const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    }
    function draw() {
      drawBackdrop();
      drawPanel(ox - cell * 0.45, oy - cell * 0.45,
        cell * (D - 1) + cell * 0.9, cell * (D - 1) + cell * 0.9,
        'rgba(250,250,245,0.08)', 'rgba(255,255,255,0.12)');
      for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) {
        if (!box[y][x]) continue;
        fillRR(ox + x * cell + 2, oy + y * cell + 2, cell - 4, cell - 4, 6,
          box[y][x] === 1 ? 'rgba(34,211,238,0.28)' : 'rgba(248,113,113,0.28)',
          'rgba(255,255,255,0.18)');
      }
      g.lineCap = 'round';
      g.strokeStyle = 'rgba(255,255,255,0.3)'; g.lineWidth = 3;
      for (let y = 0; y < D; y++) for (let x = 0; x < B; x++) if (h[y][x]) {
        g.beginPath(); g.moveTo(ox + x * cell, oy + y * cell); g.lineTo(ox + (x + 1) * cell, oy + y * cell); g.stroke();
      }
      for (let y = 0; y < B; y++) for (let x = 0; x < D; x++) if (v[y][x]) {
        g.beginPath(); g.moveTo(ox + x * cell, oy + y * cell); g.lineTo(ox + x * cell, oy + (y + 1) * cell); g.stroke();
      }
      g.lineCap = 'butt'; g.lineWidth = 1;
      for (let y = 0; y < D; y++) for (let x = 0; x < D; x++) {
        g.beginPath(); g.arc(ox + x * cell, oy + y * cell, Math.max(2, cell * 0.07), 0, Math.PI * 2);
        g.fillStyle = FG; g.fill();
      }
      textC(TITLE, W / 2, Math.max(24, oy - 22), Math.max(16, Math.min(28, W * 0.045)), FG, true);
      textC(P1 + ' ' + scores[0] + ' : ' + scores[1] + ' ' + P2 + ' · ' + (state === 'ready' ? INSTR : '当前：' + (turn === 1 ? P1 : P2)),
        W / 2, Math.max(44, oy - 2), 14, AC, false);
      if (state !== 'play') {
        drawOverlay(state === 'ready' ? '点击边缘画线开始' : '棋盘填满',
          MODE === 'ai' ? '人机对战 · ' + INSTR : INSTR, '点击 / 空格开始');
      }
      g.textAlign = 'left';
    }
    function loop() { draw(); raf = requestAnimationFrame(loop); }
    function onPointer(e) {
      if (state !== 'play') { start(); return; }
      if (MODE === 'ai' && turn === 2) return;
      const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      let best = null, bestD = cell * 0.36;
      for (let y = 0; y < D; y++) for (let x = 0; x < B; x++) if (!h[y][x]) {
        const d = distSeg(px, py, ox + x * cell, oy + y * cell, ox + (x + 1) * cell, oy + y * cell);
        if (d < bestD) { bestD = d; best = ['h', x, y]; }
      }
      for (let y = 0; y < B; y++) for (let x = 0; x < D; x++) if (!v[y][x]) {
        const d = distSeg(px, py, ox + x * cell, oy + y * cell, ox + x * cell, oy + (y + 1) * cell);
        if (d < bestD) { bestD = d; best = ['v', x, y]; }
      }
      if (best) placeEdge(best[0], best[1], best[2]);
    }
    function onKey(e) { if ((e.key === ' ' || e.key === 'Enter') && state !== 'play') { start(); e.preventDefault(); } }
    window.addEventListener('keydown', onKey); window.addEventListener('resize', resize);
    canvas.addEventListener('pointerdown', onPointer);
    reset(); raf = requestAnimationFrame(loop);
    return { destroy: function () { cancelAnimationFrame(raf); clearTimeout(aiTimer); window.removeEventListener('resize', resize); window.removeEventListener('keydown', onKey); } };
  }
});'''

_HEX = r'''Work.register({
  mount(ctx) {
    const stage = ctx.stage;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
    stage.appendChild(canvas);
    const g = canvas.getContext('2d');
    let W = 1, H = 1, DPR = 1, raf = 0, aiTimer = 0;
    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      const r = stage.getBoundingClientRect();
      W = Math.max(1, Math.floor(r.width)); H = Math.max(1, Math.floor(r.height));
      canvas.width = Math.floor(W * DPR); canvas.height = Math.floor(H * DPR);
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    resize();
    const BG = __BG__, FG = __FG__, AC = __ACCENT__;
    const TITLE = __TITLE__, INSTR = __INSTR__, P1 = __PLAYER__, P2 = __ITEM__;
    const MODE = __MODE__, DIFF = __DIFF__;
    const N = 11;
    let size = 1, hx = 1, vy = 1, ox = 0, oy = 0, board = [], turn = 1, state = 'ready', last = null;
    function layout() {
      const pad = Math.max(14, Math.min(W, H) * 0.05);
      size = Math.min((W - 2 * pad) / (Math.sqrt(3) * (N + 0.5)), (H - 2 * pad) / (1.5 * N + 0.5));
      hx = Math.sqrt(3) * size; vy = 1.5 * size;
      ox = (W - hx * (N + 0.5 * (N - 1))) / 2 + hx * 0.5;
      oy = (H - (vy * (N - 1) + 2 * size)) / 2 + size;
    }
    function center(r, c) { return { x: ox + hx * (c + 0.5 * (r % 2)), y: oy + vy * r }; }
    function reset() {
      clearTimeout(aiTimer); board = [];
      for (let r = 0; r < N; r++) board.push(new Array(N).fill(0));
      turn = 1; state = 'ready'; last = null; layout();
    }
    function start() { reset(); state = 'play'; }
    function neighbors(r, c) {
      const out = r % 2 === 0
        ? [[r, c - 1], [r, c + 1], [r - 1, c - 1], [r - 1, c], [r + 1, c - 1], [r + 1, c]]
        : [[r, c - 1], [r, c + 1], [r - 1, c], [r - 1, c + 1], [r + 1, c], [r + 1, c + 1]];
      return out.filter(function (p) { return p[0] >= 0 && p[0] < N && p[1] >= 0 && p[1] < N; });
    }
    function winner(p) {
      const seen = [], queue = [];
      for (let i = 0; i < N; i++) {
        if (p === 1) { if (board[0][i] === p) { queue.push([0, i]); seen.push('0,' + i); } }
        else { if (board[i][0] === p) { queue.push([i, 0]); seen.push(i + ',0'); } }
      }
      while (queue.length) {
        const cur = queue.shift();
        if (p === 1 && cur[0] === N - 1) return true;
        if (p === 2 && cur[1] === N - 1) return true;
        const nb = neighbors(cur[0], cur[1]);
        for (let i = 0; i < nb.length; i++) {
          const rr = nb[i][0], cc = nb[i][1], key = rr + ',' + cc;
          if (board[rr][cc] === p && seen.indexOf(key) < 0) { seen.push(key); queue.push([rr, cc]); }
        }
      }
      return false;
    }
    function aiMove() {
      if (state !== 'play' || turn !== 2) return;
      const empties = [];
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (!board[r][c]) empties.push([r, c]);
      if (!empties.length) return;
      let pick = empties[Math.floor(Math.random() * empties.length)];
      if (DIFF >= 2) {
        let best = -1;
        for (let i = 0; i < empties.length; i++) {
          let score = 0; const nb = neighbors(empties[i][0], empties[i][1]);
          for (let j = 0; j < nb.length; j++) if (board[nb[j][0]][nb[j][1]] === 2) score += 2;
          for (let j = 0; j < nb.length; j++) if (board[nb[j][0]][nb[j][1]] === 1) score += 1;
          if (score > best) { best = score; pick = empties[i]; }
        }
      }
      place(pick[0], pick[1]);
    }
    function maybeAI() { if (MODE === 'ai' && state === 'play' && turn === 2) { clearTimeout(aiTimer); aiTimer = setTimeout(aiMove, 260); } }
    function place(r, c) {
      if (state !== 'play' || board[r][c]) return;
      board[r][c] = turn; last = { r: r, c: c };
      if (winner(turn)) state = 'win';
      else { turn = 3 - turn; maybeAI(); }
    }
    function hexPath(cx, cy) {
      g.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 3 * i - Math.PI / 6;
        const px = cx + size * Math.cos(a), py = cy + size * Math.sin(a);
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
    }
    function draw() {
      drawBackdrop();
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        const p = center(r, c); hexPath(p.x, p.y);
        g.fillStyle = board[r][c] === 1 ? 'rgba(239,68,68,0.78)'
          : board[r][c] === 2 ? 'rgba(59,130,246,0.78)'
          : 'rgba(255,255,255,0.045)';
        g.fill(); g.strokeStyle = FG; g.lineWidth = 1; g.stroke();
        if (board[r][c]) {
          g.beginPath(); g.arc(p.x - size * 0.22, p.y - size * 0.26, size * 0.18, 0, Math.PI * 2);
          g.fillStyle = 'rgba(255,255,255,0.22)'; g.fill();
        }
      }
      if (last) {
        const p = center(last.r, last.c);
        g.save(); g.shadowColor = AC; g.shadowBlur = 16;
        g.beginPath(); g.arc(p.x, p.y, size * 0.22, 0, Math.PI * 2);
        g.strokeStyle = AC; g.lineWidth = 3; g.stroke(); g.restore();
      }
      textC(TITLE, W / 2, Math.max(22, oy - size - 12),
        Math.max(16, Math.min(28, W * 0.045)), FG, true);
      textC(state === 'ready' ? INSTR : ('当前：' + (turn === 1 ? P1 : P2)),
        W / 2, Math.max(40, oy - size + 6), 13, AC, false);
      if (state !== 'play') {
        drawOverlay(state === 'ready' ? '点击 / 空格开始' : '连通获胜',
          MODE === 'ai' ? '人机对战 · ' + INSTR : INSTR, '点击 / 空格开始');
      }
      g.textAlign = 'left';
    }
    function loop() { draw(); raf = requestAnimationFrame(loop); }
    function onPointer(e) {
      if (state !== 'play') { start(); return; }
      if (MODE === 'ai' && turn === 2) return;
      const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      let best = null, bestD = size * 1.1;
      for (let rr = 0; rr < N; rr++) for (let cc = 0; cc < N; cc++) {
        const p = center(rr, cc), d = Math.hypot(px - p.x, py - p.y);
        if (d < bestD) { bestD = d; best = [rr, cc]; }
      }
      if (best) place(best[0], best[1]);
    }
    function onKey(e) { if ((e.key === ' ' || e.key === 'Enter') && state !== 'play') { start(); e.preventDefault(); } }
    window.addEventListener('keydown', onKey); window.addEventListener('resize', resize);
    canvas.addEventListener('pointerdown', onPointer);
    reset(); raf = requestAnimationFrame(loop);
    return { destroy: function () { cancelAnimationFrame(raf); clearTimeout(aiTimer); window.removeEventListener('resize', resize); window.removeEventListener('keydown', onKey); } };
  }
});'''

_CHECKERS = r'''Work.register({
  mount(ctx) {
    const stage = ctx.stage;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
    stage.appendChild(canvas);
    const g = canvas.getContext('2d');
    let W = 1, H = 1, DPR = 1, raf = 0, aiTimer = 0;
    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      const r = stage.getBoundingClientRect();
      W = Math.max(1, Math.floor(r.width)); H = Math.max(1, Math.floor(r.height));
      canvas.width = Math.floor(W * DPR); canvas.height = Math.floor(H * DPR);
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    resize();
    const BG = __BG__, FG = __FG__, AC = __ACCENT__;
    const TITLE = __TITLE__, INSTR = __INSTR__, P1 = __PLAYER__, P2 = __ITEM__;
    const MODE = __MODE__, DIFF = __DIFF__;
    const N = 8;
    let cell = 1, ox = 0, oy = 0, board = [], turn = 1, state = 'ready', selected = null, moves = [];
    function layout() {
      const pad = Math.max(18, Math.min(W, H) * 0.08);
      cell = Math.min((W - 2 * pad) / N, (H - 2 * pad) / N);
      ox = (W - cell * N) / 2; oy = (H - cell * N) / 2;
    }
    function reset() {
      clearTimeout(aiTimer); board = [];
      for (let y = 0; y < N; y++) { board.push([]); for (let x = 0; x < N; x++) board[y].push(0); }
      for (let y = 0; y < 3; y++) for (let x = 0; x < N; x++) if ((x + y) % 2 === 1) board[y][x] = 1;
      for (let y = 5; y < N; y++) for (let x = 0; x < N; x++) if ((x + y) % 2 === 1) board[y][x] = 2;
      turn = 1; state = 'ready'; selected = null; moves = []; layout();
    }
    function start() { reset(); state = 'play'; }
    function isP(piece, p) { return piece === p || piece === p + 2; }
    function isKing(piece) { return piece > 2; }
    function dirs(piece) {
      if (isKing(piece)) return [[-1, -1], [-1, 1], [1, -1], [1, 1]];
      return piece === 1 ? [[1, -1], [1, 1]] : [[-1, -1], [-1, 1]];
    }
    function movesFor(x, y) {
      const piece = board[y][x], out = [], ds = dirs(piece);
      for (let i = 0; i < ds.length; i++) {
        const dx = ds[i][0], dy = ds[i][1], nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < N && ny >= 0 && ny < N && board[ny][nx] === 0) out.push({ from: [x, y], to: [nx, ny], cap: null });
        const cx = x + 2 * dx, cy = y + 2 * dy;
        if (cx >= 0 && cx < N && cy >= 0 && cy < N && board[cy][cx] === 0 && board[ny] && board[ny][nx] && isP(board[ny][nx], 3 - turn)) out.push({ from: [x, y], to: [cx, cy], cap: [nx, ny] });
      }
      return out;
    }
    function legal(p) {
      const out = [];
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (isP(board[y][x], p)) out.push.apply(out, movesFor(x, y));
      return out;
    }
    function apply(move) {
      const fx = move.from[0], fy = move.from[1], tx = move.to[0], ty = move.to[1];
      let piece = board[fy][fx]; board[fy][fx] = 0;
      if (move.cap) board[move.cap[1]][move.cap[0]] = 0;
      if (piece === 1 && ty === N - 1) piece = 3;
      if (piece === 2 && ty === 0) piece = 4;
      board[ty][tx] = piece; selected = null; moves = [];
      if (!legal(3 - turn).length) state = 'win';
      else { turn = 3 - turn; maybeAI(); }
    }
    function aiMove() {
      if (state !== 'play' || turn !== 2) return;
      const all = legal(2); if (!all.length) return;
      let picks = [], caps = [];
      for (let i = 0; i < all.length; i++) { if (all[i].cap) caps.push(all[i]); else picks.push(all[i]); }
      const pool = caps.length ? caps : picks;
      const move = pool[Math.floor(Math.random() * pool.length)];
      apply(move);
    }
    function maybeAI() { if (MODE === 'ai' && state === 'play' && turn === 2) { clearTimeout(aiTimer); aiTimer = setTimeout(aiMove, 280); } }
    function drawPiece(x, y, piece) {
      const cx = ox + (x + 0.5) * cell, cy = oy + (y + 0.5) * cell, r = cell * 0.36;
      drawStone(cx, cy, r,
        piece === 1 || piece === 3 ? '#ef4444' : '#111827',
        'rgba(255,255,255,0.35)');
      if (isKing(piece)) {
        g.save(); g.shadowColor = AC; g.shadowBlur = 10;
        g.beginPath(); g.arc(cx, cy, r * 0.45, 0, Math.PI * 2);
        g.strokeStyle = AC; g.lineWidth = 2; g.stroke(); g.restore();
      }
    }
    function draw() {
      drawBackdrop();
      drawPanel(ox - cell * 0.35, oy - cell * 0.35,
        cell * N + cell * 0.7, cell * N + cell * 0.7,
        'rgba(120,72,40,0.2)', 'rgba(255,255,255,0.1)');
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        g.fillStyle = (x + y) % 2 === 0 ? '#d6b37a' : '#7a5230';
        g.fillRect(ox + x * cell, oy + y * cell, cell, cell);
      }
      if (selected) {
        g.save(); g.shadowColor = AC; g.shadowBlur = 18;
        fillRR(ox + selected[0] * cell, oy + selected[1] * cell, cell, cell, 6,
          'rgba(34,211,238,0.24)', AC); g.restore();
      }
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (board[y][x]) drawPiece(x, y, board[y][x]);
      for (let i = 0; i < moves.length; i++) {
        const x = moves[i].to[0], y = moves[i].to[1];
        g.save(); g.shadowColor = AC; g.shadowBlur = 12;
        g.beginPath(); g.arc(ox + (x + 0.5) * cell, oy + (y + 0.5) * cell, cell * 0.1, 0, Math.PI * 2);
        g.fillStyle = AC; g.fill(); g.restore();
      }
      textC(TITLE, W / 2, Math.max(24, oy - 20), Math.max(16, Math.min(28, W * 0.045)), FG, true);
      textC(state === 'ready' ? INSTR : ('当前：' + (turn === 1 ? P1 : P2)),
        W / 2, Math.max(44, oy - 2), 14, AC, false);
      if (state !== 'play') {
        drawOverlay(state === 'ready' ? '点击棋子开始' : '获胜',
          MODE === 'ai' ? '人机对战 · ' + INSTR : INSTR, '点击 / 空格开始');
      }
      g.textAlign = 'left';
    }
    function loop() { draw(); raf = requestAnimationFrame(loop); }
    function onPointer(e) {
      if (state !== 'play') { start(); return; }
      if (MODE === 'ai' && turn === 2) return;
      const r = canvas.getBoundingClientRect();
      const x = Math.floor((e.clientX - r.left - ox) / cell), y = Math.floor((e.clientY - r.top - oy) / cell);
      if (x < 0 || x >= N || y < 0 || y >= N) return;
      for (let i = 0; i < moves.length; i++) if (moves[i].to[0] === x && moves[i].to[1] === y) { apply(moves[i]); return; }
      if (isP(board[y][x], turn)) { selected = [x, y]; moves = movesFor(x, y); }
      else { selected = null; moves = []; }
    }
    function onKey(e) { if ((e.key === ' ' || e.key === 'Enter') && state !== 'play') { start(); e.preventDefault(); } }
    window.addEventListener('keydown', onKey); window.addEventListener('resize', resize);
    canvas.addEventListener('pointerdown', onPointer);
    reset(); raf = requestAnimationFrame(loop);
    return { destroy: function () { cancelAnimationFrame(raf); clearTimeout(aiTimer); window.removeEventListener('resize', resize); window.removeEventListener('keydown', onKey); } };
  }
});'''

_UI_HELPERS = r'''
    function rr(x, y, w, h, r) {
      const rad = Math.min(r, Math.min(w, h) / 2);
      g.beginPath(); g.moveTo(x + rad, y);
      g.arcTo(x + w, y, x + w, y + h, rad);
      g.arcTo(x + w, y + h, x, y + h, rad);
      g.arcTo(x, y + h, x, y, rad);
      g.arcTo(x, y, x + w, y, rad);
      g.closePath();
    }
    function fillRR(x, y, w, h, r, fill, stroke) {
      rr(x, y, w, h, r);
      if (fill) { g.fillStyle = fill; g.fill(); }
      if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); }
    }
    function textC(text, x, y, size, color, bold) {
      g.textAlign = 'center'; g.fillStyle = color;
      g.font = (bold ? '600 ' : '') + size + 'px system-ui, -apple-system, Segoe UI, sans-serif';
      g.fillText(text, x, y);
    }
    function textL(text, x, y, size, color, bold) {
      g.textAlign = 'left'; g.fillStyle = color;
      g.font = (bold ? '600 ' : '') + size + 'px system-ui, -apple-system, Segoe UI, sans-serif';
      g.fillText(text, x, y);
    }
    function drawBackdrop() {
      const gr = g.createLinearGradient(0, 0, 0, H);
      gr.addColorStop(0, BG); gr.addColorStop(1, '#04060b');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      const vg = g.createRadialGradient(W / 2, H * 0.3, 0, W / 2, H * 0.3, Math.max(W, H) * 0.75);
      vg.addColorStop(0, 'rgba(255,255,255,0.055)');
      vg.addColorStop(1, 'rgba(0,0,0,0.28)');
      g.fillStyle = vg; g.fillRect(0, 0, W, H);
    }
    function drawPanel(x, y, w, h, fill, stroke) {
      fillRR(x, y, w, h, Math.min(18, Math.min(w, h) * 0.12),
        fill || 'rgba(255,255,255,0.045)',
        stroke || 'rgba(255,255,255,0.09)');
    }
    function drawOverlay(head, sub, button) {
      g.fillStyle = 'rgba(2,6,23,0.68)'; g.fillRect(0, 0, W, H);
      const w = Math.min(360, W - 40), h = 184;
      fillRR(W / 2 - w / 2, H / 2 - h / 2, w, h, 20,
        'rgba(15,23,42,0.96)', 'rgba(255,255,255,0.12)');
      textC(head, W / 2, H / 2 - 24, 26, '#ffffff', true);
      textC(sub, W / 2, H / 2 + 12, 14, AC, false);
      fillRR(W / 2 - 86, H / 2 + 40, 172, 38, 19, AC, 'rgba(255,255,255,0.12)');
      textC(button, W / 2, H / 2 + 64, 14, '#06121f', true);
    }
    function drawStone(cx, cy, r, color, ring) {
      g.save();
      g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 12;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fillStyle = color; g.fill();
      g.restore();
      g.beginPath(); g.arc(cx - r * 0.3, cy - r * 0.32, r * 0.26, 0, Math.PI * 2);
      g.fillStyle = 'rgba(255,255,255,0.3)'; g.fill();
      if (ring) {
        g.beginPath(); g.arc(cx, cy, r * 0.58, 0, Math.PI * 2);
        g.strokeStyle = ring; g.lineWidth = 2; g.stroke();
      }
    }
'''

_TEMPLATES = {"gomoku": _GOMOKU, "tictactoe": _TICTACTOE,
              "connect4": _CONNECT4, "reversi": _REVERSI,
              "connect6": _CONNECT6, "dotsandboxes": _DOTS,
              "hex": _HEX, "checkers": _CHECKERS}


def build_board_game_code(spec: Dict[str, Any]) -> str:
    s = normalize_spec(spec if isinstance(spec, dict) else {})
    code = _TEMPLATES[s["genre"]]
    code = code.replace(
        "const g = canvas.getContext('2d');",
        "const g = canvas.getContext('2d');" + _UI_HELPERS, 1)
    code = code.replace(
        "g.fillStyle = BG; g.fillRect(0, 0, W, H);",
        "drawBackdrop();")
    replacements = {
        "__BG__": _js(s["bg"]), "__FG__": _js(s["fg"]),
        "__ACCENT__": _js(s["accent"]), "__TITLE__": _js(s["title"]),
        "__INSTR__": _js(s["instructions"]),
        "__PLAYER__": _js(s["labels"]["player"]),
        "__ITEM__": _js(s["labels"]["item"]),
        "__MODE__": _js(s["mode"]), "__DIFF__": str(s["difficulty"]),
    }
    for token, value in replacements.items():
        code = code.replace(token, value)
    # 迭代元数据：后续改版从代码里读回同一份 spec。
    return ("// __BOARD_SPEC__ " + json.dumps(s, ensure_ascii=False) + "\n"
            + code)
