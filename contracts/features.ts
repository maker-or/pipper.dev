/**
 * Features that are built but held back from release. All are off unless the
 * build sets the variable to "1", e.g. `VITE_PIPPER_REMOTE=1 bun run dev`.
 * Nothing is deleted: turning a feature back on is setting its variable.
 *
 * - remote: phone pairing, the Remote settings page, the tunnel and the
 *   laptop-served phone app.
 * - siri: the App Intents extension, the Siri catalog and `pipper://siri`.
 * - clerk: pipper.dev sign-in. Off, Pipper opens without an account and
 *   analytics stay on the anonymous per-install id.
 *
 * Each value is read directly off `import.meta.env` so Vite replaces it with
 * a constant and drops the code behind a disabled switch.
 * scripts/build.js reads the same variable names when deciding what to
 * build and package; keep the two in step.
 */
export const REMOTE_ENABLED = import.meta.env.VITE_PIPPER_REMOTE === "1";
export const SIRI_ENABLED = import.meta.env.VITE_PIPPER_SIRI === "1";
export const CLERK_ENABLED = import.meta.env.VITE_PIPPER_CLERK === "1";
