"""小游戏确定性代码生成（GameNode 专用）。

模型只输出一个小 spec（genre / title / 配色 / 速度 / 目标 / 标签 / 提示），
本模块负责生成完整、可运行的 ``Work.register`` 单文件代码。支持三种
genre：catch（接物）、snake（贪吃蛇）、breakout（打砖块）。生成代码不含
外部网络/素材，发布前仍由 assert 节点做二次闸。
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict

DEFAULT = {
    "genre": "catch",
    "title": "小游戏",
    "bg": "#0b1020",
    "fg": "#ffffff",
    "accent": "#22d3ee",
    "speed": 5,
    "target": 10,
    "labels": {"player": "篮子", "item": "星星", "hazard": "炸弹"},
    "instructions": "左右移动，接住目标，避开危险",
}

_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


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
    genre = str(spec.get("genre") or "catch").strip().lower()
    if genre not in ("catch", "snake", "breakout", "gomoku"):
        genre = "catch"
    labels = spec.get("labels") if isinstance(spec.get("labels"), dict) else {}
    default_labels = ({"player": "黑棋", "item": "白棋", "hazard": "炸弹"}
                      if genre == "gomoku" else DEFAULT["labels"])
    return {
        "genre": genre,
        "title": _text(spec.get("title"), DEFAULT["title"], 40),
        "bg": _color(spec.get("bg"), DEFAULT["bg"]),
        "fg": _color(spec.get("fg"), DEFAULT["fg"]),
        "accent": _color(spec.get("accent"), DEFAULT["accent"]),
        "speed": _int(spec.get("speed"), DEFAULT["speed"], 1, 10),
        "target": _int(spec.get("target"), DEFAULT["target"], 5, 30),
        "labels": {
            "player": _text(labels.get("player"), default_labels["player"], 12),
            "item": _text(labels.get("item"), default_labels["item"], 12),
            "hazard": _text(labels.get("hazard"), default_labels["hazard"], 12),
        },
        "instructions": _text(spec.get("instructions"),
                              DEFAULT["instructions"], 80),
    }


_CATCH = r'''Work.register({
  mount(ctx) {
    const stage = ctx.stage;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
    stage.appendChild(canvas);
    const g = canvas.getContext('2d');
    let W = 1, H = 1, DPR = 1, raf = 0;
    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      const r = stage.getBoundingClientRect();
      W = Math.max(1, Math.floor(r.width));
      H = Math.max(1, Math.floor(r.height));
      canvas.width = Math.floor(W * DPR);
      canvas.height = Math.floor(H * DPR);
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    resize();
    const BG = __BG__, FG = __FG__, AC = __ACCENT__;
    const TITLE = __TITLE__, INSTR = __INSTR__;
    const PLAYER = __PLAYER__, ITEM = __ITEM__, HAZARD = __HAZARD__;
    const SPEED = __SPEED__, TARGET = __TARGET__;
    let state = 'ready', score = 0, lives = 3, elapsed = 0, spawn = 0, last = 0;
    let px = 0, pw = 0, ph = 0, drops = [];
    const keys = { left: false, right: false };
    function reset() {
      state = 'ready'; score = 0; lives = 3; elapsed = 0; spawn = 0; drops = [];
      pw = Math.max(70, Math.min(140, W * 0.2));
      ph = Math.max(16, pw * 0.22);
      px = W / 2 - pw / 2;
    }
    function start() { reset(); state = 'play'; last = performance.now(); }
    function spawnDrop() {
      const r = Math.max(9, Math.min(20, W * 0.03));
      const bad = Math.random() < 0.22;
      drops.push({
        x: r + Math.random() * Math.max(1, W - r * 2),
        y: -r * 2, r: r,
        vy: (90 + Math.random() * 80 + elapsed * 5) * (0.7 + SPEED * 0.06),
        bad: bad
      });
    }
    function update(dt) {
      if (state !== 'play') return;
      elapsed += dt; spawn += dt;
      const iv = Math.max(0.35, 0.9 - elapsed * 0.01 - SPEED * 0.03);
      if (spawn > iv) { spawn = 0; spawnDrop(); }
      const v = Math.max(260, W * 0.75) * (0.7 + SPEED * 0.05);
      if (keys.left) px -= v * dt;
      if (keys.right) px += v * dt;
      px = Math.max(0, Math.min(W - pw, px));
      for (let i = 0; i < drops.length; i++) drops[i].y += drops[i].vy * dt;
      drops = drops.filter(function (d) {
        if (d.y - d.r > H) { lives--; return false; }
        if (d.y + d.r > H - ph && d.x > px && d.x < px + pw) {
          if (d.bad) lives--; else score++;
          return false;
        }
        return true;
      });
      if (lives <= 0) state = 'over';
      if (score >= TARGET) state = 'win';
    }
    function draw() {
      g.fillStyle = BG; g.fillRect(0, 0, W, H);
      g.textAlign = 'center';
      g.fillStyle = FG;
      g.font = '600 ' + Math.max(18, Math.min(34, W * 0.05)) + 'px sans-serif';
      g.fillText(TITLE, W / 2, H * 0.14);
      g.font = '14px sans-serif'; g.fillStyle = AC;
      g.fillText('得分 ' + score + ' / ' + TARGET + '   生命 ' + Math.max(0, lives), W / 2, H * 0.14 + 28);
      g.fillStyle = FG; g.fillRect(px, H - ph, pw, ph);
      g.textAlign = 'center'; g.font = '10px sans-serif';
      for (let i = 0; i < drops.length; i++) {
        const d = drops[i];
        g.beginPath(); g.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        g.fillStyle = d.bad ? AC : '#f8fafc'; g.fill();
        g.fillStyle = BG; g.fillText(d.bad ? HAZARD : ITEM, d.x, d.y + 3);
      }
      if (state !== 'play') {
        g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, 0, W, H);
        g.textAlign = 'center'; g.fillStyle = '#ffffff';
        g.font = '600 26px sans-serif';
        g.fillText(state === 'ready' ? '点击 / 空格开始' : (state === 'win' ? '目标达成' : '游戏结束'), W / 2, H / 2 - 10);
        g.font = '14px sans-serif'; g.fillStyle = AC;
        g.fillText(INSTR, W / 2, H / 2 + 24);
        g.fillText('点击 / 空格重新开始', W / 2, H / 2 + 50);
      }
      g.textAlign = 'left';
    }
    function loop(t) {
      const dt = Math.min(0.05, (t - last) / 1000 || 0);
      last = t; update(dt); draw(); raf = requestAnimationFrame(loop);
    }
    function onKey(e) {
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') keys.left = e.type === 'keydown';
      if (k === 'ArrowRight' || k === 'd' || k === 'D') keys.right = e.type === 'keydown';
      if (e.type === 'keydown' && (k === ' ' || k === 'Enter')) {
        if (state !== 'play') start();
        e.preventDefault();
      }
    }
    function onPointer(e) {
      const r = canvas.getBoundingClientRect();
      px = Math.max(0, Math.min(W - pw, (e.clientX - r.left) - pw / 2));
      if (state !== 'play') start();
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('resize', resize);
    canvas.addEventListener('pointerdown', onPointer);
    canvas.addEventListener('pointermove', function (e) { if (e.buttons) onPointer(e); });
    reset(); raf = requestAnimationFrame(loop);
    return { destroy: function () {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    } };
  }
});'''

_SNAKE = r'''Work.register({
  mount(ctx) {
    const stage = ctx.stage;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
    stage.appendChild(canvas);
    const g = canvas.getContext('2d');
    let W = 1, H = 1, DPR = 1, raf = 0;
    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      const r = stage.getBoundingClientRect();
      W = Math.max(1, Math.floor(r.width));
      H = Math.max(1, Math.floor(r.height));
      canvas.width = Math.floor(W * DPR);
      canvas.height = Math.floor(H * DPR);
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    resize();
    const BG = __BG__, FG = __FG__, AC = __ACCENT__;
    const TITLE = __TITLE__, INSTR = __INSTR__;
    const PLAYER = __PLAYER__, ITEM = __ITEM__;
    const SPEED = __SPEED__, TARGET = __TARGET__;
    const COLS = 20, ROWS = 28;
    let cell = 1, ox = 0, oy = 0, snake = [], dir = { x: 1, y: 0 }, nextDir = { x: 1, y: 0 };
    let food = { x: 10, y: 10 }, score = 0, state = 'ready', acc = 0, step = 0.2, last = 0, touch = null;
    function layout() {
      cell = Math.min(W / COLS, H / ROWS);
      ox = (W - cell * COLS) / 2; oy = (H - cell * ROWS) / 2;
    }
    function spawn() {
      for (let i = 0; i < 200; i++) {
        const f = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
        if (!snake.some(function (s) { return s.x === f.x && s.y === f.y; })) return f;
      }
      return { x: 1, y: 1 };
    }
    function reset() {
      snake = [{ x: 9, y: 14 }, { x: 8, y: 14 }, { x: 7, y: 14 }];
      dir = { x: 1, y: 0 }; nextDir = { x: 1, y: 0 };
      score = 0; acc = 0; state = 'ready';
      step = Math.max(0.09, 0.28 - SPEED * 0.018);
      layout(); food = spawn();
    }
    function start() { reset(); state = 'play'; last = performance.now(); }
    function tick() {
      if (state !== 'play') return;
      dir = nextDir;
      const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
      if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS ||
          snake.some(function (s) { return s.x === head.x && s.y === head.y; })) {
        state = 'over'; return;
      }
      snake.unshift(head);
      if (head.x === food.x && head.y === food.y) { score++; food = spawn(); }
      else snake.pop();
      if (score >= TARGET) state = 'win';
    }
    function update(dt) {
      if (state !== 'play') return;
      acc += dt;
      while (acc >= step) { acc -= step; tick(); }
    }
    function draw() {
      g.fillStyle = BG; g.fillRect(0, 0, W, H);
      g.strokeStyle = 'rgba(255,255,255,0.05)';
      for (let x = 0; x <= COLS; x++) { g.beginPath(); g.moveTo(ox + x * cell, oy); g.lineTo(ox + x * cell, oy + ROWS * cell); g.stroke(); }
      for (let y = 0; y <= ROWS; y++) { g.beginPath(); g.moveTo(ox, oy + y * cell); g.lineTo(ox + COLS * cell, oy + y * cell); g.stroke(); }
      g.fillStyle = AC;
      g.beginPath(); g.arc(ox + (food.x + 0.5) * cell, oy + (food.y + 0.5) * cell, cell * 0.34, 0, Math.PI * 2); g.fill();
      for (let i = snake.length - 1; i >= 0; i--) {
        g.fillStyle = i === 0 ? AC : FG;
        g.fillRect(ox + snake[i].x * cell + 1, oy + snake[i].y * cell + 1, cell - 2, cell - 2);
      }
      g.textAlign = 'center'; g.fillStyle = FG;
      g.font = '600 ' + Math.max(16, Math.min(28, W * 0.045)) + 'px sans-serif';
      g.fillText(TITLE, W / 2, Math.max(24, oy - 18));
      g.font = '14px sans-serif'; g.fillStyle = AC;
      g.fillText(PLAYER + '得分 ' + score + ' / ' + TARGET + '   食物 ' + ITEM, W / 2, Math.max(44, oy - 2));
      if (state !== 'play') {
        g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, 0, W, H);
        g.textAlign = 'center'; g.fillStyle = '#ffffff';
        g.font = '600 26px sans-serif';
        g.fillText(state === 'ready' ? '点击 / 空格开始' : (state === 'win' ? '目标达成' : '游戏结束'), W / 2, H / 2 - 10);
        g.font = '14px sans-serif'; g.fillStyle = AC;
        g.fillText(INSTR, W / 2, H / 2 + 24);
        g.fillText('方向键 / WASD / 滑动操作', W / 2, H / 2 + 48);
      }
      g.textAlign = 'left';
    }
    function loop(t) {
      const dt = Math.min(0.05, (t - last) / 1000 || 0);
      last = t; update(dt); draw(); raf = requestAnimationFrame(loop);
    }
    function setDir(x, y) {
      if (state !== 'play') return;
      if (x === -dir.x && y === -dir.y) return;
      nextDir = { x: x, y: y };
    }
    function onKey(e) {
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') setDir(-1, 0);
      if (k === 'ArrowRight' || k === 'd' || k === 'D') setDir(1, 0);
      if (k === 'ArrowUp' || k === 'w' || k === 'W') setDir(0, -1);
      if (k === 'ArrowDown' || k === 's' || k === 'S') setDir(0, 1);
      if (e.type === 'keydown' && (k === ' ' || k === 'Enter')) {
        if (state !== 'play') start();
        e.preventDefault();
      }
    }
    function onDown(e) { touch = { x: e.clientX, y: e.clientY }; if (state !== 'play') start(); }
    function onUp(e) {
      if (!touch) return;
      const dx = e.clientX - touch.x, dy = e.clientY - touch.y;
      if (Math.abs(dx) > Math.abs(dy)) { if (dx > 10) setDir(1, 0); else if (dx < -10) setDir(-1, 0); }
      else { if (dy > 10) setDir(0, 1); else if (dy < -10) setDir(0, -1); }
      touch = null;
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', resize);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    reset(); raf = requestAnimationFrame(loop);
    return { destroy: function () {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', onKey);
    } };
  }
});'''

_BREAKOUT = r'''Work.register({
  mount(ctx) {
    const stage = ctx.stage;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
    stage.appendChild(canvas);
    const g = canvas.getContext('2d');
    let W = 1, H = 1, DPR = 1, raf = 0;
    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      const r = stage.getBoundingClientRect();
      W = Math.max(1, Math.floor(r.width));
      H = Math.max(1, Math.floor(r.height));
      canvas.width = Math.floor(W * DPR);
      canvas.height = Math.floor(H * DPR);
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    resize();
    const BG = __BG__, FG = __FG__, AC = __ACCENT__;
    const TITLE = __TITLE__, INSTR = __INSTR__;
    const PLAYER = __PLAYER__, ITEM = __ITEM__;
    const SPEED = __SPEED__, TARGET = __TARGET__;
    const COLS = 8, ROWS = 4;
    let pw = 0, ph = 0, px = 0, bx = 0, by = 0, bvx = 0, bvy = 0;
    let bricks = [], score = 0, lives = 3, state = 'ready', last = 0, keys = { left: false, right: false };
    function reset() {
      pw = Math.max(80, Math.min(150, W * 0.22)); ph = Math.max(12, pw * 0.14);
      px = W / 2 - pw / 2;
      bx = W / 2; by = H * 0.7; bvx = 0; bvy = 0;
      score = 0; lives = 3; state = 'ready';
      bricks = [];
      const bw = (W - 40) / COLS, bh = Math.max(14, H * 0.035);
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        bricks.push({ x: 20 + c * bw, y: 90 + r * (bh + 8), w: bw - 4, h: bh, alive: true });
      }
    }
    function start() {
      reset(); state = 'play'; last = performance.now();
      bx = W / 2; by = H * 0.68; bvx = (Math.random() < 0.5 ? -1 : 1) * (110 + SPEED * 16);
      bvy = -(180 + SPEED * 18);
    }
    function update(dt) {
      if (state !== 'play') return;
      const v = Math.max(300, W * 0.8) * (0.7 + SPEED * 0.05);
      if (keys.left) px -= v * dt;
      if (keys.right) px += v * dt;
      px = Math.max(0, Math.min(W - pw, px));
      bx += bvx * dt; by += bvy * dt;
      if (bx < 8) { bx = 8; bvx = Math.abs(bvx); }
      if (bx > W - 8) { bx = W - 8; bvx = -Math.abs(bvx); }
      if (by < 8) { by = 8; bvy = Math.abs(bvy); }
      if (by > H - ph - 8 && bx > px && bx < px + pw) {
        by = H - ph - 8; bvy = -Math.abs(bvy);
        bvx += ((bx - (px + pw / 2)) / (pw / 2)) * 60;
      }
      if (by > H + 20) {
        lives--;
        if (lives <= 0) state = 'over';
        else { bx = W / 2; by = H * 0.68; bvx = (Math.random() < 0.5 ? -1 : 1) * 120; bvy = -220; }
      }
      for (let i = 0; i < bricks.length; i++) {
        const b = bricks[i];
        if (!b.alive) continue;
        if (bx > b.x && bx < b.x + b.w && by > b.y && by < b.y + b.h) {
          b.alive = false; score++; bvy = -bvy; break;
        }
      }
      if (score >= TARGET || bricks.every(function (b) { return !b.alive; })) state = 'win';
    }
    function draw() {
      g.fillStyle = BG; g.fillRect(0, 0, W, H);
      for (let i = 0; i < bricks.length; i++) {
        const b = bricks[i];
        if (!b.alive) continue;
        g.fillStyle = i % 2 ? AC : FG;
        g.fillRect(b.x, b.y, b.w, b.h);
      }
      g.fillStyle = FG; g.fillRect(px, H - ph - 10, pw, ph);
      g.beginPath(); g.arc(bx, by, Math.max(5, W * 0.012), 0, Math.PI * 2); g.fillStyle = AC; g.fill();
      g.textAlign = 'center'; g.fillStyle = FG;
      g.font = '600 ' + Math.max(16, Math.min(30, W * 0.05)) + 'px sans-serif';
      g.fillText(TITLE, W / 2, 36);
      g.font = '14px sans-serif'; g.fillStyle = AC;
      g.fillText(ITEM + ' ' + score + ' / ' + TARGET + '   生命 ' + Math.max(0, lives), W / 2, 60);
      if (state !== 'play') {
        g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, 0, W, H);
        g.textAlign = 'center'; g.fillStyle = '#ffffff';
        g.font = '600 26px sans-serif';
        g.fillText(state === 'ready' ? '点击 / 空格开始' : (state === 'win' ? '目标达成' : '游戏结束'), W / 2, H / 2 - 10);
        g.font = '14px sans-serif'; g.fillStyle = AC;
        g.fillText(INSTR, W / 2, H / 2 + 24);
        g.fillText('左右移动' + PLAYER + '，接住反弹球', W / 2, H / 2 + 48);
        g.fillText('点击 / 空格重新开始', W / 2, H / 2 + 72);
      }
      g.textAlign = 'left';
    }
    function loop(t) {
      const dt = Math.min(0.05, (t - last) / 1000 || 0);
      last = t; update(dt); draw(); raf = requestAnimationFrame(loop);
    }
    function onKey(e) {
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') keys.left = e.type === 'keydown';
      if (k === 'ArrowRight' || k === 'd' || k === 'D') keys.right = e.type === 'keydown';
      if (e.type === 'keydown' && (k === ' ' || k === 'Enter')) {
        if (state !== 'play') start();
        e.preventDefault();
      }
    }
    function onMove(e) {
      const r = canvas.getBoundingClientRect();
      px = Math.max(0, Math.min(W - pw, (e.clientX - r.left) - pw / 2));
      if (state !== 'play') start();
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('resize', resize);
    canvas.addEventListener('pointerdown', onMove);
    canvas.addEventListener('pointermove', function (e) { if (e.buttons) onMove(e); });
    reset(); raf = requestAnimationFrame(loop);
    return { destroy: function () {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    } };
  }
});'''

_GOMOKU = r'''Work.register({
  mount(ctx) {
    const stage = ctx.stage;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
    stage.appendChild(canvas);
    const g = canvas.getContext('2d');
    let W = 1, H = 1, DPR = 1, raf = 0;
    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      const r = stage.getBoundingClientRect();
      W = Math.max(1, Math.floor(r.width));
      H = Math.max(1, Math.floor(r.height));
      canvas.width = Math.floor(W * DPR);
      canvas.height = Math.floor(H * DPR);
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    resize();
    const BG = __BG__, FG = __FG__, AC = __ACCENT__;
    const TITLE = __TITLE__, INSTR = __INSTR__;
    const P1 = __PLAYER__, P2 = __ITEM__;
    const SIZE = 15;
    let cell = 1, ox = 0, oy = 0, pad = 0;
    let board = [], turn = 1, state = 'ready', last = null, winLine = null;
    function layout() {
      pad = Math.max(18, Math.min(W, H) * 0.09);
      cell = Math.min((W - 2 * pad) / (SIZE - 1), (H - 2 * pad) / (SIZE - 1));
      ox = (W - cell * (SIZE - 1)) / 2;
      oy = (H - cell * (SIZE - 1)) / 2;
    }
    function reset() {
      board = [];
      for (let i = 0; i < SIZE; i++) board.push(new Array(SIZE).fill(0));
      turn = 1; state = 'ready'; last = null; winLine = null; layout();
    }
    function start() { reset(); state = 'play'; }
    function check(x, y, p) {
      const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
      for (let d = 0; d < dirs.length; d++) {
        const dx = dirs[d][0], dy = dirs[d][1];
        const line = [{ x: x, y: y }];
        for (let s = -1; s <= 1; s += 2) {
          let nx = x + dx * s, ny = y + dy * s;
          while (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[nx][ny] === p) {
            line.push({ x: nx, y: ny });
            nx += dx * s; ny += dy * s;
          }
        }
        if (line.length >= 5) return line;
      }
      return null;
    }
    function place(x, y) {
      if (state !== 'play' || board[x][y] !== 0) return;
      board[x][y] = turn; last = { x: x, y: y };
      const line = check(x, y, turn);
      if (line) { winLine = line; state = 'win'; }
      else turn = 3 - turn;
    }
    function draw() {
      g.fillStyle = BG; g.fillRect(0, 0, W, H);
      g.strokeStyle = FG; g.lineWidth = 1;
      for (let i = 0; i < SIZE; i++) {
        const a = ox + i * cell, b = oy + i * cell;
        g.beginPath(); g.moveTo(ox, b); g.lineTo(ox + (SIZE - 1) * cell, b); g.stroke();
        g.beginPath(); g.moveTo(a, oy); g.lineTo(a, oy + (SIZE - 1) * cell); g.stroke();
      }
      g.fillStyle = FG;
      const stars = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]];
      for (let i = 0; i < stars.length; i++) {
        g.beginPath();
        g.arc(ox + stars[i][0] * cell, oy + stars[i][1] * cell, Math.max(2, cell * 0.08), 0, Math.PI * 2);
        g.fill();
      }
      for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) {
        if (!board[x][y]) continue;
        g.beginPath();
        g.arc(ox + x * cell, oy + y * cell, cell * 0.42, 0, Math.PI * 2);
        g.fillStyle = board[x][y] === 1 ? '#111111' : '#f8fafc';
        g.fill();
        g.strokeStyle = FG; g.stroke();
      }
      if (last) {
        g.beginPath();
        g.arc(ox + last.x * cell, oy + last.y * cell, cell * 0.48, 0, Math.PI * 2);
        g.strokeStyle = AC; g.lineWidth = 2; g.stroke(); g.lineWidth = 1;
      }
      if (winLine) {
        const a = winLine[0], b = winLine[winLine.length - 1];
        g.beginPath();
        g.moveTo(ox + a.x * cell, oy + a.y * cell);
        g.lineTo(ox + b.x * cell, oy + b.y * cell);
        g.strokeStyle = AC; g.lineWidth = 4; g.stroke(); g.lineWidth = 1;
      }
      g.textAlign = 'center'; g.fillStyle = FG;
      g.font = '600 ' + Math.max(16, Math.min(28, W * 0.045)) + 'px sans-serif';
      g.fillText(TITLE, W / 2, Math.max(24, oy - 20));
      g.font = '14px sans-serif'; g.fillStyle = AC;
      g.fillText(state === 'ready' ? INSTR : ('当前：' + (turn === 1 ? P1 : P2) + ' · ' + P1 + ' / ' + P2), W / 2, Math.max(44, oy - 2));
      if (state !== 'play') {
        g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, 0, W, H);
        g.textAlign = 'center'; g.fillStyle = '#ffffff';
        g.font = '600 26px sans-serif';
        g.fillText(state === 'ready' ? '点击 / 空格开始' : '五连获胜', W / 2, H / 2 - 10);
        g.font = '14px sans-serif'; g.fillStyle = AC;
        g.fillText(INSTR, W / 2, H / 2 + 24);
        g.fillText('点击 / 空格重新开始', W / 2, H / 2 + 50);
      }
      g.textAlign = 'left';
    }
    function loop() { draw(); raf = requestAnimationFrame(loop); }
    function onPointer(e) {
      const r = canvas.getBoundingClientRect();
      if (state !== 'play') { start(); return; }
      const x = Math.round((e.clientX - r.left - ox) / cell);
      const y = Math.round((e.clientY - r.top - oy) / cell);
      if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) place(x, y);
    }
    function onKey(e) {
      if ((e.key === ' ' || e.key === 'Enter') && state !== 'play') {
        start(); e.preventDefault();
      }
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', resize);
    canvas.addEventListener('pointerdown', onPointer);
    reset(); raf = requestAnimationFrame(loop);
    return { destroy: function () {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', onKey);
    } };
  }
});'''

_TEMPLATES = {"catch": _CATCH, "snake": _SNAKE, "breakout": _BREAKOUT,
              "gomoku": _GOMOKU}


def build_game_code(spec: Dict[str, Any]) -> str:
    s = normalize_spec(spec if isinstance(spec, dict) else {})
    code = _TEMPLATES[s["genre"]]
    replacements = {
        "__BG__": _js(s["bg"]),
        "__FG__": _js(s["fg"]),
        "__ACCENT__": _js(s["accent"]),
        "__TITLE__": _js(s["title"]),
        "__INSTR__": _js(s["instructions"]),
        "__PLAYER__": _js(s["labels"]["player"]),
        "__ITEM__": _js(s["labels"]["item"]),
        "__HAZARD__": _js(s["labels"]["hazard"]),
        "__SPEED__": str(s["speed"]),
        "__TARGET__": str(s["target"]),
    }
    for token, value in replacements.items():
        code = code.replace(token, value)
    return code
