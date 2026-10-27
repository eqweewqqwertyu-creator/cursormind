/**
 * 覆盖层渲染：跟随鼠标的液态玻璃智能球 + 语音胶囊（声波可视化）+ 教学指路层。
 *
 * 状态模型：
 *   mode: 'follow'  默认 —— 球弹簧惯性跟随鼠标右下角
 *         'hold'    语音态 —— 球停在原地 morph 成胶囊，听写 + 声波
 *         'guide'   教学态 —— 召唤后球飞到目标按钮圈住指路
 *   shape: 'ball' | 'capsule'
 *
 * 球是 DOM #orb（CSS 玻璃 + backdrop-filter 兜底 + SVG 折射），内部 #wave canvas 画声波；
 * 高亮圈 / 气泡 / 思考三点画在 #stage canvas 上。
 * 球中心位置由弹簧积分器逐帧写 transform（不参与 CSS transition）。
 */
(function () {
  // ---- 错误上报（渲染层无 Node，走 IPC 让主进程写日志） ----
  function report(tag, e) {
    try {
      if (window.cursormind && window.cursormind.reportError) {
        window.cursormind.reportError(tag + ': ' + String(e));
      }
    } catch (_) {}
  }
  window.addEventListener('error', function (ev) {
    report('[renderer error]', (ev.error && ev.error.stack) || ev.message);
  });
  window.addEventListener('unhandledrejection', function (ev) {
    report('[renderer reject]', ev.reason);
  });

  const stage = document.getElementById('stage');
  const orb = document.getElementById('orb');
  const wave = document.getElementById('wave');
  if (!stage || !orb || !wave) { report('init', 'missing #stage/#orb/#wave'); return; }
  const sctx = stage.getContext('2d');
  const wctx = wave.getContext('2d');

  // ---- 常量 ----
  const ORB_R = 22;                 // 球半径（直径 44px）
  const CAPSULE_W = 160, CAPSULE_H = 44; // 胶囊槽（随球变小）
  const FOLLOW_DX = 34, FOLLOW_DY = 34;  // 跟随偏移：鼠标右下角（再偏一些避让光标）
  const SPRING_K = 140;             // 弹簧刚度（跟手度）
  const SPRING_C = 18;              // 阻尼（惯性/回弹）
  const COLORS = { ink: '#1A1A1A', orange: '#F97316' };

  // ---- 弹簧物理 ----
  let px = -200, py = -200;   // 当前位置（球中心，DIP）
  let vx = 0, vy = 0;         // 速度
  let tx = 0, ty = 0;         // 目标
  let mouse = { x: -200, y: -200 };
  let lastT = 0;
  let hoverPhase = 0;

  // ---- 模式 / 形状 ----
  let mode = 'follow';        // follow | hold | guide
  let guideState = 'idle';    // guide 内部：idle | flying | pointing
  let shape = 'ball';

  // ---- 指路层状态 ----
  let targetRect = null;
  let bubbleText = '';
  let thinking = false, thinkText = '', thinkStart = 0;

  // ---- 语音状态 ----
  let listening = false;
  let audioCtx = null, analyser = null, micStream = null;
  let volSmooth = 0;

  const api = window.cursormind;

  // ================= 尺寸 =================
  function resize() {
    stage.width = window.innerWidth;
    stage.height = window.innerHeight;
    sizeWave();
  }
  function sizeWave() {
    const dpr = window.devicePixelRatio || 1;
    // 胶囊态 CSS 里 wave 只占 55% 高（下半留给文本），量实际渲染盒
    wave.width = Math.max(1, Math.round(wave.clientWidth * dpr));
    wave.height = Math.max(1, Math.round(wave.clientHeight * dpr));
  }
  resize();
  window.addEventListener('resize', resize);

  // ================= 指令 =================
  if (api) {
    api.onCommand(function (cmd) {
      if (!cmd) return;
      switch (cmd.type) {
        case 'flyIn': flyIn(cmd.fromEdge || 'left'); break;
        case 'flyTo': goTo(cmd.rect, cmd.bubble); break;
        case 'highlight': goTo(cmd.rect, cmd.bubble); break;
        case 'flyToPosition': goToPosition(cmd.position, cmd.bubble); break;
        case 'thinking': startThinking(cmd.text); break;
        case 'bubble': setBubble(cmd.text); break;
        case 'clear': clear(); break;
        case 'flyOut': flyOut(); break;
        case 'idle': setIdle(); break;
        case 'toggleVoice': toggleVoice(); break;
        case 'asrResult': onAsrResult(cmd.text); break;
        case 'envFrame': break; // 球迁 DOM 后折射已由 CSS 处理，环境帧弃用
      }
    });
    api.onCursor(function (p) {
      if (p && typeof p.x === 'number') mouse = { x: p.x, y: p.y };
    });
  }

  // ================= 形状切换 =================
  function setShape(s, w, h) {
    if (s === 'rect') {
      // 指路透镜态：贴合目标元素（中心全透 + 边缘白折射环）
      shape = 'rect';
      orb.classList.remove('capsule');
      orb.classList.add('rect');
      orb.style.width = w + 'px';
      orb.style.height = h + 'px';
      orb.style.borderRadius = '12px';
      orb.style.marginLeft = (-w / 2) + 'px';
      orb.style.marginTop = (-h / 2) + 'px';
      scheduleWave();
      return;
    }
    if (shape === s) return;
    shape = s;
    orb.classList.remove('rect');
    if (s === 'capsule') {
      orb.classList.add('capsule');
      orb.style.width = CAPSULE_W + 'px';
      orb.style.height = CAPSULE_H + 'px';
      orb.style.borderRadius = (CAPSULE_H / 2) + 'px';
      orb.style.marginLeft = (-CAPSULE_W / 2) + 'px';
      orb.style.marginTop = (-CAPSULE_H / 2) + 'px';
    } else {
      orb.classList.remove('capsule');
      orb.style.width = (ORB_R * 2) + 'px';
      orb.style.height = (ORB_R * 2) + 'px';
      orb.style.borderRadius = '50%';
      orb.style.marginLeft = (-ORB_R) + 'px';
      orb.style.marginTop = (-ORB_R) + 'px';
    }
    scheduleWave();
  }
  function scheduleWave() {
    // 尺寸变了 350ms 后重测声波画布（等 morph 完成）
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(sizeWave, 380);
    sizeWave();
  }
  let sizeTimer = 0;

  /** 指路/退场/待命前把球复原为圆形（除非正在语音态，语音态由 abortListening 处理） */
  function resetToBall() {
    if (shape !== 'ball') setShape('ball');
  }

  // ================= 教学指路指令 =================
  function flyIn(edge) {
    if (listening) abortListening(); // 语音态下进入指路：先退出语音态
    else resetToBall();
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    const starts = {
      left: { x: -40, y: cy },
      right: { x: window.innerWidth + 40, y: cy },
      top: { x: cx, y: -40 },
      bottom: { x: cx, y: window.innerHeight + 40 },
    };
    const s = starts[edge] || starts.left;
    px = s.x; py = s.y; vx = 0; vy = 0;
    tx = cx; ty = cy - 120;
    targetRect = null;
    bubbleText = '';
    mode = 'guide';
    guideState = 'flying';
  }

  function goTo(rect, bubble) {
    if (listening) abortListening();
    else resetToBall();
    tx = rect.x + rect.width / 2;
    ty = rect.y + rect.height / 2;
    targetRect = rect;
    bubbleText = bubble || '';
    stopThinking();
    mode = 'guide';
    guideState = 'flying';
  }

  function goToPosition(position, bubble) {
    if (listening) abortListening();
    else resetToBall();
    tx = position.x; ty = position.y;
    targetRect = null;
    bubbleText = bubble || '';
    stopThinking();
    mode = 'guide';
    guideState = 'flying';
  }

  function startThinking(text) {
    thinking = true;
    thinkText = text || '';
    thinkStart = performance.now();
    if (mode === 'follow') {
      // 异常时序：未召唤先思考，飞入中心待命
      flyIn('left');
    }
  }
  function stopThinking() { thinking = false; thinkText = ''; }
  function setBubble(text) { bubbleText = text || ''; stopThinking(); }
  function clear() { targetRect = null; bubbleText = ''; }

  function flyOut() {
    if (listening) abortListening();
    else resetToBall();
    tx = px < window.innerWidth / 2 ? -80 : window.innerWidth + 80;
    ty = py;
    targetRect = null;
    bubbleText = '';
    stopThinking();
    mode = 'guide';
    guideState = 'flying';
  }

  function setIdle() {
    if (listening) abortListening();
    else resetToBall();
    mode = 'guide';
    guideState = 'idle';
    targetRect = null;
    bubbleText = '';
  }

  // ================= 语音胶囊态（MediaRecorder 录音 → 主进程百炼 ASR） =================
  const sttEl = document.getElementById('stt');
  let mediaRec = null;      // MediaRecorder 实例
  let audioChunks = [];     // 录音分片

  function toggleVoice() {
    if (listening) finishListening();
    else startListening();
  }

  async function startListening() {
    listening = true;
    setShape('capsule');
    if (mode === 'follow') mode = 'hold'; // 停在原地，说话时球不跟鼠标跑
    if (sttEl) sttEl.textContent = '在听…说完再按一次提交';
    await initMic();
    startRecording();
  }

  /** 松开提交：停录音 → 拼块 → base64 → 主进程识别 → asrResult 回来后提交 Agent */
  function finishListening() {
    if (!listening) return;
    listening = false;
    if (mediaRec && mediaRec.state === 'recording') {
      mediaRec.onstop = function () {
        const blob = new Blob(audioChunks, { type: mediaRec.mimeType || 'audio/webm' });
        blobToWavDataUrl(blob, function (dataUrl) {
          if (api && api.sendAsrAudio) {
            if (sttEl) sttEl.textContent = '识别中…';
            api.sendAsrAudio(dataUrl);
          }
          releaseMic();
        });
      };
      try { mediaRec.stop(); } catch (_) { releaseMic(); }
    } else {
      releaseMic();
    }
  }

  /** 中止语音态（不提交）：进入指路/退场时调用 */
  function abortListening() {
    listening = false;
    if (mediaRec && mediaRec.state === 'recording') {
      mediaRec.onstop = null;
      try { mediaRec.stop(); } catch (_) {}
    }
    releaseMic();
    if (sttEl) sttEl.textContent = '';
    setShape('ball');
    if (mode === 'hold') mode = 'follow';
  }

  function startRecording() {
    if (!micStream) return;
    audioChunks = [];
    try {
      mediaRec = new MediaRecorder(micStream);
      mediaRec.ondataavailable = function (e) {
        if (e.data && e.data.size > 0) audioChunks.push(e.data);
      };
      mediaRec.start(250); // 250ms 分片，降低峰值内存
    } catch (e) {
      report('voice', 'MediaRecorder 失败: ' + e);
    }
  }

  function blobToDataUrl(blob, cb) {
    const fr = new FileReader();
    fr.onload = function () { cb(String(fr.result)); };
    fr.onerror = function () { cb(''); };
    fr.readAsDataURL(blob);
  }

  /** webm/opus → 16k 单声道 wav：MediaRecorder 只能录 webm，但百炼接口声明 format:'wav'，渲染层转码对齐 */
  function blobToWavDataUrl(blob, cb) {
    if (!audioCtx) { blobToDataUrl(blob, cb); return; }
    blob.arrayBuffer().then(function (ab) {
      audioCtx.decodeAudioData(ab).then(function (src) {
        const target = 16000;
        const len = Math.max(1, Math.ceil(src.duration * target));
        const mix = new Float32Array(len);
        const ratio = src.sampleRate / target;
        for (let c = 0; c < src.numberOfChannels; c++) {
          const data = src.getChannelData(c);
          for (let i = 0; i < len; i++) {
            mix[i] += data[Math.min(data.length - 1, Math.floor(i * ratio))] / src.numberOfChannels;
          }
        }
        const buf = new ArrayBuffer(44 + len * 2);
        const v = new DataView(buf);
        const ws = function (off, s) { for (let j = 0; j < s.length; j++) v.setUint8(off + j, s.charCodeAt(j)); };
        ws(0, 'RIFF'); v.setUint32(4, 36 + len * 2, true); ws(8, 'WAVE');
        ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, target, true); v.setUint32(28, target * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
        ws(36, 'data'); v.setUint32(40, len * 2, true);
        for (let k = 0; k < len; k++) {
          const s = Math.max(-1, Math.min(1, mix[k]));
          v.setInt16(44 + k * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        }
        blobToDataUrl(new Blob([buf], { type: 'audio/wav' }), cb);
      }).catch(function () { blobToDataUrl(blob, cb); }); // 解不了时原样发，不阻塞链路
    }).catch(function () { cb(''); });
  }

  /** 百炼 ASR 识别结果：胶囊显示后提交 Agent 链路，随后回球 */
  function onAsrResult(text) {
    const t = String(text || '').trim();
    if (sttEl) sttEl.textContent = t ? '提问：' + t : '没听到，再试一次';
    if (t && api && api.submitVoice) api.submitVoice(t);
    setTimeout(function () {
      setShape('ball');
      if (mode === 'hold') mode = 'follow';
      if (sttEl) sttEl.textContent = '';
    }, 900);
  }

  // ================= 麦克风 / 声波 =================
  async function initMic() {
    if (audioCtx) { if (audioCtx.state === 'suspended') audioCtx.resume(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStream = stream;
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.7;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      // 不 connect(destination)：不播放监听，避免回授
    } catch (e) {
      report('mic', e && e.name ? e.name : e);
    }
  }

  function releaseMic() {
    if (micStream) {
      micStream.getTracks().forEach(function (t) { t.stop(); });
      micStream = null;
    }
    if (audioCtx) {
      audioCtx.close().catch(function () {});
      audioCtx = null; analyser = null;
    }
  }

  /** 当前音量 0~1（时域 RMS，低通平滑） */
  function readVolume() {
    if (!analyser) return 0;
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / buf.length) * 4);
  }

  /** 声波可视化：4 条正弦波，振幅随音量变化（静音平缓、说话活跃） */
  function drawWave(now) {
    if (wave.width === 0 || wave.height === 0) return;
    wctx.clearRect(0, 0, wave.width, wave.height);
    if (!listening) return;
    const dpr = window.devicePixelRatio || 1;
    const W = wave.width, H = wave.height;
    const targetVol = readVolume();
    volSmooth += (targetVol - volSmooth) * 0.25; // 低通，防跳

    const N = 4;
    const amp = (2.0 + volSmooth * 15.0) * dpr; // 振幅：安静 ~2px，说话 ~17px
    for (let k = 0; k < N; k++) {
      const freq = 0.55 + k * 0.4;              // 各条频率错开
      const phase = now * 0.004 * (1 + k * 0.25) + k * 1.9;
      const yMid = H / 2;
      const yAmp = amp * (0.55 + 0.45 * Math.sin(now * 0.0015 + k * 2.1));
      wctx.beginPath();
      for (let x = 0; x <= W; x += 2) {
        const t = x / W;
        const y = yMid + Math.sin(t * Math.PI * 2 * freq + phase) * yAmp;
        if (x === 0) wctx.moveTo(x, y); else wctx.lineTo(x, y);
      }
      wctx.strokeStyle = 'rgba(90,105,130,' + (0.32 + 0.38 * (1 - k / N)).toFixed(3) + ')';
      wctx.lineWidth = 1.3 * dpr;
      wctx.lineCap = 'round';
      wctx.stroke();
    }
  }

  // ================= 主循环 =================
  function update(now) {
    const dt = Math.min(0.05, (now - lastT) / 1000 || 0.016);
    lastT = now;
    hoverPhase += dt * 2.2;

    // 目标：follow 跟鼠标右下角；hold/guide 由指令设置
    if (mode === 'follow') {
      tx = mouse.x + FOLLOW_DX;
      ty = mouse.y + FOLLOW_DY;
    }

    // 弹簧-阻尼：v += (target - pos)*K - v*C
    vx += ((tx - px) * SPRING_K - vx * SPRING_C) * dt;
    vy += ((ty - py) * SPRING_K - vy * SPRING_C) * dt;
    px += vx * dt;
    py += vy * dt;

    // guide 到达判定：距离近且动能小 → flying 转 pointing；flyingOut 回 follow
    if (mode === 'guide' && guideState === 'flying') {
      const dx = tx - px, dy = ty - py;
      const d2 = dx * dx + dy * dy;
      const sp2 = vx * vx + vy * vy;
      if (d2 < 9 && sp2 < 2500) {
        px = tx; py = ty; vx = 0; vy = 0;
        const outOfScreen = px < -40 || px > window.innerWidth + 40;
        if (outOfScreen) {
          mode = 'follow'; // 退场完成，回跟随
        } else {
          guideState = 'pointing';
          // 视情况变形状：有矩形目标 → 球 morph 成贴合目标的液态玻璃圆角矩形；
          // 无矩形（纯定位大区域）→ 保持圆形
          if (targetRect) {
            const pad = 6;
            setShape('rect', targetRect.width + pad * 2, targetRect.height + pad * 2);
          } else {
            setShape('ball');
          }
        }
      }
    }

    // 写球位置（弹簧逐帧，不参与 CSS transition）
    orb.style.transform = 'translate3d(' + px.toFixed(1) + 'px,' + py.toFixed(1) + 'px,0)';
  }

  function draw() {
    sctx.clearRect(0, 0, stage.width, stage.height);
    if (mode === 'guide' && guideState === 'pointing' && targetRect) {
      drawHighlight(targetRect);
    }
    if (bubbleText && mode === 'guide' && (guideState === 'pointing' || guideState === 'idle')) {
      drawBubble(targetRect, bubbleText);
    }
    if (thinking && mode !== 'follow') {
      drawThinkBubble();
    }
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
    const pulse = 0.5 + 0.5 * Math.sin(hoverPhase * 3);
    sctx.save();
    sctx.lineWidth = 3;
    sctx.strokeStyle = '#FFFFFF';
    sctx.globalAlpha = 0.8 + 0.2 * pulse;
    sctx.shadowColor = 'rgba(255,255,255,0.9)';
    sctx.shadowBlur = 8;
    roundRectPath(sctx, rect.x - pad, rect.y - pad, rect.width + pad * 2, rect.height + pad * 2, 12);
    sctx.stroke();
    sctx.restore();
  }

  function drawBubble(rect, text) {
    const fontSize = 15;
    sctx.font = '500 ' + fontSize + 'px "Microsoft YaHei", "Segoe UI", sans-serif';
    const padX = 14, padY = 9;
    const bw = sctx.measureText(text).width + padX * 2;
    const bh = fontSize + padY * 2;
    let bx, by;
    if (rect) {
      bx = rect.x + rect.width / 2 - bw / 2;
      const above = rect.y - bh - 12;
      by = above > 8 ? above : rect.y + rect.height + 12;
    } else {
      bx = px - bw / 2;
      by = py - bh - 40;
    }
    bx = Math.max(8, Math.min(stage.width - bw - 8, bx));
    by = Math.max(8, by);
    sctx.save();
    sctx.shadowColor = 'rgba(0,0,0,0.18)';
    sctx.shadowBlur = 10;
    sctx.shadowOffsetY = 2;
    sctx.fillStyle = '#FFFFFF';
    sctx.strokeStyle = COLORS.orange;
    sctx.lineWidth = 1.5;
    roundRectPath(sctx, bx, by, bw, bh, 10);
    sctx.fill();
    sctx.shadowColor = 'transparent';
    sctx.stroke();
    sctx.fillStyle = COLORS.ink;
    sctx.textBaseline = 'middle';
    sctx.fillText(text, bx + padX, by + bh / 2 + 1);
    sctx.restore();
  }

  function drawThinkBubble() {
    const now = performance.now();
    const t = (now - thinkStart) / 1000;
    const dotR = 3.2;
    const dotSpan = dotR * 2 * 3 + 12;
    const textPad = thinkText ? 10 : 0;
    sctx.font = '400 12px "Microsoft YaHei", "Segoe UI", sans-serif';
    const textW = thinkText ? sctx.measureText(thinkText).width : 0;
    const bw = 24 + dotSpan + textPad + textW;
    const bh = 30;
    let bx = px - bw / 2;
    let by = py - 44 - bh;
    bx = Math.max(8, Math.min(stage.width - bw - 8, bx));
    by = Math.max(8, by);
    sctx.save();
    sctx.shadowColor = 'rgba(0,0,0,0.18)';
    sctx.shadowBlur = 10;
    sctx.shadowOffsetY = 2;
    sctx.fillStyle = '#FFFFFF';
    sctx.strokeStyle = COLORS.orange;
    sctx.lineWidth = 1.5;
    roundRectPath(sctx, bx, by, bw, bh, 15);
    sctx.fill();
    sctx.shadowColor = 'transparent';
    sctx.stroke();
    const cy = by + bh / 2;
    const startX = bx + 12 + dotR;
    for (let i = 0; i < 3; i++) {
      const phase = t * 2.4 - i * 0.55;
      const k = Math.max(0, Math.sin(phase * Math.PI));
      sctx.beginPath();
      sctx.arc(startX + i * (dotR * 2 + 6), cy, dotR * (0.7 + 0.45 * k), 0, Math.PI * 2);
      sctx.fillStyle = COLORS.orange;
      sctx.globalAlpha = 0.25 + 0.75 * k;
      sctx.fill();
    }
    sctx.globalAlpha = 1;
    if (thinkText) {
      sctx.fillStyle = '#8C8C8C';
      sctx.textBaseline = 'middle';
      sctx.fillText(thinkText, bx + 12 + dotSpan + textPad, cy + 1);
    }
    sctx.restore();
  }

  function loop(now) {
    update(now);
    draw();
    drawWave(now);
    requestAnimationFrame(loop);
  }

  if (api) api.ready();
  requestAnimationFrame(loop);
})();
