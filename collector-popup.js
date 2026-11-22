"use strict";
// The collector part of the popup: a one-line status and the way into the console page.
(() => {
  const $ = id => document.getElementById(id);
  async function render() {
    const s = await chrome.storage.local.get(["paused", "outbox", "tasks", "auto"]);
    const parts = [s.auto ? "自动执行已开启" : "手动执行"];
    if (s.paused) parts.unshift(`已暂停：${s.paused.reason}`);
    if (s.outbox?.length) parts.push(`本地待上传 ${s.outbox.length} 条`);
    const open = (s.tasks?.sessions || []).filter(x => x.status === "pending" && new Date(x.start_time) > new Date()).length;
    if (s.tasks) parts.push(`今天待采集 ${open} 场（同步于 ${new Date(s.tasks.at).toLocaleTimeString("zh-CN", {hour12: false})}）`);
    $("collector-status").textContent = parts.join(" · ");
    $("collector-status").style.color = s.paused ? "#8a3f06" : "";
  }
  $("open-console").addEventListener("click", () => chrome.runtime.openOptionsPage());
  render();
})();
