import { useCallback, useState } from "react";
import { ArrowLeft, ChevronDown, FolderOpen, SquareTerminal } from "lucide-react";
import type { Project } from "../../contracts/projects.ts";
import { Button } from "@/components/ui/button";
import { IconPicker } from "@/components/ui/icon-picker";
import { InputGroup, InputField } from "@/components/ui/input-group";
import { SetupScriptEditor } from "@/components/setup-script-editor";
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
  const [icon, setIcon] = useState<string | undefined>();
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isBrowsing, setIsBrowsing] = useState(false);
  // Optional and tucked away: most projects can be added without one.
  const [scriptOpen, setScriptOpen] = useState(false);
  const [setupScript, setSetupScript] = useState("");
  const [suggestedScript, setSuggestedScript] = useState<string | null>(null);

  const handleBrowse = useCallback(async () => {
    if (disabled) return;
    if (!window.omni?.dialog?.pickDirectory) return;
    setIsBrowsing(true);
    setError(null);
    try {
      const selected = await window.omni.dialog.pickDirectory();
      if (selected) {
        setPath(selected);
        setSuggestedScript(null);
        void window.omni.projects
          ?.suggestSetupScript?.(selected)
          .then(setSuggestedScript)
          .catch(() => setSuggestedScript(null));
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
    if (!icon) {
      setError("Select an icon.");
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
        icon,
        setupScript: setupScript.trim() ? setupScript : null,
      });
      onCreated(project);
    } catch (err) {
      console.error("Failed to create project:", err);
      setError(err instanceof Error ? err.message : "Could not create project. Try again.");
    } finally {
      setIsSubmitting(false);
      onBusyChange?.(false);
    }
  }, [disabled, disabledReason, icon, name, onBusyChange, onCreated, path, setupScript]);

  const canSubmit = !disabled && name.trim().length > 0 && icon != null && path.length > 0;

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
        <span className="text-[13px] text-muted-foreground pl-3">Icon</span>
        <IconPicker value={icon} onValueChange={setIcon} />
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

      <div className="-mt-3 flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setScriptOpen((open) => !open)}
          disabled={disabled || isSubmitting}
          aria-expanded={scriptOpen}
          data-pipper-id="add-project-setup-script-toggle"
          className={cn(
            "inline-flex items-center gap-1.5 self-start rounded-md px-3 py-1",
            "text-[12px] text-muted-foreground hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:pointer-events-none disabled:opacity-50 transition-colors",
          )}
        >
          <SquareTerminal className="size-3.5" strokeWidth={1.75} />
          {setupScript.trim() ? "Setup script" : "Add setup script"}
          <span className="text-muted-foreground/60">· optional</span>
          <ChevronDown
            className={cn("size-3 transition-transform", scriptOpen && "rotate-180")}
            strokeWidth={1.75}
          />
        </button>
        {scriptOpen && (
          <div className="flex flex-col gap-1.5 px-0.5">
            <SetupScriptEditor
              value={setupScript}
              onChange={setSetupScript}
              suggested={suggestedScript}
              disabled={disabled || isSubmitting}
              autoFocus
              data-pipper-id="add-project-setup-script"
            />
            <p className="px-1 text-[11px] leading-4 text-muted-foreground">
              Runs in each new workspace, one command per line. You can change it later in Settings
              → Projects.
            </p>
          </div>
        )}
      </div>

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
