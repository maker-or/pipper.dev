import { useCallback, useState } from "react";
import { ArrowLeft, FolderOpen } from "lucide-react";
import type { Project, ProjectShapeId } from "../../contracts/projects.ts";
import { Button } from "@/components/ui/button";
import { ShapePicker } from "@/components/project-shape";
import { InputGroup, InputField } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

interface AddProjectFormProps {
  onBack: () => void;
  onCreated: (project: Project) => void;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
  disabledReason?: string;
}

export function AddProjectForm({
  onBack,
  onCreated,
  onBusyChange,
  disabled = false,
  disabledReason,
}: AddProjectFormProps) {
  const [name, setName] = useState("");
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
        const parts = selected.split(/[/\\]/);
        const folderName = parts.pop() || parts.pop() || "";
        if (folderName) {
          setName(folderName);
        }
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

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Enter a project name.");
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

    setIsSubmitting(true);
    onBusyChange?.(true);
    try {
      const project = await window.omni.projects.create({
        name: trimmedName,
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
  }, [disabled, disabledReason, name, onBusyChange, onCreated, path, shape]);

  const canSubmit = !disabled && name.trim().length > 0 && shape != null && path.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          disabled={isSubmitting}
          className={cn(
            "inline-flex items-center justify-center size-8",
            "rounded-md text-muted-foreground hover:text-foreground hover:bg-accent",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:pointer-events-none disabled:opacity-50",
            "transition-colors",
          )}
          aria-label="Back to projects"
        >
          <ArrowLeft className="size-4" strokeWidth={1.75} />
        </button>
        <h1 className="text-2xl font-semibold text-foreground tracking-tight">New project</h1>
      </header>

      <div className="flex flex-col gap-1">
        <span className="text-[13px] text-muted-foreground pl-3">Shape</span>
        <ShapePicker value={shape} onValueChange={setShape} disabled={disabled || isSubmitting} />
      </div>

      <InputGroup className="w-full">
        <div className="flex items-end gap-2">
          <InputField
            label="Folder"
            value={path}
            onChange={() => {}}
            placeholder="No folder selected"
            disabled={disabled || isSubmitting || isBrowsing}
            readOnly
            onClick={handleBrowse}
            index={0}
            icon={FolderOpen}
            className="flex-1 cursor-pointer"
          />
          <Button
            type="button"
            variant="secondary"
            size="md"
            className="h-9 mb-[1px]"
            onClick={handleBrowse}
            disabled={disabled || isSubmitting || isBrowsing}
          >
            Browse
          </Button>
        </div>

        <InputField
          label="Name"
          value={name}
          onChange={setName}
          placeholder="My project"
          disabled={disabled || isSubmitting}
          index={1}
        />
      </InputGroup>

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
