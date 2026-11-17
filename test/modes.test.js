'use strict';

const assert = require('assert');
const { BASE_SETTINGS, ModeManager } = require('../modes');

async function main() {
  const manager = new ModeManager(BASE_SETTINGS);
  const applied = [];
  const context = {
    isFlying: false,
    applyConfig: async (key, value) => applied.push([key, value]),
    onRestoreError: (_key, error) => { throw error; }
  };

  assert.strictEqual(BASE_SETTINGS['control:altitude_max'], '10000');
  await manager.enter('training', context);
  assert.strictEqual(manager.current.id, 'training');
  assert.strictEqual(manager.settings['control:altitude_max'], '1500');
  assert.strictEqual(manager.current.preset['control:indoor_control_vz_max'], '300');

  await manager.enter('manual', context);
  assert.strictEqual(manager.current.id, 'manual');
  assert.strictEqual(manager.settings['control:altitude_max'], '10000');
  assert.strictEqual(manager.settings['control:indoor_control_vz_max'], '700');
  assert.ok(applied.some(([key, value]) => key === 'control:altitude_max' && value === '1500'));
  assert.ok(applied.some(([key, value]) => key === 'control:altitude_max' && value === '10000'));

  const beforeFlyingSwitch = applied.length;
  await assert.rejects(
    manager.enter('indoor', { ...context, isFlying: true }),
    /only be changed while the drone is landed/
  );
  assert.strictEqual(applied.length, beforeFlyingSwitch);

  await assert.rejects(manager.enter('absolute', context), /PCMD_MAG/);
  await assert.rejects(manager.enter('flip', context), /animation ID/);
  await assert.rejects(manager.enter('test-motors', context), /prototype drones only/);

  const beforeSafety = applied.length;
  const safetyResult = await manager.enter('safety', { ...context, isFlying: true });
  assert.strictEqual(safetyResult.mode.id, 'safety');
  assert.strictEqual(manager.current.id, 'manual');
  assert.strictEqual(applied.length, beforeSafety);

  console.log('PASS mode presets, landed-only switching, restoration, and fail-closed unsupported modes');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
