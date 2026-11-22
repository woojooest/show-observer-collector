(() => {
  "use strict";

  // The gzip payload is a protobuf message with repeated stand records.
  function message(bytes) {
    let offset = 0;
    function varint() {
      let value = 0;
      let factor = 1;
      while (offset < bytes.length && Number.isSafeInteger(factor)) {
        const byte = bytes[offset++];
        value += (byte & 127) * factor;
        if (!Number.isSafeInteger(value)) break;
        if (byte < 128) return value;
        factor *= 128;
      }
      throw new Error("Invalid protobuf varint");
    }
    const fields = new Map();
    while (offset < bytes.length) {
      const tag = varint();
      const number = Math.floor(tag / 8);
      const type = tag % 8;
      if (!number) throw new Error("Invalid protobuf field");
      let value;
      if (type === 0) {
        value = varint();
      } else {
        const size = type === 2 ? varint() : type === 1 ? 8 : type === 5 ? 4 : -1;
        if (size < 0 || size > bytes.length - offset) throw new Error("Invalid protobuf field length");
        value = bytes.subarray(offset, offset + size);
        offset += size;
      }
      if (!fields.has(number)) fields.set(number, []);
      fields.get(number).push(value);
    }
    return fields;
  }

  const decoder = new TextDecoder("utf-8", {fatal: true});
  const one = (fields, key) => fields.get(key)?.[0];
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const text = (fields, key) => {
    const bytes = one(fields, key);
    if (bytes === undefined) return "";
    if (!(bytes instanceof Uint8Array)) throw new Error("Invalid seat label");
    return decoder.decode(bytes);
  };

  function decodeLayout(bytes) {
    const root = message(bytes);
    const stands = root.get(1);
    if (!stands?.length || !stands.every(value => value instanceof Uint8Array)) return null;
    const standIds = new Set();
    const seatIds = new Set();
    const groups = [];
    for (const value of stands) {
      const stand = message(value);
      const id = one(stand, 1);
      const rows = stand.get(2);
      if (!integer(id) || !id || standIds.has(id) || !rows?.length ||
          !rows.every(value => value instanceof Uint8Array)) return null;
      standIds.add(id);
      const indexes = new Set();
      const seats = [];
      for (const row of rows) {
        const seat = message(row);
        const seatId = one(seat, 1);
        const x = one(seat, 2) ?? 0;
        const y = one(seat, 3) ?? 0;
        const tier = one(seat, 4);
        const index = one(seat, 11) ?? 0;
        const number = text(seat, 7);
        const rowLabel = text(seat, 8);
        const section = text(seat, 9);
        if (!integer(seatId) || !seatId || !integer(x) || !integer(y) ||
            (tier !== undefined && !integer(tier)) || !integer(index) || index >= rows.length ||
            seatIds.has(seatId) || indexes.has(index) || !number || !rowLabel) return null;
        indexes.add(index);
        seatIds.add(seatId);
        seats.push({seatId, x, y, priceId: tier || null, number, row: rowLabel, section, index});
      }
      groups.push({standId: id, seats});
    }
    return {format: "damai-protobuf", groups};
  }

  function expandStatus(value, count) {
    if (typeof value !== "string") return null;
    const tokens = value.match(/\(\d+,\d\)|\d/g);
    if (!tokens || tokens.join("") !== value) return null;
    let result = "";
    for (const token of tokens) {
      const match = token.match(/^\((\d+),(\d)\)$/);
      const length = match ? Number(match[1]) : 1;
      if (!Number.isSafeInteger(length) || length < 1 || result.length + length > count) return null;
      result += (match ? match[2] : token).repeat(length);
    }
    return result.length === count ? result : null;
  }

  function normalizeLayout(data) {
    const groups = data.layout.groups;
    const catalog = new Map();
    const warnings = [];
    for (const tier of data.dynamic?.data?.priceList || []) {
      if (tier.priceType !== 0 || !integer(tier.priceId) || !integer(tier.oriPrice) || !tier.oriPrice) continue;
      if (catalog.has(tier.priceId) && catalog.get(tier.priceId) !== tier.oriPrice) catalog.set(tier.priceId, null);
      else catalog.set(tier.priceId, tier.oriPrice);
    }

    const seats = [];
    let invalidStatus = 0;
    let unassigned = 0;
    let unmapped = 0;
    for (const group of groups) {
      const values = expandStatus(data.status?.data?.seatStatus?.[group.standId], group.seats.length);
      if (values === null) invalidStatus++;
      for (const seat of group.seats) {
        const cents = catalog.get(seat.priceId) ?? null;
        if (!seat.priceId) unassigned++;
        else if (cents === null) unmapped++;
        const code = values?.[seat.index];
        const state = code === "2" ? "available" : code === "8" ? "unavailable" : "unknown";
        seats.push({
          id: String(seat.seatId), tier: seat.priceId ? String(seat.priceId) : null, cents, state,
          section: seat.section, row: seat.row, number: seat.number,
          standId: group.standId, x: seat.x, y: seat.y, code
        });
      }
    }
    if (invalidStatus) warnings.push(`${invalidStatus} 个分区的状态缺失或长度不匹配。`);
    if (unassigned) warnings.push(`${unassigned} 个位置在座位图中没有分配票档，未计入票面均价。`);
    if (unmapped) warnings.push(`${unmapped} 个座位的票档未匹配到票面价。`);
    return {seats, warnings, layoutComplete: true};
  }

  globalThis.DamaiLayout = {decodeLayout, expandStatus, normalizeLayout};
})();
