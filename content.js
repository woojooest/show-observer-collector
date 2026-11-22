(() => {
  "use strict";
  const {decode, normalize, summarize, unknownPriceRuns} = DamaiSeat;
  const allowed = new Set(["layout", "dynamic", "status", "area"]);
  const latest = new Map();
  const limit = 12 * 1024 * 1024;

  async function accept(kind, payload, transport) {
    if (!allowed.has(kind)) return;
    const binary = payload instanceof ArrayBuffer;
    const size = typeof payload === "string" ? payload.length : binary ? payload.byteLength : 0;
    if (!size || size > limit) return;
    const entry = {payload, transport, size, time: new Date().toISOString(), state: "decoding"};
    latest.set(kind, entry);
    try {
      entry.data = await decode(payload, kind);
      entry.state = entry.data === null ? "unsupported" : "json";
    } catch {
      entry.state = "unsupported";
    }
  }

  window.addEventListener("message", event => {
    const {source, kind, payload, transport} = event.data || {};
    if (event.source !== window || event.origin !== location.origin || source !== "damai-seat-capture" ||
        !["fetch", "XHR", "JSONP"].includes(transport)) return;
    void accept(kind, payload, transport);
  });

  const overlayId = "damai-extension-price-markers";

  function markerGeometry(seats) {
    const panel = document.querySelector("#aseat-container .aseat-layer-panel:has(> canvas)");
    if (!panel || !seats.length) return null;
    const bounds = panel.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    const background = panel.querySelector(":scope > img");
    if (background) {
      const width = background.naturalWidth;
      const height = background.naturalHeight;
      if (!width || !height || Math.abs(bounds.width - bounds.height * width / height) > 2 ||
          !seats.every(({x, y}) => Number.isFinite(x) && Number.isFinite(y) &&
            x >= 0 && x <= width && y >= 0 && y <= height)) return null;
      return {panel, width, height, image: true};
    }
    let top = Infinity, left = Infinity, bottom = -Infinity, right = -Infinity;
    const occupied = new Set();
    for (const {x, y} of seats) {
      if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return null;
      const key = x + "," + y;
      if (occupied.has(key)) return null;
      occupied.add(key);
      top = Math.min(top, x);
      bottom = Math.max(bottom, x);
      left = Math.min(left, y);
      right = Math.max(right, y);
    }
    const rows = bottom - top + 1;
    const columns = right - left + 1;
    const ruler = [...panel.parentElement.children].find(layer =>
      layer !== panel && layer.classList.contains("aseat-layer-panel") &&
      layer.firstElementChild?.children.length === rows);
    const spacing = bounds.height / rows;
    if (!ruler || !spacing || Math.abs(bounds.width - columns * spacing) > 2) return null;
    return {panel, top, left, width: columns, height: rows};
  }

  function markUnknownPrices(geometry, seats) {
    document.getElementById(overlayId)?.remove();
    const ns = "http://www.w3.org/2000/svg";
    const marker = document.createElementNS(ns, "svg");
    marker.id = overlayId;
    marker.setAttribute("viewBox", `0 0 ${geometry.width} ${geometry.height}`);
    marker.setAttribute("preserveAspectRatio", "none");
    marker.setAttribute("aria-hidden", "true");
    Object.assign(marker.style, {
      position: "absolute", inset: "0", width: "100%", height: "100%",
      pointerEvents: "none", zIndex: "1"
    });
    for (const {points, radius} of unknownPriceRuns(seats, geometry.image)) {
      const coordinates = points.map(({x, y}) => geometry.image
        ? [x, y] : [x - geometry.left + 0.5, y - geometry.top + 0.5]);
      const shape = document.createElementNS(ns, points.length === 1 ? "circle" : "polyline");
      if (points.length === 1) {
        const [[x, y]] = coordinates;
        shape.setAttribute("cx", x);
        shape.setAttribute("cy", y);
        shape.setAttribute("r", radius);
        shape.setAttribute("fill", "#b63822");
        shape.setAttribute("fill-opacity", "0.38");
      } else {
        shape.setAttribute("points", coordinates.map(point => point.join(",")).join(" "));
        shape.setAttribute("fill", "none");
        shape.setAttribute("stroke", "#b63822");
        shape.setAttribute("stroke-opacity", "0.38");
        shape.setAttribute("stroke-width", 2 * radius);
        shape.setAttribute("stroke-linecap", "round");
        shape.setAttribute("stroke-linejoin", "round");
      }
      shape.dataset.seatCount = String(points.length);
      marker.append(shape);
    }
    geometry.panel.append(marker);
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === "devtools-body" && typeof message.body === "string" && message.body.length <= limit * 1.4) {
      try {
        const payload = message.encoding === "base64"
          ? Uint8Array.from(atob(message.body), character => character.charCodeAt(0)).buffer : message.body;
        void accept(message.kind, payload, "DevTools");
      } catch {}
      respond(true);
    } else if (message?.type === "clear-markers") {
      document.getElementById(overlayId)?.remove();
      respond(true);
    } else if (message?.type === "report" || message?.type === "mark-unknown-prices") {
      const data = Object.fromEntries([...latest].map(([kind, entry]) => [kind, entry.data]));
      const displayedPrices = new Set();
      for (const tier of document.querySelectorAll(".price-list .price")) {
        if (tier.querySelector(".price__promotion-tag, .price__discountTag")) continue;
        const text = tier.querySelector(".price__text, .price__package")?.textContent || "";
        const price = text.match(/[¥￥]\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*元/);
        if (price) displayedPrices.add(Math.round(Number(price[1] || price[2]) * 100));
      }
      const normalized = normalize(data, message.profile, displayedPrices);
      const geometry = markerGeometry(normalized.seats);
      const missingPrices = normalized.seats.length - normalized.seats.filter(seat => seat.cents !== null).length;
      if (message.type === "mark-unknown-prices") {
        if (geometry && missingPrices) markUnknownPrices(geometry, normalized.seats);
        respond(Boolean(geometry && missingPrices));
        return;
      }
      respond({
        canMarkUnknownPrices: Boolean(geometry && missingPrices),
        markersVisible: Boolean(document.getElementById(overlayId)),
        performance: document.querySelector(".header-bar__perform--text")?.textContent.trim() ||
          new URL(location.href).searchParams.get("performId"),
        sources: [...latest].map(([kind, {transport, size, time, state}]) => ({kind, transport, size, time, state})),
        report: summarize(normalized),
        warnings: normalized.warnings,
        seats: message.includeSeats ? normalized.seats : undefined
      });
    } else if (message?.type === "download") {
      const entry = latest.get(message.kind);
      if (!entry) { respond(null); return; }
      if (entry.data !== undefined && entry.data !== null && message.format === "json") {
        respond({body: JSON.stringify(entry.data, null, 2), extension: "json"});
      } else if (typeof entry.payload === "string") {
        respond({body: entry.payload, extension: "txt"});
      } else {
        const bytes = new Uint8Array(entry.payload);
        const chunks = [];
        for (let offset = 0; offset < bytes.length; offset += 8192) {
          chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
        }
        respond({body: btoa(chunks.join("")), base64: true, extension: bytes[0] === 31 && bytes[1] === 139 ? "gz" : "bin"});
      }
    }
  });
})();
