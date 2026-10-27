(function () {
  const dock = document.getElementById('dock');
  const btnSearch = document.getElementById('btnSearch');
  const btnSettings = document.getElementById('btnSettings');
  const searchPanel = document.getElementById('searchPanel');
  const settingsPanel = document.getElementById('settingsPanel');
  const q = document.getElementById('q');
  const reply = document.getElementById('reply');
  const reset = document.getElementById('reset');
  const api = window.cursormind;
  if (!api) return;

  // ================= MorphEngine：高阻尼弹簧（fluid morph） =================
  // 过阻尼弹簧积分器：快速起步 → 长尾缓慢沉降，无回弹振荡（高阻尼特征）。
  // 同一进度 t 驱动 width/height/radius/x 四个属性，幂次微差产生"流体错位感"。
  const PANEL_W = 540; // 展开宽度
  const PANEL_R = 18;  // 展开圆角

  function createMorph(el) {
    let raf = 0;
    let cur = null; // { w, h, r, x } 当前几何
    let t = 1, v = 0;
    let last = 0;
    let startAt = 0;
    // 过阻尼参数：k=210 c=30（ζ≈1.4~1.7），快起慢贴无振荡
    const K = 210, C = 30;
    let onDone = null;
    let from = null, to = null;

    function apply() {
      el.style.width = cur.w.toFixed(1) + 'px';
      el.style.height = cur.h.toFixed(1) + 'px';
      el.style.borderRadius = cur.r.toFixed(1) + 'px';
      // x = 面板中心相对舞台中心的偏移
      el.style.transform = 'translateX(calc(-50% + ' + cur.x.toFixed(1) + 'px))';
    }

    function lerp(a, b, k) { return a + (b - a) * k; }

    function settleNow() {
      t = 1; v = 0;
      cur = { ...to };
      apply();
      raf = 0;
      if (onDone) { const cb = onDone; onDone = null; cb(); }
    }

    function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
      last = now;
      const F = K * (1 - t) - C * v;
      v += F * dt;
      t += v * dt;
      if (t > 1) { t = 1; v = 0; }
      // 尺寸先动、圆角慢半拍 → 流体层次
      const kSize = Math.pow(Math.max(0, t), 0.9);
      const kRadius = Math.pow(Math.max(0, t), 1.35);
      const kX = Math.pow(Math.max(0, t), 1.1);
      cur.w = lerp(from.w, to.w, kSize);
      cur.h = lerp(from.h, to.h, kSize * 0.98);
      cur.r = lerp(from.r, to.r, kRadius);
      cur.x = lerp(from.x, to.x, kX);
      apply();
      const settled = (1 - t) < 0.001 && Math.abs(v) < 0.02;
      const timedOut = now - startAt > 900; // 兜底：超时强制落定（防回调悬挂）
      if (settled || timedOut) {
        settleNow();
        return;
      }
      raf = requestAnimationFrame(frame);
    }

    return {
      go(fromGeo, toGeo, done) {
        from = { ...fromGeo };
        to = { ...toGeo };
        cur = { ...fromGeo };
        t = 0; v = 1.6; // 初速冲量：一点"弹出"的启动感
        last = performance.now();
        startAt = performance.now();
        onDone = done || null;
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(frame);
      },
      stop() {
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        onDone = null;
      },
      get current() { return cur; },
    };
  }

  // ================= 状态机：dock / search / settings =================
  let mode = 'dock';
  const searchMorph = createMorph(searchPanel);
  const settingsMorph = createMorph(settingsPanel);
  const stage = document.getElementById('stage');

  /** 圆钮中心相对舞台中心的 x 偏移（morph 起点） */
  function orbOffsetX(orb) {
    const sr = stage.getBoundingClientRect();
    const r = orb.getBoundingClientRect();
    return (r.left + r.width / 2) - (sr.left + sr.width / 2);
  }

  function collapsedGeo(orb) {
    return { w: 56, h: 56, r: 28, x: orbOffsetX(orb) };
  }

  /** 量出面板目标高度（内容自适应，隐形测量） */
  function measurePanelH(panel) {
    const prev = panel.style.cssText;
    panel.style.visibility = 'hidden';
    panel.style.width = PANEL_W + 'px';
    panel.style.height = 'auto';
    panel.style.borderRadius = PANEL_R + 'px';
    panel.style.transform = 'translateX(-50%)';
    const h = panel.scrollHeight;
    panel.style.cssText = prev;
    return Math.max(h, 92);
  }

  function showDock() { dock.classList.remove('hidden'); }
  function hideDock() { dock.classList.add('hidden'); }

  function openSearch(autoFocus) {
    if (mode === 'search') return;
    closeOther('search');
    mode = 'search';
    hideDock();
    searchPanel.classList.add('visible');
    searchPanel.classList.remove('landed');
    const from = collapsedGeo(btnSearch);
    const to = { w: PANEL_W, h: measurePanelH(searchPanel), r: PANEL_R, x: 0 };
    searchMorph.go(from, to, () => {
      searchPanel.classList.add('landed');
      if (autoFocus !== false) q.focus();
    });
  }

  function openSettings() {
    if (mode === 'settings') return;
    closeOther('settings');
    mode = 'settings';
    hideDock();
    settingsPanel.classList.add('visible');
    settingsPanel.classList.remove('landed');
    const from = collapsedGeo(btnSettings);
    const to = { w: 360, h: measurePanelH(settingsPanel), r: PANEL_R, x: 0 };
    settingsMorph.go(from, to, () => {
      settingsPanel.classList.add('landed');
    });
  }

  function closePanel() {
    const panel = mode === 'search' ? searchPanel : mode === 'settings' ? settingsPanel : null;
    if (!panel) return;
    const morph = mode === 'search' ? searchMorph : settingsMorph;
    const orb = mode === 'search' ? btnSearch : btnSettings;
    const cur = morph.current || collapsedGeo(orb);
    panel.classList.remove('landed');
    morph.go({ w: cur.w, h: cur.h, r: cur.r, x: cur.x }, collapsedGeo(orb), () => {
      panel.classList.remove('visible');
      showDock();
      q.blur();
    });
    mode = 'dock';
  }

  function closeOther(next) {
    if (next === 'search') {
      settingsMorph.stop();
      settingsPanel.classList.remove('visible', 'landed');
    } else {
      searchMorph.stop();
      searchPanel.classList.remove('visible', 'landed');
    }
  }

  // ================= 交互绑定 =================
  btnSearch.addEventListener('click', () => openSearch());
  btnSettings.addEventListener('click', () => openSettings());
  // 面板空白处双击收起
  searchPanel.addEventListener('dblclick', (e) => { if (e.target === searchPanel) closePanel(); });
  settingsPanel.addEventListener('dblclick', (e) => { if (e.target === settingsPanel) closePanel(); });

  function doReset() {
    if (api.resetConversation) api.resetConversation();
    reply.classList.remove('show');
    reply.textContent = '';
    q.value = '';
    q.focus();
  }
  if (reset) reset.addEventListener('click', doReset);
  const btnResetConv = document.getElementById('btnResetConv');
  if (btnResetConv) btnResetConv.addEventListener('click', doReset);
  const btnTestFly = document.getElementById('btnTestFly');
  if (btnTestFly && api.testFly) btnTestFly.addEventListener('click', () => api.testFly());

  // ================= 语音：听写（Web Speech API）+ 播报（主进程 TTS） =================
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btnMic = document.getElementById('btnMic');
  const micInline = document.getElementById('micInline');
  let rec = null;
  let recActive = false;
  let finalTranscript = '';

  function supported() { return !!SR; }

  /** 开始听写：持续模式（可多次暂停续录），Esc/再按停止并提交 */
  function startListen(target) {
    if (!supported()) { q.placeholder = '此浏览器不支持语音识别'; return; }
    if (recActive) { stopListen(target); return; }
    rec = new SR();
    rec.lang = 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;
    finalTranscript = '';
    recActive = true;
    (target === 'inline' ? micInline : btnMic).classList.add('rec');
    q.classList.add('listening');
    q.placeholder = '在听…说完按麦克风提交';

    rec.onresult = function (e) {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalTranscript += r[0].transcript;
        else interim += r[0].transcript;
      }
      q.value = (finalTranscript + interim).trim();
    };
    rec.onerror = function (e) {
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        q.placeholder = '语音识别出错：' + e.error;
      }
      cleanup(target);
    };
    rec.onend = function () {
      // continuous 模式自动断开（静音超时）→ 若仍在录音态就重启续录
      if (recActive && supported()) {
        try { rec.start(); } catch (err) { cleanup(target); }
      }
    };
    try { rec.start(); } catch (err) { cleanup(target); }
  }

  function stopListen(target) {
    if (!recActive) return;
    recActive = false;
    const text = q.value.trim();
    if (rec) { try { rec.stop(); } catch (err) {} }
    cleanup(target);
    if (text) {
      api.submitQuestion(text);
      q.value = '';
      reply.classList.remove('show');
      reply.textContent = '';
    }
  }

  function cleanup(target) {
    (target === 'inline' ? micInline : btnMic).classList.remove('rec');
    q.classList.remove('listening');
    q.placeholder = '问一句，比如「微信设置在哪」';
  }

  // dock 麦克风圆钮：点击开始/停止听写
  if (btnMic) {
    btnMic.addEventListener('click', () => {
      if (mode !== 'search') openSearch(false);
      startListen('dock');
    });
  }
  // 搜索行内麦克风：点击开始/停止
  if (micInline) {
    micInline.addEventListener('click', () => startListen('inline'));
  }

  // 语音播报开关（设置面板）→ 主进程 TTS 开关
  const chkVoice = document.getElementById('chkVoice');
  if (chkVoice && api.setVoice) {
    chkVoice.addEventListener('change', () => api.setVoice(chkVoice.checked));
  }

  // 接收主进程 TTS 音频并播放（队列：上一条播完再播下一条）
  let audioQueue = [];
  let audioPlaying = false;
  const audioEl = new Audio();
  audioEl.addEventListener('ended', playNext);
  function playNext() {
    if (audioQueue.length === 0) { audioPlaying = false; return; }
    audioPlaying = true;
    audioEl.src = audioQueue.shift();
    audioEl.play().catch(() => { audioPlaying = false; });
  }
  if (api.onPanelAudio) {
    api.onPanelAudio(function (src) {
      if (!src) return;
      audioQueue.push(src);
      if (audioQueue.length > 3) audioQueue = audioQueue.slice(-3); // 只留最近 3 条
      if (!audioPlaying) playNext();
    });
  }

  q.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      const text = q.value.trim();
      if (text) {
        api.submitQuestion(text);
        q.value = '';
        reply.classList.remove('show');
        reply.textContent = '';
      }
      e.preventDefault();
    } else if (e.key === 'Escape') {
      if (recActive) {
        recActive = false; // Esc 只停录音不提交
        if (rec) { try { rec.stop(); } catch (err) {} }
        cleanup('inline');
        cleanup('dock');
      } else if (mode === 'search' || mode === 'settings') {
        closePanel(); // 面板态：先收回 dock
      } else {
        api.dismiss(); // dock 态：退场
      }
      e.preventDefault();
    } else if (e.key.toLowerCase() === 'r' && (e.ctrlKey || e.metaKey)) {
      doReset();
      e.preventDefault();
    }
  });

  // ================= 与主进程的消息 =================
  api.onPanelOpen(function () {
    searchMorph.stop(); settingsMorph.stop();
    searchPanel.classList.remove('visible', 'landed');
    settingsPanel.classList.remove('visible', 'landed');
    reply.classList.remove('show');
    reply.textContent = '';
    q.value = '';
    mode = 'dock';
    showDock();
  });

  // 长按 ~ 直达打字：重置一切后直接展开搜索面板并聚焦输入框
  if (api.onPanelSearch) {
    api.onPanelSearch(function () {
      searchMorph.stop(); settingsMorph.stop();
      settingsPanel.classList.remove('visible', 'landed');
      searchPanel.classList.remove('visible', 'landed');
      reply.classList.remove('show');
      reply.textContent = '';
      q.value = '';
      mode = 'dock';
      showDock();
      openSearch(true);
    });
  }

  api.onPanelReply(function (text) {
    const t = String(text || '');
    if (!t) return;
    reply.textContent = t;
    reply.classList.add('show');
    reply.scrollTop = 0;
    if (mode !== 'search') {
      openSearch(); // 从 dock morph 展开，显示回复
    } else {
      const cur = searchMorph.current || { w: PANEL_W, h: 92, r: PANEL_R, x: 0 };
      searchMorph.go(
        { w: cur.w, h: cur.h, r: cur.r, x: cur.x },
        { w: PANEL_W, h: measurePanelH(searchPanel), r: PANEL_R, x: 0 }
      );
    }
  });

  if (api.onPanelCollapse) {
    api.onPanelCollapse(function () {
      if (mode === 'search' || mode === 'settings') closePanel();
    });
  }

  if (api.onPanelMeta) {
    api.onPanelMeta(function (meta) {
      try {
        const m = typeof meta === 'string' ? JSON.parse(meta) : meta;
        const brain = document.getElementById('metaBrain');
        const eye = document.getElementById('metaEye');
        if (brain) brain.innerHTML = m.brain
          ? '<span class="pill ok">deepseek-flash ✓</span>'
          : '<span class="pill no">未配置 Key</span>';
        if (eye) eye.innerHTML = m.eye
          ? '<span class="pill ok">qwen3-vl-plus ✓</span>'
          : '<span class="pill no">未配置 Key</span>';
      } catch (e) { /* 忽略 */ }
    });
  }

  // ================= 文字优化卡片 =================
  const textcard = document.getElementById('textcard');
  const tcTitle = document.getElementById('tcTitle');
  const tcOrig = document.getElementById('tcOrig');
  const tcNew = document.getElementById('tcNew');
  const tcReplace = document.getElementById('tcReplace');
  const tcCancel = document.getElementById('tcCancel');
  let cardMode = false; // 卡片可见时 mode 视为扩展态（穿透判定用）

  if (textcard && api.onTextCard) {
    api.onTextCard(function (data) {
      try {
        const d = typeof data === 'string' ? JSON.parse(data) : data;
        tcTitle.textContent = d.title || '优化结果';
        if (d.original) {
          tcOrig.style.display = 'block';
          tcOrig.textContent = d.original;
        } else {
          tcOrig.style.display = 'none';
        }
        tcNew.textContent = d.optimized || '';
        tcReplace.style.display = d.hasAction ? '' : 'none';
        textcard.classList.add('show');
        cardMode = true;
      } catch (e) { /* 忽略坏数据 */ }
    });
    if (api.onTextCardHide) {
      api.onTextCardHide(function () {
        textcard.classList.remove('show');
        cardMode = false;
      });
    }
    if (tcReplace) tcReplace.addEventListener('click', () => api.textCardReplace());
    if (tcCancel) tcCancel.addEventListener('click', () => api.textCardCancel());
  }

  // 划选自动替换开关（设置面板）
  const chkAutoReplace = document.getElementById('chkAutoReplace');
  if (chkAutoReplace && api.setAutoReplace) {
    chkAutoReplace.addEventListener('change', () => api.setAutoReplace(chkAutoReplace.checked));
  }

  // ================= 透明区域点击穿透 =================
  // 窗口是大透明区：dock 态只 .hit（圆钮）不穿透；面板态只面板可见区域（.panel/.hit）不穿透；
  // 其余透明区穿透给下层应用。鼠标离开窗口无条件恢复穿透。
  let ignoring = true;
  function setIgnoring(v) {
    if (v === ignoring) return;
    ignoring = v;
    if (api.setIgnore) api.setIgnore(v);
  }
  document.addEventListener('mousemove', (e) => {
    const t = e.target;
    let hit = false;
    if (t && t.closest) {
      hit = mode === 'dock' && !cardMode
        ? !!t.closest('.hit')
        : (!!t.closest('.hit') || !!t.closest('.panel') || (cardMode && !!t.closest('#textcard')));
    }
    setIgnoring(!hit);
  }, { passive: true });
  document.addEventListener('mouseleave', () => {
    setIgnoring(true);
  });
  setIgnoring(true);
})();
