"use strict";
// Collector for the show observer. It runs in a logged-in Chrome and opens the same pages a person
// would. It works from a task list pulled from the observer server:
//
// - schedules: followed projects whose whole schedule should be read (from the day before the run,
//   after the catalog end date moves, or on request);
// - today's sessions: each can be captured from its seat page.
//
// By default nothing runs by itself: a person syncs the task list in the console page and runs the
// tasks they pick, or all of them. With "auto" on, the collector also does it on its own every minute:
// schedules as they come up, and each session two hours before curtain.
//
// Results go to the server at once, or stay in a local outbox to upload or export later. When the
// server cannot be reached, results stay in the outbox too.
//
// Towards Damai: one background tab at a time, a random 2–4 s pause before every page action and
// API call, one retry at most, and a full stop on a login or verification page.

importScripts("config.js");

const DEFAULTS = {observer: DEFAULT_OBSERVER_URL, token: "", upload: "server", auto: false};
const SOURCE = "damai-seat-extension";
const LOAD_TIMEOUT = 60_000; // a page must deliver its data within this

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pause = () => sleep(2000 + Math.random() * 2000);
const beijingDay = (date = new Date()) => date.toLocaleDateString("sv-SE", {timeZone: "Asia/Shanghai"});
const local = keys => chrome.storage.local.get(keys);

class Blocked extends Error {}  // login or verification: retrying would not help
class Offline extends Error {}  // the server could not be reached or failed
class Refused extends Error {}  // the server refused the token (wrong, or revoked)

async function settings() {
  return {...DEFAULTS, ...(await local(["observer", "token", "upload", "auto", "profile", "paused", "expired"]))};
}

// ---------- server ----------

async function api(method, path, body) {
  const {observer, token} = await settings();
  let response;
  try {
    response = await fetch(observer.replace(/\/$/, "") + path, {
      method,
      headers: {
        ...(body === undefined ? {} : {"Content-Type": "application/json"}),
        ...(token ? {Authorization: `Bearer ${token}`} : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (error) {
    throw new Offline(`连不上观察系统：${error.message}`);
  }
  const data = await response.json().catch(() => ({}));
  if (response.status >= 500) throw new Offline(data.error || `观察系统返回 ${response.status}`);
  if (response.status === 401) {
    // The login expired or this device was logged out: stop the automatic round until a new login.
    if (token) await chrome.storage.local.set({expired: true});
    throw new Refused("登录已失效，请在控制台重新登录");
  }
  if (!response.ok) throw new Error(data.error || `观察系统返回 ${response.status}`);
  return data;
}

// Every result leaves through here: to the server, or into the outbox. perishable marks a result
// that cannot be taken again later (a seat capture: after curtain it is gone); a schedule can be
// read again at any time.
async function report(method, path, body, label, {perishable = false} = {}) {
  const {upload} = await settings();
  if (upload === "server") {
    try {
      await api(method, path, body);
      return "已上传";
    } catch (error) {
      // A result is kept when the server cannot be reached. A refused token (revoked while the work
      // ran) keeps only a perishable one: an old schedule uploaded after a new token is set would
      // pass for the current one and drop sessions added in between; it is simply read again.
      if (!(error instanceof Offline || (perishable && error instanceof Refused))) throw error;
      await log({kind: "collector", problem: `${error.message}，结果先存在本地`});
    }
  }
  const {outbox = []} = await local("outbox");
  outbox.push({id: crypto.randomUUID(), time: new Date().toISOString(), method, path, body, label});
  await chrome.storage.local.set({outbox});
  return "已存本地";
}

async function uploadOutbox(ids) {
  const {outbox = []} = await local("outbox");
  const keep = [];
  let sent = 0;
  for (const entry of outbox) {
    if (ids && !ids.includes(entry.id)) {
      keep.push(entry);
      continue;
    }
    try {
      await api(entry.method, entry.path, entry.body);
      sent++;
    } catch (error) {
      keep.push({...entry, error: error.message});
    }
  }
  await chrome.storage.local.set({outbox: keep});
  await log({kind: "collector", detail: `上传本地数据：成功 ${sent} 条，剩余 ${keep.length} 条`});
  return {sent, left: keep.length};
}

// Today's sessions and the ones someone asked to capture. An observer older than that list only has today's.
async function taskSessions() {
  try {
    return await api("GET", "/api/collect/sessions");
  } catch (error) {
    if (error instanceof Offline || !/404|not found/i.test(error.message)) throw error;
    return api("GET", "/api/collect/today");
  }
}

async function syncTasks() {
  const [projects, sessions] = await Promise.all([api("GET", "/api/collect/projects"), taskSessions()]);
  const tasks = {at: new Date().toISOString(), day: beijingDay(), projects, sessions};
  await chrome.storage.local.set({tasks});
  return tasks;
}

// ---------- log and pause ----------

async function log(entry) {
  const {events = []} = await local("events");
  events.unshift({time: new Date().toISOString(), ...entry});
  await chrome.storage.local.set({events: events.slice(0, 100)});
  if (entry.problem) {
    chrome.action.setBadgeText({text: "!"});
    chrome.action.setBadgeBackgroundColor({color: "#b4530a"});
  }
}

// What a page address or an MTop error says about why data could not be read.
function blockedBy(text) {
  if (/login\.html|SESSION_EXPIRED|未登录|请登录/i.test(text)) return "登录态过期";
  if (/punish|x5sec|_____tmd_____|USER_VALIDATE|RGV587/i.test(text)) return "触发风控验证";
  return "";
}

async function stop(reason) {
  await chrome.storage.local.set({paused: {reason, at: new Date().toISOString()}});
  await log({kind: "collector", problem: `已暂停：${reason}。重新登录后在控制台点「恢复采集」`});
}

// ---------- Damai pages ----------

async function withTab(url, work) {
  const tab = await chrome.tabs.create({url, active: false});
  try {
    return await work(tab.id);
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function loaded(tabId) {
  const until = Date.now() + LOAD_TIMEOUT;
  while (Date.now() < until) {
    const tab = await chrome.tabs.get(tabId);
    const blocked = blockedBy(tab.url || "");
    if (blocked) throw new Blocked(blocked);
    if (tab.status === "complete") return;
    await sleep(500);
  }
  throw new Error("页面加载超时");
}

// Runs inside the item page (MAIN world) and asks the page's own MTop client, exactly as the
// "选座购票" sheet does. Without a day it reads the calendar and then every date; with a day,
// only that date. Each call is paused 2–4 s and retried once, except on login or verification.
async function readSchedule(itemId, day) {
  const pause = () => new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 2000));
  for (let i = 0; i < 40 && !window.lib?.mtop?.request; i++) await new Promise(r => setTimeout(r, 500));
  if (!window.lib?.mtop?.request) return {error: "页面脚本没有加载完成"};
  const text = error => (error?.ret || []).join(" ") || String(error?.message || error);
  const ask = async dataId => {
    await pause();
    const response = await window.lib.mtop.request({
      api: "mtop.alibaba.detail.subpage.getdetail", v: "2.0", type: "GET", dataType: "json",
      data: {itemId, bizCode: "ali.china.damai", scenario: "itemsku", exParams: JSON.stringify({dataType: 4, dataId}),
        platform: "8", comboChannel: "2", dmChannel: "damai@damaih5_h5"}
    });
    return response.data.result ? JSON.parse(response.data.result) : response.data;
  };
  const once = async dataId => {
    try {
      return await ask(dataId);
    } catch (error) {
      if (/SESSION_EXPIRED|USER_VALIDATE|RGV587/.test(text(error))) throw error;
      return ask(dataId);
    }
  };
  const views = (response, dateId) => (response.performCalendar?.performViews || [])
    .filter(view => !dateId || view.dateKey === dateId);
  const pick = view => ({performId: view.performId, startMs: Number(view.performDateTS)});
  try {
    if (day) {
      const dateId = day.replace(/-/g, "");
      const response = await once(dateId);
      const info = response.itemBasicInfo || {};
      return {
        projectId: String(info.projectId || ""), cityId: String(info.nationalStandardCityId || ""),
        // Only a date that is on the calendar gives an authoritative list for that day.
        listed: (response.performCalendar?.dateViews || []).some(date => date.dateId === dateId),
        performs: views(response, dateId).map(pick)
      };
    }
    const first = await once("");
    const info = first.itemBasicInfo || {};
    const performs = new Map(views(first).map(view => [view.performId, view]));
    const seen = new Set(views(first).map(view => view.dateKey));
    for (const date of first.performCalendar?.dateViews || []) {
      if (seen.has(date.dateId)) continue;
      for (const view of views(await once(date.dateId), date.dateId)) performs.set(view.performId, view);
    }
    if (!performs.size && first.perform?.performId) performs.set(first.perform.performId, first.perform);
    return {
      projectId: String(info.projectId || ""), cityId: String(info.nationalStandardCityId || ""),
      listed: true, performs: [...performs.values()].map(pick)
    };
  } catch (error) {
    return {error: text(error)};
  }
}

function seatURL(itemId, performId, projectId, cityId) {
  const query = new URLSearchParams({itemId, performId, projectId, performanceCityId: cityId});
  return `https://m.damai.cn/shows/seat.html?${query}`;
}

// Reads a project's schedule (the whole of it, or one day) and reports it.
async function readProjectSchedule(projectId, name, day) {
  const itemId = String(projectId);
  const result = await withTab(`https://m.damai.cn/shows/item.html?itemId=${itemId}`, async tabId => {
    await loaded(tabId);
    await pause();
    const [{result}] = await chrome.scripting.executeScript({
      target: {tabId}, world: "MAIN", func: readSchedule, args: [itemId, day || ""]
    });
    return result;
  });
  if (result.error) {
    const blocked = blockedBy(result.error);
    if (blocked) throw new Blocked(`${blocked}（${result.error}）`);
    throw new Error(result.error);
  }
  const sessions = result.performs.filter(p => p.startMs > 0).map(p => ({
    start_time: new Date(p.startMs).toISOString(),
    damai_session_id: Number(p.performId),
    seat_url: result.projectId ? seatURL(itemId, p.performId, result.projectId, result.cityId) : ""
  }));
  const scope = !day ? {complete: true} : result.listed ? {day} : {};
  const where = await report("PUT", `/api/projects/${itemId}/sessions`, {source: SOURCE, sessions, ...scope},
    `${day ? "复核当天" : "完整排期"} ${name}`);
  return {count: sessions.length, listed: result.listed, where};
}

// Seats whose state is unknown make a tier's remaining count unreadable; unknown prices make
// the tier unusable. Both are sent as null so the observer leaves them out of occupancy.
// Seats whose price is unknown still have a known count and state: they form a tier with no face price.
function tiersOf(report) {
  return report.tiers.map(tier => ({
    tier: tier.cents == null ? "未知票价" : `¥${tier.cents / 100}`,
    face_price: tier.cents == null ? null : tier.cents / 100,
    total: tier.total,
    remaining: tier.unknown > 0 ? null : tier.available
  }));
}

async function readSeats(session) {
  const {profile = {}} = await settings();
  return withTab(session.seat_url, async tabId => {
    const until = Date.now() + LOAD_TIMEOUT;
    let last = null;
    while (Date.now() < until) {
      await pause();
      const tab = await chrome.tabs.get(tabId);
      const blocked = blockedBy(tab.url || "");
      if (blocked) throw new Blocked(blocked);
      let reply;
      try {
        reply = await chrome.tabs.sendMessage(tabId, {type: "report", profile, includeSeats: true});
      } catch {
        continue; // content script not ready yet
      }
      const decoded = kind => reply.sources.some(source => source.kind === kind && source.state === "json");
      if (decoded("layout") && decoded("status") && reply.report.counts.total > 0) {
        // Prices may arrive a moment after the seats; read once more and keep it if nothing moved.
        if (last && last.report.priced === reply.report.priced) return reply;
        last = reply;
      }
    }
    if (last) return last;
    throw new Error("座位数据加载超时");
  });
}

// The seat map of a capture: every seat with its position, price and state, for drawing the plan.
// {prices: [yuan|null], labels: ["区域 排"], seats: [[x, y, price index, state, label index, "座号"]]}
// state: 1 available, 2 not available, 0 unknown. Null when the layout has no coordinates.
function seatmapOf(seats) {
  if (!seats?.length || !seats.every(s => Number.isFinite(s.x) && Number.isFinite(s.y))) return null;
  const prices = [...new Set(seats.map(s => s.cents))].sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
  const labels = [], labelIndex = new Map();
  const labelOf = s => {
    const text = [s.section, s.row].filter(Boolean).join(" ");
    if (!labelIndex.has(text)) labelIndex.set(text, labels.push(text) - 1);
    return labelIndex.get(text);
  };
  const state = s => s.state === "available" ? 1 : s.state === "unknown" ? 0 : 2;
  return {
    prices: prices.map(c => c == null ? null : c / 100),
    labels,
    seats: seats.map(s => [s.x, s.y, prices.indexOf(s.cents), state(s), labelOf(s), String(s.number ?? "")])
  };
}

// ---------- tasks ----------

const label = session =>
  `${session.name} ${new Date(session.start_time).toLocaleString("zh-CN", {timeZone: "Asia/Shanghai", hour12: false})}`;

// A failure is retried once and then left alone. Nothing is written for a failed capture: the session
// stays open for another try, and becomes missing on the server by itself if it starts uncaptured.
async function twice(work) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Blocked) throw error;
    await pause();
    return work();
  }
}

async function runSchedule(project) {
  try {
    const {count, where} = await readProjectSchedule(project.project_id, project.name);
    const why = {requested: "手动请求", first: "首次读取"}[project.reason] || `结束日期变为 ${project.end_date}`;
    await log({kind: "schedule", project: project.name, detail: `${why}，${count} 场，${where}`});
  } catch (error) {
    if (error instanceof Blocked) throw error;
    await log({kind: "schedule", project: project.name, problem: error.message});
  }
}

// Before the first capture of a project on a day, re-read that day's sessions once.
async function verifyDay(projectId, name) {
  const today = beijingDay();
  const key = `verified:${projectId}`;
  if ((await local(key))[key] === today) return;
  await chrome.storage.local.set({[key]: today}); // once a day, whatever the outcome
  try {
    const {count, listed, where} = await readProjectSchedule(projectId, name, today);
    await log({kind: "schedule", project: name,
      detail: listed ? `复核当天：${count} 场，${where}` : "当天不在日历里，保留已知场次"});
  } catch (error) {
    if (error instanceof Blocked) throw error;
    await log({kind: "schedule", project: name, problem: `复核当天失败：${error.message}，按已知场次采集`});
  }
  await pause();
}

async function runCapture(session) {
  if (new Date(session.start_time) <= new Date()) {
    await log({kind: "capture", session: label(session), problem: "已经开演，不能再采集"});
    return;
  }
  // Today's sessions are checked against today's calendar first; a session asked for ahead of its day is not.
  if (beijingDay(new Date(session.start_time)) === beijingDay()) await verifyDay(session.project_id, session.name);
  try {
    const {report: seats, seats: list} = await twice(() => readSeats(session));
    const where = await report("PUT", `/api/sessions/${session.session_id}/snapshot`,
      {captured_at: new Date().toISOString(), source: SOURCE, status: "ok", tiers: tiersOf(seats), seatmap: seatmapOf(list)},
      `库存 ${label(session)}`, {perishable: true});
    await log({kind: "capture", session: label(session), detail: `${seats.counts.total} 座，${where}`});
  } catch (error) {
    if (error instanceof Blocked) throw error;
    await log({kind: "capture", session: label(session), problem: `${error.message}（未写入，可再试）`});
  }
}

// Runs picked tasks from the synced list. ids: {projects: [...], sessions: [...]}.
async function runTasks(ids) {
  const {paused} = await settings();
  if (paused) throw new Error(`采集器已暂停：${paused.reason}`);
  const {tasks} = await local("tasks");
  if (!tasks) throw new Error("还没有同步待办");
  try {
    for (const project of tasks.projects.filter(p => ids.projects?.includes(p.project_id))) {
      await runSchedule(project);
      await pause();
    }
    for (const session of tasks.sessions.filter(s => ids.sessions?.includes(s.session_id))) {
      await runCapture(session);
      await pause();
    }
  } catch (error) {
    if (error instanceof Blocked) return stop(error.message);
    throw error;
  }
  await log({kind: "collector", detail: "选中的任务已执行完"});
}

// The automatic round: schedules as they come up, and sessions two hours before curtain.
async function autoRound() {
  const {auto, paused, expired, token} = await settings();
  if (!auto || paused || expired || !token) return;
  try {
    const today = beijingDay();
    for (const project of await api("GET", "/api/collect/projects")) {
      // A failed read is not retried the same day; a manual request is retried only when made again.
      const key = `autoTried:${project.project_id}`;
      const attempt = project.reason === "requested" ? `request ${project.requested_at}` : today;
      if ((await local(key))[key] === attempt) continue;
      await chrome.storage.local.set({[key]: attempt});
      await runSchedule(project);
      await pause();
    }
    for (const session of await api("GET", "/api/collect/due?lead_minutes=1")) {
      const key = `autoTried:session:${session.session_id}`;
      if ((await local(key))[key]) continue;
      await chrome.storage.local.set({[key]: true});
      await runCapture(session);
      await pause();
    }
    // Sessions asked for from the detail page, once per request.
    for (const session of (await taskSessions()).filter(s => s.requested_at)) {
      const key = `autoTried:request:${session.session_id}`;
      if ((await local(key))[key] === session.requested_at) continue;
      await chrome.storage.local.set({[key]: session.requested_at});
      await runCapture(session);
      await pause();
    }
  } catch (error) {
    if (error instanceof Blocked) return stop(error.message);
    if (error instanceof Offline) return; // try again next minute
    await log({kind: "collector", problem: error.message});
  }
}

// ---------- wiring ----------

let running = Promise.resolve();
function exclusive(job) {
  const next = running.then(job, job);
  running = next.catch(() => {});
  return next;
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "tick") exclusive(autoRound);
});

function arm() {
  chrome.alarms.clearAll();
  chrome.alarms.create("tick", {periodInMinutes: 1});
}
chrome.runtime.onInstalled.addListener(arm);
chrome.runtime.onStartup.addListener(arm);

// What the owner sees for this device on the observer's account page.
function deviceName() {
  const ua = navigator.userAgent;
  const version = /Chrome\/(\d+)/.exec(ua)?.[1];
  const os = /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
  return [version ? `Chrome ${version}` : "Chrome", os].filter(Boolean).join(" · ");
}

// Logs this device in. Admins and users use the same door; the server tells which one it was.
async function login({observer, username, password, code}) {
  let response;
  try {
    response = await fetch(observer + "/api/devices/login", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({username, password, code, device: deviceName()})
    });
  } catch (error) {
    throw new Error(`连不上观察系统：${error.message}`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `观察系统返回 ${response.status}`);
  await chrome.storage.local.set({observer, token: data.token, account: {username: data.username, role: data.role, expires_at: data.expires_at}});
  await chrome.storage.local.remove("expired");
  await log({kind: "collector", detail: `已登录：${data.username}`});
}

// Logs this device out: the server revokes the token, and the token is forgotten here either way.
async function logout() {
  try {
    await api("POST", "/api/devices/logout");
  } catch (error) {
    if (!(error instanceof Refused || error instanceof Offline)) throw error;
  }
  await chrome.storage.local.remove(["token", "account", "expired", "tasks"]);
  await log({kind: "collector", detail: "已退出这台设备"});
}

const handlers = {
  "collector-login": message => login(message),
  "collector-logout": () => logout(),
  "collector-sync": () => syncTasks(),
  "collector-run": message => exclusive(() => runTasks(message.ids || {})),
  "collector-upload": message => exclusive(() => uploadOutbox(message.ids)),
  "collector-resume": async () => {
    await chrome.storage.local.remove("paused");
    chrome.action.setBadgeText({text: ""});
    await log({kind: "collector", detail: "已恢复采集"});
  }
};

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const handle = sender.id === chrome.runtime.id && handlers[message?.type];
  if (!handle) return;
  Promise.resolve(handle(message)).then(
    result => respond({ok: true, result}),
    error => respond({ok: false, error: error.message}));
  return true;
});
