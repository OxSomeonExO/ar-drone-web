'use strict';

const BASE_SETTINGS = Object.freeze({
  'control:altitude_max': '5000',
  'control:outdoor': 'FALSE',
  'control:euler_angle_max': '0.20944',
  'control:control_vz_max': '700',
  'control:control_yaw': '3',
  'control:indoor_euler_angle_max': '0.20944',
  'control:indoor_control_vz_max': '700',
  'control:indoor_control_yaw': '3',
  'control:outdoor_euler_angle_max': '0.34907',
  'control:outdoor_control_vz_max': '1000',
  'control:outdoor_control_yaw': '3.49066'
});

class Mode {
  constructor(id, name, preset = {}, options = {}) {
    this.id = id;
    this.name = name;
    this.preset = Object.freeze({ ...preset });
    this.available = options.available !== false;
    this.reason = options.reason || '';
  }

  on_enter() {}
  on_exit() {}
  tick() {}
  handle_message() { return false; }
}

class ManualMode extends Mode {
  constructor() { super('manual', 'Manual'); }
}

class TestMotorsMode extends Mode {
  constructor() {
    super('test-motors', 'TEST MOTORS', {}, {
      available: false,
      reason: 'AT*PWM is documented for prototype drones only; this controller cannot safely identify stock-drone per-motor support.'
    });
  }
}

class TrainingMode extends Mode {
  constructor() {
    super('training', 'TRAINING', {
      'control:altitude_max': '1500',
      'control:outdoor': 'FALSE',
      'control:euler_angle_max': '0.12',
      'control:control_vz_max': '300',
      'control:indoor_euler_angle_max': '0.12',
      'control:indoor_control_vz_max': '300',
      'control:indoor_control_yaw': '1'
    });
  }
}

class IndoorMode extends Mode {
  constructor() {
    super('indoor', 'INDOOR', {
      'control:altitude_max': '2000',
      'control:outdoor': 'FALSE',
      'control:euler_angle_max': '0.16',
      'control:control_vz_max': '700',
      'control:indoor_euler_angle_max': '0.16',
      'control:indoor_control_vz_max': '700',
      'control:indoor_control_yaw': '1.74533'
    });
  }
}

class OutdoorMode extends Mode {
  constructor() {
    super('outdoor', 'OUTDOOR', {
      'control:altitude_max': '3000',
      'control:outdoor': 'TRUE',
      'control:euler_angle_max': '0.30',
      'control:control_vz_max': '1000',
      'control:outdoor_euler_angle_max': '0.30',
      'control:outdoor_control_vz_max': '1000',
      'control:outdoor_control_yaw': '3.49066'
    });
  }
}

class AbsoluteControlMode extends Mode {
  constructor() {
    super('absolute', 'ABSOLUTE CONTROL', {}, {
      available: false,
      reason: 'PCMD_MAG is not documented in the verified AR.Drone 2.0 SDK command set.'
    });
  }
}

class TiltMode extends Mode {
  constructor() { super('tilt', 'TILT'); }
}

class FlipMode extends Mode {
  constructor() {
    super('flip', 'FLIP', {}, {
      available: false,
      reason: 'A flip would require battery ≥30%, altitude ≥1.0 m, and a flying drone. The verified SDK does not identify a flip animation ID, so flips are disabled.'
    });
  }
}

class DirectorMode extends Mode {
  constructor() { super('director', 'DIRECTOR'); }
}

class RaceMode extends Mode {
  constructor() { super('race', 'RACE'); }
}

class SafetyMode extends Mode {
  constructor() { super('safety', 'SAFETY'); }
}

class CalibrationMode extends Mode {
  constructor() {
    super('calibration', 'CALIBRATION', {}, {
      available: false,
      reason: 'Magnetometer AT*CALIB semantics were not found in the verified SDK; flat trim remains available in settings.'
    });
  }
}

class ModeManager {
  constructor(settings = BASE_SETTINGS) {
    this.settings = { ...settings };
    this.current = new ManualMode();
    this.currentRestore = null;
    this.modes = new Map([
      ['manual', this.current],
      ['test-motors', new TestMotorsMode()],
      ['training', new TrainingMode()],
      ['indoor', new IndoorMode()],
      ['outdoor', new OutdoorMode()],
      ['absolute', new AbsoluteControlMode()],
      ['tilt', new TiltMode()],
      ['flip', new FlipMode()],
      ['director', new DirectorMode()],
      ['race', new RaceMode()],
      ['safety', new SafetyMode()],
      ['calibration', new CalibrationMode()]
    ]);
  }

  async enter(id, context) {
    const next = this.modes.get(id);
    if (!next) throw new Error(`Unknown mode: ${id}`);
    if (!next.available) throw new Error(next.reason);
    if (id === 'safety') {
      next.on_enter(context);
      return { mode: next, applied: {} };
    }
    if (id !== 'safety' && context.isFlying) {
      throw new Error('Modes can only be changed while the drone is landed.');
    }

    await this.exit(context);
    if (id === 'manual') {
      this.current = next;
      next.on_enter(context);
      return { mode: next, applied: {} };
    }

    const restore = { ...this.settings };
    try {
      for (const [key, value] of Object.entries(next.preset)) {
        await context.applyConfig(key, value);
        this.settings[key] = value;
      }
    } catch (error) {
      for (const [key, value] of Object.entries(restore)) {
        try {
          await context.applyConfig(key, value);
          this.settings[key] = value;
        } catch (restoreError) {
          context.onRestoreError(key, restoreError);
        }
      }
      throw error;
    }

    this.current = next;
    this.currentRestore = restore;
    next.on_enter(context);
    return { mode: next, applied: { ...next.preset } };
  }

  async exit(context) {
    if (this.currentRestore) {
      for (const [key, value] of Object.entries(this.currentRestore)) {
        await context.applyConfig(key, value);
        this.settings[key] = value;
      }
    }
    this.current.on_exit(context);
    this.current = this.modes.get('manual');
    this.currentRestore = null;
  }

  list() {
    return Array.from(this.modes.values()).map((mode) => ({
      id: mode.id,
      name: mode.name,
      available: mode.available,
      reason: mode.reason
    }));
  }
}

module.exports = {
  BASE_SETTINGS,
  Mode,
  ModeManager,
  modes: {
    ManualMode,
    TestMotorsMode,
    TrainingMode,
    IndoorMode,
    OutdoorMode,
    AbsoluteControlMode,
    TiltMode,
    FlipMode,
    DirectorMode,
    RaceMode,
    SafetyMode,
    CalibrationMode
  }
};
