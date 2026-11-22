(() => {
  "use strict";

  const sources = {
    "mtop.damai.wireless.seat.dynamicinfo": "dynamic",
    "mtop.damai.wireless.seat.queryperformseatstatus": "status",
    "mtop.damai.wireless.project.getb2b2careainfo": "area"
  };

  function kindOf(value) {
    try {
      const url = new URL(value, "https://m.damai.cn/");
      if (url.origin === "https://seatstatic.damai.cn" &&
          /^\/resources\/xuanzuo\/.*\/seat\.gz$/.test(url.pathname)) return "layout";
      if (url.origin === "https://mtop.damai.cn") {
        const api = url.pathname.match(/^\/h5\/([^/]+)\/[\d.]+\/$/);
        return api && Object.hasOwn(sources, api[1]) ? sources[api[1]] : null;
      }
    } catch {}
    return null;
  }

  function parseText(text) {
    try { return JSON.parse(text); } catch {}
    const wrapped = text.match(/^\s*[$\w.]+\s*\(([\s\S]*)\)\s*;?\s*$/);
    if (wrapped) {
      try { return JSON.parse(wrapped[1]); } catch {}
    }
    return null;
  }

  async function decode(input, kind) {
    if (typeof input === "string") return parseText(input);
    let bytes = new Uint8Array(input);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    const json = parseText(new TextDecoder().decode(bytes));
    return json ?? (kind === "layout" && globalThis.DamaiLayout ? DamaiLayout.decodeLayout(bytes) : null);
  }

  function valueAt(value, path) {
    if (!path || path === "$") return value;
    return path.replace(/^\$\./, "").split(".").reduce((parent, key) => {
      const object = typeof parent === "string" ? parseText(parent) : parent;
      return object != null && Object.hasOwn(object, key) ? object[key] : undefined;
    }, value);
  }

  function records(value, path) {
    const list = valueAt(value, path);
    if (Array.isArray(list)) return list;
    if (list && typeof list === "object") {
      return Object.entries(list).map(([key, entry]) => ({
        ...(entry && typeof entry === "object" ? entry : {}), $key: key, $value: entry
      }));
    }
    return [];
  }

  function idOf(value) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
    return null;
  }

  function fields(record, names) {
    for (const name of names) {
      const value = valueAt(record, name);
      if (value != null && value !== "") return value;
    }
    return undefined;
  }

  function priceInCents(value, divisor = 1) {
    if (typeof value === "string") value = value.trim().replace(/^[¥￥]/, "").replace(/元$/, "").trim();
    if (typeof value === "string" && !/^\d+(\.\d+)?$/.test(value)) return null;
    if (typeof value !== "number" && typeof value !== "string") return null;
    const cents = Number(value) * (100 / divisor);
    if (!Number.isFinite(cents) || cents < 0 || !Number.isSafeInteger(Math.round(cents)) ||
        Math.abs(Math.round(cents) - cents) > 0.000001) return null;
    return Math.round(cents);
  }

  // Discover collections of named records. Compact tuples or encoded binary need a reviewed adapter.
  function collections(root) {
    const found = [];
    function visit(node, path, depth) {
      if (depth > 24 || !node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        if (node.some(value => value && typeof value === "object" && !Array.isArray(value))) {
          found.push({path, rows: node});
        }
        node.forEach((value, index) => visit(value, path + "." + index, depth + 1));
        return;
      }
      // MTop sometimes embeds a JSON object as an escaped string.
      for (const [key, value] of Object.entries(node)) {
        const child = typeof value === "string" && /^[\[{]/.test(value.trim()) ? parseText(value) : value;
        visit(child, path + "." + key, depth + 1);
      }
    }
    visit(root, "$", 0);
    return found;
  }

  const seatIds = ["seatId", "seatID", "seatCode", "seatNoId"];
  const tierIds = ["priceId", "priceLevelId", "skuId", "ticketPriceId", "priceGradeId"];
  const priceFields = ["facePrice", "ticketFacePrice", "originalPrice", "seatPrice"];
  const geometry = ["x", "y", "row", "rowNo", "seatNo", "column", "col", "rowNum", "seatNum"];
  const states = new Map([
    ["available", "available"], ["selectable", "available"], ["onsale", "available"], ["可选", "available"], ["可售", "available"],
    ["sold", "sold"], ["soldout", "sold"], ["已售", "sold"], ["已售出", "sold"],
    ["locked", "locked"], ["已锁定", "locked"], ["锁定", "locked"],
    ["selected", "selected"], ["已选中", "selected"],
    ["unavailable", "unavailable"], ["不可选", "unavailable"], ["notsale", "unavailable"]
  ]);

  function stateOf(value, aliases) {
    const key = idOf(value);
    if (key === null) return "unknown";
    if (aliases && Object.hasOwn(aliases, key) && [...states.values()].includes(aliases[key])) return aliases[key];
    return states.get(key.toLowerCase().replace(/[ _-]/g, "")) || "unknown";
  }

  function autoLayout(data) {
    const matches = collections(data).filter(({rows}) => rows.length && rows.every(row =>
      idOf(fields(row, seatIds)) && geometry.some(key => row[key] != null)));
    // Keep disjoint, per-section collections, but never combine ambiguous duplicate IDs.
    return matches.flatMap(match => match.rows);
  }

  function autoPrices(data) {
    return collections(data).flatMap(({rows}) => rows.filter(row =>
      row && idOf(fields(row, tierIds)) && fields(row, priceFields) != null && !idOf(fields(row, seatIds))));
  }

  function autoStatuses(data) {
    return collections(data).flatMap(({rows}) => rows.filter(row =>
      row && idOf(fields(row, seatIds)) && fields(row, ["seatStatus", "status", "state", "available", "selectable"]) != null));
  }

  function confirmedPrice(value, unit, displayedPrices) {
    if (unit === "yuan" || unit === "fen") return priceInCents(value, unit === "fen" ? 100 : 1);
    if (typeof value === "string" && /[¥￥元]/.test(value)) return priceInCents(value);
    const options = new Set([priceInCents(value), priceInCents(value, 100)]);
    const matches = [...options].filter(option => displayedPrices.has(option));
    return matches.length === 1 ? matches[0] : null;
  }

  function normalize(data, profile = {}, displayedPrices = new Set()) {
    if (data.layout?.format === "damai-protobuf") return DamaiLayout.normalizeLayout(data);
    const layout = profile.layout || {};
    const catalog = profile.prices || {};
    const inventory = profile.status || {};
    const seatRows = Object.hasOwn(layout, "path") ? records(data[layout.source || "layout"], layout.path) : autoLayout(data.layout);
    const priceRows = Object.hasOwn(catalog, "path") ? records(data[catalog.source || "dynamic"], catalog.path) :
      [data.dynamic, data.area, data.layout].flatMap(autoPrices);
    const statusRows = Object.hasOwn(inventory, "path") ? records(data[inventory.source || "status"], inventory.path) : autoStatuses(data.status);
    const warnings = [];
    const prices = new Map();

    for (const row of priceRows) {
      const id = idOf(fields(row, catalog.id ? [catalog.id] : tierIds));
      const cents = confirmedPrice(fields(row, catalog.price ? [catalog.price] : priceFields), catalog.unit, displayedPrices);
      if (!id || cents === null) continue;
      if (prices.has(id) && prices.get(id) !== cents) prices.set(id, null);
      else prices.set(id, cents);
    }

    const statuses = new Map();
    for (const row of statusRows) {
      const id = idOf(fields(row, inventory.id ? [inventory.id] : seatIds));
      if (!id) continue;
      const status = fields(row, inventory.value ? [inventory.value] : ["seatStatus", "status", "state"]);
      const selectable = fields(row, ["selectable", "available"]);
      const state = status == null && typeof selectable === "boolean" && !inventory.value
        ? (selectable ? "available" : "unavailable") : stateOf(status, inventory.codes);
      if (statuses.has(id) && statuses.get(id) !== state) statuses.set(id, "unknown");
      else statuses.set(id, state);
    }

    const seats = new Map();
    const duplicates = new Set();
    let missingId = 0;
    for (const row of seatRows) {
      const id = idOf(fields(row, layout.id ? [layout.id] : seatIds));
      if (!id) { missingId++; continue; }
      const tier = idOf(fields(row, layout.tier ? [layout.tier] : tierIds));
      const directValue = fields(row, layout.price ? [layout.price] : priceFields);
      const direct = confirmedPrice(directValue, layout.unit, displayedPrices);
      const linked = prices.get(tier) ?? null;
      const cents = direct !== null && linked !== null && direct !== linked ? null : (direct ?? linked);
      const seat = {
        id, tier, cents, state: statuses.get(id) || "unknown",
        section: fields(row, ["sectionName", "floorName", "areaName", "floorId", "areaId"]) ?? "",
        row: fields(row, ["rowNo", "rowName", "rowNum", "row"]) ?? "",
        number: fields(row, ["seatNo", "seatNum", "column", "col"]) ?? ""
      };
      if (seats.has(id)) duplicates.add(id);
      else seats.set(id, seat);
    }
    for (const id of duplicates) seats.delete(id);
    if (duplicates.size) warnings.push(`有 ${duplicates.size} 个重复座位 ID 已排除，请核对座位主键。`);
    if (missingId) warnings.push(`有 ${missingId} 条布局记录缺少可用的座位 ID。`);
    if (!seats.size) warnings.push("尚未识别出逐座布局，可能需要根据响应字段设置映射。");
    if (seats.size && !statuses.size) warnings.push("尚未识别到逐座库存记录，全部状态暂列未知。");
    if (statuses.size && ![...seats.keys()].some(id => statuses.has(id))) warnings.push("库存与布局的座位 ID 尚未匹配。");
    if ([...seats.values()].some(seat => seat.cents === null)) warnings.push("部分座位缺少可核实的票价或价格单位。");
    return {seats: [...seats.values()], warnings, layoutComplete: profile.layoutComplete === true && !duplicates.size && !missingId};
  }

  function summarize({seats, layoutComplete}) {
    const tiers = new Map();
    let totalCents = 0;
    let priced = 0;
    let availableCents = 0;
    let availablePriced = 0;
    const counts = {total: 0, available: 0, sold: 0, locked: 0, selected: 0, unavailable: 0, unknown: 0};
    for (const seat of seats) {
      const row = tiers.get(seat.cents) || {...Object.fromEntries(Object.keys(counts).map(k => [k, 0])), cents: seat.cents};
      for (const target of [counts, row]) {
        target.total++;
        target[seat.state]++;
      }
      tiers.set(seat.cents, row);
      if (seat.cents !== null) {
        priced++;
        totalCents += seat.cents;
        if (seat.state === "available") {
          availablePriced++;
          availableCents += seat.cents;
        }
      }
    }
    return {
      tiers: [...tiers.values()].sort((a, b) => (a.cents ?? Infinity) - (b.cents ?? Infinity)),
      counts, priced, availablePriced, fullAverage: layoutComplete && priced > 0 && counts.total === priced,
      average: priced ? totalCents / priced / 100 : null,
      availableAverage: availablePriced ? availableCents / availablePriced / 100 : null
    };
  }

  function unknownPriceRuns(seats, imageCoordinates) {
    const stands = new Map();
    for (const seat of seats) {
      const standId = imageCoordinates ? seat.standId : 0;
      if (!stands.has(standId)) stands.set(standId, []);
      stands.get(standId).push(seat);
    }

    const runs = [];
    for (const stand of stands.values()) {
      const rows = new Map();
      for (const seat of stand) {
        // If the layout omits a row label, a single marker remains safe.
        const row = imageCoordinates ? (seat.row || Symbol()) : seat.x;
        if (!rows.has(row)) rows.set(row, []);
        rows.get(row).push(seat);
      }
      const column = seat => imageCoordinates ? seat.x : seat.y;
      const depth = seat => imageCoordinates ? seat.y : seat.x;

      for (const row of rows.values()) {
        row.sort((a, b) => column(a) - column(b));
        let run = null;
        for (const seat of row) {
          if (seat.cents !== null) {
            run = null;
            continue;
          }
          let pitch = 1;
          if (imageCoordinates) {
            let nearest = Infinity;
            for (const other of stand) {
              const distance = (other.x - seat.x) ** 2 + (other.y - seat.y) ** 2;
              if (distance > 0 && distance < nearest) nearest = distance;
            }
            pitch = Number.isFinite(nearest) ? Math.sqrt(nearest) : 16;
          }
          const point = {x: column(seat), y: depth(seat), pitch};
          const last = run?.points.at(-1);
          if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 1.35 * Math.min(pitch, last.pitch)) {
            run = {points: [], radius: pitch * 0.38};
            runs.push(run);
          }
          run.points.push(point);
          run.radius = Math.min(run.radius, pitch * 0.38);
        }
      }
    }
    return runs;
  }

  globalThis.DamaiSeat = {kindOf, decode, parseText, normalize, summarize, unknownPriceRuns};
})();
