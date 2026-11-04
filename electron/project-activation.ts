import { isActivationSuperseded } from "./activation.ts";

/**
 * Make `projectId` the active project, rolling back to the previous one only
 * when this activation itself failed.
 *
 * A superseded activation is not a failure: the user clicked another project
 * while this one was still loading, and that newer activation has already set
 * the active project. Rolling back here would restore the project that was
 * active *before this click* — a stale one — over the newer choice, leaving
 * the window showing one project's thread under another project's selection.
 * It resolves quietly instead; the newer activation owns the outcome.
 */
export async function activateProjectSelection(input: {
  projectId: string;
  getActiveProjectId: () => string | null;
  setActiveProjectId: (projectId: string) => void;
  activate: (projectId: string) => Promise<void>;
}): Promise<{ superseded: boolean }> {
  const previousProjectId = input.getActiveProjectId();
  input.setActiveProjectId(input.projectId);
  try {
    await input.activate(input.projectId);
    return { superseded: false };
  } catch (err) {
    if (isActivationSuperseded(err)) return { superseded: true };
    if (previousProjectId) input.setActiveProjectId(previousProjectId);
    throw err;
  }
}
