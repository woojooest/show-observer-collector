"use strict";

function collect(entry) {
  const kind = DamaiSeat.kindOf(entry.request.url);
  if (!kind || entry.response.status < 200 || entry.response.status >= 300 ||
      entry.response.content?.size > 12 * 1024 * 1024) return;
  entry.getContent((body, encoding) => {
    if (typeof body !== "string" || !body || body.length > 17 * 1024 * 1024) return;
    chrome.tabs.sendMessage(chrome.devtools.inspectedWindow.tabId, {
      type: "devtools-body", kind, body, encoding
    }).catch(() => {});
  });
}

chrome.devtools.network.onRequestFinished.addListener(collect);
chrome.devtools.network.getHAR(result => result.entries.forEach(collect));
