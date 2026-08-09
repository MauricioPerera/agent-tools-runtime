// Hero stage: one "agent" jack on the left connects to exactly one module
// jack at a time -- draw the cable in, hold it lit, retract, pick another.
// The whole point of the piece: nothing stays wired that isn't in use.
(function () {
  "use strict";

  var canvas = document.getElementById("patchbay");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var DPR = Math.min(window.devicePixelRatio || 1, 2);
  var W = 0, H = 0;
  var agent = { x: 0, y: 0, r: 0 };
  var jacks = [];
  var ROWS = 3, COLS = 3;

  function layout() {
    var rect = canvas.parentElement.getBoundingClientRect();
    W = rect.width;
    H = rect.height;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    agent.x = W * 0.16;
    agent.y = H * 0.5;
    agent.r = Math.max(7, Math.min(W, H) * 0.035);

    jacks = [];
    var gridX0 = W * 0.52;
    var gridX1 = W * 0.92;
    var gridY0 = H * 0.16;
    var gridY1 = H * 0.86;
    var jr = Math.max(5, Math.min(W, H) * 0.024);
    for (var row = 0; row < ROWS; row++) {
      for (var col = 0; col < COLS; col++) {
        var jitterX = (Math.sin(row * 3 + col * 7) * 0.06) * (gridX1 - gridX0);
        var jitterY = (Math.cos(row * 5 + col * 2) * 0.05) * (gridY1 - gridY0);
        jacks.push({
          x: gridX0 + (col / (COLS - 1)) * (gridX1 - gridX0) + jitterX,
          y: gridY0 + (row / (ROWS - 1)) * (gridY1 - gridY0) + jitterY,
          r: jr
        });
      }
    }
  }

  function colors() {
    var css = getComputedStyle(document.documentElement);
    return {
      border: css.getPropertyValue("--border").trim() || "#3a3226",
      ink: css.getPropertyValue("--ink-faint").trim() || "#6f6353",
      amber: css.getPropertyValue("--amber").trim() || "#e8a33d",
      cyan: css.getPropertyValue("--cyan").trim() || "#5fd9c8"
    };
  }

  function drawJackRing(x, y, r, color, glow) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    if (glow > 0) {
      ctx.beginPath();
      ctx.arc(x, y, r * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = glow;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  function cablePoint(t, from, to) {
    // gentle bezier sag so it reads as a physical cable, not a ruler line
    var midX = (from.x + to.x) / 2;
    var midY = (from.y + to.y) / 2 + Math.min(40, Math.abs(to.x - from.x) * 0.12);
    var x = (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * midX + t * t * to.x;
    var y = (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * midY + t * t * to.y;
    return { x: x, y: y };
  }

  function drawCable(progress, from, to, color, alpha) {
    ctx.beginPath();
    var steps = 24;
    for (var i = 0; i <= steps; i++) {
      var t = (i / steps) * progress;
      var p = cablePoint(t, from, to);
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // state machine: connecting -> holding -> disconnecting -> (pick new target) -> idle gap
  var PHASES = { CONNECT: 0, HOLD: 1, DISCONNECT: 2, GAP: 3 };
  var phase = PHASES.GAP;
  var phaseStart = 0;
  var DURATIONS = { connect: 650, hold: 900, disconnect: 450, gap: 350 };
  var targetIndex = 0;
  var order = [];

  function shuffleOrder() {
    order = jacks.map(function (_, i) { return i; });
    for (var i = order.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    }
  }

  function frame(now) {
    if (!phaseStart) phaseStart = now;
    var elapsed = now - phaseStart;
    var c = colors();

    ctx.clearRect(0, 0, W, H);

    // faint grid dots for the "rack surface" feel
    ctx.fillStyle = c.border;
    ctx.globalAlpha = 0.35;
    for (var gx = 0; gx < 6; gx++) {
      for (var gy = 0; gy < 5; gy++) {
        ctx.beginPath();
        ctx.arc(W * 0.05 + gx * (W * 0.9 / 5), H * 0.08 + gy * (H * 0.84 / 4), 1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    var current = jacks[order[targetIndex] || 0];

    var connectT = 0, alpha = 1, agentGlow = 0.15, jackGlow = 0;
    if (phase === PHASES.CONNECT) {
      connectT = Math.min(1, elapsed / DURATIONS.connect);
      agentGlow = 0.4 + connectT * 0.3;
      jackGlow = connectT * 0.9;
      if (connectT >= 1) { phase = PHASES.HOLD; phaseStart = now; }
    } else if (phase === PHASES.HOLD) {
      connectT = 1; agentGlow = 0.7; jackGlow = 0.9;
      if (elapsed >= DURATIONS.hold) { phase = PHASES.DISCONNECT; phaseStart = now; }
    } else if (phase === PHASES.DISCONNECT) {
      var dt = Math.min(1, elapsed / DURATIONS.disconnect);
      connectT = 1; alpha = 1 - dt; agentGlow = 0.7 * (1 - dt); jackGlow = 0.9 * (1 - dt);
      if (dt >= 1) { phase = PHASES.GAP; phaseStart = now; }
    } else if (phase === PHASES.GAP) {
      connectT = 0; alpha = 0; agentGlow = 0.15; jackGlow = 0;
      if (elapsed >= DURATIONS.gap) {
        targetIndex++;
        if (!order.length || targetIndex >= order.length) { shuffleOrder(); targetIndex = 0; }
        phase = PHASES.CONNECT; phaseStart = now;
      }
    }

    // idle jacks
    jacks.forEach(function (j, i) {
      if (i === order[targetIndex]) return;
      drawJackRing(j.x, j.y, j.r, c.border, 0);
    });

    // active cable + jack
    if (connectT > 0 && current) {
      drawCable(connectT, agent, current, c.amber, alpha);
      drawJackRing(current.x, current.y, current.r, c.amber, jackGlow * alpha);
    }

    // agent node
    ctx.beginPath();
    ctx.arc(agent.x, agent.y, agent.r, 0, Math.PI * 2);
    ctx.fillStyle = c.cyan;
    ctx.globalAlpha = 0.12 + agentGlow * 0.5;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(agent.x, agent.y, agent.r, 0, Math.PI * 2);
    ctx.strokeStyle = c.cyan;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    if (!reduceMotion) requestAnimationFrame(frame);
  }

  function staticFrame() {
    var c = colors();
    ctx.clearRect(0, 0, W, H);
    jacks.forEach(function (j) { drawJackRing(j.x, j.y, j.r, c.border, 0); });
    if (jacks[4]) {
      drawCable(1, agent, jacks[4], c.amber, 1);
      drawJackRing(jacks[4].x, jacks[4].y, jacks[4].r, c.amber, 0.8);
    }
    ctx.beginPath();
    ctx.arc(agent.x, agent.y, agent.r, 0, Math.PI * 2);
    ctx.strokeStyle = c.cyan;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  function start() {
    layout();
    shuffleOrder();
    if (reduceMotion) { staticFrame(); return; }
    requestAnimationFrame(frame);
  }

  var resizeTimer;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      layout();
      if (reduceMotion) staticFrame();
    }, 150);
  });

  document.addEventListener("DOMContentLoaded", start);
})();
