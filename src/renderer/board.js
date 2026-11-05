/**
 * 灵标看板渲染层：便签贴条 UI + 添加/完成/删除 + 拖拽（吸附/上滑由主进程判定）。
 */
(function () {
  const api = window.cursormind;
  if (!api) return;

  const list = document.getElementById('list');
  const inText = document.getElementById('inText');
  const inTime = document.getElementById('inTime');
  const addBtn = document.getElementById('addBtn');
  const hdr = document.getElementById('hdr');
  const btnCollapse = document.getElementById('btnCollapse');
  const btnHide = document.getElementById('btnHide');
  const dockbar = document.getElementById('dockbar');

  let tasks = [];
  let dragging = false;
  let dragOffset = null; // 拖动起点鼠标相对窗口的固定偏移

  const COLORS = ['c0', 'c1', 'c2', 'c3', 'c4'];

  // ================= 渲染 =================
  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return d.getMonth() + 1 + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function toLocalInput(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function render() {
    // 未完成优先，未完成按提醒时间升序；完成排后
    const pending = tasks.filter((t) => !t.done).sort((a, b) => (a.remindAt || Infinity) - (b.remindAt || Infinity));
    const done = tasks.filter((t) => t.done);
    list.innerHTML = '';
    for (const t of [...pending, ...done]) list.appendChild(noteEl(t));
    addBtn.disabled = false;
  }

  function noteEl(t) {
    const el = document.createElement('div');
    el.className = 'note ' + (t.done ? 'done ' : '') + (COLORS[(t.createdAt || 0) % COLORS.length] || 'c0');

    const txt = document.createElement('div');
    txt.className = 'txt';
    txt.textContent = t.text;

    const meta = document.createElement('div');
    meta.className = 'meta';
    if (t.remindAt) {
      const clock = document.createElement('span');
      clock.className = 'clock';
      clock.textContent = '⏰ ' + fmtTime(t.remindAt);
      meta.appendChild(clock);
    } else {
      meta.textContent = '无提醒';
    }

    const doneBtn = document.createElement('button');
    doneBtn.className = 'done-btn';
    doneBtn.title = t.done ? '取消完成' : '标记完成';
    doneBtn.textContent = '✓';
    doneBtn.addEventListener('click', () => {
      t.done = !t.done;
      save();
    });

    const del = document.createElement('button');
    del.className = 'del';
    del.title = '删除';
    del.textContent = '×';
    del.addEventListener('click', () => {
      tasks = tasks.filter((x) => x.id !== t.id);
      save();
    });

    el.appendChild(txt);
    el.appendChild(meta);
    el.appendChild(doneBtn);
    el.appendChild(del);
    return el;
  }

  function save() {
    api.boardSave(tasks);
  }

  // ---------- 添加 ----------
  function addTask() {
    const text = inText.value.trim();
    if (!text) return;
    let remindAt = null;
    if (inTime.value) {
      const t = new Date(inTime.value).getTime();
      if (!isNaN(t)) remindAt = t;
    }
    tasks.push({
      id: 't' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
      text,
      remindAt,
      done: false,
      createdAt: Date.now(),
    });
    inText.value = '';
    inTime.value = '';
    inText.focus();
    save();
    render();
  }
  addBtn.addEventListener('click', addTask);
  inText.addEventListener('keydown', (e) => { if (e.key === 'Enter') addTask(); });

  // ---------- 拖拽（头部把手） ----------
  // 用 pointer capture：拖动时鼠标即使离开 header/窗口，事件仍持续派发给 header，可自由拖满屏。
  // 偏移在 pointerdown 时固定（相对窗口），拖动过程不随窗口移动而漂移。
  hdr.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    dragOffset = { x: e.clientX, y: e.clientY };
    try { hdr.setPointerCapture(e.pointerId); } catch (_) {}
  });
  hdr.addEventListener('pointermove', (e) => {
    if (!dragging || !dragOffset) return;
    // offset = 鼠标相对窗口左上（frame:false，client 坐标即窗口内容坐标）；固定值防漂移
    api.boardDrag({ x: dragOffset.x, y: dragOffset.y });
  });
  window.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    if (dragOffset) {
      try { if (hdr.hasPointerCapture(e.pointerId)) hdr.releasePointerCapture(e.pointerId); } catch (_) {}
      dragOffset = null;
    }
    api.boardDrop();
  });

  // 收起 / 隐藏
  btnCollapse.addEventListener('click', () => api.boardCollapse());
  btnHide.addEventListener('click', () => api.boardHide());

  // 停靠窄条点击 → 展开
  dockbar.addEventListener('click', () => api.boardExpand());

  // ---------- 主进程状态 ----------
  api.onBoardState((s) => {
    document.body.classList.toggle('docked', !!(s && s.docked));
  });
  api.onBoardData((data) => {
    if (Array.isArray(data)) { tasks = data; render(); }
  });
  api.onBoardSynced((data) => {
    if (Array.isArray(data)) { tasks = data; render(); }
  });

  // 初始化：请求数据
  if (api.boardLoad) api.boardLoad();
})();