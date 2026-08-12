const UUIDS = {
  service: "7e570001-5eec-4c51-9a11-c5c5c5c5c5c5",
  command: "7e570002-5eec-4c51-9a11-c5c5c5c5c5c5",
  telemetry: "7e570003-5eec-4c51-9a11-c5c5c5c5c5c5",
};

const state = {
  connected: false,
  reconnecting: false,
  demo: false,
  mode: "atlas",
  aps: new Map(),
  bleDevices: new Map(),
  trail: [],
  incidents: [],
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

  async connect() {
    if (!navigator.bluetooth) throw new Error("Web Bluetooth is unavailable. On iPhone, open this page in Bluefy.");
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
      await this.telemetry.startNotifications();
      this.telemetry.addEventListener("characteristicvaluechanged", this.telemetryListener);
      state.connected = true;
      state.reconnecting = false;
      state.demo = false;
      this.reconnectAttempt = 0;
      clearInterval(demoTimer);
      updateConnection();
      await this.send({ cmd: "hello" });
      if (!this.initialScanSent) {
        this.initialScanSent = true;
        await this.send({ cmd: "scan" });
      }
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

  scheduleReconnect(delay) {
    if (!this.device || state.connected || this.connecting || this.reconnectTimer) return;
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
    if (this.device && !state.connected) {
      this.clearReconnectTimer();
      this.scheduleReconnect(0);
    }
  }

  onDisconnect() {
    state.connected = false;
    state.reconnecting = true;
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
    indicator.textContent = "C5 CONNECTED";
    indicator.classList.add("online");
    $("#connectButton").textContent = "Connected";
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

function handleTelemetry(message) {
  if (message.t === "ap") {
    state.aps.set(message.id, { ...message, lastSeen: Date.now() });
    saveObservation({ kind: "ap", at: Date.now(), ...message });
  } else if (message.t === "ble") {
    state.bleDevices.set(message.id, { ...message, lastSeen: Date.now() });
    saveObservation({ kind: "ble", at: Date.now(), ...message });
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
  } else if (message.t === "configured") {
    $("#heartbeatEvidence").textContent = "CONFIGURED";
    toast("Configuration stored on SPECTER");
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

function modeName(value) {
  return typeof value === "number" ? ["atlas", "lab", "sentinel"][value] : value;
}

async function setMode(mode) {
  state.mode = mode;
  $$(".mode-tab").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  $$(".mode-panel").forEach((panel) => panel.classList.remove("active"));
  $(`#${mode}Panel`).classList.add("active");
  if (state.connected) await ble.send({ cmd: "mode", value: mode });
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
    const wifiRows = aps.slice(0, 24).map((ap) => {
      const strength = Math.max(3, Math.min(100, (ap.rssi + 100) * 1.43));
      const age = Math.max(0, Math.floor((Date.now() - ap.lastSeen) / 1000));
      const label = ap.ssid?.trim() || `ghost-${ap.id.slice(0, 6)}`;
      return `<tr><td>${escapeHtml(label)} <small>${escapeHtml(ap.id.slice(0, 8))}</small></td><td><span class="band-pill ${ap.band === 5 ? "five" : ""}">${ap.band === 5 ? "5" : "2.4"}</span></td><td>${ap.channel}</td><td><span class="strength-bar"><i style="width:${strength}%"></i></span>${ap.rssi}</td><td>${age}s</td></tr>`;
    });
    const bleRows = bleDevices.slice(0, 12).map((device) => {
      const strength = Math.max(3, Math.min(100, (device.rssi + 100) * 1.43));
      const age = Math.max(0, Math.floor((Date.now() - device.lastSeen) / 1000));
      const label = device.name?.trim() || `ble-ghost-${device.id.slice(0, 6)}`;
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

function renderAll() { renderAtlas(); renderLab(); renderSentinel(); }

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
    state.aps.clear();
    const count = 18 + Math.floor(Math.random() * 15);
    for (let i = 0; i < count; i += 1) {
      const band = Math.random() > .62 ? 5 : 2;
      const channel = band === 2 ? 1 + Math.floor(Math.random() * 11) : [36,40,44,48,149,153,157,161][Math.floor(Math.random() * 8)];
      const id = (hashNumber(`${i}-specter-demo`) >>> 0).toString(16).padStart(8, "0");
      state.aps.set(id, { t: "ap", id, ssid: Math.random() > .32 ? names[i % names.length] : "", band, channel, rssi: -35 - Math.floor(Math.random() * 58), lastSeen: Date.now() });
    }
    const spike = Math.random() > .88;
    Object.assign(state.status, { wifi: true, gateway: true, internet: !spike, dns: true, rssi: -46 - Math.floor(Math.random() * 12), channel: 149, wifi_2g: [...state.aps.values()].filter((ap) => ap.band === 2).length, wifi_5g: [...state.aps.values()].filter((ap) => ap.band === 5).length, deauth: spike ? 38 : Math.floor(Math.random() * 3), disconnects: spike ? 2 : 0, beacon_timeouts: spike ? 1 : 0, score: spike ? 78 : Math.floor(Math.random() * 12), classification: spike ? "suspicious_rf_event" : "normal" });
    if (spike) addIncident(state.status);
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
    for (const record of records.slice(-3000)) {
      if (record.kind === "gps") state.trail.push(record);
      else if (record.kind === "incident") state.incidents.unshift(record);
      else if (record.kind === "ap" && record.at >= recentCutoff) state.aps.set(record.id, { ...record, lastSeen: record.at });
      else if (record.kind === "ble" && record.at >= recentCutoff) state.bleDevices.set(record.id, { ...record, lastSeen: record.at });
    }
    state.trail = state.trail.slice(-1000);
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

$("#connectButton").addEventListener("click", async () => { try { await ble.connect(); } catch (error) { toast(error.message); } });
$("#demoButton").addEventListener("click", startDemo);
$("#scanButton").addEventListener("click", async () => { if (state.connected) await ble.send({ cmd: "scan" }); else startDemo(); });
$("#gpsButton").addEventListener("click", toggleGps);
$("#heatmapNetwork").addEventListener("change", renderTrail);
$("#exportButton").addEventListener("click", exportSession);
$("#settingsButton").addEventListener("click", () => $("#settingsDialog").showModal());
$$(".mode-tab").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
$$(".segmented button").forEach((button) => button.addEventListener("click", () => { selectedBand = Number(button.dataset.band); $$(".segmented button").forEach((item) => item.classList.toggle("active", item === button)); renderChannels(); }));
$("#sentinelToggle").addEventListener("change", async (event) => { if (state.connected) await ble.send({ cmd: "configure", sentinel_enabled: event.target.checked }); renderSentinel(); });
$("#notificationButton").addEventListener("click", async () => { if (!("Notification" in window)) return toast("Browser notifications are unavailable here"); const permission = await Notification.requestPermission(); toast(permission === "granted" ? "Phone alerts enabled while the app is active" : "Notification permission was not granted"); });
$("#settingsForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  if (!state.connected) return toast("Connect the C5 before sending configuration");
  const form = new FormData(event.currentTarget);
  const command = { cmd: "configure", ssid: form.get("ssid"), password: form.get("password"), worker_url: form.get("worker_url"), device_id: form.get("device_id"), device_token: form.get("device_token"), alert_threshold: Number(form.get("alert_threshold")), heartbeat_seconds: Number(form.get("heartbeat_seconds")), sentinel_enabled: $("#sentinelToggle").checked };
  try { await ble.send(command); event.currentTarget.elements.password.value = ""; event.currentTarget.elements.device_token.value = ""; $("#settingsDialog").close(); toast("Configuration sent; reboot C5 to apply Wi-Fi changes"); }
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
