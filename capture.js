(() => {
  "use strict";
  // Kept in this entry point so the MAIN-world hook starts independently.
  function kindOf(input) {
    try {
      const url = new URL(input, location.href);
      if (url.origin === "https://seatstatic.damai.cn" &&
          /^\/resources\/xuanzuo\/.*\/seat\.gz$/.test(url.pathname)) return "layout";
      if (url.origin !== "https://mtop.damai.cn") return null;
      const api = url.pathname.match(/^\/h5\/mtop\.damai\.wireless\.([^/]+)\/[\d.]+\/?$/)?.[1];
      switch (api) {
        case "seat.dynamicinfo": return "dynamic";
        case "seat.queryperformseatstatus": return "status";
        case "project.getb2b2careainfo": return "area";
        default: return null;
      }
    } catch { return null; }
  }
  const limit = 12 * 1024 * 1024;
  const publish = (kind, payload, transport) => {
    window.postMessage({source: "damai-seat-capture", kind, payload, transport}, location.origin);
  };

  const fetch = window.fetch;
  window.fetch = function (...args) {
    const request = args[0];
    const kind = kindOf(request instanceof Request ? request.url : request);
    const result = Reflect.apply(fetch, this, args);
    if (kind) result.then(response => {
      if (!response.ok || Number(response.headers.get("content-length")) > limit) return;
      return response.clone().arrayBuffer().then(bytes => {
        if (bytes.byteLength <= limit) publish(kind, bytes, "fetch");
      });
    }).catch(() => {});
    return result;
  };

  const xhrUrls = new WeakMap();
  const xhr = XMLHttpRequest.prototype;
  const open = xhr.open;
  const send = xhr.send;

  xhr.open = function (...args) {
    const result = Reflect.apply(open, this, args);
    xhrUrls.set(this, kindOf(args[1]));
    return result;
  };
  xhr.send = function (...args) {
    const kind = xhrUrls.get(this);
    if (kind) this.addEventListener("load", () => {
      if (this.status < 200 || this.status >= 300) return;
      try {
        if (this.responseType === "arraybuffer" && this.response?.byteLength <= limit) {
          publish(kind, this.response, "XHR");
        } else if (this.responseType === "blob" && this.response?.size <= limit) {
          this.response.arrayBuffer().then(bytes => publish(kind, bytes, "XHR")).catch(() => {});
        } else if (this.responseType === "json") {
          const payload = JSON.stringify(this.response);
          if (payload?.length <= limit) publish(kind, payload, "XHR");
        } else if (!this.responseType || this.responseType === "text") {
          if (this.responseText.length <= limit) publish(kind, this.responseText, "XHR");
        }
      } catch {}
    }, {once: true});
    return Reflect.apply(send, this, args);
  };

  // Some MTop calls use script tags and JSONP callbacks.
  const wrapped = new WeakSet();
  function observeJsonp(script) {
    if (!(script instanceof HTMLScriptElement) || !script.src) return;
    const kind = kindOf(script.src);
    if (!kind || kind === "layout") return;
    const callback = new URL(script.src).searchParams.get("callback");
    if (!/^[$a-zA-Z_][\w$]*(\.[$a-zA-Z_][\w$]*)*$/.test(callback || "")) return;
    const segments = callback.split(".");
    if (segments.some(key => ["__proto__", "constructor", "prototype"].includes(key))) return;
    const name = segments.pop();
    try {
      const owner = segments.reduce((value, key) => value?.[key], window);
      const original = owner?.[name];
      if (typeof original !== "function" || wrapped.has(original)) return;
      function observed(...args) {
        try {
          const payload = JSON.stringify(args[0]);
          if (payload?.length <= limit) publish(kind, payload, "JSONP");
        } catch {}
        return Reflect.apply(original, this, args);
      }
      owner[name] = observed;
      wrapped.add(observed);
    } catch {}
  }

  new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") observeJsonp(mutation.target);
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        observeJsonp(node);
        for (const script of node.querySelectorAll("script[src]")) observeJsonp(script);
      }
    }
  }).observe(document, {attributes: true, attributeFilter: ["src"], childList: true, subtree: true});
})();
