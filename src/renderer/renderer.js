/**
 * 覆盖层渲染：假箭头精灵（飞行 / 眨眼 / 待机）+ 高亮圈 + 气泡。
 * 由主进程通过 window.cursormind.onCommand 下发指令。
 * 坐标系统 = 屏幕像素坐标（窗口全屏覆盖，dpr=1）。
 */
(function () {
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  const COLORS = {
    ink: '#1A1A1A',
    body: '#2D2D2D',
    stroke: '#FFFFFF',
    orange: '#F97316',
  };

  // ---- 状态 ----
  let state = 'off'; // off | idle | flying | pointing | flyingOut
  let pos = { x: -60, y: -60 }; // 箭头尖端坐标
  let from = { x: 0, y: 0 };
  let target = { x: 0, y: 0 };
  let targetRect = null;
  let bubbleText = '';
  let afterFly = 'idle';
  let flyStart = 0;
  let flyDur = 600;
  let landScale = 1;
  let landStart = 0;
  let blinkTimer = 0;
  let blinking = 0;
  let hoverPhase = 0;
  // 思考中状态（头顶三点气泡）
  let thinking = false;
  let thinkText = '';
  let thinkStart = 0;

  // ---- 指令 ----
  const api = window.cursormind;
  if (api) {
    api.onCommand(function (cmd) {
      if (!cmd) return;
      switch (cmd.type) {
        case 'flyIn': flyIn(cmd.fromEdge || 'left'); break;
        case 'flyTo': goTo(cmd.rect, cmd.bubble); break;
        case 'highlight': highlight(cmd.rect, cmd.bubble); break;
        case 'flyToPosition': goToPosition(cmd.position, cmd.bubble); break;
        case 'thinking': startThinking(cmd.text); break;
        case 'bubble': setBubble(cmd.text); break;
        case 'clear': clear(); break;
        case 'flyOut': flyOut(); break;
        case 'idle': setIdle(); break;
      }
    });
  }

  function flyIn(edge) {
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const starts = {
      left: { x: -40, y: cy },
      right: { x: canvas.width + 40, y: cy },
      top: { x: cx, y: -40 },
      bottom: { x: cx, y: canvas.height + 40 },
    };
    const start = starts[edge] || starts.left;
    pos = { x: start.x, y: start.y };
    from = { x: start.x, y: start.y };
    target = { x: cx, y: cy - 120 };
    targetRect = null;
    bubbleText = '';
    flyStart = performance.now();
    flyDur = 620;
    state = 'flying';
    afterFly = 'idle';
  }

  function goTo(rect, bubble) {
    from = { x: pos.x, y: pos.y };
    target = rectCenter(rect);
    targetRect = rect;
    bubbleText = bubble || '';
    stopThinking();
    flyStart = performance.now();
    flyDur = 500;
    state = 'flying';
    afterFly = 'pointing';
  }

  function highlight(rect, bubble) {
    goTo(rect, bubble);
  }

  // 纯视觉粗指路：只飞到位置，不画高亮框（避免误导）
  function goToPosition(position, bubble) {
    from = { x: pos.x, y: pos.y };
    target = { x: position.x, y: position.y };
    targetRect = null; // 不画框
    bubbleText = bubble || '';
    stopThinking();
    flyStart = performance.now();
    flyDur = 500;
    state = 'flying';
    afterFly = 'pointing';
  }

  // ---- 思考中 ----
  function startThinking(text) {
    thinking = true;
    thinkText = text || '';
    thinkStart = performance.now();
    // 若精灵未在场（异常时序），先飞入中心
    if (state === 'off') {
      flyIn('left');
    }
  }

  function stopThinking() {
    thinking = false;
    thinkText = '';
  }

  function setBubble(text) {
    bubbleText = text || '';
    stopThinking(); // 有输出即结束思考
  }

  function clear() {
    targetRect = null;
    bubbleText = '';
  }

  function flyOut() {
    from = { x: pos.x, y: pos.y };
    const cx = canvas.width / 2;
    target = pos.x < cx ? { x: -60, y: pos.y } : { x: canvas.width + 60, y: pos.y };
    targetRect = null;
    bubbleText = '';
    stopThinking();
    flyStart = performance.now();
    flyDur = 500;
    state = 'flyingOut';
  }

  function setIdle() {
    state = 'idle';
    targetRect = null;
    bubbleText = '';
  }

  function rectCenter(r) {
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }

  // ---- 动画 ----
  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function update(now) {
    blinkTimer += 16;
    if (blinking > 0) blinking -= 16;
    else if (blinkTimer > 2400 + Math.random() * 1800) {
      blinking = 140;
      blinkTimer = 0;
    }
    hoverPhase += 0.05;

    if (state === 'flying' || state === 'flyingOut') {
      const t = Math.min(1, (now - flyStart) / flyDur);
      const e = easeOutCubic(t);
      pos.x = from.x + (target.x - from.x) * e;
      pos.y = from.y + (target.y - from.y) * e;
      if (t >= 1) {
        if (state === 'flyingOut') {
          state = 'off';
        } else {
          state = afterFly;
          if (afterFly === 'pointing') {
            landScale = 1.25;
            landStart = now;
          }
        }
      }
    }

    if (state === 'pointing' && landScale > 1) {
      const t = (now - landStart) / 220;
      landScale = t < 1 ? 1.25 - 0.25 * easeOutCubic(t) : 1;
    }
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (targetRect && state === 'pointing') {
      drawHighlight(targetRect);
    }
    if (bubbleText && (state === 'pointing' || state === 'idle')) {
      drawBubble(targetRect, bubbleText);
    }
    if (thinking && state !== 'off') {
      drawThinkBubble();
    }
    if (state !== 'off') {
      drawSprite(pos, landScale, blinking > 0);
    }
  }

  /** 思考中气泡：精灵头顶三点依次呼吸（typing indicator 风格）+ 可选阶段文字 */
  function drawThinkBubble() {
    const now = performance.now();
    const t = (now - thinkStart) / 1000;

    const dotR = 3.2;
    const dotSpan = dotR * 2 * 3 + 12; // 三点总宽
    const textPad = thinkText ? 10 : 0;
    ctx.font = '400 12px "Microsoft YaHei", "Segoe UI", sans-serif';
    const textW = thinkText ? ctx.measureText(thinkText).width : 0;
    const bw = 24 + dotSpan + textPad + textW;
    const bh = 30;

    // 气泡锚在精灵尖上方（跟随精灵浮动）
    let bx = pos.x - bw / 2;
    let by = pos.y - 44 - bh;
    bx = Math.max(8, Math.min(canvas.width - bw - 8, bx));
    by = Math.max(8, by);

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = COLORS.orange;
    ctx.lineWidth = 1.5;
    roundRectPath(ctx, bx, by, bw, bh, 15);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.stroke();

    // 三点动画：依次呼吸点亮
    const cy = by + bh / 2;
    const startX = bx + 12 + dotR;
    for (let i = 0; i < 3; i++) {
      const phase = t * 2.4 - i * 0.55;
      const k = Math.max(0, Math.sin(phase * Math.PI));
      ctx.beginPath();
      ctx.arc(startX + i * (dotR * 2 + 6), cy, dotR * (0.7 + 0.45 * k), 0, Math.PI * 2);
      ctx.fillStyle = COLORS.orange;
      ctx.globalAlpha = 0.25 + 0.75 * k;
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (thinkText) {
      ctx.fillStyle = '#8C8C8C';
      ctx.textBaseline = 'middle';
      ctx.fillText(thinkText, bx + 12 + dotSpan + textPad, cy + 1);
    }
    ctx.restore();
  }

  function roundRectPath(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function drawHighlight(rect) {
    const pad = 8;
    const x = rect.x - pad, y = rect.y - pad;
    const w = rect.width + pad * 2, h = rect.height + pad * 2;
    const pulse = 0.5 + 0.5 * Math.sin(hoverPhase * 3);
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.orange;
    ctx.globalAlpha = 0.75 + 0.25 * pulse;
    roundRectPath(ctx, x, y, w, h, 10);
    ctx.stroke();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = COLORS.orange;
    roundRectPath(ctx, x, y, w, h, 10);
    ctx.fill();
    ctx.restore();
  }

  function drawBubble(rect, text) {
    const fontSize = 15;
    ctx.font = '500 ' + fontSize + 'px "Microsoft YaHei", "Segoe UI", sans-serif';
    const padX = 14, padY = 9;
    const bw = ctx.measureText(text).width + padX * 2;
    const bh = fontSize + padY * 2;

    let bx, by;
    if (rect) {
      bx = rect.x + rect.width / 2 - bw / 2;
      const above = rect.y - bh - 12;
      by = above > 8 ? above : rect.y + rect.height + 12;
    } else {
      bx = pos.x - bw / 2;
      by = pos.y - bh - 40;
    }
    bx = Math.max(8, Math.min(canvas.width - bw - 8, bx));
    by = Math.max(8, by);

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = COLORS.orange;
    ctx.lineWidth = 1.5;
    roundRectPath(ctx, bx, by, bw, bh, 10);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.stroke();

    ctx.fillStyle = COLORS.ink;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + padX, by + bh / 2 + 1);
    ctx.restore();
  }

  function drawSprite(p, scale, isBlink) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(scale, scale);
    if (state === 'idle' || thinking) {
      ctx.translate(0, Math.sin(hoverPhase * 2) * 3);
    }

    // 假箭头主体
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 19);
    ctx.lineTo(4.2, 15.2);
    ctx.lineTo(6.4, 24);
    ctx.lineTo(9.0, 22.8);
    ctx.lineTo(6.8, 14.2);
    ctx.lineTo(12.6, 13.0);
    ctx.closePath();
    ctx.fillStyle = COLORS.body;
    ctx.fill();
    ctx.strokeStyle = COLORS.stroke;
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    ctx.stroke();

    drawEye(4.0, 7.2, 2.6, isBlink);
    drawEye(7.4, 9.4, 2.3, isBlink);

    ctx.restore();
  }

  function drawEye(ex, ey, r, isBlink) {
    ctx.save();
    ctx.translate(ex, ey);
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 1.15, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    if (!isBlink) {
      ctx.beginPath();
      ctx.arc(r * 0.25, 0, r * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = '#1A1A1A';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(r * 0.25, -r * 0.25, r * 0.2, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
    } else {
      ctx.strokeStyle = '#1A1A1A';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-r, 0);
      ctx.lineTo(r, 0);
      ctx.stroke();
    }
    ctx.restore();
  }

  function loop(now) {
    update(now);
    draw();
    requestAnimationFrame(loop);
  }

  if (api) api.ready();
  requestAnimationFrame(loop);
})();
