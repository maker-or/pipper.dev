# Pipper launch intro (macOS)

> **Not shipped.** The launch intro is held back from release builds: it is
> off unless `VITE_PIPPER_LAUNCH_INTRO=1` (see `contracts/features.ts`). Off,
> new users go straight to onboarding, the Dock has no replay items, and
> `scripts/build.js` neither builds nor packages the helper (it also deletes
> a stale one from `dist/`). To work on it, set the variable in `.env` or
> before `bun run dev` / `bun run build`.

The first-launch "stone in water" intro: three ripples leave back to back and
cross the whole display, each leaving a third of the darkness, then one line of
text sharpens in at the centre. It is a borderless, transparent,
screen-saver-level window over the full display (menu bar and Dock included).
Everything visible is drawn by the Metal shader in
`Sources/LaunchIntroCore/Shaders.swift`.

- `LaunchIntroCore`: timeline, shaders and renderer. Every frame is a pure
  function of seconds since start; `Timeline.swift` holds all values.
- `PipperLaunchIntro`: the overlay app. It reports `started`, `complete`,
  `skipped` and `dismissed` as JSON lines on stdout, takes `layout {json}`,
  `close {json}` and `dismiss` on stdin, and exits when stdin closes.
  `electron/launch-intro.ts` is the host.

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

There are two versions, sharing the ripples. Version 1 is the above: bold
ripples (dark bands, bright rims and glints) and the @ surfacing. Version 2
(`IntroConfig(version: .two)`) has subtle ripples, long low swells that bend
the stage, catch a soft light and bring the darkness in (`water_v2_fragment`);
once they have passed, the darkness stays as they left it, darker at the
bottom than at the top as in version 1, so the screen never turns fully dark
(`Ending.still`; the backlit ending's solid plane is `planeDarkness`).
The backlit line (`backlight_fragment`, the `light…`, `shaft…` and `letter…`
settings) is still supported but version 2 no longer shows it.

Version 2 first shows its name (`Brand.swift`). Once the last ripple has
crossed the display, Pipper's brand icons (the tiles in
`src/launch/welcome-shapes.svg`, drawn from the same outlines and colours)
pop in one by one, one tile per letter of "Pipper", each with a springy
overshoot and a pop in the score (`pop` in `Score.swift`). Then each pops
out in the same order with a higher pop, and its letter springs in where it
was; once all are in, the letters close up into the word. The name sits
above the middle.

Version 2's line is "One interface to control your agents" (`Phrase` in
`Carousel.swift`). Once the name is whole, a laser prints it at the middle: a thin blue scan line with a bright head
(`scan_fragment`) works down over it like a real printer (`scanLine` in
`Carousel.swift`). It prints in bands: the paper feeds one band down with a
quick jolt that overshoots a little and settles, then stops dead while the
head travels across, speeding up and slowing at each end and printing behind
itself, alternating direction each band (`word_fragment` and
`drawing_fragment` show only what is printed). It is held there, then a second sweep prints the window
the user is about to land in, top to bottom down its real frame
(`WindowDrawing.swift`, `drawing_fragment`): above the scan line the window
is already in its real colours (background, cards, toggles, button, soft bars
for its text), with a thin outline glowing on the rows just printed, and it is
printed over the line as it passes. The last frame is the window without its
text and icons, in exactly its place, and the hand-over fades it into the
real window (about 1.5s, easing in and out) while the dark draws in around
it. Version 2 runs about 14s.

Version 3 (`IntroConfig(version: .three)`) is version 2 opening on a bloom
instead of ripples (`Opening.bloom`, `discs_fragment`): a grid of embossed
discs, lit on their upper left and shaded on their lower right, through which
a sakura colour blooms out from the middle of the display, deep plum at its
core, then crimson, hot pink and pale pink-white at the edges, until it
covers the screen (a little thinner at the edges, so the desktop shows
faintly through). Its sound is a low swell rather than drops, and nothing
taps the trackpad for it. The name, the line and the printed window then
follow as in version 2. The bloom's timing and grid are the `bloom…` and
`discColumns` settings.

A rolling "Run Claude, Codex … any agent" carousel (`Carousel`) can take the
line's place: set `carousel` instead of `phrase` in `IntroConfig.use(.two)`.

Nothing about that window is built in. While the intro plays, the launch
window is already loaded, hidden; the host measures every element marked
`data-intro-outline` in it (`INTRO_LAYOUT_SCRIPT` in
`electron/launch-intro.ts`: `text`, `card`, `toggle`, `button`) until the
agent picker has loaded and holds still, and sends it as `layout {json}`
(the window's frame alone goes first, as soon as the window exists; the
elements must arrive before the window starts printing):
the window's frame, corners and background and each element's box, corners
and colour, in screen points. A colour carries the element's opacity and its
parents', so a disabled (half-transparent) button is drawn half-transparent. A layout that arrives after the drawing would
have started, or none at all (say, a sign-in screen), ends the intro as
before. To draw a different screen, mark its elements the same way.

The first launch plays version 2; the Dock menu replays any of the three.

It ends in a window rather than fading. Once the last frame is held, the host
shows the launch window under the overlay and sends `close` with its frame
(points, from the top left of the menu-bar display), corner radius and
background colour (`CloseTarget.swift`). The dark draws in to that rounded
rectangle while the desktop comes back around it, takes on the window's
colour, then the overlay fades to reveal the real window in the same place.
A skipped or failed intro, or a window on another display, just fades. Dock
replays close into whichever Pipper window is open.

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
# version 2's drawn window, from a layout's JSON in the frame's pixels
.build/release/pipper-launch-intro --intro-version 2 --render-frames /tmp/intro \
  --times 9,10,11,12 --size 1440x900 --background wallpaper.heic --layout layout.json
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
