# Drivers and subjects that fight the poster

`useTransitionSpec` covers a component animated by CSS transitions or keyframes. Everything else needs a small
driver of your own, and some components behave differently once they're inside a scaled poster. These are the cases
met so far, and what to do about each.

## Writing a custom driver

Write one when the interaction is a gesture, a pointer path, a scroll position, or a JS animation library's clock.
Give it the same shape as `useTransitionSpec`: `root`, `m` (the held values), `ready`, `snapshots`, `selected`,
`select`.

- **Each moment is a run, not a time.** For each moment, reset the component (through its own API, with any
  transition finished), drive it there, then copy it with `captureEach(root, 1, () => value)`. Put the copies in one
  camera afterwards with `oneCamera(shots)`.
- **Hold a released moment part way.** After a release, wait a frame or two for the component's own transition or
  animation to start, then `pause()` it and set `currentTime` to a fraction of its duration.
- **Wait for the thing to happen; never assume a time.** Poll (a few ms at a time, with a generous cap) until the
  menu closes or the transition exists, and record when it did. If it never happens, report that instead.
- **Cancel stale runs.** Number each run. When `select` starts a new one, the old one returns without writing state.
- **Stop when the component is gone.** A poster is drawn again from scratch on a theme change, and a run that's
  still going then drives a component that has left the page: its sizes read 0 and a pointer path turns into NaN
  (`new PointerEvent` throws on it). Check before each step (`!alive || !root.isConnected || !root.offsetWidth`),
  throw a sentinel, and catch only that one where the run started.
- **Compare against the real thing once.** Drive the live component with a real browser mouse (Playwright's
  `page.mouse`) and check that your synthetic run gives the same result and roughly the same timing.

## Synthetic input that components accept

- **Pointer paths:** send `pointerout` to the element being left (`relatedTarget`: the one entered),
  `pointerover` to the one entered, then `pointermove`. React builds `onPointerEnter` and `onPointerLeave` from
  those pairs; a bare `pointerleave` is ignored. Move in steps of about 2px, as a mouse samples: the exit point of a
  coarse path is far from where a real pointer would leave.
- **Pointer type:** Radix menus act only on `pointerType: 'mouse'`.
- **Pointer capture:** `setPointerCapture` throws for a pointer id with no real pointer behind it, and a press
  handler that calls it stops half way (Vaul then reads a start position of 0 and the drawer jumps away). While the
  driver runs, let capture calls for its own pointer id through as no-ops; leave every other id alone, and put the
  originals back on unmount.
- **Hover:** if a component expands on `onMouseEnter`, a synthetic `mouseover` may not reach it; `mousemove` on the
  same element often does (Sonner's toaster expands on either).
- **Typing:** make the input controllable (its value through state) and set it; then wait for whatever the component
  measures (cmdk writes its list height a frame or two later) before looking for animations.

## Subjects that fight the poster

- **Fixed to the window:** toasters and sheets (Sonner, Vaul) position themselves `fixed`. Give them a box the size
  of their corner of the screen and override their position to `absolute` in it, with a comment saying why.
- **Placed by floating-ui** (Radix menus, popovers, tooltips): floating-ui misplaces content inside a box scaled by
  CSS `zoom`. Scale these with a transform instead, in an outer box sized to the scaled footprint:

  ```tsx
  <div className={styles.subject} style={{ width: W * Z, height: H * Z }}>
    <div style={{ transform: `scale(${Z})`, transformOrigin: '0 0', width: W }}>
      <div ref={root} style={{ display: 'inline-block' }}><Subject /></div>
    </div>
  </div>
  ```

  It also places once and only re-places on resize or scroll: after the poster lays out or rescales, dispatch a
  `resize` event before measuring.
- **Measures itself on screen:** a component that compares its `getBoundingClientRect()` size with distances in its
  own px (Vaul's close threshold, swipe and drag thresholds) decides differently when scaled. Draw it at screen scale
  1: `const Z = useScreenScale(root)`, with the transform box above. Say so in the title block ("drawn at screen
  scale 1"). Screen scale 1 follows the window, though, so the drawing's size changes with it, against "a resize
  changes the scale, not the arrangement": use it only for a component that measures throughout (a drag).
- **Measures once, as it opens:** Radix Accordion and Collapsible measure their content with
  `getBoundingClientRect()` when they open and write it as px (`--radix-accordion-content-height`). Scaled, that
  height comes out wrong (97.25 for 76) and changes with the window. Hold the subject at screen scale 1 only while it
  opens and measures, then put it back at the poster's fixed drawing scale: the keyframes keep the true px.
- **Moves focus:** menus highlight items, and close submenus, by moving focus. The kit keeps an unready poster
  focusable (transparent, not hidden), but a driver that captures moments before `ready` must still run with the
  poster on screen: set ready first, then capture, and pass `settled={false}` to `SpecPage` until the last run is
  held, so the page of posters keeps it under its spinner (and its focus moves out of the reader's way) until then.
- **Portals:** render menus, toasters and dialogs in place (no portal, or a `container` inside the subject), so
  the moments copy them with the rest.
- **Not inert:** a component that needs focus can't sit under `inert`. Block real input with `pointer-events: none`
  on its wrapper instead, and mark the wrapper `data-subject-root` for the overlap check.

## Springs

A spring has no duration or easing to read from a stylesheet. Read it from the running animation instead.

- **Motion (framer-motion):** give the animated value a motion value (`style={{ x }}` with `useMotionValue`), so the
  driver can reach it. After the trigger, wait a frame or two for `x.animation`. Then:
  - `anim.pause()`, and `anim.time = ms / 1000` to hold any moment (the value follows a frame later);
  - `anim.duration` is when Motion calls the spring at rest, in seconds;
  - the inner JS animation, `anim.animation`, has the resolved `options` (`stiffness`, `damping`, `mass`,
    `keyframes`) and `generate(ms).value`, the spring Motion runs, sampled without moving it: plot that.

  These are Motion internals: check them against the installed version, and keep the reads in one place. Motion
  hands some springs to the browser instead (opacity, filter, clip-path, a whole transform, background colour); those show up in `getAnimations()`
  with a `linear()` easing, and `useTransitionSpec` holds them like any transition.
- **A spring you can only see the config of** (another library, a value in code): `springAt(ms, config)` gives its
  progress, `settleTime` when it comes to rest and `overshoot` how far past it goes. Say on the poster that the
  curve is derived from the config, and check it against the real thing once (sample the element's position over
  a real run).
- **Reaching the value:** a motion value the component keeps to itself can't be read from outside. In the poster's
  copy of the subject, hand it out (a ref prop, say `knobX`), and say so in a comment.
- **Reset to rest, really:** Motion starts a new spring from the value's current velocity. Finishing the last
  spring to reset leaves it moving, and the next run overshoots more (3.1px for 2.3). After a reset, wait until
  `value.getVelocity()` is 0 before triggering the next run.
- **Reduced motion:** springs are often skipped outright (Motion with `reducedMotion="user"`): no animation starts
  and the value jumps. Detect that (no animation after the trigger) rather than waiting for one.

## Posters that share a page

All posters are shown together on `/specs`, so each must leave the others alone.

- **Outside clicks:** a poster's own moment buttons are outside its component. A menu or popover that closes on an
  outside click or focus (Radix's `onInteractOutside`) closes when a moment is picked; prevent that in the
  poster's copy of the subject, with a comment saying why.
- **Synthetic events stay on the subject:** dispatch them on the subject's own elements, never on `document` or
  `window`, so another poster doesn't see them.
- **Global patches:** a driver that patches a prototype (pointer capture, above) only lets its own pointer id
  through, and puts the original back on unmount.
- **Focus:** a driver focusing its component would scroll the row to it; `SpecStrip` puts the row back.
- **Modal components** hide everything else from screen readers (`aria-hidden` on the rest of the page) and trap
  focus, which takes the other posters and the toolbar away from screen readers and keyboards. Render the subject
  non-modal. Where the library won't (Vaul always renders a modal Radix dialog, whatever its `modal` prop), hand the
  page back in the poster's copy of the subject: undo the hiding as it's applied (watch `data-aria-hidden` with a
  MutationObserver and remove it and `aria-hidden` outside the subject), and pause the trap by mounting an empty
  Radix `FocusScope` a frame after each opening (Radix runs only the newest trap). Check with the toolbar: focus it
  and Tab; focus must stay there.

## Theme

Read the app's theme before drawing anything, and draw nothing until it's known: a poster that starts light and
flips to dark remounts mid-capture. Key the poster on the theme so a change redraws it, and its moments are copied
again in the new colours. Components with their own theme prop (Sonner's toaster) take the app's theme too.
