(() => {
  // ../../../packages/capyclaw-document-workbench/src/client/index.mjs
  var DEFAULTS = {
    pollTimeoutSec: 3,
    claimRetryMs: 800,
    activeClaimRetryMs: 1500,
    heartbeatMs: 3e3,
    stateDebounceMs: 800,
    errorRetryMs: 500,
    shotIdleMs: 3e3
  };
  var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function createEditorClient({
    api,
    apiBase = "",
    clientId,
    adapter,
    authority = "server",
    documentKey = "document",
    documentPath = "/document",
    storage = typeof localStorage !== "undefined" ? localStorage : null,
    workerFactory = null,
    heartbeatWorkerUrl = "./heartbeat-worker.js",
    singletonKey = "document-workbench-singleton",
    intervals = {},
    onStatus = () => {
    },
    onNote = () => {
    }
  } = {}) {
    if (typeof api !== "function") throw new Error("createEditorClient 需要 api(path, init)");
    if (!adapter || typeof adapter.load !== "function" || typeof adapter.dump !== "function") {
      throw new Error("createEditorClient 需要 adapter.load / adapter.dump");
    }
    if (authority !== "server" && authority !== "editor") {
      throw new Error("authority 只能是 server 或 editor");
    }
    const timing = { ...DEFAULTS, ...intervals };
    const st = {
      clientId,
      active: false,
      stopped: false,
      heartbeat: null,
      heartbeatWorker: null,
      lastSeq: 0,
      lastShotReq: 0,
      lastUiSeq: 0,
      busy: false,
      shooting: false,
      pumping: false,
      watching: false,
      onchange: null,
      unsubscribe: null,
      stateTimer: null,
      shotCache: null,
      singletonKey,
      pendingShotReq: null
    };
    const note = (message, kind = "") => onNote(message, kind);
    const badge = (text, kind = "") => onStatus(text, kind);
    function request(path, init) {
      return api(path, init);
    }
    function post(path, body) {
      return request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    }
    async function claim(force) {
      try {
        const meta = typeof adapter.meta === "function" ? adapter.meta() : null;
        const result = await post("/claim", {
          id: st.clientId,
          force: !!force,
          ...meta && typeof meta === "object" ? { meta } : {}
        });
        return !!(result && result.ok);
      } catch {
        return false;
      }
    }
    async function ensureLinked() {
      for (; ; ) {
        if (await claim(true)) return;
        await sleep(600);
      }
    }
    async function restore() {
      try {
        const doc = await request("");
        const value = doc && doc[documentKey];
        if (value !== void 0 && value !== null) await adapter.load(value);
        st.lastSeq = Number(doc && doc.seq) || 0;
        st.lastUiSeq = Number(doc && doc.ui_seq) || 0;
        return doc;
      } catch {
        return null;
      }
    }
    async function activate() {
      if (st.active) return;
      st.stopped = false;
      st.active = true;
      try {
        storage?.setItem(st.singletonKey, st.clientId);
      } catch {
      }
      badge("", "ok");
      note("");
      watch();
      pump();
      startHeartbeatWorker();
      try {
        const status = await request("/status");
        if (status && status.shot_req > 0 && (!status.shot || (status.shot.req | 0) < status.shot_req)) {
          st.lastShotReq = status.shot_req;
          shoot(status.shot_req);
        }
      } catch {
      }
    }
    async function claimLoop() {
      if (storage && typeof window !== "undefined" && window.addEventListener) {
        window.addEventListener("storage", (event) => {
          if (event.key === st.singletonKey && event.newValue && event.newValue !== st.clientId) {
            if (st.active) {
              st.active = false;
              stopHeartbeatWorker();
              badge("", "standby");
              note("");
            }
          }
        });
      }
      let firstClaim = true;
      for (; ; ) {
        if (st.stopped) break;
        if (!st.active) {
          if (await claim(firstClaim)) {
            firstClaim = false;
            await activate();
          } else {
            firstClaim = false;
            badge("", "standby");
            note("");
          }
        }
        await sleep(st.active ? timing.activeClaimRetryMs : timing.claimRetryMs);
      }
    }
    async function apply(doc) {
      st.busy = true;
      let applied = 0;
      let error = "";
      try {
        applied = await adapter.apply(doc.cmds || []);
        if (!Number.isFinite(applied)) applied = (doc.cmds || []).length;
      } catch (caught) {
        error = String(caught && caught.message || caught);
        if (!adapter.isMounted?.()) st.lastSeq = 0;
      }
      try {
        await post("/ack", { seq: doc.seq, applied, error });
      } catch {
      }
      st.busy = false;
      note(error ? `第 ${doc.seq} 队应用失败：${error}` : `第 ${doc.seq} 队已应用（${applied} 条）`, error ? "error" : "ok");
      Promise.resolve().then(() => pushState(doc.seq)).catch(() => {
      });
    }
    async function applyLocal(commands) {
      st.busy = true;
      try {
        await adapter.apply(commands || []);
        await pushState();
      } finally {
        st.busy = false;
      }
    }
    async function pumpOnce() {
      if (!st.active) return false;
      const doc = await request(`/watch?seq=${st.lastSeq}&shot=${st.lastShotReq}&ui=${st.lastUiSeq}&timeout=${timing.pollTimeoutSec}`);
      if (!doc) return false;
      if ((doc.shot_req | 0) < (st.lastShotReq | 0)) st.lastShotReq = doc.shot_req | 0;
      if (doc.shot_req && doc.shot_req > st.lastShotReq) {
        st.lastShotReq = doc.shot_req;
        shoot(doc.shot_req);
      }
      if ((doc.seq | 0) !== (st.lastSeq | 0)) {
        st.lastSeq = doc.seq | 0;
        if (authority === "editor") {
          if (doc.cmds && doc.cmds.length) await apply(doc);
        } else if (st.lastSeq > 0) {
          st.busy = true;
          try {
            const mirror = await request(documentPath);
            const value = mirror && mirror[documentKey];
            if (value !== void 0) await adapter.load(value);
          } catch {
          } finally {
            st.busy = false;
          }
        }
      }
      if ((doc.ui_seq | 0) > (st.lastUiSeq | 0)) {
        st.lastUiSeq = doc.ui_seq | 0;
        st.busy = true;
        try {
          const uiDoc = await request("/ui");
          await adapter.applyUi?.(uiDoc.ui || []);
        } catch {
        } finally {
          st.busy = false;
        }
      }
      return true;
    }
    async function pump() {
      if (st.pumping) return;
      st.pumping = true;
      try {
        for (; ; ) {
          if (st.stopped) break;
          if (!st.active) {
            await sleep(1500);
            continue;
          }
          try {
            await pumpOnce();
          } catch {
            await sleep(timing.errorRetryMs);
          }
        }
      } finally {
        st.pumping = false;
      }
    }
    async function shoot(req) {
      if (st.shooting) {
        st.pendingShotReq = req;
        return;
      }
      st.shooting = true;
      try {
        const idleDeadline = Date.now() + timing.shotIdleMs;
        while (st.busy && Date.now() < idleDeadline) await sleep(100);
        let current = req;
        for (; ; ) {
          let data = "";
          for (let attempt = 0; attempt < 2 && !data; attempt++) {
            try {
              data = await adapter.renderScreenshot();
            } catch {
              await sleep(400);
            }
          }
          if (!data) {
            try {
              await post("/shot-result", { req: current, data: "" });
            } catch {
            }
            throw new Error("画面渲染为空");
          }
          st.shotCache = data;
          await post("/shot-result", { req: current, data });
          if (st.pendingShotReq && st.pendingShotReq !== current) {
            current = st.pendingShotReq;
            st.pendingShotReq = null;
            continue;
          }
          break;
        }
      } catch (caught) {
        badge("", "error");
        note("截图失败：" + String(caught && caught.message || caught));
      } finally {
        st.shooting = false;
        st.pendingShotReq = null;
      }
    }
    function watch() {
      if (st.watching || typeof adapter.onChange !== "function") return;
      st.watching = true;
      st.onchange = () => {
        clearTimeout(st.stateTimer);
        st.stateTimer = setTimeout(() => {
          pushState().catch(() => {
          });
        }, timing.stateDebounceMs);
      };
      st.unsubscribe = adapter.onChange(st.onchange) || null;
    }
    async function pushState(seq) {
      if (!st.active) return;
      if (adapter.isMounted && !adapter.isMounted()) return;
      try {
        const body = { [documentKey]: adapter.dump() };
        if (seq != null) body.seq = Number(seq);
        else if (st.lastSeq) body.seq = Number(st.lastSeq);
        await post("/state", body);
      } catch {
      }
    }
    function release() {
      try {
        if (typeof navigator !== "undefined" && navigator.sendBeacon) {
          const body = new Blob([JSON.stringify({ id: st.clientId })], { type: "application/json" });
          navigator.sendBeacon(apiBase + "/release", body);
          return;
        }
        post("/release", { id: st.clientId }).catch(() => {
        });
      } catch {
      }
    }
    function startHeartbeatWorker() {
      if (st.heartbeatWorker) return;
      try {
        const worker = workerFactory ? workerFactory() : typeof Worker !== "undefined" ? new Worker(heartbeatWorkerUrl) : null;
        if (!worker) {
          startFallbackHeartbeat();
          return;
        }
        st.heartbeatWorker = worker;
        if (st.heartbeat) {
          clearInterval(st.heartbeat);
          st.heartbeat = null;
        }
        worker.onmessage = (event) => {
          if ((event.data || {}).type === "error") {
            stopHeartbeatWorker();
            startFallbackHeartbeat();
          }
        };
        worker.onerror = () => {
          stopHeartbeatWorker();
          startFallbackHeartbeat();
        };
        worker.postMessage({ type: "start", data: { clientId: st.clientId, apiBase } });
      } catch {
        startFallbackHeartbeat();
      }
    }
    function stopHeartbeatWorker() {
      if (st.heartbeatWorker) {
        try {
          st.heartbeatWorker.postMessage({ type: "stop" });
        } catch {
        }
        try {
          st.heartbeatWorker.terminate();
        } catch {
        }
        st.heartbeatWorker = null;
      }
      if (st.heartbeat) {
        clearInterval(st.heartbeat);
        st.heartbeat = null;
      }
    }
    function startFallbackHeartbeat() {
      if (st.heartbeat) return;
      st.heartbeat = setInterval(async () => {
        if (!st.active) return;
        const ok = await claim();
        if (!ok) {
          st.active = false;
          badge("", "standby");
          note("");
        }
      }, timing.heartbeatMs);
    }
    function stop() {
      st.stopped = true;
      st.active = false;
      clearTimeout(st.stateTimer);
      st.stateTimer = null;
      stopHeartbeatWorker();
      try {
        st.unsubscribe?.();
      } catch {
      }
      st.unsubscribe = null;
      st.watching = false;
    }
    return {
      state: st,
      claim,
      ensureLinked,
      restore,
      activate,
      claimLoop,
      apply,
      applyLocal,
      pumpOnce,
      pump,
      shoot,
      watch,
      pushState,
      release,
      startHeartbeatWorker,
      stopHeartbeatWorker,
      startFallbackHeartbeat,
      stop,
      note,
      badge
    };
  }

  // src/editor/screenshot.js
  var MAX_PAGES = 12;
  var MAX_HEIGHT = 16e3;
  function renderSheet(getRoot = () => document) {
    const root = getRoot();
    if (!root) return "";
    const canvases = [...root.querySelectorAll("canvas")].filter((c) => c.width > 0 && c.height > 0);
    if (!canvases.length) return "";
    const pages = canvases.slice(0, MAX_PAGES);
    const width = Math.max(...pages.map((c) => c.width));
    let height = pages.reduce((n, c) => n + c.height, 0);
    let scale = 1;
    if (height > MAX_HEIGHT) {
      scale = MAX_HEIGHT / height;
      height = MAX_HEIGHT;
    }
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.floor(width * scale));
    out.height = Math.max(1, Math.floor(height));
    const g = out.getContext("2d");
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, out.width, out.height);
    let y = 0;
    for (const c of pages) {
      g.drawImage(c, 0, Math.floor(y), Math.floor(c.width * scale), Math.floor(c.height * scale));
      y += c.height * scale;
    }
    return out.toDataURL("image/jpeg", 0.85);
  }

  // src/editor/session.js
  var API_BASE = "/api/desktop/works/canvas-bridge";
  var BRIDGE_HANDLERS = {
    setValue(app, args) {
      app.load(args[0]);
    },
    clear(app) {
      app.load({ header: [], main: [], footer: [] });
    },
    appendElementList(app, args) {
      const doc = app.dump().data;
      doc.main = (doc.main || []).concat(args[0] || []);
      app.load(doc);
    }
  };
  function createEditorSession({
    api,
    ui: ui2,
    clientId,
    getApp = () => window.CanvasApp,
    apiBase = API_BASE,
    editorRoot = () => document
  }) {
    const adapter = {
      isMounted() {
        const app = getApp();
        return !!(app && app.isMounted && app.isMounted());
      },
      meta() {
        return { app: "canvas-editor", capabilities: ["block-write", "exec-commands", "table", "image"] };
      },
      async load(doc) {
        await getApp().load(doc);
      },
      dump() {
        return getApp().dump().data;
      },
      async apply(commands) {
        const app = getApp();
        let applied = 0;
        for (const command of commands || []) {
          const { cmd, args = [] } = command;
          const bridge = BRIDGE_HANDLERS[cmd];
          if (bridge) {
            bridge(app, args);
          } else {
            await app.exec(cmd, ...args);
          }
          applied += 1;
        }
        return applied;
      },
      async applyUi(commands) {
        return adapter.apply(commands);
      },
      onChange(handler) {
        const app = getApp();
        if (!app || typeof app.on !== "function") return null;
        app.on("change", handler);
        return () => {
          try {
            app.off?.("change", handler);
          } catch {
          }
        };
      },
      renderScreenshot() {
        return renderSheet(editorRoot);
      }
    };
    const client = createEditorClient({
      api,
      apiBase,
      clientId,
      adapter,
      authority: "editor",
      documentKey: "doc",
      documentPath: "/doc",
      storage: typeof localStorage !== "undefined" ? localStorage : null,
      heartbeatWorkerUrl: "./heartbeat-worker.js",
      singletonKey: "canvas-workbench-singleton",
      onStatus: ui2.badge,
      onNote: ui2.note
    });
    return client;
  }

  // src/editor/transport.js
  function createTransport(basePath, fetchImpl = (...args) => fetch(...args)) {
    const api = (path, options) => fetchImpl(basePath + path, options).then((response) => response.json());
    return {
      api,
      get: (path) => api(path),
      post: (path, body) => api(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      })
    };
  }

  // src/editor/ui.js
  function createUi({ root = document } = {}) {
    let timer = null;
    const find = (selector) => root.querySelector(selector);
    return {
      note(message) {
        const element = find("[data-note]");
        if (!element) return;
        element.textContent = message || "";
        clearTimeout(timer);
        if (message && !/失败|错误|未连接|未就绪|不能/.test(message)) {
          timer = setTimeout(() => {
            if (element.textContent === message) element.textContent = "";
          }, 4e3);
        }
      },
      badge(text, kind) {
        const element = find("[data-badge]");
        if (!element) return;
        element.textContent = text || "";
        element.dataset.kind = kind || "";
      }
    };
  }

  // src/editor/main.js
  var API_BASE2 = "/api/desktop/works/canvas-bridge";
  var $ = (sel) => document.querySelector(sel);
  var transport = createTransport(API_BASE2);
  var ui = createUi();
  var session = createEditorSession({
    api: transport.api,
    ui,
    clientId: "cw_" + Date.now() + "_" + Math.floor(Math.random() * 1e6)
  });
  var Studio = {
    async bootEditor() {
      const box = $("[data-editor]");
      window.__BOOT = { steps: [], at: Date.now() };
      const trace = (step) => {
        window.__BOOT.steps.push(step);
        try {
          console.info("[canvas-wb] " + step);
        } catch {
        }
      };
      try {
        if (typeof window.CanvasApp === "undefined") throw new Error("canvas-full-app.js 未加载");
        trace("mount:start");
        if (typeof window.onload !== "function") window.onload = function() {
        };
        await window.CanvasApp.mount(box, { width: 794, height: 1123, mode: "edit", pageMode: "paging" });
        trace("mount:done");
        await session.restore();
        trace("restore:done");
        await session.ensureLinked();
        trace("link:done");
        await session.activate();
        trace("activate:done");
        const veil = $("[data-veil]");
        if (veil) {
          veil.style.opacity = "0";
          setTimeout(() => veil.remove(), 260);
        }
        trace("claimLoop:start");
        session.claimLoop();
        trace("boot:done");
      } catch (e) {
        trace("error:" + String(e && e.message || e));
        const note = $("[data-editor-note]");
        if (note) note.innerHTML = "编辑器装载失败：" + esc(String(e && e.message || e)) + '<br><button data-act="retry" style="margin-top:8px">重试</button>';
      }
    }
  };
  function esc(s) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }
  window.addEventListener("pagehide", session.release);
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    const app = window.CanvasApp;
    if (act === "retry") {
      location.reload();
      return;
    }
    if (!app || !app.isMounted || !app.isMounted()) {
      session.note("编辑器未就绪");
      return;
    }
    if (act === "print") app.print();
    if (act === "undo") app.undo();
    if (act === "redo") app.redo();
    if (act === "continuous" || act === "paging") app.setPageMode(act);
  });
  window.__CANVAS_DEBUG = { session, Studio };
  Studio.bootEditor();
})();
