"use strict";
// Console page: settings, the synced task list, the local outbox and the log.
// It only talks to the background service worker and reads chrome.storage.
(() => {
  const $ = id => document.getElementById(id);
  const time = iso => new Date(iso).toLocaleString("zh-CN", {timeZone: "Asia/Shanghai", hour12: false});
  const hm = iso => new Date(iso).toLocaleTimeString("zh-CN", {timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false});
  const reasons = {requested: "手动请求", first: "开演前首次读取", end_date_changed: "结束日期变动"};
  const ask = async message => {
    const reply = await chrome.runtime.sendMessage(message);
    if (!reply?.ok) throw new Error(reply?.error || "后台没有响应");
    return reply.result;
  };
  const cell = (row, text) => { row.insertCell().textContent = text; };

  // A session can be picked while it has a seat page and has not started; a captured one is captured again,
  // and the newer result replaces the stored one. "Run all" takes only the ones still waiting.
  const pickable = s => s.seat_url && new Date(s.start_time) > new Date();
  const waiting = s => pickable(s) && (s.status === "pending" || s.requested_at);
  const statusOf = s => {
    if (new Date(s.start_time) <= new Date()) return s.status === "ok" ? `已采集 ${hm(s.captured_at)}` : "已开演，缺失";
    if (!s.seat_url) return "没有选座页地址";
    if (s.requested_at) return `网页请求采集（${hm(s.requested_at)}）`;
    return s.status === "ok" ? `已采集 ${hm(s.captured_at)}，可重新采集` : "待采集";
  };
  const today = new Date().toLocaleDateString("sv-SE", {timeZone: "Asia/Shanghai"});
  const when = iso => new Date(iso).toLocaleDateString("sv-SE", {timeZone: "Asia/Shanghai"}) === today
    ? hm(iso) : new Date(iso).toLocaleString("zh-CN", {timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false});

  function box(kind, id, enabled, open = enabled) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.kind = kind;
    input.dataset.open = open ? "1" : "";
    input.value = id;
    input.disabled = !enabled;
    return input;
  }

  function empty(body, columns, text) {
    const td = body.insertRow().insertCell();
    td.colSpan = columns;
    td.className = "empty";
    td.textContent = text;
  }

  function renderTasks(tasks) {
    $("synced").textContent = tasks ? `同步于 ${time(tasks.at)}` : "还没有同步";
    const projects = $("projects"), sessions = $("sessions");
    projects.replaceChildren();
    sessions.replaceChildren();
    if (!tasks) return;
    for (const p of tasks.projects) {
      const row = projects.insertRow();
      row.insertCell().append(box("projects", p.project_id, true));
      cell(row, p.name);
      cell(row, reasons[p.reason] || p.reason);
    }
    if (!tasks.projects.length) empty(projects, 3, "没有需要读取的排期");
    for (const s of tasks.sessions) {
      const row = sessions.insertRow();
      row.insertCell().append(box("sessions", s.session_id, pickable(s), waiting(s)));
      cell(row, when(s.start_time));
      cell(row, s.name);
      cell(row, s.venue);
      cell(row, hm(s.target_time));
      cell(row, statusOf(s));
    }
    if (!tasks.sessions.length) empty(sessions, 6, "今天没有关注剧目的场次，也没有网页请求采集的场次");
  }

  async function render() {
    const s = await chrome.storage.local.get(["observer", "token", "account", "expired", "upload", "auto", "paused", "tasks", "outbox", "events"]);
    renderAccount(s);
    if (document.activeElement?.form !== $("settings")) {
      for (const radio of document.querySelectorAll("input[name=upload]")) radio.checked = radio.value === (s.upload || "server");
      $("auto").checked = !!s.auto;
    }
    $("paused").hidden = $("resume").hidden = !s.paused;
    if (s.paused) $("paused").textContent = `已暂停（${time(s.paused.at)}）：${s.paused.reason}。暂停期间不访问大麦。`;
    renderTasks(s.tasks);
    const outbox = s.outbox || [];
    $("outbox-count").textContent = `${outbox.length} 条待上传`;
    $("upload").disabled = $("export").disabled = !outbox.length;
    $("outbox").replaceChildren(...outbox.map(e => {
      const li = document.createElement("li");
      li.textContent = `${time(e.time)} ${e.label}${e.error ? `（上次上传失败：${e.error}）` : ""}`;
      if (e.error) li.className = "problem";
      return li;
    }));
    const kinds = {schedule: "排期", capture: "采集"};
    $("events").replaceChildren(...(s.events || []).slice(0, 30).map(e => {
      const li = document.createElement("li");
      li.textContent = `${time(e.time)} ${kinds[e.kind] || "采集器"} ${e.project || e.session || ""} ${e.problem || e.detail || ""}`;
      if (e.problem) li.className = "problem";
      return li;
    }));
  }

  // ---------- account ----------
  // One login form for everyone: the server knows from the account whether it is an admin's or a
  // user's, and asks for a code (need_code) when the account has a second factor. The login gives a
  // token that expires: 30 days for an admin, 90 for a user. A token made by hand still works.
  const DAY = 24 * 3600e3;
  const roles = {admin: ["管理员", "admin", "管理员关注的剧目以及数据采集请求"], user: ["用户", "ok", "关注的剧目以及数据采集请求"]};
  const day = iso => new Date(iso).toLocaleDateString("zh-CN", {timeZone: "Asia/Shanghai"});

  function renderAccount(s) {
    const inside = !!s.token;
    const a = s.account;
    const [roleName, roleChip, scope] = roles[a?.role] || ["令牌", "", "由令牌的账号决定"];
    $("signed-in").hidden = !inside;
    $("login").hidden = inside;
    $("expired").hidden = !s.expired;
    $("who").textContent = a?.username || "使用令牌";
    $("avatar").textContent = (a?.username || "令")[0].toUpperCase();
    $("role").textContent = roleName;
    $("role").className = `chip ${roleChip}`;
    $("until").textContent = a?.expires_at ? `登录信息有效期至 ${day(a.expires_at)}` : "不过期";
    $("server").textContent = s.observer || "";
    $("scope").textContent = scope;
    const left = a?.expires_at ? Math.ceil((new Date(a.expires_at) - Date.now()) / DAY) : Infinity;
    $("expiring").hidden = !inside || s.expired || left > 3;
    $("expiring").textContent = `登录将于 ${Math.max(left, 0)} 天后到期，到期后需要在这里重新登录。`;
    $("status").textContent = !inside ? "未登录" : s.expired ? "登录已失效" : a ? `${a.username} · ${roleName}` : "使用令牌";
    $("status").className = `chip push ${!inside || s.expired ? "warn" : roleChip}`;
    if (document.activeElement?.form !== $("login") && !$("observer").value) {
      $("observer").value = s.observer || DEFAULT_OBSERVER_URL;
    }
  }

  // A server that is not on this machine needs a host permission, granted on this click.
  async function allow(observer) {
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(observer)) return true;
    return chrome.permissions.request({origins: [new URL(observer).origin + "/*"]});
  }

  $("login").addEventListener("submit", async event => {
    event.preventDefault();
    const observer = $("observer").value.trim().replace(/\/$/, "");
    if (!(await allow(observer))) {
      $("login-msg").textContent = "没有获得访问该地址的权限";
      return;
    }
    $("login-msg").textContent = "登录中…";
    $("login-btn").disabled = true;
    try {
      await ask({type: "collector-login", observer,
        username: $("username").value, password: $("password").value, code: $("code").value.trim()});
      $("password").value = $("code").value = "";
      $("code-row").hidden = true;
      $("login-msg").textContent = "";
    } catch (error) {
      if (error.message === "need_code") {
        // The password was right and the account has a second factor: ask for the code.
        $("code-row").hidden = false;
        $("code").required = true;
        $("code").focus();
        $("login-msg").textContent = "请输入验证器 App 上的 6 位数字";
      } else {
        $("login-msg").textContent = error.message;
      }
    } finally {
      $("login-btn").disabled = false;
    }
  });
  $("save-token").addEventListener("click", async () => {
    const observer = $("observer").value.trim().replace(/\/$/, "");
    const token = $("token").value.trim();
    if (!observer || !token || !(await allow(observer))) {
      $("login-msg").textContent = "请填写服务器地址和令牌";
      return;
    }
    await chrome.storage.local.set({observer, token, account: null});
    await chrome.storage.local.remove("expired");
    $("token").value = "";
  });
  $("logout").addEventListener("click", () => busy($("logout"), "退出中…", () => ask({type: "collector-logout"})));

  $("settings").addEventListener("submit", async event => {
    event.preventDefault();
    await chrome.storage.local.set({
      auto: $("auto").checked,
      upload: document.querySelector("input[name=upload]:checked")?.value || "server"
    });
    $("saved").textContent = "已保存";
  });

  for (const all of document.querySelectorAll("[data-all]")) {
    all.addEventListener("change", () => {
      for (const input of document.querySelectorAll(`input[data-kind=${all.dataset.all}][data-open="1"]`)) input.checked = all.checked;
    });
  }

  async function busy(button, label, work) {
    const text = button.textContent;
    button.disabled = true;
    button.textContent = label;
    $("running").textContent = "";
    try {
      await work();
    } catch (error) {
      $("running").textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = text;
      render();
    }
  }

  const picked = onlyChecked => {
    const ids = {projects: [], sessions: []};
    for (const input of document.querySelectorAll("input[data-kind]:not(:disabled)")) {
      if (onlyChecked ? input.checked : input.dataset.open) ids[input.dataset.kind].push(Number(input.value));
    }
    return ids;
  };
  const run = (button, onlyChecked) => busy(button, "执行中…", async () => {
    const ids = picked(onlyChecked);
    if (!ids.projects.length && !ids.sessions.length) throw new Error("没有可执行的任务");
    $("running").textContent = `执行 ${ids.projects.length} 个排期、${ids.sessions.length} 场采集，进度见日志`;
    await ask({type: "collector-run", ids});
  });

  $("sync").addEventListener("click", () => busy($("sync"), "同步中…", () => ask({type: "collector-sync"})));
  $("run-picked").addEventListener("click", () => run($("run-picked"), true));
  $("run-all").addEventListener("click", () => run($("run-all"), false));
  $("upload").addEventListener("click", () => busy($("upload"), "上传中…", () => ask({type: "collector-upload"})));
  $("resume").addEventListener("click", () => busy($("resume"), "恢复中…", () => ask({type: "collector-resume"})));
  $("export").addEventListener("click", async () => {
    const {outbox = []} = await chrome.storage.local.get("outbox");
    const url = URL.createObjectURL(new Blob([JSON.stringify(outbox, null, 2)], {type: "application/json"}));
    const a = document.createElement("a");
    a.href = url;
    a.download = `show-observer-outbox-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  });

  chrome.storage.onChanged.addListener(render);
  chrome.action?.setBadgeText({text: ""});
  render();
})();
