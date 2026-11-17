'use strict';

const arDrone = require('ar-drone');
const DRONE_IP = process.env.DRONE_IP || '192.168.1.1';
const TAKEOFF = process.argv.includes('--takeoff');
const DIAGNOSIS_MS = 10000;

console.log('AR.Drone 2.0 diagnostic');
console.log(`Drone IP: ${DRONE_IP}`);
console.log(`Mode: ${TAKEOFF ? 'takeoff / 3-second hover / land (remove propellers)' : 'navdata only for 10 seconds'}`);
console.log('This connects to a real drone; it does not use web-app mock mode.');

// createClient() starts the AT command loop and navdata stream automatically.
const client = arDrone.createClient({ ip: DRONE_IP });
let navdataCount = 0;
let lastNavdata = null;
let lastNavdataTime = 0;
let finished = false;

client.on('error', (err) => {
  console.error(`[DIAG] Drone client error: ${err.message || err}`);
});

client.on('navdata', (data) => {
  navdataCount++;
  lastNavdata = data;
  lastNavdataTime = Date.now();
});

const statusTimer = setInterval(() => {
  const age = lastNavdataTime ? `${Date.now() - lastNavdataTime} ms` : 'no packets yet';
  if (!lastNavdata) {
    console.log(`[DIAG] navdata=waiting age=${age} packets=${navdataCount}`);
    return;
  }

  const demo = lastNavdata.demo || {};
  const flags = lastNavdata.droneState || {};
  const battery = typeof demo.batteryPercentage === 'number' ? `${demo.batteryPercentage}%` : 'N/A';
  const altitude = typeof demo.altitude === 'number' ? `${demo.altitude.toFixed(3)} m` : 'N/A';
  console.log(`[DIAG] navdata=YES battery=${battery} altitude=${altitude} age=${age} packets=${navdataCount}`);
  console.log(`[DIAG] droneState flags=${JSON.stringify(flags)}`);
}, 1000);

function finish() {
  if (finished) return;
  finished = true;
  clearInterval(statusTimer);
  console.log('\nDiagnostic summary');
  if (!navdataCount) {
    console.log('FAIL: no navdata received. Confirm Wi-Fi, drone power, and DRONE_IP.');
  } else {
    const demo = lastNavdata.demo || {};
    const flags = lastNavdata.droneState || {};
    console.log(`PASS: received ${navdataCount} navdata packets.`);
    console.log(`Battery: ${demo.batteryPercentage === undefined ? 'N/A' : `${demo.batteryPercentage}%`}`);
    console.log(`Altitude: ${typeof demo.altitude === 'number' ? `${demo.altitude.toFixed(3)} m` : 'N/A'}`);
    console.log(`Drone state flags: ${JSON.stringify(flags)}`);
  }
  process.exitCode = navdataCount ? 0 : 1;
  setTimeout(() => process.exit(), 100);
}

if (TAKEOFF) {
  console.warn('[DIAG] Propellers must be removed before running this mode.');
  setTimeout(() => {
    if (!navdataCount) {
      console.error('[DIAG] No navdata after 3 seconds; takeoff aborted.');
      finish();
      return;
    }

    console.log('[DIAG] Taking off.');
    client.takeoff();
    console.log('[DIAG] Hovering for 3 seconds.');
    setTimeout(() => {
      console.log('[DIAG] Landing.');
      client.land();
      setTimeout(finish, 1000);
    }, 3000);
  }, 3000);
} else {
  setTimeout(finish, DIAGNOSIS_MS);
}
