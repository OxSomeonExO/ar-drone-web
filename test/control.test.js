'use strict';

const assert = require('assert');
const AtCommandCreator = require('ar-drone/lib/control/AtCommandCreator');
const Client = require('ar-drone/lib/Client');
const { BASE_SETTINGS } = require('../modes');
const {
  CONTROL_LIMITS,
  CONFIG_IDS,
  THROTTLE_TAKEOFF_THRESHOLD,
  altitudeLimitMillimeters,
  altitudeMillimetersToMeters,
  encodePcmd,
  floatToAtInt32,
  limitGazAtAltitude,
  parseConfigValue,
  queueConfigIds,
  setDroneAxes
} = require('../control');

assert.strictEqual(altitudeLimitMillimeters(2.4), '2400');
assert.strictEqual(altitudeLimitMillimeters(5), '5000');
assert.strictEqual(BASE_SETTINGS['control:altitude_max'], '5000');
assert.strictEqual(altitudeMillimetersToMeters(1200), 1.2);
assert.strictEqual(limitGazAtAltitude(altitudeMillimetersToMeters(1200), 2, 0.6), 0.6);
assert.strictEqual(limitGazAtAltitude(altitudeMillimetersToMeters(2100), 2, 0.6), -0.3);
assert.strictEqual(limitGazAtAltitude(1.5, 2, 0.6), 0.6);
assert.strictEqual(limitGazAtAltitude(1.96, 2, 0.6), 0);
assert.strictEqual(limitGazAtAltitude(2.1, 2, 0), -0.3);
assert.strictEqual(limitGazAtAltitude(2.1, 2, -0.4), -0.4);
assert.strictEqual(
  parseConfigValue('control:altitude_max = 2000\r\ncontrol:outdoor = FALSE\r\n', 'control:altitude_max'),
  '2000'
);

assert.strictEqual(CONTROL_LIMITS.verticalSpeedMmPerSecond, 700);
assert.strictEqual(CONTROL_LIMITS.yawRateRadiansPerSecond, 3.0);
assert.notStrictEqual(CONTROL_LIMITS.verticalSpeedMmPerSecond, 0);
assert.notStrictEqual(CONTROL_LIMITS.yawRateRadiansPerSecond, 0);
assert.strictEqual(THROTTLE_TAKEOFF_THRESHOLD, 0.05);

const client = Object.create(Client.prototype);
client._pcmd = {};
setDroneAxes(client, { roll: -0.2, pitch: 0.3, gaz: 0.4, yaw: -0.5 });
const creator = new AtCommandCreator();
assert.strictEqual(
  creator.config('control:altitude_max', '5000').serialize(6),
  'AT*CONFIG=6,"control:altitude_max","5000"\r'
);
assert.strictEqual(creator.ref({ fly: true }).serialize(12), 'AT*REF=12,512\r');
const configQueue = { _cmds: [], _cmdCreator: creator };
queueConfigIds({ _udpControl: configQueue });
assert.strictEqual(
  configQueue._cmds[0].serialize(5) +
    creator.config('control:altitude_max', '2000').serialize(6),
  `AT*CONFIG_IDS=5,"${CONFIG_IDS.session}","${CONFIG_IDS.user}","${CONFIG_IDS.app}"\r` +
    'AT*CONFIG=6,"control:altitude_max","2000"\r'
);
const packageCommand = creator.pcmd(client._pcmd);
const expected = `AT*PCMD=7,1,${floatToAtInt32(-0.2)},${floatToAtInt32(-0.3)},${floatToAtInt32(0.4)},${floatToAtInt32(-0.5)}`;
assert.strictEqual(packageCommand.serialize(7), `${expected}\r`);
assert.notStrictEqual(client._pcmd.left, undefined);
assert.notStrictEqual(client._pcmd.front, undefined);
assert.notStrictEqual(client._pcmd.up, undefined);
assert.notStrictEqual(client._pcmd.counterClockwise, undefined);

setDroneAxes(client, { roll: 0.2, pitch: -0.3, gaz: -0.4, yaw: 0.5 });
assert.deepStrictEqual(Object.keys(client._pcmd).sort(), ['back', 'clockwise', 'down', 'right']);
const reversedPackageCommand = creator.pcmd(client._pcmd);
const reversedExpected = `AT*PCMD=8,1,${floatToAtInt32(0.2)},${floatToAtInt32(0.3)},${floatToAtInt32(-0.4)},${floatToAtInt32(0.5)}`;
assert.strictEqual(reversedPackageCommand.serialize(8), `${reversedExpected}\r`);

setDroneAxes(client, { roll: 0, pitch: 0, gaz: 0, yaw: 0 });
const zeroPackageCommand = creator.pcmd(client._pcmd);
assert.strictEqual(zeroPackageCommand.serialize(9), 'AT*PCMD=9,1,0,0,0,0\r');

const axes = { roll: -0.2, pitch: -0.3, gaz: 0.4, yaw: -0.5 };
const mockEncoded = encodePcmd(7, axes);
assert.strictEqual(mockEncoded, expected);
assert.strictEqual(
  encodePcmd(10, { roll: 0, pitch: 0, gaz: 1, yaw: 0 }),
  `AT*PCMD=10,1,0,0,${floatToAtInt32(1)},0`
);

console.log('PASS control units, throttle takeoff threshold, and nonzero four-axis PCMD encoding');
