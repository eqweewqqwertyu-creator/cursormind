(function () {
  const q = document.getElementById('q');
  const reply = document.getElementById('reply');
  const reset = document.getElementById('reset');
  const api = window.cursormind;
  if (!api) return;

  function showReply(text) {
    if (!text) return;
    reply.textContent = text;
    reply.classList.add('show');
    reply.scrollTop = 0;
  }

  function hideReply() {
    reply.classList.remove('show');
    reply.textContent = '';
  }

  // 重置对话：清空上下文，开始新会话
  function doReset() {
    if (api.resetConversation) api.resetConversation();
    hideReply();
    q.value = '';
    q.focus();
  }

  api.onPanelOpen(function () {
    q.value = '';
    q.focus();
  });

  api.onPanelReply(function (text) {
    showReply(String(text || ''));
    q.focus();
  });

  if (reset) {
    reset.addEventListener('click', doReset);
  }

  q.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      const text = q.value.trim();
      if (text) {
        api.submitQuestion(text);
        q.value = '';
        hideReply();
      }
      e.preventDefault();
    } else if (e.key === 'Escape') {
      api.dismiss();
      e.preventDefault();
    } else if (e.key.toLowerCase() === 'r' && (e.ctrlKey || e.metaKey)) {
      // Ctrl+R 重置对话（面板聚焦时可用，override 浏览器刷新）
      doReset();
      e.preventDefault();
    }
  });

  setTimeout(function () {
    q.focus();
  }, 60);
})();
