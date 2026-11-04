import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GearSix, WarningCircle } from "@phosphor-icons/react";
import type { SettingChange, SettingChangeRecord } from "../../contracts/settings.ts";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

interface SettingsChangeCardViewProps {
  changes: SettingChange[];
  undone: boolean;
  undoing: boolean;
  onUndo: () => void;
}

/** Presentational card; the container below loads the change and undoes it. */
export function SettingsChangeCardView({
  changes,
  undone,
  undoing,
  onUndo,
}: SettingsChangeCardViewProps) {
  const forNewThreads = changes.some((change) => change.applies === "new_threads");
  return (
    <div
      data-pipper-id="settings-change-card"
      data-undone={undone ? "true" : undefined}
      className="flex w-full max-w-md flex-col gap-2 rounded-2xl border border-border/70 bg-surface-2/70 px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <GearSix size={14} weight="duotone" className="shrink-0 text-muted-foreground" />
        <span className="flex-1 text-[13px] font-medium text-foreground">
          {undone ? "Settings change undone" : "Settings changed"}
        </span>
        {undone ? null : (
          <Button variant="ghost" size="sm" onClick={onUndo} loading={undoing}>
            Undo
          </Button>
        )}
      </div>
      <ul className={cn("flex flex-col gap-1", undone && "line-through opacity-60")}>
        {changes.map((change) => (
          <li key={change.path} className="flex min-w-0 items-baseline gap-2 text-[12px]">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{change.label}</span>
            <span className="shrink-0 tabular-nums text-foreground">
              {change.fromText} → {change.toText}
            </span>
          </li>
        ))}
      </ul>
      {forNewThreads && !undone && (
        <p className="text-[11px] text-muted-foreground">
          Tools turned on or off apply to new threads.
        </p>
      )}
    </div>
  );
}

/**
 * A settings change an agent made with `update_settings`, where it made it.
 * Undo puts every setting in the change back, as the user's own action.
 */
export function SettingsChangeCard({ changeId }: { changeId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["settings-change", changeId];
  const { data: record } = useQuery({
    queryKey,
    queryFn: (): Promise<SettingChangeRecord | null> => window.omni.settings.getChange(changeId),
    staleTime: 30_000,
  });
  const [undoing, setUndoing] = useState(false);
  if (!record) return null;

  const undo = async () => {
    setUndoing(true);
    try {
      queryClient.setQueryData(queryKey, await window.omni.settings.undoChange(changeId));
    } catch (err) {
      toast({
        icon: <WarningCircle weight="duotone" className="size-5 text-destructive" />,
        title: "Could not undo the settings change",
        description: err instanceof Error ? err.message : "Try again from Settings.",
      });
    } finally {
      setUndoing(false);
    }
  };

  return (
    <SettingsChangeCardView
      changes={record.changes}
      undone={record.undone}
      undoing={undoing}
      onUndo={() => void undo()}
    />
  );
}
