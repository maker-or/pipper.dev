import { cn } from "@/lib/utils";

export const SETUP_SCRIPT_PLACEHOLDER = [
  "# One command per line, run from the new workspace",
  "uv sync",
  'cp "$ROOT_PATH/.env" .env',
].join("\n");

export const SETUP_SCRIPT_HELP =
  "Runs in the background each time a workspace is created, from the workspace folder, and stops at the first failing command. Use $ROOT_PATH for the main checkout, $WORKSPACE_PATH and $WORKSPACE_NAME for the new workspace.";

interface SetupScriptEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Detected starting point offered while the editor is empty. */
  suggested?: string | null;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  "data-pipper-id"?: string;
}

/** Monospace editor for a project's setup script, one command per line. */
export function SetupScriptEditor({
  value,
  onChange,
  suggested,
  disabled = false,
  autoFocus = false,
  className,
  "data-pipper-id": dataPipperId,
}: SetupScriptEditorProps) {
  const lines = Math.min(10, Math.max(3, value.split("\n").length + 1));
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={SETUP_SCRIPT_PLACEHOLDER}
        rows={lines}
        disabled={disabled}
        autoFocus={autoFocus}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label="Setup script"
        data-pipper-id={dataPipperId}
        className={cn(
          "w-full resize-y rounded-lg border border-border/70 bg-surface-2 px-3 py-2",
          "font-mono text-[12px] leading-5 text-foreground placeholder:text-muted-foreground/60",
          "outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]",
          "disabled:opacity-50",
        )}
      />
      {suggested && !value.trim() && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(suggested)}
          className="self-start rounded-md px-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          Use detected: <span className="font-mono">{suggested}</span>
        </button>
      )}
    </div>
  );
}
