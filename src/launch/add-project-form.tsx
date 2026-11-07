import { useCallback, useState } from "react";
import { FolderOpen } from "lucide-react";
import type { Project, ProjectShapeId } from "../../contracts/projects.ts";
import { Button } from "@/components/ui/button";
import { ShapePicker } from "@/components/project-shape";

interface AddProjectFormProps {
  onCreated: (project: Project) => void;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
  disabledReason?: string;
}

export function AddProjectForm({
  onCreated,
  onBusyChange,
  disabled = false,
  disabledReason,
}: AddProjectFormProps) {
  const [shape, setShape] = useState<ProjectShapeId | undefined>();
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isBrowsing, setIsBrowsing] = useState(false);

  const handleBrowse = useCallback(async () => {
    if (disabled) return;
    if (!window.omni?.dialog?.pickDirectory) return;
    setIsBrowsing(true);
    setError(null);
    try {
      const selected = await window.omni.dialog.pickDirectory();
      if (selected) {
        setPath(selected);
      }
    } catch (err) {
      console.error("Failed to pick directory:", err);
      setError("Could not open folder picker.");
    } finally {
      setIsBrowsing(false);
    }
  }, [disabled]);

  const handleSubmit = useCallback(async () => {
    setError(null);
    if (disabled) {
      setError(disabledReason ?? "Workspace setup is still running.");
      return;
    }

    if (!shape) {
      setError("Choose a shape.");
      return;
    }
    if (!path) {
      setError("Choose a project folder.");
      return;
    }
    if (!window.omni?.projects?.create) return;

    const folderName = path.split(/[/\\]/).filter(Boolean).at(-1) || "Project";

    setIsSubmitting(true);
    onBusyChange?.(true);
    try {
      const project = await window.omni.projects.create({
        name: folderName,
        path,
        icon: shape,
      });
      onCreated(project);
    } catch (err) {
      console.error("Failed to create project:", err);
      setError(err instanceof Error ? err.message : "Could not create project. Try again.");
    } finally {
      setIsSubmitting(false);
      onBusyChange?.(false);
    }
  }, [disabled, disabledReason, onBusyChange, onCreated, path, shape]);

  const canSubmit = !disabled && shape != null && path.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <span className="text-[13px] text-muted-foreground pl-3">Shape</span>
        <ShapePicker value={shape} onValueChange={setShape} disabled={disabled || isSubmitting} />
      </div>

      <section className="flex flex-col gap-2">
        <span className="pl-1 text-[13px] text-muted-foreground">Folder</span>
        <div className="flex items-center gap-3">
          <FolderOpen
            className="ml-1 size-[18px] shrink-0 text-muted-foreground"
            strokeWidth={1.75}
          />
          <span
            className="min-w-0 flex-1 truncate text-sm text-muted-foreground"
            title={path || undefined}
          >
            {path || "No folder selected"}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="md"
            className="h-9 shrink-0"
            onClick={handleBrowse}
            disabled={disabled || isSubmitting || isBrowsing}
            loading={isBrowsing}
          >
            Browse
          </Button>
        </div>
      </section>

      {error != null && (
        <p className="text-sm text-destructive px-0.5" role="alert">
          {error}
        </p>
      )}

      {disabled && error == null && disabledReason != null && (
        <p className="text-sm text-muted-foreground px-0.5" role="status">
          {disabledReason}
        </p>
      )}

      <Button
        type="button"
        variant="secondary"
        size="lg"
        className="w-full"
        onClick={handleSubmit}
        disabled={!canSubmit || isSubmitting}
      >
        {isSubmitting ? "Creating…" : "Create project"}
      </Button>
    </div>
  );
}
