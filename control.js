'use strict';

const CONTROL_LIMITS = Object.freeze({
  verticalSpeedMmPerSecond: 700,
  yawRateRadiansPerSecond: 3.0
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

module.exports = {
  CONTROL_LIMITS,
  THROTTLE_TAKEOFF_THRESHOLD,
  altitudeLimitMillimeters,
  encodePcmd,
  floatToAtInt32,
  limitGazAtAltitude,
  setDroneAxes
};
