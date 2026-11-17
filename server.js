'use strict';
/**
 * server.js  —  AR.Drone 2.0 WebSocket bridge
 *
 * Env vars:
 *   PORT       (default 3000)
 *   DRONE_IP   (default 192.168.1.1)
 *   DRONE_MOCK (set to "1" for mock mode — no real drone)
 */

// ─── Environment ─────────────────────────────────────────────────────────────
const PORT      = parseInt(process.env.PORT  || '3000', 10);
const DRONE_IP  = process.env.DRONE_IP  || '192.168.1.1';
const MOCK_MODE = process.env.DRONE_MOCK === '1';

const os      = require('os');
const http    = require('http');
const net     = require('net');
const path    = require('path');
const express = require('express');
const { WebSocketServer, OPEN } = require('ws');
const { BASE_SETTINGS, ModeManager } = require('./modes');
const {
  CONFIG_IDS,
  CONTROL_LIMITS,
  THROTTLE_TAKEOFF_THRESHOLD,
  altitudeLimitMillimeters,
  encodePcmd,
  limitGazAtAltitude,
  parseConfigValue,
  queueConfigIds,
  setDroneAxes
} = require('./control');

// ─── Helpers ─────────────────────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function broadcast(wss, obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === OPEN) {
      client.send(msg, (err) => {
        if (err) console.warn('[WS] broadcast failed:', err.message || err);
      });
    }
  }
}

// ─── State ────────────────────────────────────────────────────────────────────
let altitudeCurrent = 0;
let lastPcmdGaz = 0;
let batteryPct      = null;
let isFlying        = false;
let maxAlt          = 5.0;      // metres; firmware altitude_max supports approximately 0.5–5 m
let emergencyActive = false;
let droneStateFlags = {};
let actualSpeed     = 0;
let activeMode      = 'manual';
let safetyEnabled   = true;
let safetyBatteryThreshold = 20;
let safetyWarningSent = false;
let flightLog       = [];
let watchdogTimer   = null;

// Diagnostic counters
let navdataCount    = 0;
let lastNavdataTime = 0;
let videoFrameCount = 0;
let videoFps        = 0;
let clientCount     = 0;

function hasRecentNavdata() {
  return lastNavdataTime > 0 && Date.now() - lastNavdataTime <= 2000;
}

function logEvent(event, details = {}) {
  flightLog.push({
    time: new Date().toISOString(),
    mode: activeMode,
    altitude: altitudeCurrent,
    speed: actualSpeed,
    battery: batteryPct,
    event,
    details: JSON.stringify(details)
  });
  if (flightLog.length > 10000) flightLog.shift();
}

// ─── Mock drone ───────────────────────────────────────────────────────────────
function createMockDrone() {
  const { EventEmitter } = require('events');
  const ee = new EventEmitter();

  let simAlt     = 0;
  let simFlying  = false;
  const configuredBattery = Number(process.env.DRONE_MOCK_BATTERY);
  let simBattery = Number.isFinite(configuredBattery)
    ? clamp(configuredBattery, 0, 100)
    : 87;
  let simGaz     = 0;
  let mockPcmdSequence = 1;
  let mockConfigSequence = 1;
  let mockRefSequence = 1;

  const navInterval = setInterval(() => {
    if (simFlying) simAlt = Math.max(0, simAlt + simGaz * 0.05);
    ee.emit('navdata', {
      droneState: { flying: simFlying ? 1 : 0, emergency: 0 },
      demo: { altitude: simAlt, batteryPercentage: simBattery }
    });
  }, 100);

  const drone = {
    takeoff()          {
      simFlying = true;
      console.log(`[AT*REF MOCK] AT*REF=${mockRefSequence++},512\\r`);
    },
    land()             { simFlying = false; simAlt = 0; console.log('[MOCK] land'); },
    stop()             { simGaz = 0; console.log('[MOCK] stop'); },
    up(v)              { simGaz =  v; console.log(`[MOCK] up(${v.toFixed(3)})`); },
    down(v)            { simGaz = -v; console.log(`[MOCK] down(${v.toFixed(3)})`); },
    logPcmd(axes) {
      console.log(`[AT*PCMD MOCK] ${encodePcmd(mockPcmdSequence++, axes)}\\r`);
    },
    front(v)           { console.log(`[MOCK] front(${v.toFixed(3)})`); },
    back(v)            { console.log(`[MOCK] back(${v.toFixed(3)})`); },
    right(v)           { console.log(`[MOCK] right(${v.toFixed(3)})`); },
    left(v)            { console.log(`[MOCK] left(${v.toFixed(3)})`); },
    clockwise(v)       { console.log(`[MOCK] clockwise(${v.toFixed(3)})`); },
    counterClockwise(v){ console.log(`[MOCK] counterClockwise(${v.toFixed(3)})`); },
    disableEmergency() { console.log('[MOCK] disableEmergency'); },
    ftrim()            { console.log('[MOCK] ftrim'); },
    config(k, v, cb)   {
      const ids = `AT*CONFIG_IDS=${mockConfigSequence++},"${CONFIG_IDS.session}","${CONFIG_IDS.user}","${CONFIG_IDS.app}"`;
      const config = `AT*CONFIG=${mockConfigSequence++},"${k}","${v}"`;
      console.log(`[AT*CONFIG MOCK] ${ids}\\r`);
      console.log(`[AT*CONFIG MOCK] ${config}\\r`);
      if (cb) setImmediate(() => cb(null));
    },
    getPngStream() {
      const { Readable } = require('stream');
      let frameTimer;
      const stream = new Readable({
        read() {},
        destroy(err, callback) {
          clearInterval(frameTimer);
          callback(err);
        }
      });
      const PNG_1x1 = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=',
        'base64'
      );
      frameTimer = setInterval(() => stream.push(PNG_1x1), 83);
      return stream;
    },
    on(ev, cb)          { ee.on(ev, cb); return drone; },
    once(ev, cb)        { ee.once(ev, cb); return drone; },
    removeListener(ev,cb){ ee.removeListener(ev, cb); return drone; },
    _cleanup()          { clearInterval(navInterval); }
  };
  return drone;
}

// ─── Real drone factory ───────────────────────────────────────────────────────
function createRealDrone() {
  const arDrone = require('ar-drone');
  // createClient() calls resume() itself.
  const drone = arDrone.createClient({ ip: DRONE_IP });
  const socket = drone._udpControl && drone._udpControl._socket;
  if (!socket || typeof socket.send !== 'function') {
    throw new Error('Cannot enable AT*PCMD logging: ar-drone UDP control socket is unavailable.');
  }
  const originalSend = socket.send;
  socket.send = function(data, offset, length) {
    if (Buffer.isBuffer(data)) {
      const payload = data.toString('ascii', offset, offset + length);
      for (const command of payload.split('\r')) {
        if (command.startsWith('AT*CONFIG=') || command.startsWith('AT*CONFIG_IDS=')) {
          console.log(`[AT] ${command}\\r`);
        } else if (command.startsWith('AT*PCMD=')) {
          const fields = command.split(',');
          if (fields.slice(2).every((field) => field === '0')) continue;
          console.log(`[AT*PCMD] ${command}\\r`);
        } else if (command.startsWith('AT*REF=')) {
          console.log(`[AT] ${command}\\r`);
        }
      }
    }
    return originalSend.apply(this, arguments);
  };
  return drone;
}

// ─── Movement helper ──────────────────────────────────────────────────────────
function applyMove(drone, pitch, roll, yaw, gaz) {
  pitch = clamp(pitch, -1, 1);
  roll  = clamp(roll,  -1, 1);
  yaw   = clamp(yaw,   -1, 1);
  gaz   = clamp(gaz,   -1, 1);

  const guardedGaz = limitGazAtAltitude(altitudeCurrent, maxAlt, gaz);
  if (guardedGaz !== gaz) {
    console.log(`[MOVE] alt guard: gaz ${gaz.toFixed(3)} → ${guardedGaz.toFixed(3)} (alt=${altitudeCurrent.toFixed(2)}m limit=${maxAlt.toFixed(2)}m)`);
  }
  gaz = guardedGaz;
  lastPcmdGaz = gaz;

  setDroneAxes(drone, { pitch, roll, yaw, gaz });

  if (typeof drone.logPcmd === 'function') {
    drone.logPcmd({ roll, pitch: pitch === 0 ? 0 : -pitch, gaz, yaw });
  }
  console.log(`[CMD] → drone: PCMD pitch=${pitch.toFixed(3)} roll=${roll.toFixed(3)} yaw=${yaw.toFixed(3)} gaz=${gaz.toFixed(3)}`);
}

// ─── Watchdog ─────────────────────────────────────────────────────────────────
function resetWatchdog(drone) {
  if (watchdogTimer) clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(() => {
    if (isFlying) {
      console.log('[WD] No move for 1 s — hovering');
      try {
        drone.stop();
        console.log('[CMD] → drone: stop()');
      } catch (err) {
        console.error('[WD] hover command failed:', err.message || err);
      }
    }
  }, 1000);
}

// ─── Firmware configuration ────────────────────────────────────────────────────
function sendConfigWithRetry(drone, key, value, callback, attempt = 1) {
  try {
    if (!MOCK_MODE) queueConfigIds(drone);
    drone.config(key, value, (err) => {
      if (err && attempt < 3) {
        console.warn(`[CFG] ${key} not acknowledged (attempt ${attempt}); resending`);
        sendConfigWithRetry(drone, key, value, callback, attempt + 1);
        return;
      }
      callback(err || null);
    });
  } catch (err) {
    if (attempt < 3) {
      console.warn(`[CFG] ${key} send failed (attempt ${attempt}); resending:`, err.message || err);
      sendConfigWithRetry(drone, key, value, callback, attempt + 1);
      return;
    }
    callback(err);
  }
}

function applyAltitudeConfig(drone, callback) {
  const mm = altitudeLimitMillimeters(maxAlt);
  console.log(`[CFG] altitude_max → ${mm} mm (${maxAlt} m)`);
  sendConfigWithRetry(drone, 'control:altitude_max', mm, (err) => {
    if (err) console.error('[CFG] altitude_max was not acknowledged after retries:', err.message || err);
    else console.log(`[CFG] altitude_max acknowledged (${mm} mm)`);
    if (callback) callback(err || null);
  });
}

function readDroneConfig(drone) {
  if (MOCK_MODE) return;
  const keys = [
    'control:altitude_max',
    'control:control_vz_max',
    'control:euler_angle_max',
    'control:outdoor'
  ];
  const socket = net.createConnection({ host: DRONE_IP, port: 5559 });
  let response = '';
  let finished = false;
  let idleTimer = null;
  const finish = (error) => {
    if (finished) return;
    finished = true;
    clearTimeout(idleTimer);
    if (error) {
      console.warn('[CFG READBACK] failed:', error.message || error);
    } else {
      console.log('[CFG READBACK] values reported by drone:');
      for (const key of keys) {
        const value = parseConfigValue(response, key);
        console.log(`[CFG READBACK] ${key}=${value === null ? 'NOT PRESENT' : value}`);
      }
    }
    socket.destroy();
  };
  socket.setTimeout(3000, () => finish(new Error('TCP 5559 readback timed out')));
  socket.on('connect', () => {
    console.log('[CFG READBACK] TCP 5559 connected; requesting configuration with AT*CTRL=4,0');
    try {
      drone.ctrl(4, 0);
    } catch (err) {
      finish(err);
    }
  });
  socket.on('data', (chunk) => {
    response += chunk.toString('ascii');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finish(), 300);
  });
  socket.on('end', () => finish());
  socket.on('error', (err) => finish(err));
}

function applyFlightConfig(drone, onComplete) {
  const settings = [
    ['control:altitude_max', altitudeLimitMillimeters(maxAlt), 'altitude_max'],
    ['control:outdoor', BASE_SETTINGS['control:outdoor'], 'outdoor'],
    ['control:euler_angle_max', BASE_SETTINGS['control:euler_angle_max'], 'euler_angle_max'],
    ['control:control_vz_max', String(CONTROL_LIMITS.verticalSpeedMmPerSecond), 'control_vz_max'],
    ['control:control_yaw', String(CONTROL_LIMITS.yawRateRadiansPerSecond), 'control_yaw'],
    ['control:indoor_euler_angle_max', BASE_SETTINGS['control:indoor_euler_angle_max'], 'indoor_euler_angle_max'],
    ['control:indoor_control_vz_max', BASE_SETTINGS['control:indoor_control_vz_max'], 'indoor_control_vz_max'],
    ['control:indoor_control_yaw', BASE_SETTINGS['control:indoor_control_yaw'], 'indoor_control_yaw'],
    ['control:outdoor_euler_angle_max', BASE_SETTINGS['control:outdoor_euler_angle_max'], 'outdoor_euler_angle_max'],
    ['control:outdoor_control_vz_max', BASE_SETTINGS['control:outdoor_control_vz_max'], 'outdoor_control_vz_max'],
    ['control:outdoor_control_yaw', BASE_SETTINGS['control:outdoor_control_yaw'], 'outdoor_control_yaw']
  ];

  function applyNext(index) {
    if (index >= settings.length) {
      if (onComplete) onComplete();
      return;
    }
    const [key, value, label] = settings[index];
    console.log(`[CFG] ${label} → ${value}${label === 'altitude_max' ? ' mm' : ''}`);
    sendConfigWithRetry(drone, key, value, (err) => {
      if (err) console.error(`[CFG] ${label} was not acknowledged after retries:`, err.message || err);
      else console.log(`[CFG] ${label} acknowledged (${value})`);
      applyNext(index + 1);
    });
  }
  applyNext(0);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const app    = express();
  const server = http.createServer(app);
  const wss    = new WebSocketServer({ server });
  let takeoffRequestId = 0;
  let takeoffPending = false;
  let takeoffSource = null;
  let takeoffCommandSent = false;
  let pendingMove = null;
  let throttleTakeoffSince = null;
  let throttleTakeoffArmed = true;
  let altitudeConfigTimer = null;
  let motorTestTimer = null;
  let motorTestActive = false;
  let motorTestOwner = null;
  let motorSequenceOwner = null;
  let motorSequenceId = null;
  let directorTimer = null;
  let directorRun = null;
  let lastSafetyNavdataTime = 0;
  let hasSeenNavdata = false;
  let lastMotorTestResult = 'not tested';
  const modeManager = new ModeManager(BASE_SETTINGS);
  let modeTransition = Promise.resolve();
  let modeTransitionCount = 0;
  let commandAckSeen = null;

  function getFlightLimits() {
    const outdoor = modeManager.settings['control:outdoor'] === 'TRUE';
    const hullPrefix = outdoor ? 'outdoor' : 'indoor';
    const configuredVerticalSpeed =
      modeManager.settings[`control:${hullPrefix}_control_vz_max`] ||
      modeManager.settings['control:control_vz_max'];
    const configuredTilt =
      modeManager.settings[`control:${hullPrefix}_euler_angle_max`] ||
      modeManager.settings['control:euler_angle_max'];
    const telemetryIsFresh = hasRecentNavdata();
    return {
      altitudeRawMm: telemetryIsFresh ? Math.round(altitudeCurrent * 1000) : null,
      altitudeMeters: telemetryIsFresh ? altitudeCurrent : null,
      limitMm: Number(modeManager.settings['control:altitude_max']),
      limitMeters: maxAlt,
      verticalSpeedMmPerSecond: Number(configuredVerticalSpeed),
      tiltRadians: Number(configuredTilt),
      mode: activeMode,
      batteryPct: telemetryIsFresh && typeof batteryPct === 'number' ? batteryPct : null,
      lastPcmdGaz,
      commandAck: commandAckSeen,
      droneState: droneStateFlags
    };
  }

  wss.on('error', (err) => {
    console.error('[SRV] HTTP/WebSocket server error:', err.message || err);
    if (err.code === 'EADDRINUSE') {
      console.error(`[SRV] Port ${PORT} is already in use. Set PORT to another available port.`);
    }
    process.exit(1);
  });

  app.use(express.static(path.join(__dirname, 'public')));

  function getStatus() {
    return {
      mock: MOCK_MODE,
      clients: clientCount,
      navdataAge: lastNavdataTime ? Date.now() - lastNavdataTime : null,
      navdata: hasRecentNavdata(),
      navdataCount,
      altitude: altitudeCurrent,
      battery: batteryPct,
      flying: isFlying,
      maxAlt,
      flightLimits: getFlightLimits(),
      droneState: droneStateFlags,
      videoFps,
      mode: activeMode,
      safety: { enabled: safetyEnabled, batteryThreshold: safetyBatteryThreshold },
      motorTest: { active: motorTestActive, result: lastMotorTestResult },
      modes: modeManager.list(),
      director: directorRun ? {
        shot: directorRun.shot,
        countdown: Math.max(0, Math.ceil((directorRun.startedAt - Date.now()) / 1000)),
        progress: Math.max(0, Math.min(1, (Date.now() - directorRun.startedAt) / directorRun.duration))
      } : null
    };
  }

  function sendNotice(ws, message) {
    if (ws.readyState === OPEN) {
      ws.send(JSON.stringify({ type: 'notice', message }), (err) => {
        if (err) console.warn('[WS] notice send failed:', err.message || err);
      });
    }
  }

  function broadcastState() {
    broadcast(wss, {
      type: 'status',
      altitude: Math.round(altitudeCurrent * 100) / 100,
      battery: typeof batteryPct === 'number' ? Math.round(batteryPct) : null,
      flying: isFlying,
      maxAlt,
      flightLimits: getFlightLimits(),
      droneState: droneStateFlags,
      clients: clientCount,
      navdataAge: lastNavdataTime ? Date.now() - lastNavdataTime : null,
      videoFps,
      mock: MOCK_MODE,
      navdata: hasRecentNavdata(),
      mode: activeMode,
      safety: { enabled: safetyEnabled, batteryThreshold: safetyBatteryThreshold },
      motorTest: { active: motorTestActive, result: lastMotorTestResult },
      modes: modeManager.list()
    });
  }

  function stopMotorTest(reason, preserveSequence = false) {
    if (motorTestTimer) clearTimeout(motorTestTimer);
    motorTestTimer = null;
    if (!motorTestActive) {
      if (!preserveSequence) {
        motorSequenceOwner = null;
        motorSequenceId = null;
      }
      return;
    }
    motorTestActive = false;
    motorTestOwner = null;
    if (!preserveSequence) {
      motorSequenceOwner = null;
      motorSequenceId = null;
    }
    lastMotorTestResult = MOCK_MODE ? 'simulated only; no motors were driven' : 'not run';
    logEvent('motor-test-stop', { reason, simulated: MOCK_MODE });
    console.log(`[MOTOR TEST] stopped: ${reason}`);
    broadcastState();
  }

  function refuseMotorTest(ws, message) {
    motorSequenceOwner = null;
    motorSequenceId = null;
    logEvent('motor-test-refused', { message });
    sendNotice(ws, message);
  }

  function stopDirector(reason) {
    if (directorTimer) clearInterval(directorTimer);
    directorTimer = null;
    if (!directorRun) return;
    const shot = directorRun.shot;
    directorRun = null;
    drone.stop();
    console.log(`[DIRECTOR] cancelled/stopped: ${reason}`);
    logEvent('director-stop', { shot, reason });
    broadcastState();
  }

  function safetyLand(reason) {
    if (!isFlying) return;
    stopDirector('safety landing');
    drone.stop();
    drone.land();
    takeoffCommandSent = false;
    logEvent('safety-land', { reason });
    console.warn(`[SAFETY] landing: ${reason}`);
    broadcast(wss, { type: 'notice', message: `Safety landing: ${reason}` });
  }

  function cancelThrottleTakeoff() {
    if (!takeoffPending || takeoffSource !== 'throttle') return;
    takeoffRequestId++;
    takeoffPending = false;
    takeoffSource = null;
    pendingMove = null;
    console.log('[CMD] throttle takeoff cancelled before launch');
  }

  function requestTakeoff(ws, source) {
    if (modeTransitionCount > 0) {
      sendNotice(ws, 'Takeoff blocked while a mode preset is being applied.');
      return;
    }
    if (takeoffPending || takeoffCommandSent || isFlying) return;
    if (!MOCK_MODE && !hasRecentNavdata()) {
      if (source === 'button') {
        sendNotice(ws, 'Takeoff blocked: no recent navdata from the drone.');
      } else {
        sendNotice(ws, 'Throttle takeoff blocked: no recent navdata from the drone.');
      }
      console.warn(`[CMD] ${source} takeoff blocked — no recent navdata from the drone`);
      return;
    }

    if (altitudeConfigTimer) {
      clearTimeout(altitudeConfigTimer);
      altitudeConfigTimer = null;
    }
    takeoffPending = true;
    takeoffSource = source;
    const requestId = ++takeoffRequestId;
    console.log(`[CMD] ${source} takeoff requested`);
    console.log(`[TAKEOFF] before command: state flags=${JSON.stringify(droneStateFlags)} battery=${batteryPct === null ? 'N/A' : `${Math.round(batteryPct)}%`}`);
    applyAltitudeConfig(drone, (err) => {
      if (requestId !== takeoffRequestId) return;
      takeoffPending = false;
      takeoffSource = null;
      if (err) {
        pendingMove = null;
        sendNotice(ws, 'Takeoff blocked: height-limit configuration was not acknowledged.');
        return;
      }
      if (source === 'throttle' &&
          (!pendingMove || pendingMove.gaz < THROTTLE_TAKEOFF_THRESHOLD)) {
        pendingMove = null;
        console.log('[CMD] throttle takeoff cancelled — throttle was released');
        return;
      }

      drone.takeoff();
      takeoffCommandSent = true;
      console.log(`[CMD] → drone: takeoff() via ${source}`);
      console.log(`[TAKEOFF] AT*REF requested; current state flags=${JSON.stringify(droneStateFlags)} battery=${batteryPct === null ? 'N/A' : `${Math.round(batteryPct)}%`}`);
      if (pendingMove) {
        const axes = pendingMove;
        pendingMove = null;
        applyMove(drone, axes.pitch, axes.roll, axes.yaw, axes.gaz);
        resetWatchdog(drone);
      }
    });
  }

  // ── Health endpoint ──────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json(getStatus());
  });

  app.get('/flight-log.csv', (_req, res) => {
    const header = 'time,mode,altitude_m,speed,battery_percent,event,details';
    const rows = flightLog.map((entry) => [
      entry.time, entry.mode, entry.altitude, entry.speed, entry.battery ?? '',
      entry.event, entry.details
    ].map((value) => `"${String(value).replace(/"/g, '""')}"`).join(','));
    res.type('text/csv').attachment('flight-log.csv').send([header, ...rows].join('\r\n'));
  });

  // ── Drone init ───────────────────────────────────────────────────────────────
  if (MOCK_MODE) {
    console.log('[SRV] *** MOCK MODE — no real drone ***');
  } else {
    console.log(`[SRV] LIVE MODE — connecting to drone at ${DRONE_IP}`);
    console.log('[SRV] ar-drone createClient() starts its command loop and navdata.');
  }

  const drone = MOCK_MODE ? createMockDrone() : createRealDrone();

  drone.disableEmergency();
  applyFlightConfig(drone, () => readDroneConfig(drone));
  const applyModeConfig = (key, value) => new Promise((resolve, reject) => {
    sendConfigWithRetry(drone, key, value, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  function startDirector(ws, shotId) {
    const scripts = {
      turn: { duration: 10000, phases: [{ ms: 10000, axes: { yaw: 0.2 } }] },
      dolly: { duration: 5000, phases: [
        { ms: 2500, axes: { pitch: -0.2 } },
        { ms: 2500, axes: { pitch: 0.2 } }
      ] },
      reveal: { duration: 7000, rise: 1, phases: [
        { ms: 7000, axes: { pitch: 0.12, gaz: 0.2 } }
      ] },
      slide: { duration: 5000, phases: [
        { ms: 2500, axes: { roll: -0.2 } },
        { ms: 2500, axes: { roll: 0.2 } }
      ] }
    };
    const script = scripts[shotId];
    if (!script) {
      sendNotice(ws, 'Unknown Director shot.');
      return;
    }

    stopDirector('replaced by another script');
    sendNotice(ws, 'Director starts in 3 seconds. Touch either stick or press LAND to cancel.');
    logEvent('director-countdown', { shot: shotId });
    const countdownStarted = Date.now();
    directorRun = {
      shot: shotId,
      startedAt: countdownStarted + 3000,
      duration: script.duration,
      startAltitude: altitudeCurrent,
      phases: script.phases,
      rise: script.rise || 0,
      running: false
    };
    let phaseIndex = 0;
    directorTimer = setInterval(() => {
      if (!directorRun) return;
      const now = Date.now();
      if (now < directorRun.startedAt) return;
      if (!directorRun.running) {
        directorRun.running = true;
        directorRun.startedAt = now;
        logEvent('director-start', { shot: shotId });
      }
      if (directorRun.rise &&
          altitudeCurrent >= Math.min(maxAlt, directorRun.startAltitude + directorRun.rise)) {
        stopDirector('height target reached');
        return;
      }
      const elapsed = now - directorRun.startedAt;
      if (elapsed >= directorRun.duration) {
        stopDirector('script complete');
        return;
      }
      while (phaseIndex < script.phases.length &&
             elapsed >= script.phases.slice(0, phaseIndex + 1).reduce((sum, p) => sum + p.ms, 0)) {
        phaseIndex++;
      }
      const phase = script.phases[Math.min(phaseIndex, script.phases.length - 1)];
      const axes = { pitch: 0, roll: 0, yaw: 0, gaz: 0, ...phase.axes };
      for (const key of ['pitch', 'roll', 'yaw', 'gaz']) axes[key] = clamp(axes[key], -0.3, 0.3);
      applyMove(drone, axes.pitch, axes.roll, axes.yaw, axes.gaz);
      resetWatchdog(drone);
      broadcastState();
    }, 50);
  }

  // ── Navdata ──────────────────────────────────────────────────────────────────
  drone.on('error', (err) => {
    console.error('[DRONE] client error:', err.message || err);
  });
  drone.on('navdata', (data) => {
    const navdataRecovered = hasSeenNavdata && Date.now() - lastNavdataTime > 2000;
    hasSeenNavdata = true;
    navdataCount++;
    lastNavdataTime = Date.now();
    if (navdataRecovered) {
      console.warn('[CFG] navdata recovered after a connection gap; reapplying flight configuration');
      applyFlightConfig(drone, () => readDroneConfig(drone));
    }
    lastSafetyNavdataTime = lastNavdataTime;
    const demo  = data.demo || {};
    const state = data.droneState || {};
    const previousFlying = isFlying;
    const parsedAltitude = typeof demo.altitudeMeters === 'number'
      ? demo.altitudeMeters
      : demo.altitude;
    altitudeCurrent = typeof parsedAltitude === 'number' ? parsedAltitude : altitudeCurrent;
    batteryPct = typeof demo.batteryPercentage === 'number' ? demo.batteryPercentage : batteryPct;
    isFlying = !!state.flying;
    droneStateFlags = { ...state };
    if (typeof state.controlCommandAck === 'number' || typeof state.controlCommandAck === 'boolean') {
      commandAckSeen = !!state.controlCommandAck;
    }
    emergencyActive = !!(state.emergency || state.emergencyLanding || state.emergencyLanding === 1);
    if (!previousFlying && isFlying) {
      console.log(`[TAKEOFF] flying confirmed; state flags=${JSON.stringify(state)} battery=${batteryPct === null ? 'N/A' : `${Math.round(batteryPct)}%`}`);
    }
    if (safetyEnabled && typeof batteryPct === 'number') {
      if (batteryPct <= safetyBatteryThreshold && isFlying) {
        safetyLand(`battery ${Math.round(batteryPct)}% reached ${safetyBatteryThreshold}% threshold`);
      } else if (batteryPct <= safetyBatteryThreshold + 10 && !safetyWarningSent) {
        safetyWarningSent = true;
        broadcast(wss, { type: 'notice', message: `Safety warning: battery is ${Math.round(batteryPct)}%` });
        logEvent('safety-battery-warning', { battery: batteryPct });
      } else if (batteryPct > safetyBatteryThreshold + 10) {
        safetyWarningSent = false;
      }
    }
  });

  // ── Status broadcast 5× per second ──────────────────────────────────────────
  setInterval(() => {
    broadcast(wss, {
      type    : 'status',
      altitude: Math.round(altitudeCurrent * 100) / 100,
      battery : typeof batteryPct === 'number' ? Math.round(batteryPct) : null,
      flying  : isFlying,
      maxAlt,
      flightLimits: getFlightLimits(),
      droneState: droneStateFlags,
      clients: clientCount,
      navdataAge: lastNavdataTime ? Date.now() - lastNavdataTime : null,
      videoFps,
      mock: MOCK_MODE,
      navdata: hasRecentNavdata(),
      mode: activeMode,
      safety: { enabled: safetyEnabled, batteryThreshold: safetyBatteryThreshold },
      motorTest: { active: motorTestActive, result: lastMotorTestResult },
      modes: modeManager.list(),
      videoFps,
      director: directorRun ? {
        shot: directorRun.shot,
        countdown: Math.max(0, Math.ceil((directorRun.startedAt - Date.now()) / 1000)),
        progress: Math.max(0, Math.min(1, (Date.now() - directorRun.startedAt) / directorRun.duration))
      } : null
    });
  }, 200);

  setInterval(() => {
    if (safetyEnabled && isFlying &&
        (!lastSafetyNavdataTime || Date.now() - lastSafetyNavdataTime > 2000)) {
      safetyLand('navdata lost for more than 2 seconds');
    }
    if (activeMode === 'race' || activeMode === 'tilt') {
      const mode = modeManager.modes.get(activeMode);
      if (mode) mode.tick({ altitude: altitudeCurrent, battery: batteryPct, flying: isFlying });
    }
    flightLog.push({
      time: new Date().toISOString(),
      mode: activeMode,
      altitude: altitudeCurrent,
      speed: actualSpeed,
      battery: batteryPct,
      event: 'sample',
      details: ''
    });
    if (flightLog.length > 10000) flightLog.shift();
  }, 1000);

  // ── Server-side status log every 2 s ────────────────────────────────────────
  let _prevFrameCount = 0;
  setInterval(() => {
    const navAge = lastNavdataTime ? Math.round((Date.now() - lastNavdataTime)) + 'ms' : 'NO DATA';
    videoFps = Math.round((_prevFrameCount === videoFrameCount ? 0 :
      (videoFrameCount - _prevFrameCount) / 2));
    _prevFrameCount = videoFrameCount;
    console.log(
      `[STATUS] clients=${clientCount}  navAge=${navAge}  ` +
      `alt=${altitudeCurrent.toFixed(2)}m  bat=${typeof batteryPct === 'number' ? `${Math.round(batteryPct)}%` : 'N/A'}  ` +
      `flying=${isFlying}  videoFps=${videoFps}`
    );
  }, 2000);

  // ── Video stream ─────────────────────────────────────────────────────────────
  const FPS_INTERVAL = Math.round(1000 / 12);
  const MAX_BUF      = 512 * 1024;
  let lastFrameTime  = 0;

  try {
    const pngStream = drone.getPngStream();
    pngStream.on('error', (err) => {
      console.warn('[VIDEO] stream error:', err.message || err);
    });
    pngStream.on('data', (chunk) => {
      const now = Date.now();
      if (now - lastFrameTime < FPS_INTERVAL) return;
      lastFrameTime = now;
      videoFrameCount++;
      for (const client of wss.clients) {
        if (client.readyState !== OPEN) continue;
        if (client.bufferedAmount > MAX_BUF) continue;
        client.send(chunk, { binary: true }, (err) => {
          if (err) console.warn('[VIDEO] websocket send failed:', err.message || err);
        });
      }
    });
  } catch (err) {
    console.warn('[VIDEO] getPngStream() failed:', err.message || err);
  }

  // ── WebSocket ────────────────────────────────────────────────────────────────
  wss.on('connection', (ws) => {
    clientCount++;
    console.log(`[WS] client connected  (total: ${clientCount})`);

    // Send current state immediately
    ws.send(JSON.stringify({
      type: 'status',
      altitude: altitudeCurrent,
      battery: batteryPct,
      flying: isFlying,
      maxAlt,
      flightLimits: getFlightLimits(),
      droneState: droneStateFlags,
      clients: clientCount,
      navdataAge: lastNavdataTime ? Date.now() - lastNavdataTime : null,
      videoFps,
      mock: MOCK_MODE,
      navdata: hasRecentNavdata(),
      mode: activeMode,
      safety: { enabled: safetyEnabled, batteryThreshold: safetyBatteryThreshold },
      motorTest: { active: motorTestActive, result: lastMotorTestResult },
      modes: modeManager.list(),
      videoFps
    }), (err) => {
      if (err) console.warn('[WS] initial status send failed:', err.message || err);
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        console.warn('[WS] binary frame from phone ignored');
        return;
      }
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch (err) {
        console.warn('[WS] malformed JSON ignored:', err.message);
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      console.log(`[CMD] ← phone: ${JSON.stringify(msg)}`);
      const continuesMotorSequence = msg.type === 'motor-test' &&
        motorSequenceOwner === ws && typeof msg.sequenceId === 'string' &&
        msg.sequenceId === motorSequenceId;
      if (motorSequenceOwner && !continuesMotorSequence &&
          msg.type !== 'motor-test-sequence-stop') {
        stopMotorTest('another websocket message received');
      } else if (motorTestActive &&
                 msg.type !== 'motor-test-sequence-stop' && !continuesMotorSequence) {
        stopMotorTest('another websocket message received');
      }

      switch (msg.type) {

        case 'takeoff':
          stopDirector('takeoff requested');
          requestTakeoff(ws, 'button');
          logEvent('takeoff-requested', { source: 'button' });
          break;

        case 'land':
          stopDirector('LAND pressed');
          takeoffRequestId++;
          takeoffPending = false;
          takeoffSource = null;
          takeoffCommandSent = false;
          pendingMove = null;
          throttleTakeoffSince = null;
          throttleTakeoffArmed = false;
          if (altitudeConfigTimer) {
            clearTimeout(altitudeConfigTimer);
            altitudeConfigTimer = null;
          }
          if (watchdogTimer) clearTimeout(watchdogTimer);
          drone.stop();
          console.log('[CMD] → drone: stop()');
          drone.land();
          console.log('[CMD] → drone: land()');
          logEvent('land');
          break;

        case 'stop':
          throttleTakeoffSince = null;
          throttleTakeoffArmed = true;
          cancelThrottleTakeoff();
          drone.stop();
          console.log('[CMD] → drone: stop()');
          break;

        case 'mode': {
          if (typeof msg.id !== 'string') break;
          if (msg.id === 'safety') {
            safetyEnabled = !safetyEnabled;
            safetyWarningSent = false;
            logEvent('safety-toggle', { enabled: safetyEnabled, threshold: safetyBatteryThreshold });
            broadcastState();
            break;
          }
          modeTransitionCount++;
          modeTransition = modeTransition.then(() => modeManager.enter(msg.id, {
            isFlying: isFlying || takeoffPending,
            applyConfig: applyModeConfig,
            onRestoreError: (key, err) => {
              console.error(`[MODE] restore ${key} failed:`, err.message || err);
            }
          })).then(({ mode }) => {
            activeMode = mode.id;
            maxAlt = Number(modeManager.settings['control:altitude_max']) / 1000;
            logEvent('mode-change', { mode: activeMode });
            broadcastState();
          }).catch((err) => {
            sendNotice(ws, `Mode not changed: ${err.message}`);
            console.warn(`[MODE] change rejected: ${err.message}`);
          }).finally(() => { modeTransitionCount--; });
          break;
        }

        case 'safety-toggle':
          if (typeof msg.enabled === 'boolean') {
            safetyEnabled = msg.enabled;
            if (typeof msg.threshold === 'number' && isFinite(msg.threshold)) {
              safetyBatteryThreshold = clamp(msg.threshold, 10, 50);
            }
            safetyWarningSent = false;
            logEvent('safety-toggle', { enabled: safetyEnabled, threshold: safetyBatteryThreshold });
            broadcastState();
          }
          break;

        case 'hull': {
          if (!['indoor', 'outdoor'].includes(msg.value)) break;
          if (isFlying) {
            sendNotice(ws, 'Hull settings can only be changed while landed.');
            break;
          }
          const value = msg.value === 'outdoor' ? 'TRUE' : 'FALSE';
          applyModeConfig('control:outdoor', value).then(() => {
            modeManager.settings['control:outdoor'] = value;
            logEvent('hull-change', { hull: msg.value });
            sendNotice(ws, `${msg.value} hull preset applied.`);
          }).catch((err) => {
            sendNotice(ws, `Hull setting failed: ${err.message}`);
            console.error('[CFG] hull setting failed:', err.message || err);
          });
          break;
        }

        case 'emergency-hover':
          stopDirector('emergency hover');
          drone.stop();
          actualSpeed = 0;
          logEvent('emergency-hover');
          console.warn('[SAFETY] emergency hover command');
          break;

        case 'motor-test':
          if (motorTestActive) {
            refuseMotorTest(ws, 'Motor test refused: another test is already active.');
            break;
          }
          if (msg.sequenceStart === true && typeof msg.sequenceId === 'string') {
            motorSequenceOwner = ws;
            motorSequenceId = msg.sequenceId;
          } else if (msg.sequenceId !== undefined &&
                     (motorSequenceOwner !== ws || msg.sequenceId !== motorSequenceId)) {
            refuseMotorTest(ws, 'Motor test sequence refused: invalid sequence token.');
            break;
          }
          if (isFlying) {
            refuseMotorTest(ws, 'Motor test refused: drone must be landed.');
          } else if (typeof batteryPct !== 'number' || batteryPct < 30) {
            refuseMotorTest(ws, 'Motor test refused: battery must be at least 30%.');
          } else if (emergencyActive) {
            refuseMotorTest(ws, 'Motor test refused: clear the emergency state first.');
          } else if (msg.propsRemoved !== true || msg.confirmed !== true) {
            refuseMotorTest(ws, 'Motor test refused: remove all propellers and confirm twice.');
          } else if (!MOCK_MODE) {
            lastMotorTestResult = 'unavailable: AT*PWM is prototype-only in the verified SDK';
            refuseMotorTest(ws, lastMotorTestResult);
          } else {
            const power = clamp(Number(msg.power) || 0.15, 0.01, 0.30);
            motorTestActive = true;
            motorTestOwner = ws;
            lastMotorTestResult = 'mock simulation; no motors were driven';
            logEvent('motor-test-start', { motor: msg.motor || 'sequence', power, simulated: true });
            console.log(`[MOTOR TEST MOCK] ${msg.motor || 'sequence'} at ${Math.round(power * 100)}% (no motors driven)`);
            broadcastState();
            const preserveSequence = typeof msg.sequenceId === 'string' &&
              motorSequenceOwner === ws && msg.sequenceId === motorSequenceId;
            motorTestTimer = setTimeout(
              () => stopMotorTest('2 second limit reached', preserveSequence),
              2000
            );
          }
          break;

        case 'motor-test-stop':
          if (motorTestOwner === ws) stopMotorTest('button released');
          break;

        case 'motor-test-sequence-stop':
          stopMotorTest('sequence cancelled');
          break;

        case 'motor-test-capabilities':
          sendNotice(ws, 'AT*PWM is prototype-only; standard AR.Drone 2.0 stock-firmware per-motor testing is unsupported. No motors will be driven.');
          break;

        case 'flip': {
          let reason = '';
          if (!isFlying) reason = 'the drone is not flying';
          else if (typeof batteryPct !== 'number' || batteryPct < 30) reason = 'battery is below 30%';
          else if (altitudeCurrent < 1.0) reason = 'altitude is below 1.0 m';
          else reason = 'the verified SDK does not identify a safe flip animation ID';
          logEvent('flip-refused', { reason, direction: msg.direction || '' });
          sendNotice(ws, `Flip refused: ${reason}. No flip command was sent.`);
          break;
        }

        case 'race-event':
          if (activeMode === 'race' && ['start', 'lap', 'stop'].includes(msg.event)) {
            logEvent(`race-${msg.event}`, { lap: Number(msg.lap) || 0, lapMs: Number(msg.lapMs) || 0 });
          }
          break;

        case 'flight-event':
          if (typeof msg.event === 'string') logEvent(msg.event, msg.details || {});
          break;

        case 'director-start':
          if (activeMode !== 'director' || !isFlying) {
            sendNotice(ws, 'Director requires Director mode and a flying drone.');
          } else {
            startDirector(ws, msg.shot);
          }
          break;

        case 'director-cancel':
        case 'stick-touch':
          stopDirector(msg.type === 'stick-touch' ? 'stick touched' : 'cancelled');
          break;

        case 'move': {
          let pitch = typeof msg.pitch === 'number' && isFinite(msg.pitch) ? msg.pitch : 0;
          let roll  = typeof msg.roll  === 'number' && isFinite(msg.roll)  ? msg.roll  : 0;
          let yaw   = typeof msg.yaw   === 'number' && isFinite(msg.yaw)   ? msg.yaw   : 0;
          let gaz   = typeof msg.gaz   === 'number' && isFinite(msg.gaz)   ? msg.gaz   : 0;
          const modeSpeedCap = activeMode === 'training' ? 0.15 :
            activeMode === 'director' ? 0.30 : 1;
          pitch = clamp(pitch, -modeSpeedCap, modeSpeedCap);
          roll = clamp(roll, -modeSpeedCap, modeSpeedCap);
          yaw = clamp(yaw, -modeSpeedCap, modeSpeedCap);
          gaz = clamp(gaz, -modeSpeedCap, modeSpeedCap);
          pitch = clamp(pitch, -1, 1);
          roll = clamp(roll, -1, 1);
          yaw = clamp(yaw, -1, 1);
          gaz = clamp(gaz, -1, 1);
          const axes = { pitch, roll, yaw, gaz };
          if (Math.max(Math.abs(pitch), Math.abs(roll), Math.abs(yaw), Math.abs(gaz)) > 0) {
            actualSpeed = Math.max(Math.abs(pitch), Math.abs(roll), Math.abs(yaw), Math.abs(gaz));
            if (directorRun) {
              stopDirector('stick input');
              drone.stop();
              break;
            }
          }

          if (gaz < THROTTLE_TAKEOFF_THRESHOLD) {
            throttleTakeoffSince = null;
            throttleTakeoffArmed = true;
            cancelThrottleTakeoff();
          } else if (!isFlying && !takeoffCommandSent && !takeoffPending &&
                     throttleTakeoffArmed) {
            if (throttleTakeoffSince === null) {
              throttleTakeoffSince = Date.now();
              console.log('[CMD] hold left stick UP for 350 ms to take off');
            } else if (Date.now() - throttleTakeoffSince >= 350) {
              throttleTakeoffArmed = false;
              pendingMove = axes;
              requestTakeoff(ws, 'throttle');
            }
          }

          if (takeoffPending) {
            pendingMove = axes;
            break;
          }
          applyMove(drone, pitch, roll, yaw, gaz);
          resetWatchdog(drone);
          break;
        }

        case 'limit': {
          if (typeof msg.value !== 'number' || !isFinite(msg.value)) break;
          maxAlt = clamp(msg.value, 0.5, 5.0);
          modeManager.settings['control:altitude_max'] = altitudeLimitMillimeters(maxAlt);
          if (altitudeConfigTimer) clearTimeout(altitudeConfigTimer);
          altitudeConfigTimer = setTimeout(() => {
            altitudeConfigTimer = null;
            applyAltitudeConfig(drone);
          }, 300);
          broadcast(wss, {
            type: 'status',
            altitude: altitudeCurrent,
            battery: batteryPct,
            flying: isFlying,
            maxAlt,
            flightLimits: getFlightLimits(),
            droneState: droneStateFlags,
            mock: MOCK_MODE,
            navdata: hasRecentNavdata()
          });
          break;
        }

        case 'ftrim':
          if (!isFlying) {
            drone.ftrim();
            console.log('[CMD] → drone: ftrim()');
          } else {
            console.warn('[CMD] ftrim ignored — drone is flying');
          }
          break;

        case 'reset':
          drone.disableEmergency();
          console.log('[CMD] → drone: disableEmergency()');
          break;

        default:
          console.warn(`[CMD] unknown message type: ${msg.type}`);
      }
    });

    ws.on('close', () => {
      clientCount = Math.max(0, clientCount - 1);
      console.log(`[WS] client disconnected  (remaining: ${clientCount})`);
      if (motorTestOwner === ws) stopMotorTest('test owner disconnected');
      if (motorSequenceOwner === ws) {
        stopMotorTest('sequence owner disconnected');
      }
      if (clientCount === 0) {
        stopDirector('all clients disconnected');
        console.log('[WS] last client left — stopping and landing');
        takeoffRequestId++;
        takeoffPending = false;
        takeoffSource = null;
        takeoffCommandSent = false;
        pendingMove = null;
        throttleTakeoffSince = null;
        throttleTakeoffArmed = true;
        takeoffSource = null;
        takeoffCommandSent = false;
        pendingMove = null;
        if (watchdogTimer) clearTimeout(watchdogTimer);
        if (altitudeConfigTimer) {
          clearTimeout(altitudeConfigTimer);
          altitudeConfigTimer = null;
        }
        try {
          drone.stop();
          console.log('[CMD] → drone: stop()');
        } catch (err) {
          console.error('[WS] stop on disconnect failed:', err.message || err);
        }
        setTimeout(() => {
          try {
            drone.land();
            console.log('[CMD] → drone: land()');
          } catch (err) {
            console.error('[WS] land on disconnect failed:', err.message || err);
          }
        }, 500);
      }
    });

    ws.on('error', (err) => {
      console.warn('[WS] client error:', err.message || err);
    });
  });

  // ── SIGINT ───────────────────────────────────────────────────────────────────
  process.on('SIGINT', () => {
    console.log('\n[SRV] SIGINT — stopping and landing…');
    takeoffRequestId++;
    takeoffPending = false;
    takeoffSource = null;
    takeoffCommandSent = false;
    pendingMove = null;
    if (watchdogTimer) clearTimeout(watchdogTimer);
    if (altitudeConfigTimer) clearTimeout(altitudeConfigTimer);
    try {
      drone.stop();
      console.log('[CMD] → drone: stop()');
    } catch (err) {
      console.error('[SRV] stop on shutdown failed:', err.message || err);
    }
    setTimeout(() => {
      try {
        drone.land();
        console.log('[CMD] → drone: land()');
      } catch (err) {
        console.error('[SRV] land on shutdown failed:', err.message || err);
      }
      setTimeout(() => {
        if (MOCK_MODE && drone._cleanup) drone._cleanup();
        process.exit(0);
      }, 1500);
    }, 500);
  });

  // ── Listen ───────────────────────────────────────────────────────────────────
  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n════════════════════════════════════════');
    console.log(`  AR.Drone Web Controller  [${MOCK_MODE ? 'MOCK' : 'LIVE'}]`);
    console.log('════════════════════════════════════════');
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          console.log(`  http://${iface.address}:${PORT}`);
        }
      }
    }
    console.log(`  http://127.0.0.1:${PORT}  (localhost)`);
    console.log('════════════════════════════════════════');
    console.log(`  Health: http://127.0.0.1:${PORT}/health`);
    console.log('════════════════════════════════════════\n');
  });
}

main().catch((err) => {
  console.error('[SRV] Fatal:', err);
  process.exit(1);
});
