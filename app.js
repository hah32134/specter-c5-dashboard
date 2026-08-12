const UUIDS = {
  service: "7e570001-5eec-4c51-9a11-c5c5c5c5c5c5",
  command: "7e570002-5eec-4c51-9a11-c5c5c5c5c5c5",
  telemetry: "7e570003-5eec-4c51-9a11-c5c5c5c5c5c5",
};

const state = {
  connected: false,
  authenticated: false,
  reconnecting: false,
  manualReconnect: false,
  demo: false,
  mode: "atlas",
  aps: new Map(),
  bleDevices: new Map(),
  trail: [],
  incidents: [],
  setupAps: new Map(),
  security: { claimed: false, claimWindow: false, nonce: "" },
  map: { active: false, checkpoint: false, x: .5, y: .5, heading: 0, steps: 0, confidence: 0, samples: [], floorPlan: null, lastStep: 0, lastSample: 0, lastProbe: 0 },
  gpsWatch: null,
  gpsAccuracy: null,
  lastGpsIds: new Set(),
  scan: { active: false, done: 0, total: 0, phase: "ready" },
  status: {
    wifi: false, gateway: false, internet: false, dns: false,
    rssi: -127, channel: 0, wifi_2g: 0, wifi_5g: 0,
    deauth: 0, disconnects: 0, beacon_timeouts: 0,
    score: 0, classification: "not_armed", uptime: 0,
  },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let toastTimer;
let demoTimer;
let scanFinishTimer;

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2600);
}

class SpecterBLE {
  device = null;
  command = null;
  telemetry = null;
  input = "";
  connecting = false;
  reconnectTimer = null;
  reconnectAttempt = 0;
  initialScanSent = false;
  disconnectListener = () => this.onDisconnect();
  telemetryListener = (event) => this.receive(event.target.value);

  async connect(fresh = false) {
    if (!navigator.bluetooth) throw new Error("Web Bluetooth is unavailable. On iPhone, open this page in Bluefy.");
    if (fresh) this.releaseStaleDevice();
    if (!this.device) {
      this.setDevice(await navigator.bluetooth.requestDevice({
        filters: [{ services: [UUIDS.service] }, { namePrefix: "SPECTER" }],
        optionalServices: [UUIDS.service],
      }));
    }
    await this.connectDevice();
  }

  setDevice(device) {
    if (this.device) this.device.removeEventListener("gattserverdisconnected", this.disconnectListener);
    this.device = device;
    this.reconnectAttempt = 0;
    state.manualReconnect = false;
    this.device.addEventListener("gattserverdisconnected", this.disconnectListener);
    try { localStorage.setItem("specter-device-id", device.id); } catch {}
  }

  async connectDevice() {
    if (!this.device || this.connecting || state.connected) return;
    this.connecting = true;
    this.clearReconnectTimer();
    state.reconnecting = true;
    updateConnection();
    try {
      const server = this.device.gatt.connected ? this.device.gatt : await this.device.gatt.connect();
      const service = await server.getPrimaryService(UUIDS.service);
      this.command = await service.getCharacteristic(UUIDS.command);
      this.telemetry = await service.getCharacteristic(UUIDS.telemetry);
      this.telemetry.removeEventListener("characteristicvaluechanged", this.telemetryListener);
      await this.telemetry.startNotifications();
      this.telemetry.addEventListener("characteristicvaluechanged", this.telemetryListener);
      state.connected = true;
      state.authenticated = false;
      state.reconnecting = false;
      state.manualReconnect = false;
      state.demo = false;
      this.reconnectAttempt = 0;
      clearInterval(demoTimer);
      updateConnection();
      await this.send({ cmd: "hello" });
    } catch (error) {
      state.connected = false;
      state.reconnecting = Boolean(this.device);
      this.command = null;
      this.telemetry = null;
      updateConnection();
      throw error;
    } finally {
      this.connecting = false;
      if (!state.connected && this.device) this.scheduleReconnect();
    }
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  releaseStaleDevice() {
    this.clearReconnectTimer();
    try { this.telemetry?.removeEventListener("characteristicvaluechanged", this.telemetryListener); } catch {}
    if (this.device) this.device.removeEventListener("gattserverdisconnected", this.disconnectListener);
    try { if (this.device?.gatt?.connected) this.device.gatt.disconnect(); } catch {}
    this.device = null; this.command = null; this.telemetry = null; this.input = "";
    this.reconnectAttempt = 0; this.initialScanSent = false;
    state.connected = false; state.authenticated = false; state.reconnecting = false; state.manualReconnect = false;
    try { localStorage.removeItem("specter-device-id"); } catch {}
  }

  scheduleReconnect(delay) {
    if (!this.device || state.connected || this.connecting || this.reconnectTimer) return;
    if (this.reconnectAttempt >= 3) {
      state.reconnecting = false;
      state.manualReconnect = true;
      updateConnection();
      toast("Bluefy needs a fresh device selection — tap Reconnect C5");
      return;
    }
    state.reconnecting = true;
    updateConnection();
    const wait = delay ?? Math.min(1000 * (2 ** this.reconnectAttempt), 15000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (document.visibilityState === "hidden") return this.scheduleReconnect(1500);
      try {
        await this.connectDevice();
        toast("SPECTER reconnected");
      } catch (error) {
        console.warn("SPECTER reconnect failed", error);
        this.scheduleReconnect();
      }
    }, wait);
  }

  async restore() {
    if (!navigator.bluetooth?.getDevices) return;
    try {
      const devices = await navigator.bluetooth.getDevices();
      const remembered = localStorage.getItem("specter-device-id");
      const device = devices.find((item) => item.id === remembered) || devices.find((item) => item.name?.startsWith("SPECTER"));
      if (device) {
        this.setDevice(device);
        this.scheduleReconnect(100);
      }
    } catch (error) {
      console.warn("SPECTER permission restore unavailable", error);
    }
  }

  foreground() {
    if (this.device && !state.connected && !state.manualReconnect) {
      this.clearReconnectTimer();
      this.scheduleReconnect(0);
    }
  }

  onDisconnect() {
    state.connected = false;
    state.authenticated = false;
    state.reconnecting = true;
    state.manualReconnect = false;
    this.command = null;
    this.telemetry = null;
    updateConnection();
    toast("SPECTER link lost - reconnecting");
    this.scheduleReconnect(700);
  }

  receive(value) {
    this.input += decoder.decode(value, { stream: true });
    const lines = this.input.split("\n");
    this.input = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try { handleTelemetry(JSON.parse(line)); }
      catch (error) { console.warn("Bad telemetry", line, error); }
    }
  }

  async send(command) {
    if (!this.command) throw new Error("SPECTER is not connected");
    const bytes = encoder.encode(`${JSON.stringify(command)}\n`);
    for (let offset = 0; offset < bytes.length; offset += 180) {
      const part = bytes.slice(offset, offset + 180);
      if (this.command.writeValueWithoutResponse) await this.command.writeValueWithoutResponse(part);
      else await this.command.writeValue(part);
    }
  }
}

const ble = new SpecterBLE();

function updateConnection() {
  const indicator = $("#connectionState");
  if (state.connected) {
    indicator.textContent = state.authenticated ? "C5 SECURE" : "C5 LOCKED";
    indicator.classList.add("online");
    $("#connectButton").textContent = "Connected";
  } else if (state.manualReconnect) {
    indicator.textContent = "TAP TO RECONNECT";
    indicator.classList.remove("online");
    $("#connectButton").textContent = "Reconnect C5";
  } else if (state.reconnecting) {
    indicator.textContent = "RECONNECTING";
    indicator.classList.remove("online");
    $("#connectButton").textContent = "Reconnecting…";
  } else if (state.demo) {
    indicator.textContent = "SIMULATION";
    indicator.classList.add("online");
    $("#connectButton").textContent = "Connect C5";
  } else {
    indicator.textContent = "OFFLINE";
    indicator.classList.remove("online");
    $("#connectButton").textContent = "Connect C5";
  }
}

function bytesToHex(bytes) { return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(""); }
async function hmacHex(keyText, material) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(keyText), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(material))));
}
async function authenticate(message) {
  state.security = { claimed: Boolean(message.claimed), claimWindow: Boolean(message.claim_window), nonce: message.nonce || "" };
  const ownerKey = localStorage.getItem("specter-owner-key");
  if (ownerKey && message.nonce) {
    const proof = await hmacHex(ownerKey, `specter-auth:${message.nonce}`);
    await ble.send({ cmd: "auth", proof });
    $("#ownerState").textContent = "AUTHENTICATING SAVED OWNER";
  } else {
    $("#ownerState").textContent = message.claim_window ? "BOOT DETECTED — READY TO CLAIM" : "WAITING FOR PHYSICAL BUTTON";
    $("#ownerClaim").disabled = !message.claim_window;
    if (!$("#ownerDialog").open) $("#ownerDialog").showModal();
  }
}

async function finishAuthentication() {
  state.authenticated = true;
  if ($("#ownerDialog").open) $("#ownerDialog").close();
  updateConnection();
  toast("Owner authentication verified");
  if (!ble.initialScanSent) { ble.initialScanSent = true; await ble.send({ cmd: "scan" }); }
}

function handleTelemetry(message) {
  if (message.t === "security" || message.t === "claim_window") {
    if (message.t === "claim_window") {
      $("#ownerInstructions").textContent = "BOOT detected. The physical authorization window is open — tap Claim browser now.";
      $("#ownerState").textContent = "BOOT DETECTED — READY TO CLAIM";
      $("#ownerClaim").disabled = false;
      toast("BOOT detected — tap Claim browser now");
      try { navigator.vibrate?.([80, 50, 80]); } catch {}
    }
    authenticate(message).catch((error) => toast(error.message));
  } else if (message.t === "authenticated") {
    finishAuthentication().catch((error) => toast(error.message));
  } else if (message.t === "claimed") {
    finishAuthentication().catch((error) => toast(error.message));
  } else if (message.t === "auth_failed") {
    state.authenticated = false;
    localStorage.removeItem("specter-owner-key");
    $("#ownerState").textContent = "OWNER KEY REJECTED — PRESS BOOT TO REAUTHORIZE";
    $("#ownerClaim").disabled = true;
    if (!$("#ownerDialog").open) $("#ownerDialog").showModal();
  } else if (message.t === "claim_denied") {
    localStorage.removeItem("specter-owner-key");
    $("#ownerState").textContent = `CLAIM DENIED: ${String(message.reason || "unknown").replaceAll("_", " ").toUpperCase()}`;
  } else if (message.t === "ownership_reset") {
    localStorage.removeItem("specter-owner-key"); state.authenticated = false; $("#ownerClaim").disabled = false;
  } else if (message.t === "ap") {
    state.aps.set(message.id, { ...message, lastSeen: Date.now() });
    saveObservation({ kind: "ap", at: Date.now(), ...message });
  } else if (message.t === "ble") {
    state.bleDevices.set(message.id, { ...message, lastSeen: Date.now() });
    saveObservation({ kind: "ble", at: Date.now(), ...message });
  } else if (message.t === "setup_ap") {
    state.setupAps.set(message.id, message); renderSetupNetworks();
  } else if (message.t === "setup_scan_started") {
    state.setupAps.clear(); $("#setupNetworkList").innerHTML = "<p>Scanning all supported channels…</p>"; $("#setupScanButton").disabled = true;
  } else if (message.t === "setup_scan_complete") {
    $("#setupScanButton").disabled = false; renderSetupNetworks(); toast(`Found ${message.count || state.setupAps.size} access points`);
  } else if (message.t === "scan_queued") {
    Object.assign(state.scan, { active: true, done: 0, total: 0, phase: "queued" });
    renderScanState();
  } else if (message.t === "scan_started") {
    Object.assign(state.scan, { active: true, done: 0, total: message.total || 0, phase: "wifi" });
    renderScanState();
  } else if (message.t === "scan_progress") {
    Object.assign(state.scan, { active: true, done: message.done || 0, total: message.total || 0, phase: "wifi" });
    renderScanState();
  } else if (message.t === "scan_complete") {
    state.status.wifi_2g = message.wifi_2g;
    state.status.wifi_5g = message.wifi_5g;
    Object.assign(state.scan, { active: true, phase: "ble" });
    updateHeatmapOptions();
    renderScanState();
    renderAll();
    clearTimeout(scanFinishTimer);
    scanFinishTimer = setTimeout(() => {
      if (state.scan.phase === "ble") {
        Object.assign(state.scan, { active: false, phase: "complete" });
        renderScanState();
      }
    }, 8000);
  } else if (message.t === "ble_scan_started") {
    Object.assign(state.scan, { active: true, phase: "ble" });
    renderScanState();
  } else if (message.t === "ble_scan_complete") {
    clearTimeout(scanFinishTimer);
    Object.assign(state.scan, { active: false, phase: "complete" });
    renderScanState();
    renderAll();
    setTimeout(() => {
      if (!state.scan.active) { state.scan.phase = "ready"; renderScanState(); }
    }, 1800);
  } else if (message.t === "status") {
    const previous = state.status.score;
    Object.assign(state.status, message);
    renderAll();
    if (message.score >= 70 && previous < 70) addIncident(message);
    maybeCaptureMapSample();
  } else if (message.t === "probe_result") {
    state.status.probe_kbps = message.kbps || 0; renderLab(); maybeCaptureMapSample(true);
  } else if (message.t === "configured") {
    $("#heartbeatEvidence").textContent = "CONFIGURED";
    toast(message.restarting ? "Configuration stored — C5 restarting" : "Configuration stored on SPECTER");
  } else if (message.t === "error") {
    toast(`C5: ${message.message || message.code}`);
  } else if (message.t === "ready" || message.t === "hello") {
    toast(`SPECTER ${message.version || ""} ready`);
  }
}

function renderScanState() {
  const holder = $(".scan-control");
  const label = $("#scanState");
  const button = $("#scanButton");
  holder.classList.toggle("busy", state.scan.active);
  button.disabled = state.scan.active;
  if (state.scan.phase === "queued") label.textContent = "QUEUED";
  else if (state.scan.phase === "wifi") label.textContent = state.scan.total ? `WI-FI ${state.scan.done}/${state.scan.total}` : "WI-FI";
  else if (state.scan.phase === "ble") label.textContent = "BLE PASS";
  else if (state.scan.phase === "complete") label.textContent = "COMPLETE";
  else label.textContent = "READY";
}

function renderSetupNetworks() {
  const holder = $("#setupNetworkList");
  const networks = [...state.setupAps.values()].filter((ap) => ap.ssid?.trim()).sort((a, b) => b.rssi - a.rssi);
  if (!networks.length) { holder.innerHTML = "<p>No named networks found. You can still type a hidden SSID manually.</p>"; return; }
  holder.innerHTML = networks.map((ap) => `<div class="network-option"><div><b>${escapeHtml(ap.ssid)}</b><small>${ap.band === 5 ? "5" : "2.4"} GHz · ch ${ap.channel} · ${ap.rssi} dBm</small></div><button type="button" class="button ghost" data-pick-primary="${escapeHtml(ap.id)}">Primary</button><button type="button" class="button ghost" data-pick-backup="${escapeHtml(ap.id)}">Backup</button></div>`).join("");
  holder.querySelectorAll("[data-pick-primary]").forEach((button) => button.addEventListener("click", () => { $("#settingsForm").elements.ssid.value = state.setupAps.get(button.dataset.pickPrimary)?.ssid || ""; }));
  holder.querySelectorAll("[data-pick-backup]").forEach((button) => button.addEventListener("click", () => { $("#settingsForm").elements.backup_ssid.value = state.setupAps.get(button.dataset.pickBackup)?.ssid || ""; }));
}

function modeName(value) {
  return typeof value === "number" ? ["atlas", "lab", "sentinel", "mapper"][value] : value;
}

async function setMode(mode) {
  state.mode = mode;
  $$(".mode-tab").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  $$(".mode-panel").forEach((panel) => panel.classList.remove("active"));
  $(`#${mode}Panel`).classList.add("active");
  if (state.connected && state.authenticated && mode !== "mapper") await ble.send({ cmd: "mode", value: mode });
  requestAnimationFrame(renderAll);
}

function activeAps() {
  const cutoff = Date.now() - 120000;
  return [...state.aps.values()].filter((ap) => ap.lastSeen >= cutoff).sort((a, b) => b.rssi - a.rssi);
}

function activeBleDevices() {
  const cutoff = Date.now() - 120000;
  return [...state.bleDevices.values()].filter((device) => device.lastSeen >= cutoff).sort((a, b) => b.rssi - a.rssi);
}

function hashNumber(text) {
  let value = 2166136261;
  for (const character of String(text)) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function canvasContext(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(rect.width * ratio));
  const height = Math.max(1, Math.floor(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width; canvas.height = height;
  }
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width: rect.width, height: rect.height };
}

function renderRadar() {
  const canvas = $("#radarCanvas");
  const { context: ctx, width, height } = canvasContext(canvas);
  ctx.clearRect(0, 0, width, height);
  const cx = width / 2, cy = height / 2, radius = Math.min(width, height) * .45;
  ctx.strokeStyle = "rgba(100,255,200,.12)";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i += 1) {
    ctx.beginPath(); ctx.arc(cx, cy, radius * i / 4, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy); ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius); ctx.stroke();

  for (const ap of activeAps().slice(0, 60)) {
    const angle = (hashNumber(ap.id) % 360) * Math.PI / 180;
    const normalized = Math.max(0.07, Math.min(.98, (-ap.rssi - 30) / 70));
    const distance = radius * normalized;
    const x = cx + Math.cos(angle) * distance;
    const y = cy + Math.sin(angle) * distance;
    const color = ap.band === 5 ? "98,216,255" : "100,255,200";
    const size = Math.max(2.5, 8 - normalized * 5);
    ctx.fillStyle = `rgba(${color},.13)`; ctx.beginPath(); ctx.arc(x, y, size * 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgb(${color})`; ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill();
    if (ap.rssi > -60) { ctx.strokeStyle = "rgba(255,202,112,.65)"; ctx.beginPath(); ctx.arc(x, y, size + 4, 0, Math.PI * 2); ctx.stroke(); }
  }
  for (const device of activeBleDevices().slice(0, 32)) {
    const angle = (hashNumber(`ble-${device.id}`) % 360) * Math.PI / 180;
    const normalized = Math.max(0.07, Math.min(.98, (-device.rssi - 30) / 70));
    const distance = radius * normalized;
    const x = cx + Math.cos(angle) * distance;
    const y = cy + Math.sin(angle) * distance;
    const size = Math.max(2.5, 7 - normalized * 4);
    ctx.fillStyle = "rgba(189,140,255,.14)"; ctx.beginPath(); ctx.arc(x, y, size * 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#bd8cff"; ctx.beginPath(); ctx.rect(x - size, y - size, size * 2, size * 2); ctx.fill();
  }
}

function atmosphereFor(aps) {
  if (!aps.length) return "DORMANT";
  if (state.status.score >= 70) return "STORM";
  if (aps.length >= 35) return "CROWDED";
  if (aps.length >= 16) return "ECHOING";
  if (aps.length <= 4) return "HOLLOW";
  return "STILL";
}

function renderAtlas() {
  const aps = activeAps();
  const bleDevices = activeBleDevices();
  $("#atmosphere").textContent = atmosphereFor(aps);
  $("#observedCount").textContent = aps.length + bleDevices.length;
  $("#count2g").textContent = aps.filter((ap) => ap.band === 2).length;
  $("#count5g").textContent = aps.filter((ap) => ap.band === 5).length;
  $("#countBle").textContent = bleDevices.length;
  $("#strongestSignal").textContent = aps[0] ? `${aps[0].rssi} dBm` : "—";
  const rows = $("#signalRows");
  if (!aps.length && !bleDevices.length) {
    rows.innerHTML = '<tr class="empty-row"><td colspan="5">Connect SPECTER or enter demo mode.</td></tr>';
  } else {
    const hidden = aps.filter((ap) => !ap.ssid?.trim());
    const visible = aps.filter((ap) => ap.ssid?.trim());
    const groupedHidden = new Set();
    const companions = new Map();
    for (const signal of hidden) {
      const likely = visible.find((candidate) => candidate.channel === signal.channel && Math.abs(candidate.rssi - signal.rssi) <= 5 && Math.abs(candidate.lastSeen - signal.lastSeen) <= 15000);
      if (likely) { groupedHidden.add(signal.id); companions.set(likely.id, (companions.get(likely.id) || 0) + 1); }
    }
    const wifiRows = aps.filter((ap) => !groupedHidden.has(ap.id)).slice(0, 24).map((ap) => {
      const strength = Math.max(3, Math.min(100, (ap.rssi + 100) * 1.43));
      const age = Math.max(0, Math.floor((Date.now() - ap.lastSeen) / 1000));
      const label = ap.ssid?.trim() || "Hidden signal";
      const companion = companions.get(ap.id) ? ` <small>+${companions.get(ap.id)} likely hidden companion</small>` : "";
      return `<tr><td>${escapeHtml(label)}${companion} <small>${escapeHtml(ap.id.slice(0, 8))}</small></td><td><span class="band-pill ${ap.band === 5 ? "five" : ""}">${ap.band === 5 ? "5" : "2.4"}</span></td><td>${ap.channel}</td><td><span class="strength-bar"><i style="width:${strength}%"></i></span>${ap.rssi}</td><td>${age}s</td></tr>`;
    });
    const bleRows = bleDevices.slice(0, 12).map((device) => {
      const strength = Math.max(3, Math.min(100, (device.rssi + 100) * 1.43));
      const age = Math.max(0, Math.floor((Date.now() - device.lastSeen) / 1000));
      const label = device.name?.trim() || "Unnamed BLE signal";
      return `<tr><td>${escapeHtml(label)} <small>${escapeHtml(device.id.slice(0, 8))}</small></td><td><span class="band-pill ble-band">BLE</span></td><td>—</td><td><span class="strength-bar"><i style="width:${strength}%"></i></span>${device.rssi}</td><td>${age}s</td></tr>`;
    });
    rows.innerHTML = [...wifiRows, ...bleRows].join("");
  }
  renderRadar();
  renderTrail();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function setDiagnostic(id, value) {
  const element = $(id);
  element.textContent = value === null ? "UNKNOWN" : value ? "HEALTHY" : "FAILED";
  const card = element.closest(".diagnostic");
  card.classList.toggle("good", value === true); card.classList.toggle("bad", value === false);
}

function renderLab() {
  const status = state.status;
  const hasData = state.connected || state.demo;
  setDiagnostic("#routerDiag", hasData ? status.wifi : null);
  setDiagnostic("#gatewayDiag", hasData ? status.gateway : null);
  setDiagnostic("#dnsDiag", hasData ? status.dns : null);
  setDiagnostic("#internetDiag", hasData ? status.internet : null);
  $("#routerDetail").textContent = status.wifi ? `${status.rssi} dBm on channel ${status.channel}` : "No active association";
  $("#currentRssi").textContent = hasData && status.rssi > -127 ? status.rssi : "—";
  $("#currentChannel").textContent = status.channel || "—";
  $("#activeProfile").textContent = hasData ? (Number(status.active_profile) === 1 ? "BACKUP" : "PRIMARY") : "—";
  $("#linkLatency").textContent = hasData ? `${status.dns_ms || 0} / ${status.internet_ms || 0} ms` : "—";
  $("#probeSpeed").textContent = status.probe_kbps ? `${status.probe_kbps} kbps` : "NOT RUN";
  $("#chipTemperature").textContent = Number.isFinite(Number(status.temperature_c)) ? `${Number(status.temperature_c).toFixed(1)} °C internal` : "—";
  $("#heapStats").textContent = status.free_heap ? `${Math.round(status.free_heap / 1024)} / ${Math.round((status.min_free_heap || 0) / 1024)} KB` : "—";
  const quality = Math.max(0, Math.min(100, (status.rssi + 100) * 2));
  $("#rssiMeter").style.width = `${quality}%`;
  $("#linkAssessment").textContent = !hasData ? "NO DATA" : status.rssi >= -55 ? "EXCELLENT" : status.rssi >= -67 ? "GOOD" : status.rssi >= -75 ? "WEAK" : "UNSTABLE";
  renderChannels();
}

let selectedBand = 2;
function renderChannels() {
  const canvas = $("#channelCanvas");
  const { context: ctx, width, height } = canvasContext(canvas);
  ctx.clearRect(0, 0, width, height);
  const channels = selectedBand === 2 ? Array.from({ length: 14 }, (_, i) => i + 1) : [36,40,44,48,52,56,60,64,100,104,108,112,116,120,124,128,132,136,140,144,149,153,157,161,165];
  const counts = new Map(channels.map((channel) => [channel, 0]));
  for (const ap of activeAps()) if (ap.band === selectedBand) counts.set(ap.channel, (counts.get(ap.channel) || 0) + 1);
  const padding = { left: 34, right: 12, top: 20, bottom: 30 };
  const chartW = width - padding.left - padding.right, chartH = height - padding.top - padding.bottom;
  const max = Math.max(4, ...counts.values());
  ctx.strokeStyle = "rgba(100,255,200,.1)"; ctx.fillStyle = "#5b746c"; ctx.font = "9px monospace";
  for (let i = 0; i <= 4; i += 1) { const y = padding.top + chartH * i / 4; ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(width - padding.right, y); ctx.stroke(); }
  const gap = 3, barW = Math.max(3, chartW / channels.length - gap);
  channels.forEach((channel, index) => {
    const count = counts.get(channel) || 0;
    const barH = chartH * count / max;
    const x = padding.left + index * chartW / channels.length;
    const gradient = ctx.createLinearGradient(0, padding.top + chartH - barH, 0, padding.top + chartH);
    gradient.addColorStop(0, selectedBand === 2 ? "#64ffc8" : "#62d8ff"); gradient.addColorStop(1, "rgba(50,130,105,.18)");
    ctx.fillStyle = gradient; ctx.fillRect(x, padding.top + chartH - barH, barW, barH);
    if ((selectedBand === 2 || index % 2 === 0) && width > 450) { ctx.fillStyle = "#607870"; ctx.fillText(channel, x, height - 10); }
  });
}

const classificationCopy = {
  normal: ["FIELD NORMAL", "No suspicious multi-signal interference pattern is present."],
  degraded: ["FIELD DEGRADED", "Some indicators are abnormal, but the evidence does not yet suggest deliberate interference."],
  beacon_loss: ["BEACON LOSS", "The connected access point stopped delivering expected beacon frames."],
  possible_deauth_burst: ["DEAUTH BURST", "An unusual burst of Wi-Fi deauthentication or disassociation frames was observed."],
  suspicious_rf_event: ["SUSPICIOUS RF EVENT", "Several independent indicators deteriorated together. Check the property and security system."],
  severe_rf_event: ["SEVERE RF EVENT", "A severe multi-signal outage pattern is in progress. Cloud and local alerts have been requested."],
  internet_or_isp_failure: ["INTERNET FAILURE", "The local Wi-Fi link remains present, but the external connectivity probe failed."],
  not_armed: ["NOT ARMED", "Configure Wi-Fi and the cloud heartbeat, then arm Sentinel."],
};

function renderSentinel() {
  const armed = $("#sentinelToggle").checked;
  const score = armed ? state.status.score || 0 : 0;
  $("#threatScore").textContent = score;
  const color = score >= 70 ? "var(--red)" : score >= 40 ? "var(--amber)" : "var(--green)";
  $("#scoreRing").style.setProperty("--score", `${score * 3.6}deg`);
  $("#scoreRing").style.color = color;
  const key = armed ? state.status.classification || "normal" : "not_armed";
  const copy = classificationCopy[key] || [String(key).replaceAll("_", " ").toUpperCase(), "SPECTER recorded an unclassified network condition."];
  $("#classification").textContent = copy[0]; $("#classification").style.color = color;
  $("#classificationDetail").textContent = copy[1];
  $("#beaconEvidence").textContent = state.status.beacon_timeouts || 0;
  $("#deauthEvidence").textContent = state.status.deauth || 0;
  $("#disconnectEvidence").textContent = state.status.disconnects || 0;
  $("#networkEvidence").textContent = activeAps().length;
  renderTimeline();
}

function addIncident(status) {
  const incident = { at: Date.now(), score: status.score, classification: status.classification, deauth: status.deauth, beacon: status.beacon_timeouts };
  const previous = state.incidents[0];
  const duplicate = previous && incident.at - previous.at < 60000 &&
    previous.score === incident.score && previous.classification === incident.classification &&
    (previous.deauth || 0) === (incident.deauth || 0) && (previous.beacon || 0) === (incident.beacon || 0);
  if (duplicate) return;
  state.incidents.unshift(incident); state.incidents = state.incidents.slice(0, 50);
  saveObservation({ kind: "incident", ...incident });
  if ("Notification" in window && Notification.permission === "granted") new Notification("SPECTER interference warning", { body: `${classificationCopy[incident.classification]?.[0] || incident.classification} · score ${incident.score}/100` });
  renderTimeline();
}

function renderTimeline() {
  const element = $("#incidentTimeline");
  if (!state.incidents.length) { element.innerHTML = "<li><time>—</time><div><strong>Sentinel waiting</strong><p>No evidence has been recorded in this session.</p></div></li>"; return; }
  element.innerHTML = state.incidents.map((incident) => `<li><time>${new Date(incident.at).toLocaleTimeString()}</time><div><strong>${escapeHtml(classificationCopy[incident.classification]?.[0] || incident.classification)}</strong><p>Score ${incident.score}/100 · ${incident.deauth || 0} deauth frames · ${incident.beacon || 0} beacon timeouts</p></div></li>`).join("");
}

function renderTrail() {
  const canvas = $("#trailCanvas");
  const { context: ctx, width, height } = canvasContext(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(100,255,200,.08)"; ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 35) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,height); ctx.stroke(); }
  for (let y = 0; y < height; y += 35) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(width,y); ctx.stroke(); }
  if (!state.trail.length) {
    ctx.fillStyle = "#5b746c"; ctx.font = "10px monospace"; ctx.textAlign = "center";
    ctx.fillText("START GPS AND WALK TO BUILD THE FIELD MAP", width / 2, height / 2);
    return;
  }
  const lats = state.trail.map((point) => point.lat), lons = state.trail.map((point) => point.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const latSpan = Math.max(maxLat - minLat, .00002), lonSpan = Math.max(maxLon - minLon, .00002);
  const selected = $("#heatmapNetwork")?.value || "field";
  const coordinates = state.trail.map((point) => ({
    point,
    x: 10 + (point.lon - minLon) / lonSpan * (width - 20),
    y: height - 10 - (point.lat - minLat) / latSpan * (height - 20),
  }));
  for (const item of coordinates) {
    const signals = item.point.signals || [];
    const sample = selected === "field"
      ? signals.reduce((best, signal) => signal.rssi > (best?.rssi ?? -128) ? signal : best, null)
      : signals.find((signal) => signal.id === selected);
    if (!sample) continue;
    const intensity = Math.max(0, Math.min(1, (sample.rssi + 100) / 65));
    const hue = 210 - intensity * 210;
    const radius = 22 + intensity * 20;
    const gradient = ctx.createRadialGradient(item.x, item.y, 1, item.x, item.y, radius);
    gradient.addColorStop(0, `hsla(${hue},95%,62%,${.2 + intensity * .45})`);
    gradient.addColorStop(1, `hsla(${hue},95%,50%,0)`);
    ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(item.x, item.y, radius, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = "rgba(231,255,246,.7)"; ctx.lineWidth = 1.5; ctx.beginPath();
  coordinates.forEach((item, index) => index ? ctx.lineTo(item.x, item.y) : ctx.moveTo(item.x, item.y));
  ctx.stroke();
  const latest = coordinates.at(-1);
  ctx.fillStyle = "#64ffc8"; ctx.beginPath(); ctx.arc(latest.x, latest.y, 3.5, 0, Math.PI * 2); ctx.fill();
}

function updateHeatmapOptions() {
  const select = $("#heatmapNetwork");
  if (!select) return;
  const selected = select.value;
  const options = activeAps().slice(0, 40).map((ap) => {
    const label = ap.ssid?.trim() || `ghost-${ap.id.slice(0, 6)}`;
    return `<option value="${escapeHtml(ap.id)}">${escapeHtml(label)} (${ap.band === 5 ? "5" : "2.4"}G)</option>`;
  });
  select.innerHTML = `<option value="field">Overall field</option>${options.join("")}`;
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;
}

function mapColor(value, metric) {
  let quality = metric === "rssi" ? (value + 90) / 50 : metric === "throughput" ? value / 1500 : metric === "latency" ? 1 - value / 350 : 1 - value;
  quality = Math.max(0, Math.min(1, quality));
  return `hsla(${quality * 125},95%,55%,.48)`;
}

function renderMapper() {
  const canvas = $("#mapperCanvas");
  if (!canvas) return;
  const { context: ctx, width, height } = canvasContext(canvas);
  ctx.clearRect(0, 0, width, height);
  if (state.map.floorPlan?.complete) ctx.drawImage(state.map.floorPlan, 0, 0, width, height);
  else {
    ctx.fillStyle = "#071012"; ctx.fillRect(0, 0, width, height); ctx.strokeStyle = "rgba(100,255,200,.08)";
    for (let x = 0; x < width; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
    for (let y = 0; y < height; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
  }
  const metric = $("#mapMetric")?.value || "rssi";
  const profile = $("#mapProfile")?.value || "all";
  const samples = state.map.samples.filter((sample) => profile === "all" || String(sample.profile) === profile);
  for (const sample of samples) {
    const x = sample.x * width, y = sample.y * height;
    const value = metric === "rssi" ? sample.rssi : metric === "throughput" ? sample.kbps : metric === "latency" ? Math.max(sample.dnsMs, sample.internetMs) : sample.online ? 0 : 1;
    const radius = Math.max(26, Math.min(width, height) * .1);
    const gradient = ctx.createRadialGradient(x, y, 2, x, y, radius);
    gradient.addColorStop(0, mapColor(value, metric)); gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
  }
  if (samples.length) {
    ctx.strokeStyle = "rgba(231,255,246,.75)"; ctx.lineWidth = 1.5; ctx.beginPath();
    samples.forEach((sample, index) => index ? ctx.lineTo(sample.x * width, sample.y * height) : ctx.moveTo(sample.x * width, sample.y * height)); ctx.stroke();
  }
  ctx.fillStyle = state.map.checkpoint ? "#ffca70" : "#64ffc8"; ctx.beginPath(); ctx.arc(state.map.x * width, state.map.y * height, 6, 0, Math.PI * 2); ctx.fill();
  $("#mapSamples").textContent = state.map.samples.length; $("#mapSteps").textContent = state.map.steps;
  $("#mapConfidence").textContent = state.map.confidence >= 2 ? "ANCHORED" : state.map.confidence ? "ESTIMATED" : "UNANCHORED";
  $("#mapActiveProfile").textContent = Number(state.status.active_profile) === 1 ? "BACKUP" : "PRIMARY";
  const weak = state.map.samples.filter((sample) => sample.rssi < -72 || !sample.online || Math.max(sample.dnsMs, sample.internetMs) > 250);
  $("#mapWeakZones").textContent = weak.length;
  const suggestion = weak.length < 3 ? "Keep surveying across rooms and both bands." : "Weak samples cluster near the marked path. Place a mesh node or extender near the transition where signal is roughly −60 to −68 dBm—not inside the deepest dead zone.";
  $("#mapSuggestions").innerHTML = `<strong>Placement notes</strong><p>${suggestion}</p>`;
}

function maybeCaptureMapSample(force = false) {
  if (!state.map.active || (!state.authenticated && !state.demo)) return;
  const now = Date.now(); if (!force && now - state.map.lastSample < 1800) return;
  state.map.lastSample = now;
  const sample = { at: now, x: state.map.x, y: state.map.y, heading: state.map.heading, confidence: state.map.confidence, rssi: state.status.rssi, channel: state.status.channel, profile: Number(state.status.active_profile || 0), dnsMs: Number(state.status.dns_ms || 0), internetMs: Number(state.status.internet_ms || 0), kbps: Number(state.status.probe_kbps || 0), online: Boolean(state.status.internet), temperatureC: Number(state.status.temperature_c || 0) };
  state.map.samples.push(sample); state.map.samples = state.map.samples.slice(-3000); saveObservation({ kind: "map", ...sample }); renderMapper();
  if (now - state.map.lastProbe > 15000) { state.map.lastProbe = now; ble.send({ cmd: "probe" }).catch(() => {}); }
}

function motionStep(event) {
  if (!state.map.active) return;
  const acceleration = event.accelerationIncludingGravity; if (!acceleration) return;
  const magnitude = Math.hypot(acceleration.x || 0, acceleration.y || 0, acceleration.z || 0);
  const now = Date.now();
  if (magnitude > 12.2 && now - state.map.lastStep > 360) {
    state.map.lastStep = now; state.map.steps += 1; state.map.confidence = Math.max(1, state.map.confidence);
    const angle = state.map.heading * Math.PI / 180; state.map.x = Math.max(.01, Math.min(.99, state.map.x + Math.sin(angle) * .014)); state.map.y = Math.max(.01, Math.min(.99, state.map.y - Math.cos(angle) * .014));
    maybeCaptureMapSample(); renderMapper();
  }
}

function orientationUpdate(event) {
  if (!state.map.active) return;
  const heading = event.webkitCompassHeading ?? (event.alpha == null ? null : 360 - event.alpha);
  if (heading != null) state.map.heading = heading;
}

async function toggleMapSurvey() {
  state.map.active = !state.map.active; $("#mapStart").textContent = state.map.active ? "Stop survey" : "Start survey";
  if (state.map.active) {
    try { if (typeof window.DeviceMotionEvent?.requestPermission === "function") await window.DeviceMotionEvent.requestPermission(); } catch {}
    try { if (typeof window.DeviceOrientationEvent?.requestPermission === "function") await window.DeviceOrientationEvent.requestPermission(); } catch {}
    window.addEventListener("devicemotion", motionStep); window.addEventListener("deviceorientation", orientationUpdate);
    if (navigator.geolocation) navigator.geolocation.getCurrentPosition((position) => { state.map.gps = { lat: position.coords.latitude, lon: position.coords.longitude, accuracy: position.coords.accuracy }; }, () => {}, { enableHighAccuracy: true, timeout: 8000 });
    maybeCaptureMapSample(true); toast("Survey running — set a checkpoint to anchor your position");
  } else { window.removeEventListener("devicemotion", motionStep); window.removeEventListener("deviceorientation", orientationUpdate); }
  renderMapper();
}

async function loadFloorPlan(file) {
  if (!file) return;
  const source = new Image(); source.src = URL.createObjectURL(file); await source.decode();
  const scale = Math.min(1, 1600 / Math.max(source.width, source.height)); const canvas = document.createElement("canvas"); canvas.width = Math.round(source.width * scale); canvas.height = Math.round(source.height * scale); canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  const data = canvas.toDataURL("image/jpeg", .82); URL.revokeObjectURL(source.src); const image = new Image(); image.src = data; await image.decode(); state.map.floorPlan = image; saveObservation({ kind: "floorplan", at: Date.now(), data }); renderMapper();
}

function exportMapJson() { downloadBlob("specter-coverage.json", JSON.stringify({ exported_at: new Date().toISOString(), gps_anchor: state.map.gps || null, samples: state.map.samples }, null, 2), "application/json"); }
function downloadBlob(name, data, type) { const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([data], { type })); link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 500); }

function renderAll() { renderAtlas(); renderLab(); renderSentinel(); renderMapper(); }

async function toggleGps() {
  if (state.gpsWatch !== null) {
    navigator.geolocation.clearWatch(state.gpsWatch); state.gpsWatch = null; $("#gpsButton").textContent = "Start GPS"; return;
  }
  if (!navigator.geolocation) return toast("Geolocation is unavailable in this browser");
  state.lastGpsIds = new Set(activeAps().map((ap) => ap.id));
  state.gpsWatch = navigator.geolocation.watchPosition((position) => {
    const signals = activeAps().slice(0, 48).map(({ id, ssid, rssi, band, channel }) => ({ id, ssid, rssi, band, channel }));
    const currentIds = new Set(signals.map((signal) => signal.id));
    let changed = 0;
    for (const id of currentIds) if (!state.lastGpsIds.has(id)) changed += 1;
    for (const id of state.lastGpsIds) if (!currentIds.has(id)) changed += 1;
    state.lastGpsIds = currentIds;
    const point = { lat: position.coords.latitude, lon: position.coords.longitude, accuracy: position.coords.accuracy, at: Date.now(), change, signals };
    state.trail.push(point); state.trail = state.trail.slice(-1000); state.gpsAccuracy = point.accuracy;
    $("#gpsAccuracy").textContent = `±${Math.round(point.accuracy)} m`; $("#gpsSamples").textContent = state.trail.length;
    saveObservation({ kind: "gps", ...point }); renderTrail();
  }, (error) => toast(`GPS: ${error.message}`), { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 });
  $("#gpsButton").textContent = "Stop GPS";
}

function startDemo() {
  state.demo = true; state.connected = false; updateConnection(); clearInterval(demoTimer);
  const names = ["NIGHTSHIFT", "apartment-5G", "printer", "mesh-node", "unknown", "HOME-LAB", "camera-net", "guest"];
  const generate = () => {
    const previousScore = state.status.score;
    state.aps.clear();
    const count = 18 + Math.floor(Math.random() * 15);
    for (let i = 0; i < count; i += 1) {
      const band = Math.random() > .62 ? 5 : 2;
      const channel = band === 2 ? 1 + Math.floor(Math.random() * 11) : [36,40,44,48,149,153,157,161][Math.floor(Math.random() * 8)];
      const id = (hashNumber(`${i}-specter-demo`) >>> 0).toString(16).padStart(8, "0");
      state.aps.set(id, { t: "ap", id, ssid: Math.random() > .32 ? names[i % names.length] : "", band, channel, rssi: -35 - Math.floor(Math.random() * 58), lastSeen: Date.now() });
    }
    const spike = Math.random() > .88;
    Object.assign(state.status, { wifi: true, gateway: true, internet: !spike, dns: true, rssi: -46 - Math.floor(Math.random() * 12), channel: 149, active_profile: Math.random() > .8 ? 1 : 0, dns_ms: 8 + Math.floor(Math.random() * 25), internet_ms: 18 + Math.floor(Math.random() * 70), probe_kbps: 700 + Math.floor(Math.random() * 900), temperature_c: 43 + Math.random() * 5, free_heap: 148000, min_free_heap: 132000, wifi_2g: [...state.aps.values()].filter((ap) => ap.band === 2).length, wifi_5g: [...state.aps.values()].filter((ap) => ap.band === 5).length, deauth: spike ? 38 : Math.floor(Math.random() * 3), disconnects: spike ? 2 : 0, beacon_timeouts: spike ? 1 : 0, score: spike ? 78 : Math.floor(Math.random() * 12), classification: spike ? "suspicious_rf_event" : "normal" });
    maybeCaptureMapSample();
    if (spike && previousScore < 70) addIncident(state.status);
    renderAll();
  };
  generate(); demoTimer = setInterval(generate, 5000); toast("Demo telemetry active");
}

let databasePromise;
function database() {
  if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open("specter-c5", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("observations", { keyPath: "key", autoIncrement: true });
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  return databasePromise;
}
async function saveObservation(observation) {
  try { const db = await database(); db.transaction("observations", "readwrite").objectStore("observations").add(observation); }
  catch (error) { console.warn("Local history unavailable", error); }
}

async function loadHistory() {
  try {
    const db = await database();
    const records = await new Promise((resolve, reject) => {
      const request = db.transaction("observations", "readonly").objectStore("observations").getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    const recentCutoff = Date.now() - 120000;
    const restoredIncidents = [];
    for (const record of records.slice(-3000)) {
      if (record.kind === "gps") state.trail.push(record);
      else if (record.kind === "map") state.map.samples.push(record);
      else if (record.kind === "floorplan" && record.data) { const image = new Image(); image.onload = renderMapper; image.src = record.data; state.map.floorPlan = image; }
      else if (record.kind === "incident") restoredIncidents.unshift(record);
      else if (record.kind === "ap" && record.at >= recentCutoff) state.aps.set(record.id, { ...record, lastSeen: record.at });
      else if (record.kind === "ble" && record.at >= recentCutoff) state.bleDevices.set(record.id, { ...record, lastSeen: record.at });
    }
    state.incidents = restoredIncidents.filter((incident, index, incidents) => {
      const newer = incidents.slice(0, index).find((candidate) =>
        candidate.at - incident.at < 60000 && candidate.at >= incident.at &&
        candidate.score === incident.score && candidate.classification === incident.classification &&
        (candidate.deauth || 0) === (incident.deauth || 0) &&
        (candidate.beacon || 0) === (incident.beacon || 0));
      return !newer;
    });
    state.trail = state.trail.slice(-1000);
    state.map.samples = state.map.samples.slice(-3000);
    state.incidents = state.incidents.slice(0, 50);
    const latest = state.trail.at(-1);
    if (latest) {
      state.gpsAccuracy = latest.accuracy;
      $("#gpsAccuracy").textContent = `±${Math.round(latest.accuracy)} m`;
      $("#gpsSamples").textContent = state.trail.length;
    }
    updateHeatmapOptions();
    renderAll();
  } catch (error) {
    console.warn("SPECTER history restore unavailable", error);
  }
}

function exportSession() {
  const data = { exported_at: new Date().toISOString(), status: state.status, signals: activeAps(), trail: state.trail, incidents: state.incidents };
  const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })); link.download = `specter-${new Date().toISOString().replaceAll(":", "-")}.json`; link.click(); URL.revokeObjectURL(link.href);
}

$("#connectButton").addEventListener("click", async () => { try { await ble.connect(state.manualReconnect); } catch (error) { toast(error.message); } });
$("#demoButton").addEventListener("click", startDemo);
$("#scanButton").addEventListener("click", async () => { if (state.connected) await ble.send({ cmd: "scan" }); else startDemo(); });
$("#gpsButton").addEventListener("click", toggleGps);
$("#heatmapNetwork").addEventListener("change", renderTrail);
$("#exportButton").addEventListener("click", exportSession);
$("#settingsButton").addEventListener("click", () => $("#settingsDialog").showModal());
$("#setupScanButton").addEventListener("click", async () => { if (!state.authenticated) return toast("Authenticate this browser first"); state.setupAps.clear(); await ble.send({ cmd: "setup_scan" }); });
$("#ownerClaim").addEventListener("click", async () => { const key = bytesToHex(crypto.getRandomValues(new Uint8Array(32))); localStorage.setItem("specter-owner-key", key); $("#ownerState").textContent = "CLAIMING OWNER SLOT"; try { await ble.send({ cmd: "claim", owner_key: key }); } catch (error) { localStorage.removeItem("specter-owner-key"); toast(error.message); } });
$("#ownerCancel").addEventListener("click", () => { ble.clearReconnectTimer(); if (ble.device?.gatt?.connected) ble.device.gatt.disconnect(); $("#ownerDialog").close(); });
$("#mapStart").addEventListener("click", toggleMapSurvey);
$("#mapCheckpoint").addEventListener("click", () => { state.map.checkpoint = true; $("#mapHint").textContent = "Tap your current position on the coverage map."; renderMapper(); });
$("#mapperCanvas").addEventListener("pointerdown", (event) => { if (!state.map.checkpoint) return; const rect = event.currentTarget.getBoundingClientRect(); state.map.x = (event.clientX - rect.left) / rect.width; state.map.y = (event.clientY - rect.top) / rect.height; state.map.checkpoint = false; state.map.confidence = 2; $("#mapHint").textContent = "Checkpoint anchored. Continue walking; re-anchor after turns or drift."; maybeCaptureMapSample(true); });
$("#floorPlanInput").addEventListener("change", (event) => loadFloorPlan(event.target.files[0]).catch((error) => toast(error.message)));
$("#mapMetric").addEventListener("change", renderMapper); $("#mapProfile").addEventListener("change", renderMapper);
$("#mapProbe").addEventListener("click", () => state.authenticated ? ble.send({ cmd: "probe" }) : toast("Connect and authenticate first"));
$("#mapExportJson").addEventListener("click", exportMapJson);
$("#mapExportPng").addEventListener("click", () => { const link = document.createElement("a"); link.download = "specter-coverage.png"; link.href = $("#mapperCanvas").toDataURL("image/png"); link.click(); });
$$(".mode-tab").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
$$(".segmented button").forEach((button) => button.addEventListener("click", () => { selectedBand = Number(button.dataset.band); $$(".segmented button").forEach((item) => item.classList.toggle("active", item === button)); renderChannels(); }));
$("#sentinelToggle").addEventListener("change", async (event) => { if (state.connected) await ble.send({ cmd: "configure", sentinel_enabled: event.target.checked }); renderSentinel(); });
$("#notificationButton").addEventListener("click", async () => { if (!("Notification" in window)) return toast("Browser notifications are unavailable here"); const permission = await Notification.requestPermission(); toast(permission === "granted" ? "Phone alerts enabled while the app is active" : "Notification permission was not granted"); });
$("#settingsForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  if (!state.connected || !state.authenticated) return toast("Connect and authenticate before sending configuration");
  const form = new FormData(event.currentTarget);
  const command = { cmd: "configure", ssid: form.get("ssid"), password: form.get("password"), backup_ssid: form.get("backup_ssid"), backup_password: form.get("backup_password"), worker_url: form.get("worker_url"), device_id: form.get("device_id"), device_token: form.get("device_token"), alert_threshold: Number(form.get("alert_threshold")), heartbeat_seconds: Number(form.get("heartbeat_seconds")), sentinel_enabled: $("#sentinelToggle").checked };
  try { await ble.send(command); event.currentTarget.elements.password.value = ""; event.currentTarget.elements.backup_password.value = ""; event.currentTarget.elements.device_token.value = ""; $("#settingsDialog").close(); toast("Configuration sent; C5 will restart and reconnect"); }
  catch (error) { toast(error.message); }
});

window.addEventListener("resize", () => requestAnimationFrame(renderAll));
window.addEventListener("focus", () => ble.foreground());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") ble.foreground(); });
setInterval(() => { if (state.mode === "atlas") renderRadar(); }, 2000);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
ble.restore();
loadHistory();
updateConnection(); renderScanState(); renderAll();
