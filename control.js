'use strict';

const CONTROL_LIMITS = Object.freeze({
  verticalSpeedMmPerSecond: 700,
  yawRateRadiansPerSecond: 3.0
});
const CONFIG_IDS = Object.freeze({
  session: 'd2e081a3',
  user: 'e4b372c3',
  app: 'd2e081a3'
});
const THROTTLE_TAKEOFF_THRESHOLD = 0.05;

function floatToAtInt32(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeFloatBE(value, 0);
  return buffer.readInt32BE(0);
}

function encodePcmd(sequence, axes, flag) {
  const progressiveFlag = flag === undefined ? 1 : flag;
  return `AT*PCMD=${sequence},${progressiveFlag},${floatToAtInt32(axes.roll)},${floatToAtInt32(axes.pitch)},${floatToAtInt32(axes.gaz)},${floatToAtInt32(axes.yaw)}`;
}

function limitGazAtAltitude(altitudeMeters, limitMeters, gaz) {
  if (altitudeMeters >= limitMeters - 0.05 && gaz > 0) gaz = 0;
  if (altitudeMeters > limitMeters && gaz >= 0) return -0.3;
  return gaz;
}

function setDroneAxes(drone, axes) {
  if (axes.pitch > 0) drone.front(axes.pitch);
  else if (axes.pitch < 0) drone.back(-axes.pitch);
  else drone.back(0);

  if (axes.roll > 0) drone.right(axes.roll);
  else if (axes.roll < 0) drone.left(-axes.roll);
  else drone.right(0);

  if (axes.yaw > 0) drone.clockwise(axes.yaw);
  else if (axes.yaw < 0) drone.counterClockwise(-axes.yaw);
  else drone.clockwise(0);

  if (axes.gaz > 0) drone.up(axes.gaz);
  else if (axes.gaz < 0) drone.down(-axes.gaz);
  else drone.up(0);
}

function altitudeLimitMillimeters(limitMeters) {
  return String(Math.round(limitMeters * 1000));
}

function altitudeMillimetersToMeters(altitudeMillimeters) {
  return altitudeMillimeters / 1000;
}

function parseConfigValue(configText, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = configText.match(new RegExp(`(?:^|[\\r\\n])\\s*${escapedKey}\\s*=\\s*"?([^"\\r\\n]*)"?`, 'm'));
  return match ? match[1].trim() : null;
}

function queueConfigIds(drone) {
  const control = drone && drone._udpControl;
  if (!control || !Array.isArray(control._cmds) ||
      !control._cmdCreator || typeof control._cmdCreator.raw !== 'function') {
    throw new Error('Cannot send AT*CONFIG_IDS: ar-drone UDP control queue is unavailable.');
  }
  const ids = [CONFIG_IDS.session, CONFIG_IDS.user, CONFIG_IDS.app]
    .map((id) => `"${id}"`);
  control._cmds.push(control._cmdCreator.raw('CONFIG_IDS', ids));
}

module.exports = {
  CONFIG_IDS,
  CONTROL_LIMITS,
  THROTTLE_TAKEOFF_THRESHOLD,
  altitudeLimitMillimeters,
  altitudeMillimetersToMeters,
  encodePcmd,
  floatToAtInt32,
  limitGazAtAltitude,
  parseConfigValue,
  queueConfigIds,
  setDroneAxes
};
