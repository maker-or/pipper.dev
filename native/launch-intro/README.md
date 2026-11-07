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

The first front washes the screen over to a stage: the desktop picture (the
light or dark frame of a dynamic one, the still of an aerial), so from then on
every pixel is the overlay's own, windows, Dock and menu bar included. As each
front passes, the stage is shoved away from the stone and rides a damped spring
back (`push`, `pushPeriod`, `pushDamping`, `pushOnset`, `stageWash` in
`Timeline.swift`), with a little `refraction` shimmer along the bands. The
stage needn't match the screen exactly, so no permission is needed: the helper
never prompts. If Screen Recording happens to be granted already, a capture of
the screen is used as the stage instead, so nothing visibly washes away. With
no usable desktop picture, the ripples only darken the live screen.

```sh
swift test                                   # timeline + GPU frame tests
swift build -c release
.build/release/pipper-launch-intro           # play over the main display
.build/release/pipper-launch-intro --render-frames /tmp/intro \
  --times 0,1,2,3,4.267 --size 1440x900 --background wallpaper.heic --screen desktop.png
```

`scripts/build.js` builds it into `dist/`, and electron-builder ships it as
`Contents/MacOS/pipper-launch-intro`. Set `PIPPER_LAUNCH_INTRO=always` to replay
it on every launch, or `never` to turn it off.
