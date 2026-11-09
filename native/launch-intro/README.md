# Pipper launch intro (macOS)

The first-launch "stone in water" intro: three ripples leave back to back and
cross the whole display, each leaving a third of the darkness, then one line of
text sharpens in at the centre. It is a borderless, transparent,
screen-saver-level window over the full display (menu bar and Dock included).
Everything visible is drawn by the Metal shader in
`Sources/LaunchIntroCore/Shaders.swift`.

- `LaunchIntroCore`: timeline, shaders and renderer. Every frame is a pure
  function of seconds since start; `Timeline.swift` holds all values.
- `PipperLaunchIntro`: the overlay app. It reports `started`, `complete`,
  `skipped` and `dismissed` as JSON lines on stdout, takes `dismiss` on stdin,
  and exits when stdin closes. `electron/launch-intro.ts` is the host.

Then the stone turns out to have been the @. Once the line is sharp the water
goes still and the line softens away, and a vast @ rises from where the stone
fell, under the dark surface. It is never drawn: it is seen by the light its
body holds back (the darkness was its shadow), by how its rounded surface bends
the stage above it, and by the light along its upper curves. Deep down its form
is broad and faint; as it nears the surface it fills the display, defined, its
relief stronger, and is held still for the last frame. The dark never lifts and
nothing moves like water from here on. The values are the `mark…` and
`surface…` settings in `Timeline.swift`, and `surfaceFrame()` is the scene as a
function of time. `ripple_fragment` draws everything up to the sharp line and
`surface_fragment` everything after, so the opening's frames stay
byte-for-byte what they were.

There are two versions, sharing the timeline. Version 1 is the above: bold
ripples (dark bands, bright rims and glints) and the @ surfacing. Version 2
(`IntroConfig(version: .two)`) has subtle ripples, long low swells that bend
the stage, catch a soft light and bring the darkness in (`water_v2_fragment`),
and a backlit ending (`backlight_fragment`): its line, "One interface to
control your agents", sharpens in white, then the dark closes into a solid
plane with the line cut through it and a light behind it, just up and to the
left of the first letter, shines through. The letters burn white nearest the
light, through Pipper's amber `#FFAA4F`, to red-orange at the far end, and
their beams fan away from the light in a wedge that points back at it, the way
Pipper's cursor points. Only the letters nearest the light throw much of a
beam, so the line stays readable. The values are the `light…`, `shaft…`,
`letter…`, `beamSoftness` and `planeDarkness` settings in `Timeline.swift`.
The first launch plays version 1; the Dock menu replays either.

The first front washes the screen over to a stage: the desktop picture (the
light or dark frame of a dynamic one, the still of an aerial), so from then on
every pixel is the overlay's own, windows, Dock and menu bar included. As each
front passes, the stage is shoved away from the stone and rides a damped spring
back (`push`, `pushPeriod`, `pushDamping`, `pushOnset`, `stageWash` in
`Timeline.swift`), with a little `refraction` shimmer along the bands. The
stage needn't match the screen exactly, so no permission is needed: the helper
never prompts. If Screen Recording happens to be granted already, a capture of
the screen is used as the stage instead, so nothing visibly washes away. If
the desktop picture's file was deleted after it was set (the desktop keeps
showing it from memory only Screen Recording can read), the stage is plain, in
the picture's fill colour, so windows still wash away.

```sh
swift test                                   # timeline + GPU frame tests
swift build -c release
.build/release/pipper-launch-intro           # play over the main display
.build/release/pipper-launch-intro --intro-version 2   # version 2
.build/release/pipper-launch-intro --render-frames /tmp/intro \
  --times 0,1,2,3,4.267 --size 1440x900 --background wallpaper.heic --screen desktop.png
```

## Sound and haptics

`Score.swift` renders the music from the same `IntroConfig`, so it moves with
any retiming. Each ripple leaving the stone is a water drop and a sub thump
scaled by its strength (the first carries the unseen splash); each front's
crossing is a wash that brightens as it climbs and flutters at the rings' rate
(speed ÷ wavelength); the pad swells with the text's opacity and brightens as it
sharpens and then holds; a low open fifth swells as the @ rises and opens
up as it comes into focus. It is rendered while the
backdrop loads and started on the same host time as the first frame.

`Haptics.swift` pulses the trackpad as each front passes under the pointer
(read live): three firm taps for the 1.5 opener, one light tap for the 0.65
followers, one as the text settles, and one, softly, as the @ surfaces. macOS
only plays these on a Force Touch trackpad with a finger on it.

```sh
.build/release/pipper-launch-intro --render-audio /tmp/intro.wav   # just the score
.build/release/pipper-launch-intro --silent --no-haptics           # picture only
```

## Playground

`playground/index.html` runs the same shader in WebGL with a slider for every
setting, ten presets (Ripple, Single swell, Bloom, Lens, Tide, Two stones,
Shockwave, Ink drop, Rain, Breath), playback, and your own screenshot or
wallpaper (drop it on the preview). "Copy Swift" gives the `IntroConfig` values
to paste into `Timeline.swift`; sources other than one stone, wobble, lens and
breath exist only in the playground until they are ported to `Shaders.swift`.
`?preset=tide&t=1.2` opens a preset paused at a moment.

```sh
python3 -m http.server 4791 --directory native/launch-intro/playground
```

`scripts/build.js` builds it into `dist/`, and electron-builder ships it as
`Contents/MacOS/pipper-launch-intro`. Set `PIPPER_LAUNCH_INTRO=always` to replay
it on every launch, or `never` to turn it off.
