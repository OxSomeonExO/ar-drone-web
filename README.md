# AR.Drone 2.0 Web Controller

A phone-friendly web controller for the **Parrot AR.Drone 2.0**.  
A Node.js bridge translates WebSocket messages from the browser into UDP commands via the `ar-drone` package.

```
Phone browser  ←—— WebSocket ——→  Node server  ←—— UDP ——→  AR.Drone 2.0 (192.168.1.1)
```

---

## Requirements

- **Node.js** ≥ 14
- **ffmpeg** — required by `ar-drone` to decode the drone's H.264 video into PNG frames.
  - Windows: `winget install --id Gyan.FFmpeg`
  - macOS:   `brew install ffmpeg`
  - Linux:   `sudo apt install ffmpeg`

---

## Install

```bash
cd ar-drone-web
npm install
```

---

## Run

### Mock mode (no drone needed — for UI testing)
```bash
# Command Prompt (cmd)
set "DRONE_MOCK=1"
node server.js

# Windows PowerShell
$env:DRONE_MOCK="1"; node server.js

# macOS / Linux
DRONE_MOCK=1 node server.js
```

### Live mode (drone must be on and you must be on its WiFi)
```bash
# Command Prompt (cmd): clear any mock setting inherited from mock.bat
set "DRONE_MOCK="
set "DRONE_IP=192.168.1.1"
node server.js

# PowerShell
Remove-Item Env:DRONE_MOCK -ErrorAction SilentlyContinue
node server.js
```

For `cmd`, run `set "DRONE_MOCK="` in the same window before starting the live
server. A mock setting inherited from an earlier batch command otherwise keeps
`node server.js` in mock mode.

The connection label says **Connected · MOCK** when the simulated drone is active and
**Connected · LIVE** for the real drone. Mock mode reports a deliberately fake 87%
battery; it is not telemetry from the aircraft. `/health` includes `"mock": true|false`.
If live navdata is missing, the page displays **LIVE · NO NAVDATA**, leaves battery
and altitude blank, and blocks takeoff until fresh telemetry arrives.

### Standalone diagnostics
```bash
node diagnose.js
# Only with propellers removed:
node diagnose.js --takeoff
```

Override defaults with environment variables:

| Variable     | Default       | Description                        |
|-------------|---------------|------------------------------------|
| `PORT`      | `3000`        | HTTP / WebSocket port              |
| `DRONE_IP`  | `192.168.1.1` | Drone IP on its own WiFi           |
| `DRONE_MOCK`| *(unset)*     | Set to `1` to run without a drone  |

---

## Connecting the phone

1. Connect both the **bridge machine** and your **phone** to the drone's WiFi network  
   (SSID: `ardrone2_xxxxxx`, no password by default).
2. Start the server on the bridge machine — it prints all reachable URLs, e.g.:  
   `http://192.168.1.2:3000`
3. Open that URL in your phone's browser.
4. Keep the browser tab open (the screen-wake-lock is requested automatically).

> **No internet is needed.** The front end is fully self-contained.

---

## Controls

| Control | Action |
|---------|--------|
| **Left stick** — horizontal | Yaw (rotate) |
| **Left stick** — vertical   | Hold UP for 0.35 s to take off; then controls altitude (gaz) |
| **Right stick** — horizontal | Roll (sideways) |
| **Right stick** — vertical   | Pitch (forward/back) |
| **Take off** button | Arm & take off |
| **LAND** button (red) | Land immediately |
| **📷 Photo** | Save a PNG screenshot |
| **⏺ Record** | Start/stop video recording |
| **⚙ Settings** | Height limit (0.5–10 m), speed, hull, flat trim, emergency reset |
| **Modes** | Manual, Training, Indoor, Outdoor, Tilt, Director, Race, and Safety |

The Take off button remains available; alternatively, deliberately hold the
left stick UP for 0.35 seconds to initiate takeoff, then use its vertical axis
to climb or descend. Speed defaults to **30%** — keep it low until you are
comfortable.
The live server configures the firmware's vertical speed limit to **700 mm/s**
and yaw rate to **3 rad/s** at startup. The height setting is entered in metres,
converted to millimetres for firmware, and enforced in metres against the
`ar-drone` navdata altitude. Both joysticks are transparent overlays over the
full-screen camera view; the server continuously forwards the latest four axes
and logs nonzero AT*PCMD packets for diagnosis. Each movement axis is sent with
only one directional `ar-drone` setter because calling the opposite setter
with zero clears the requested axis in that package.

Mode presets can be selected only while landed (Safety remains an independent
toggle). Training caps movement to 15% and limits height to 1.5 m; Indoor and
Outdoor apply their respective hull/flight configuration presets. The selected
mode is remembered in the browser. The TEST MOTORS screen is simulation-only
in mock mode; stock-drone per-motor PWM is not enabled. Absolute control, flips,
and magnetometer calibration remain disabled because the verified SDK material
does not define the commands/IDs needed to implement them safely.

---

## Safety Checklist

> Read this before flying with propellers attached.

- [ ] **Test with propellers removed first.** Verify all controls respond correctly on the ground.
- [ ] **Attach the indoor hull** (propeller guard) for indoor or first flights.
- [ ] **Fly in an open space** away from people, obstacles, and power lines.
- [ ] **Keep speed at 30% or lower** until you are familiar with the drone's behaviour.
- [ ] **Keep the LAND button reachable at all times.** In an emergency, tap it immediately.
- [ ] **Check battery** before flight — land before it drops below 20%.
- [ ] **Stay in WiFi range** — after 1 second without stick commands, the watchdog commands a hover. When the last web client disconnects, the server stops and lands the drone.
- [ ] **Flat trim on the ground** (Settings → Flat Trim) before takeoff on an uneven surface.
- [ ] **Never fly over people or animals.**
- [ ] **Know your local regulations** regarding UAV flight.

---

## ffmpeg Note

The `ar-drone` package pipes the drone's H.264 video stream through `ffmpeg` to produce PNG frames.  
If `ffmpeg` is not in your `PATH`, the video feed will not work (the rest of the controller still works).  
Install it with the command for your OS listed in the Requirements section above.

---

## Project Layout

```
ar-drone-web/
  package.json      — dependencies
  server.js         — Node.js WebSocket + UDP bridge
  modes.js          — mode presets and landed-only settings restoration
  diagnose.js       — standalone navdata / propeller-off diagnostic
  public/
    index.html      — self-contained UI (all CSS & JS inline)
  README.md         — this file
  TESTING.md        — beginner setup, test steps, and troubleshooting
```
