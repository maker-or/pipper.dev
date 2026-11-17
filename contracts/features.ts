/**
 * Features that are built but held back from release. They are off unless the
 * build sets the variable to "1", e.g. `VITE_PIPPER_REMOTE=1 bun run dev`;
 * the launch intro is the exception, on unless set to "0".
 * Nothing is deleted: turning a feature back on is setting its variable.
 *
 * - remote: phone pairing, the Remote settings page, the tunnel and the
 *   laptop-served phone app.
 * - siri: the App Intents extension, the Siri catalog and `pipper://siri`.
 * - clerk: pipper.dev sign-in. Off, Pipper opens without an account and
 *   analytics stay on the anonymous per-install id.
 * - launch intro: the first-launch animation (native/launch-intro). Shipped:
 *   on unless VITE_PIPPER_LAUNCH_INTRO=0, which sends new users straight to
 *   onboarding and neither builds nor packages the helper. `bun run dev`
 *   builds the helper first and adds a "Replay Launch Intro" Dock item.
 *
 * Each value is read directly off `import.meta.env` so Vite replaces it with
 * a constant and drops the code behind a disabled switch.
 * scripts/build.js reads the same variable names when deciding what to
 * build and package; keep the two in step.
 */
export const REMOTE_ENABLED = import.meta.env.VITE_PIPPER_REMOTE === "1";
export const SIRI_ENABLED = import.meta.env.VITE_PIPPER_SIRI === "1";
export const CLERK_ENABLED = import.meta.env.VITE_PIPPER_CLERK === "1";
export const LAUNCH_INTRO_ENABLED = import.meta.env.VITE_PIPPER_LAUNCH_INTRO !== "0";
