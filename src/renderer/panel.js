(function () {
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

  // ================= 状态机：hidden / search / settings =================
  // dock 栏已删除：面板从底部中央小圆点 morph 展开，收回后窗口隐藏（「不用时窗口不存在」）
  let mode = 'hidden';
  const searchMorph = createMorph(searchPanel);
  const settingsMorph = createMorph(settingsPanel);

  /** morph 起点几何：底部中央 56px 小圆点（dock 删除前的圆钮位置） */
  const DOCK_GEO = { w: 56, h: 56, r: 28, x: 0 };

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

  function openSearch(autoFocus) {
    if (mode === 'search') return;
    closeOther('search');
    mode = 'search';
    searchPanel.classList.add('visible');
    searchPanel.classList.remove('landed');
    const from = DOCK_GEO;
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
    settingsPanel.classList.add('visible');
    settingsPanel.classList.remove('landed');
    const from = DOCK_GEO;
    const to = { w: 360, h: measurePanelH(settingsPanel), r: PANEL_R, x: 0 };
    settingsMorph.go(from, to, () => {
      settingsPanel.classList.add('landed');
    });
  }

  function closePanel() {
    const panel = mode === 'search' ? searchPanel : mode === 'settings' ? settingsPanel : null;
    if (!panel) return;
    const morph = mode === 'search' ? searchMorph : settingsMorph;
    const cur = morph.current || DOCK_GEO;
    panel.classList.remove('landed');
    morph.go({ w: cur.w, h: cur.h, r: cur.r, x: cur.x }, DOCK_GEO, () => {
      panel.classList.remove('visible');
      // 收回后窗口直接隐藏（dock 已删，没有常驻形态）
      if (api.requestHide) api.requestHide();
      q.blur();
    });
    mode = 'hidden';
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
  // 设置面板右上角关闭钮（dock 删除后的独立关闭途径）
  const btnCloseSettings = document.getElementById('btnCloseSettings');
  if (btnCloseSettings) btnCloseSettings.addEventListener('click', () => closePanel());
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

  // ================= 语音：听写（搜索行内麦克风）+ 播报（主进程 TTS） =================
  // dock 麦克风已随 dock 删除；此处的 Web Speech 听写仅剩行内入口（国内网络不可用，实际语音走 ~ 键胶囊链路）
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micInline = document.getElementById('micInline');
  let rec = null;
  let recActive = false;
  let finalTranscript = '';

  function supported() { return !!SR; }

  /** 开始听写：持续模式（可多次暂停续录），Esc/再按停止并提交 */
  function startListen() {
    if (!supported()) { q.placeholder = '此浏览器不支持语音识别'; return; }
    if (recActive) { stopListen(); return; }
    rec = new SR();
    rec.lang = 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;
    finalTranscript = '';
    recActive = true;
    micInline.classList.add('rec');
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
      cleanup();
    };
    rec.onend = function () {
      // continuous 模式自动断开（静音超时）→ 若仍在录音态就重启续录
      if (recActive && supported()) {
        try { rec.start(); } catch (err) { cleanup(); }
      }
    };
    try { rec.start(); } catch (err) { cleanup(); }
  }

  function stopListen() {
    if (!recActive) return;
    recActive = false;
    const text = q.value.trim();
    if (rec) { try { rec.stop(); } catch (err) {} }
    cleanup();
    if (text) {
      api.submitQuestion(text);
      q.value = '';
      reply.classList.remove('show');
      reply.textContent = '';
    }
  }

  function cleanup() {
    micInline.classList.remove('rec');
    q.classList.remove('listening');
    q.placeholder = '问一句，比如「微信设置在哪」';
  }

  // 搜索行内麦克风：点击开始/停止
  if (micInline) {
    micInline.addEventListener('click', () => startListen());
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
        cleanup();
      } else if (mode === 'search' || mode === 'settings') {
        closePanel(); // 面板态：收回并隐藏窗口
      } else {
        api.dismiss(); // 空态：退场
      }
      e.preventDefault();
    } else if (e.key.toLowerCase() === 'r' && (e.ctrlKey || e.metaKey)) {
      doReset();
      e.preventDefault();
    }
  });

  // ================= 与主进程的消息 =================
  // 召唤（Ctrl+Alt+E / 托盘左键）：dock 已删，直接展开搜索面板
  api.onPanelOpen(function () {
    searchMorph.stop(); settingsMorph.stop();
    searchPanel.classList.remove('visible', 'landed');
    settingsPanel.classList.remove('visible', 'landed');
    reply.classList.remove('show');
    reply.textContent = '';
    q.value = '';
    mode = 'hidden';
    openSearch(true);
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
      mode = 'hidden';
      openSearch(true);
    });
  }

  // 托盘右键菜单「设置」：展开设置面板
  if (api.onPanelSettings) {
    api.onPanelSettings(function () {
      searchMorph.stop(); settingsMorph.stop();
      searchPanel.classList.remove('visible', 'landed');
      settingsPanel.classList.remove('visible', 'landed');
      mode = 'hidden';
      openSettings();
    });
  }

  api.onPanelReply(function (text) {
    const t = String(text || '');
    if (!t) return;
    reply.textContent = t;
    reply.classList.add('show');
    reply.scrollTop = 0;
    if (mode !== 'search') {
      openSearch(false); // 隐藏态被回复拉回：morph 展开，不抢输入焦点
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
        // 开关真实状态同步（主进程为源，面板只反映；修复：重开后显示旧默认值）
        if (chkVoice && typeof m.voice === 'boolean') chkVoice.checked = m.voice;
        if (chkAutoReplace && typeof m.autoReplace === 'boolean') chkAutoReplace.checked = m.autoReplace;
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
      // dock 已删：面板态（search/settings）与卡片态命中 .panel/.hit/#textcard 不穿透，
      // 其余（含隐藏态残余鼠标事件）全穿透给下层应用
      hit = !!t.closest('.hit') || !!t.closest('.panel') || (cardMode && !!t.closest('#textcard'));
    }
    setIgnoring(!hit);
  }, { passive: true });
  document.addEventListener('mouseleave', () => {
    setIgnoring(true);
  });
  setIgnoring(true);
})();
