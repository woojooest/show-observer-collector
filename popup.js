"use strict";

const element = id => document.getElementById(id);
const $profile = element("profile");
const formatMoney = new Intl.NumberFormat("zh-CN", {style: "currency", currency: "CNY"});
const amount = value => value == null ? "—" : formatMoney.format(value);
const kinds = {layout: "座位文件", dynamic: "场次动态信息", status: "场次座位状态", area: "场馆区域信息"};
const stateLabels = {available: "可选", sold: "已售", unknown: "未知"};

function displayState(state) {
  if (state === "sold" || state === "unavailable") return "sold";
  return state === "available" ? "available" : "unknown";
}
let profile = {};
let tabId;
let busy = false;
let markersVisible = false;
try { profile = JSON.parse(localStorage.getItem("profile") || "{}"); } catch {}
$profile.value = JSON.stringify(profile, null, 2);

function statusMessage(message) {
  element("message").textContent = message;
}

async function toTab(message) {
  if (tabId == null) {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    tabId = tab?.id;
  }
  if (tabId == null) throw new Error("未找到当前标签页。");
  return chrome.tabs.sendMessage(tabId, message);
}

function saveFile(name, parts, type) {
  const url = URL.createObjectURL(new Blob(parts, {type}));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function addRow(table, label, row) {
  const tr = table.insertRow();
  const th = document.createElement("th");
  th.scope = "row";
  th.textContent = label;
  tr.append(th);
  const sold = row.sold + row.unavailable;
  const counts = [row.total, row.available, sold, row.total - row.available - sold];
  for (const count of counts) tr.insertCell().textContent = count;
}

function renderSources(sources) {
  element("sources").replaceChildren();
  for (const kind of Object.keys(kinds)) {
    const entry = sources.find(source => source.kind === kind);
    const line = document.createElement("li");
    const label = document.createElement("span");
    const progress = {decoding: "解码中", json: "已解码", unsupported: "格式待确认"};
    label.textContent = entry
      ? `${kinds[kind]} · ${progress[entry.state]} · ${entry.transport} · ${new Date(entry.time).toLocaleTimeString()}`
      : `${kinds[kind]} · 等待捕获`;
    line.append(label);
    if (entry) {
      const actions = document.createElement("div");
      const formats = entry.state === "json" ? [["原文", "raw"], ["JSON", "json"]] : [["原文", "raw"]];
      for (const [title, format] of formats) {
        const button = document.createElement("button");
        button.textContent = title;
        button.setAttribute("aria-label", `导出${kinds[kind]}${title}`);
        button.addEventListener("click", async () => {
          try {
            const file = await toTab({type: "download", kind, format});
            if (!file) return statusMessage("当前标签页没有这份资源。");
            const body = file.base64 ? Uint8Array.from(atob(file.body), c => c.charCodeAt(0)) : file.body;
            saveFile(`damai-${kind}.${file.extension}`, [body], "application/octet-stream");
          } catch { statusMessage("导出失败，请确认选座页仍然打开。"); }
        });
        actions.append(button);
      }
      line.append(actions);
    }
    element("sources").append(line);
  }
}

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const snapshot = await toTab({type: "report", profile});
    const {report, warnings, performance, sources} = snapshot;
    markersVisible = snapshot.markersVisible;
    const markerButton = element("mark-unknown");
    markerButton.hidden = !markersVisible && report.counts.total === report.priced;
    markerButton.disabled = !markersVisible && !snapshot.canMarkUnknownPrices;
    markerButton.title = markerButton.disabled ? "当前座位图的坐标尚无法校准" : "";
    markerButton.textContent = markersVisible ? "清除区域标记" : "圈出未知票价区域";
    element("performance").textContent = performance || "";
    renderSources(sources);
    element("statistics").hidden = !report.counts.total;
    if (!report.counts.total) {
      statusMessage(sources.length ? warnings.join(" ") : "正在等待本页的座位文件和库存响应。");
      return;
    }
    const notes = [...warnings];
    if (!markerButton.hidden && markerButton.disabled) notes.push("当前座位图的坐标尚无法校准。");
    if (!report.fullAverage && !report.priced) notes.push("场次平均票价尚未确认。");
    if (report.counts.unknown + report.counts.locked + report.counts.selected) notes.push("状态不明的座位保留为未知。");
    statusMessage(notes.join(" "));
    element("average-label").textContent = report.fullAverage ? "全场平均票面价" : "已知票价座位均价";
    element("average").textContent = amount(report.average);
    element("coverage").textContent = `${report.priced} / ${report.counts.total} 个已识别座位有价格`;
    element("available-average").textContent = amount(report.availableAverage);
    element("available-coverage").textContent = `${report.availablePriced} / ${report.counts.available} 个可选座位有价格`;
    element("tiers").replaceChildren();
    element("totals").replaceChildren();
    for (const row of report.tiers) addRow(element("tiers"), row.cents === null ? "票价未知" : amount(row.cents / 100), row);
    addRow(element("totals"), "合计", report.counts);
  } catch {
    element("statistics").hidden = true;
    element("performance").textContent = "";
    renderSources([]);
    statusMessage("请打开大麦选座页。若已打开，安装扩展后刷新页面一次。");
  } finally {
    busy = false;
  }
}

function csvCell(value) {
  const text = String(value ?? "");
  const safe = typeof value === "string" && /^(\s*[=+\-@]|[\t\r\n])/.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"', '""') + '"';
}

element("export").addEventListener("click", async () => {
  try {
    const result = await toTab({type: "report", profile, includeSeats: true});
    const rows = [["座位ID", "区域", "排", "座号", "票档ID", "票面价（元）", "状态"]];
    for (const seat of result.seats) {
      rows.push([seat.id, seat.section, seat.row, seat.number, seat.tier,
        seat.cents === null ? "" : seat.cents / 100, stateLabels[displayState(seat.state)]]);
    }
    saveFile("damai-seats.csv", ["\uFEFF", rows.map(row => row.map(csvCell).join(",")).join("\r\n")],
      "text/csv;charset=utf-8");
  } catch {
    statusMessage("导出失败，请确认选座页仍然打开。");
  }
});

element("save").addEventListener("click", () => {
  try {
    const candidate = JSON.parse($profile.value);
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
        ["layout", "prices", "status"].some(key => candidate[key] != null &&
          (typeof candidate[key] !== "object" || Array.isArray(candidate[key])))) {
      throw new Error("映射应为 JSON 对象。");
    }
    for (const group of ["layout", "prices", "status"]) {
      const item = candidate[group] || {};
      for (const key of ["path", "source", "id", "tier", "price", "unit", "value"]) {
        if (Object.hasOwn(item, key) && typeof item[key] !== "string") {
          throw new Error(`${group}.${key} 应为字符串。`);
        }
      }
    }
    localStorage.setItem("profile", JSON.stringify(candidate));
    chrome.storage.local.set({profile: candidate}); // the background collector reads it from here
    profile = candidate;
    refresh();
  } catch (error) {
    statusMessage(`字段映射无法应用。 ${error.message}`);
  }
});

element("mark-unknown").addEventListener("click", async () => {
  try {
    const success = await toTab({type: markersVisible ? "clear-markers" : "mark-unknown-prices", profile});
    if (!success) {
      statusMessage("当前座位图无法校准标记位置。");
      return;
    }
    if (markersVisible) await refresh();
    else window.close();
  } catch {
    statusMessage("标记失败，请确认选座页仍然打开。");
  }
});

element("refresh").addEventListener("click", refresh);
refresh();


