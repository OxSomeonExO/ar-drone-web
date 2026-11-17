# AR.Drone controller: setup and test guide

These steps include copy-paste commands for both Windows Command Prompt (`cmd`)
and PowerShell. Keep the server window open while you use the phone. The mock
mode is only a software test: its 87% battery is fake and it does not communicate
with the aircraft. **Use commands for your current terminal:** Command Prompt
shows a path like `C:\Users\...>`; PowerShell shows `PS C:\Users\...>`. The
`$env:...` and `Remove-Item` commands are PowerShell-only.

## 1. Setup

Install Node.js LTS and ffmpeg from PowerShell:

```powershell
winget install --id OpenJS.NodeJS.LTS --exact
winget install --id Gyan.FFmpeg --exact
```

Close and reopen PowerShell after installation, then check both tools and install
the app dependencies:

```powershell
cd "C:\Users\Othma\OneDrive\Desktop\codes\Parrot Drone\ar-drone-web"
node --version
ffmpeg -version
npm.cmd install
```

`npm.cmd` avoids the PowerShell script-policy error that can occur with `npm`.
Run the focused control unit tests after installation:

```powershell
npm.cmd test
```

The tests verify metres-versus-millimetres handling, altitude-guard behavior,
nonzero yaw/vertical-speed limits, float32 encoding, and the installed
`ar-drone` package's `roll,pitch,gaz,yaw` PCMD argument order.
The app and tests were syntax-checked on Node.js v26.13.1. The installed
`ar-drone` package is version 0.3.3. Its
`createClient()` already calls `resume()`; do not call `resume()` a second time.
The package still uses the deprecated `new Buffer(...)` API and legacy
`Stream` APIs, and its `createPngStream()` API is deprecated. This app uses
`getPngStream()`. Those old package APIs worked in the Node 24 software probe,
but the real aircraft was not available for a flight/telemetry test.

Connect the computer to the drone's Wi-Fi network (usually named
`ardrone2_xxxxxx`; its default password is empty). Connect the phone to that
same Wi-Fi network. Run the server on the computer and use the computer's
Wi-Fi/LAN address printed at startup, for example `http://192.168.1.2:3000`.
Do not use the drone address `192.168.1.1` as the web-page address. If Windows
asks about the firewall, allow Node.js on private networks. The computer and
phone need to be on the drone's network at the same time.

## 2. Test A — no drone (mock mode)

In the app folder, run the commands for the terminal you opened.

**Command Prompt (`cmd`):**

```bat
set "DRONE_MOCK=1"
set "PORT=3000"
node server.js
```

**PowerShell:**

```powershell
$env:DRONE_MOCK = "1"
$env:PORT = "3000"
node server.js
```

Expected server output includes:

```text
[SRV] *** MOCK MODE — no real drone ***
AR.Drone Web Controller  [MOCK]
Health: http://127.0.0.1:3000/health
```

Open `http://127.0.0.1:3000` on the computer, or use the computer's printed
network address on the phone. The connection label must say
**Connected · MOCK**, the battery should show **87%**, and the camera test
image should appear. Click **DBG** to see WebSocket state, last message,
status, and video frame rate.

In a second terminal window, check the health endpoint:

```powershell
curl.exe http://127.0.0.1:3000/health
```

Expected fields include `"mock": true`, `"battery": 87`, a nonzero
`"navdataCount"`, and a positive `"videoFps"`. Without pressing the Take off
button, hold the left stick UP for at least 0.35 seconds. The mock status should
change to flying and the server should log
`[CMD] → drone: takeoff() via throttle`; the held input should produce a
nonzero gaz field in the mock PCMD line. Center the stick to stop climbing.
Then move either joystick, change the height slider, and press **LAND**. This
does not prove the real drone received anything.
Hold both sticks off-center at the same time. The page console should print
`[MOVE] → server` with nonzero `yaw`, `gaz`, `roll`, and `pitch`; the server
should print a matching `[CMD] ← phone` entry and a nonzero packet such as
`[AT*PCMD MOCK] AT*PCMD=...,1,...,...,...,...`. PCMD fields are ordered
`roll,pitch,gaz,yaw`; a positive forward/pitch UI input is sign-inverted by
the installed `ar-drone` package when encoded. Confirm both sticks measure
220×220 CSS pixels in landscape on a sufficiently large viewport, with an
88×88 knob. At smaller sizes they are clamped to fit; the video canvas covers
the viewport behind the translucent controls.

If port 3000 is already in use, stop the other server with Ctrl+C and choose
another port before starting this one. For example, in **Command Prompt**:

```bat
set "PORT=3456"
```

In **PowerShell**:

```powershell
$env:PORT = "3456"
```

Then open `http://127.0.0.1:3456` and check
`http://127.0.0.1:3456/health`.

## 3. Test B — drone connected, propellers OFF

Stop mock mode with **Ctrl+C** and answer `Y` if Command Prompt asks whether to
terminate the batch job. Connect the computer to the drone's Wi-Fi. Then run
the diagnostic from **Command Prompt (`cmd`)**:

```bat
set "DRONE_MOCK="
set "DRONE_IP=192.168.1.1"
node diagnose.js
```

`set "DRONE_MOCK="` clears the mock setting in Command Prompt. In
**PowerShell**, use:

```powershell
Remove-Item Env:DRONE_MOCK -ErrorAction SilentlyContinue
$env:DRONE_IP = "192.168.1.1"
node diagnose.js
```

This diagnostic runs for 10 seconds and does not take off. With the drone on
and reachable, output should look like:

```text
Mode: navdata only for 10 seconds
[DIAG] navdata=YES battery=...% altitude=... m age=... ms packets=...
[DIAG] droneState flags={...}
PASS: received ... navdata packets.
```

Battery and altitude must be values from the aircraft, not a constant 87.
If it prints `no packets yet` and ends with `FAIL`, check that the computer is
connected to the drone Wi-Fi and that `DRONE_IP` is correct. The diagnostic
does not use the web app or its mock mode.

In live web-app mode with no fresh packets, the page says
**Connected · LIVE · NO NAVDATA**, shows `--` for battery and altitude, and
blocks takeoff. This prevents a default or simulated battery value from looking
like real telemetry.

Optional takeoff test, **only with propellers removed** (same command in either
terminal):

```text
node diagnose.js --takeoff
```

It waits up to three seconds for navdata, takes off, waits three seconds, then
lands. It aborts instead of taking off if it receives no navdata.

## 4. Test C — web controls, propellers OFF

Keep the propellers removed. Start the real server (not mock mode). In
**Command Prompt (`cmd`)**, run:

```bat
set "DRONE_MOCK="
set "DRONE_IP=192.168.1.1"
set "PORT=3000"
node server.js
```

Expected output must say `[SRV] LIVE MODE` and `Web Controller [LIVE]`.
If it says `MOCK MODE`, **stop there**: no commands are being sent to the real
drone. In **PowerShell**, run:

```powershell
Remove-Item Env:DRONE_MOCK -ErrorAction SilentlyContinue
$env:DRONE_IP = "192.168.1.1"
$env:PORT = "3000"
node server.js
```

Open the printed computer address on the phone. Confirm the label says
**Connected · LIVE** and the battery matches the diagnostic. You can take off
with the button or by holding the left joystick upward past center for about
**0.35 seconds** (gaz must reach at least 0.05; at 10% speed this is about
half stick travel). Throttle takeoff is sent only after live navdata and the
height-limit configuration are confirmed. Keep holding UP to climb; return the
stick to center to stop climbing. Press **LAND** to land. With propellers off,
the aircraft cannot fly; keep it on a stable surface and clear of hands.

Move each joystick separately. The left stick should send yaw/altitude
(`clockwise`/`counterClockwise`, `up`/`down`); the right stick should send
roll/pitch (`left`/`right`, `front`/`back`). With both sticks held, each
`[CMD] ← phone` message must retain all four axes, and the live server must
log the actual nonzero `AT*PCMD=...` UDP command. The server should also print
`[CMD] → drone: PCMD ...`. At startup it should acknowledge
`control_vz_max (700)` and `control_yaw (3)`. These settings ensure firmware
has usable vertical/yaw rate limits.

With propellers still removed, keep hands and objects clear of the motors.
After the live configuration has been acknowledged, hold the left stick up
past center for about 0.35 seconds. The server should log
`[CMD] throttle takeoff requested` and then `[CMD] → drone: takeoff() via
throttle`. Keep holding briefly and verify incoming `gaz` and the actual PCMD
contain a nonzero gaz field. Center the stick to stop climbing. After takeoff,
move left-stick X and verify nonzero yaw in PCMD; yaw is not meaningfully
testable while the drone is landed. Then press LAND. Motors may spin during
this test; without propellers the drone cannot demonstrate lift or real
altitude control. Do not hold the aircraft while its motors are running.

Open **Settings**, drag the height limit, and confirm the displayed value
changes. The server should report a firmware configuration such as
`[CFG] altitude_max → 1500 mm (1.5 m)` followed by
`[CFG] altitude_max acknowledged (1500 mm)`. The software guard also blocks
upward commands at the configured height. If the limit is not acknowledged,
the web server blocks takeoff rather than silently proceeding.

## 5. Test D — video, photo, and recording

With the real server still running, check:

```powershell
ffmpeg -version
```

The page's video placeholder should disappear when decoded frames arrive. Use
**📷** to download a PNG photo and **⏺ Record** to start; press it again to stop
and download a WebM or MP4 recording, depending on browser support. The debug
overlay shows received video frames and FPS. The server also reports video FPS
at two-second intervals.

Mock mode tests that PNG binary frames reach the browser and decode, but it
does not test the aircraft's real H.264 stream or ffmpeg decoding of that
stream.

## 6. Test E — first real flight

Only fly after the propeller-off checks pass. Use a large, open, legal flying
area away from people, animals, roads, trees, power lines, and water. Choose
calm weather with very little wind. Fit the full indoor hull/propeller guard
for an indoor practice area; for outdoor flight, use the outdoor hull and stay
well away from people and obstacles. Start at the lowest speed setting (10%),
keep the height limit low, and make short, gentle inputs close to the ground.
Keep the LAND button reachable and land well before the battery is low. Follow
local UAV rules and do not fly over people.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Page doesn't load | Server is stopped, wrong port/IP, or port is already in use | Keep `node server.js` running; use the URL printed in that window. If port 3000 is taken, set `PORT` to `3456` before starting (`set "PORT=3456"` in Command Prompt or `$env:PORT = "3456"` in PowerShell) and use `:3456`. |
| Joysticks do nothing | WebSocket is disconnected, page is stale, or the wrong UI is open | Check **DBG** for `WS: OPEN`, reload the page, then move one stick at a time and look for `[CMD]` logs. |
| Yaw or altitude does nothing | Firmware rate limits are not acknowledged, or nonzero axes are not reaching PCMD | Confirm startup logs acknowledge `control_vz_max (700)` and `control_yaw (3)`. While moving the left stick, compare the browser's `[MOVE] → server` values with server `[CMD] ← phone` and nonzero `[AT*PCMD]` values. Power-cycle the drone if it is locked to another controller. |
| Drone doesn't respond | Server is still in mock mode, computer is not on the drone Wi-Fi, or navdata is missing | First check the server startup text says `[SRV] LIVE MODE`, and the page says **Connected · LIVE**. In Command Prompt run `set "DRONE_MOCK="`; in PowerShell run `Remove-Item Env:DRONE_MOCK -ErrorAction SilentlyContinue`. Connect to drone Wi-Fi and run `node diagnose.js`. |
| Motors don't spin | Drone is not armed/ready, battery is low, emergency state is active, or propellers were intentionally removed | Check live navdata and battery, charge the battery, use **Reset Emergency** only if appropriate, and verify propeller-off tests by observing status/commands rather than expecting flight. |
| No video | ffmpeg is missing/not in `PATH`, or the drone video stream is unavailable | Run `ffmpeg -version`, install ffmpeg, reopen the terminal, restart the server, and check `[VIDEO]` errors and debug FPS. |
| Drone ignores commands / is locked to another device | Another controller still owns the drone connection | Power-cycle the drone, wait for its Wi-Fi to return, reconnect the computer, then run `node diagnose.js` again. |
| Phone can't reach the server | Windows Firewall blocks Node.js, or phone and computer are on different networks | Allow Node.js on private networks (or allow inbound TCP on the selected server port) and connect both devices to the drone Wi-Fi. Use the computer's printed IP, not `192.168.1.1`. |

## What this test suite can and cannot verify

The mock server and headless browser verify page loading, mock/live indication,
WebSocket text commands, binary PNG delivery/decoding, both portrait joysticks,
simultaneous four-axis input, PCMD serialization, joystick sizing/transparency,
height-limit UI/config requests, takeoff/land command flow, status/health
reporting, and browser-side control code. Unit tests verify altitude units,
the software guard, PCMD output ordering, and that each selected axis survives
its opposite-direction setter.

The mock run cannot verify live Wi-Fi command delivery, firmware
acknowledgements, motor response, real video/ffmpeg decoding, or flight
behavior. Your earlier standalone diagnostic output showed live navdata and
battery, but only the propeller-off web-app test above can verify this updated
server's commands and firmware settings against the aircraft.

## Summary of changes

- Fixed the movement root cause: the server set each requested axis then called
  the opposite `ar-drone` setter with zero. The library treats that setter as
  the active direction and deletes the requested direction, erasing yaw, gaz,
  and potentially the other axes. Each axis now uses exactly one direction
  setter; tests exercise the installed client's PCMD state.
- Added deliberate left-stick throttle takeoff: hold UP for 350 ms, after
  which the server sends the required takeoff REF command and continues the
  held gaz input. Releasing cancels an unacknowledged throttle takeoff; LAND
  remains the explicit landing control.
- Added actual live UDP AT*PCMD logging and matching mock logs.
- Explicitly configure nonzero firmware limits: 700 mm/s vertical speed and
  3 rad/s yaw. Keep the software altitude guard in metres and convert only the
  firmware height setting to millimetres.
- Added unit tests for altitude units/guard behavior, package PCMD encoding,
  and direction-setter behavior.
- Doubled joystick and knob dimensions in landscape, clamped the controls to
  the viewport, and placed translucent joysticks over full-screen video.
- Retained the existing two-stick command loop, watchdog hover, and stop on
  release; changed the speed control to clamp at a nonzero 10% minimum.

## Mode system and 10 m height limit

### Mock test

In PowerShell, from the project folder:

```powershell
Set-Location "C:\Users\Othma\OneDrive\Desktop\codes\Parrot Drone\ar-drone-web"
npm.cmd test
$env:DRONE_MOCK = "1"
$env:DRONE_MOCK_BATTERY = "87"
$env:PORT = "3000"
node server.js
```

Expected test output includes `PASS mode presets...`. The server should report
`[SRV] *** MOCK MODE — no real drone ***` and
`[MOCK] config(control:altitude_max, 10000)`. Open
`http://127.0.0.1:3000` (or the computer's printed LAN address) in a browser.
The status must say **Connected · MOCK** and show **87%**; that battery is
simulated.

1. Open **Modes → TRAINING**. The first-use hint should appear, the HUD should
   show TRAINING, and the height should become **1.5 m**. The server logs
   `control:altitude_max, 1500` and the training vertical-speed/tilt settings.
2. Select **Manual**. The preset should restore and the height should return to
   **10.0 m** (`control:altitude_max, 10000`). Indoor and Outdoor should set
   their corresponding presets; Outdoor is capped at **3.0 m**.
3. Open **TEST MOTORS**. The first confirmation shows the large text
   **“Remove all 4 propellers first”**; tick the box and accept the second
   confirmation. Select 15% power and hold a motor button. In mock mode the
   server reports a simulation, never drives motors, and stops on release,
   another message, disconnect, or after 2 seconds. “Test all in sequence”
   runs each simulated test for at most 2 seconds. The stock-drone mode is
   intentionally unavailable because SDK `AT*PWM` is prototype-only.
4. Change the limit slider to 10 m. It should show `10.0 m`, and the server
   should log `control:altitude_max, 10000`. Open `/health` to see the same
   altitude, battery, mode, navdata age, client count, and video FPS summary.
5. Select **Director**, take off in mock mode, start a scripted shot, then touch
   either stick. The countdown/progress should appear and stick touch should
   cancel the script and hover. LAND should also cancel it.
6. Select **Race** and verify Start/Lap/Stop, lap times, and the CSV download.
   Select **Tilt** on a phone to grant orientation permission; the right stick
   is replaced by the held tilt pad. Safety can be toggled in every mode.

To check low-battery refusal and auto-land without a real drone, stop the first
server with **Ctrl+C**, then run:

```powershell
$env:DRONE_MOCK_BATTERY = "25"
node server.js
```

The HUD should show **25%**. TEST MOTORS must be refused below 30%. In Safety,
set the auto-land threshold to 25%, then use mock takeoff: it should warn and
land automatically at the threshold. This proves only simulated behavior.

### Real-drone checklist — propellers OFF first

- [ ] Before connecting, remove all four propellers. Do not use TEST MOTORS on
  stock firmware; no per-motor PWM command is sent by this app.
- [ ] Connect the computer to the drone Wi-Fi, clear mock mode, then run
  `node diagnose.js`. Confirm live navdata, battery, altitude, and state flags.
- [ ] Start the web server in LIVE mode and confirm the page says
  **Connected · LIVE**. Check **Settings → Height Limit** and the server's
  `altitude_max → 10000 mm` acknowledgement. An acknowledgement alone does not
  prove the aircraft applied the value.
- [ ] With propellers still off, verify joystick command logs and LAND. Do not
  hold the aircraft while motors run. Do not expect lift or meaningful altitude
  control without propellers.
- [ ] Install the correct hull only after the propeller-off checks. In a legal,
  open flight area, test takeoff, gentle climb/descent, LAND, and the selected
  mode presets at low speed. Increase height gradually; do not make the first
  flight a 10 m climb.
- [ ] Test phone tilt permissions/orientation and the Director cancel behavior
  only in a safe area with a clear landing option.
- [ ] Do not attempt Absolute Control, flips, magnetometer calibration, or
  per-motor tests. They remain disabled pending verified stock-firmware SDK
  support.

### Commands used and files changed

The controller uses documented `AT*CONFIG` for height/outdoor/flight-limit
presets, `AT*PCMD` for progressive four-axis movement, `AT*REF` for takeoff,
landing, and emergency reset, and `AT*FTRIM` for flat trim. The implementation
does **not** send `AT*PWM`, `PCMD_MAG`, flip `AT*ANIM`, or magnetometer `AT*CALIB`.

Mode-system changes are in `modes.js`, `server.js`, `public/index.html`,
`test/modes.test.js`, `test/control.test.js`, and `package.json`; related user
guidance is in `README.md` and this file. The 10 m ceiling is applied both in
the UI/server software guard and through the firmware `control:altitude_max`
setting, while Outdoor remains capped at 3 m.
