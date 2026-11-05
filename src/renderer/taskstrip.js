/**
 * 后台任务条渲染层：紧凑胶囊 ⇄ 任务列表。
 * 数据由主进程全量推送（JSON 字符串），本层只渲染 + 上抛操作；
 * 运行中的耗时每 5s 本地刷新一次（无需主进程参与）。
 */
(function () {
  var cm = window.cursormind;
  if (!cm) return;

  var tasks = [];
  var lastDoneCount = -1; // 完成闪烁判定：上一次推送时的已完成数

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtDur(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + '秒';
    return Math.floor(s / 60) + '分' + (s % 60) + '秒';
  }

  function fmtTokens(t) {
    var n = Number(t) || 0;
    return n > 0 ? n.toLocaleString() + ' tokens' : '';
  }

  function statusLabel(t, now) {
    switch (t.status) {
      case 'running':
        return '运行中 · 第' + (t.step || 0) + '步 · ' + fmtDur(now - t.startedAt);
      case 'queued':
        return '排队中';
      case 'done':
        return '完成 · ' + fmtDur((t.endedAt || now) - t.startedAt);
      case 'failed':
        return '失败 · ' + fmtDur((t.endedAt || now) - t.startedAt);
      case 'blocked':
        return '已拦下（检测到删除/外发）';
      case 'cancelled':
        return '已取消';
      default:
        return '';
    }
  }

  // ---------- 紧凑胶囊 ----------
  function renderCompact() {
    var running = tasks.filter(function (t) { return t.status === 'running' || t.status === 'queued'; });
    var doneN = tasks.filter(function (t) { return t.status === 'done'; }).length;
    var otherN = tasks.length - running.length - doneN;
    var dot = document.getElementById('cDot');
    var cnt = document.getElementById('cCnt');
    var title = document.getElementById('cTitle');

    if (running.length > 0) {
      var latest = running[running.length - 1];
      dot.className = 'dot run';
      cnt.className = 'cnt';
      cnt.textContent = '后台 ' + running.length;
      title.textContent = latest.title + (latest.status === 'running' && latest.step ? ' · 第' + latest.step + '步' : '');
      document.title = '灵标后台 ' + running.length;
    } else if (doneN > 0) {
      dot.className = 'dot idle';
      cnt.className = 'cnt ok';
      cnt.textContent = '完成 ' + doneN;
      title.textContent = otherN > 0 ? '点开看结果（' + otherN + ' 条未成功）' : '点开看结果';
    } else {
      dot.className = 'dot warn';
      cnt.className = 'cnt warn';
      cnt.textContent = '后台';
      title.textContent = otherN > 0 ? '任务已结束' : '';
    }
  }

  // ---------- 展开列表 ----------
  function renderList() {
    var rows = document.getElementById('rows');
    var now = Date.now();
    if (!tasks.length) {
      rows.innerHTML = '<div class="empty">暂无后台任务</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      var acts = '';
      if (t.status === 'running' || t.status === 'queued') {
        acts += '<button class="abtn cancel" data-act="cancel" data-id="' + esc(t.id) + '">取消</button>';
      }
      if ((t.status === 'done' || t.status === 'failed' || t.status === 'blocked') && t.finalText) {
        acts += '<button class="abtn view" data-act="view" data-id="' + esc(t.id) + '">看结果</button>';
      }
      var metaParts = [statusLabel(t, now)];
      var tk = fmtTokens(t.inTok + t.outTok);
      if (tk) metaParts.push(tk);
      if (t.skills && t.skills.length) metaParts.push(t.skills.join('/'));

      html += '<div class="tcard st-' + esc(t.status) + '">'
        + '<div class="head"><span class="sdot ' + esc(t.status) + '"></span>'
        + '<span class="tt" title="' + esc(t.title) + '">' + esc(t.title) + '</span>'
        + '<button class="del" data-act="remove" data-id="' + esc(t.id) + '" title="移除">×</button></div>'
        + '<div class="meta">' + metaParts.filter(Boolean).map(esc).join(' · ') + '</div>'
        + (acts ? '<div class="acts">' + acts + '</div>' : '')
        + '</div>';
    }
    rows.innerHTML = html;
  }

  function render() {
    renderCompact();
    renderList();
  }

  // ---------- 数据同步 ----------
  function onData(json, expandedJson) {
    try { tasks = JSON.parse(json) || []; } catch (e) { tasks = []; }
    document.body.className = String(expandedJson) === 'true' ? 'list' : '';
    var doneN = 0;
    for (var i = 0; i < tasks.length; i++) if (tasks[i].status === 'done') doneN++;
    if (lastDoneCount >= 0 && doneN > lastDoneCount) {
      var c = document.getElementById('compact');
      c.classList.remove('flash');
      void c.offsetWidth; // 重启动画
      c.classList.add('flash');
    }
    lastDoneCount = doneN;
    render();
  }

  // ---------- 事件 ----------
  document.getElementById('compact').addEventListener('click', function () {
    cm.taskstripExpandToggle();
  });
  document.getElementById('btnCollapse').addEventListener('click', function () {
    cm.taskstripExpandToggle();
  });
  document.getElementById('btnClear').addEventListener('click', function () {
    cm.taskstripClearDone();
  });
  document.getElementById('rows').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!btn) return;
    var id = btn.getAttribute('data-id');
    var act = btn.getAttribute('data-act');
    if (act === 'cancel') cm.taskstripCancel(id);
    else if (act === 'view') cm.taskstripView(id);
    else if (act === 'remove') cm.taskstripRemove(id);
  });

  cm.onTaskData(function (json, expandedJson) { onData(json, expandedJson); });
  cm.taskstripLoad();

  // 运行中任务的耗时本地刷新（5s 一次，轻量）
  setInterval(function () {
    if (tasks.length) render();
  }, 5000);
})();
