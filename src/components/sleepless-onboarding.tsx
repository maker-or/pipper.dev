import { useEffect, useState } from "react";
import { ArrowRight, CircleNotch, WarningCircle } from "@phosphor-icons/react";
import type { SleeplessPreferences, SleeplessStatus } from "../../contracts/sleepless.ts";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardGroup,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

const DEFAULT_PREFERENCES: SleeplessPreferences = {
  enabled: false,
  acOnly: true,
  batteryFloor: 20,
  maxDurationMinutes: 240,
};

interface SleeplessOnboardingProps {
  onComplete: (action?: "enabled" | "skipped" | "continued") => void;
}

export function SleeplessOnboarding({ onComplete }: SleeplessOnboardingProps) {
  const [status, setStatus] = useState<SleeplessStatus | null>(null);
  const [preferences, setPreferences] = useState<SleeplessPreferences>(DEFAULT_PREFERENCES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void window.omni.sleepless.getStatus().then((value) => {
      if (!mounted || !value) return;
      setStatus(value);
      setPreferences(value.preferences);
    });
    const off = window.omni.sleepless.onStatusChanged((value) => {
      if (!mounted) return;
      setStatus(value);
      setPreferences(value.preferences);
    });
    return () => {
      mounted = false;
      off();
    };
  }, []);

  const updatePreference = async (
    partial: Partial<Pick<SleeplessPreferences, "acOnly" | "batteryFloor" | "maxDurationMinutes">>,
  ) => {
    const next = { ...preferences, ...partial };
    setPreferences(next);
    if (!status?.preferences.enabled) return;
    try {
      const result = await window.omni.sleepless.setPreferences(partial);
      if (result) {
        setStatus(result);
        setPreferences(result.preferences);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this setting.");
    }
  };

  const enable = async () => {
    if (!status || busy) return;
    if (status.preferences.enabled && status.serviceStatus === "enabled") {
      onComplete("continued");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await window.omni.sleepless.setPreferences({
        acOnly: preferences.acOnly,
        batteryFloor: preferences.batteryFloor,
        maxDurationMinutes: preferences.maxDurationMinutes,
      });
      if (saved) setStatus(saved);
      const result = await window.omni.sleepless.setEnabled(true);
      if (result) {
        setStatus(result);
        setPreferences(result.preferences);
        if (result.serviceStatus === "enabled" && result.preferences.enabled) {
          onComplete("enabled");
          return;
        }
        setError(result.error ?? "The helper could not be installed.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The helper could not be installed.");
    } finally {
      setBusy(false);
    }
  };

  const skip = () => onComplete("skipped");
  const supported = status?.supported !== false;
  const configured = status?.preferences.enabled && status.serviceStatus === "enabled";
  const displayedError = error ?? status?.error;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-7">
      <div className="flex items-start gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Lid down, agents up
          </h1>
        </div>
      </div>

      <Card className="overflow-hidden rounded-xl border border-border bg-surface-1/75 shadow-[0_18px_60px_rgba(0,0,0,0.18)]">
        <CardContent className="p-0">
          <CardGroup
            orientation="inline"
            columns={1}
            border="none"
            proximityHover={false}
            className="divide-y divide-border/60"
          >
            <Card className="min-h-0 rounded-none bg-transparent">
              <CardHeader>
                <CardTitle>Power adapter only</CardTitle>
                <CardDescription>Keep the Mac awake only while it is plugged in.</CardDescription>
              </CardHeader>
              <CardFooter>
                <Switch
                  label="Require power adapter"
                  checked={preferences.acOnly}
                  disabled={busy || !status}
                  onToggle={() => void updatePreference({ acOnly: !preferences.acOnly })}
                  className="gap-0 px-0 py-0 [&>span:last-of-type]:sr-only"
                />
              </CardFooter>
            </Card>

            <Card className="min-h-0 rounded-none bg-transparent">
              <CardHeader>
                <CardTitle>Battery floor</CardTitle>
                <CardDescription>Stop below this level.</CardDescription>
              </CardHeader>
              <CardFooter>
                <Select
                  value={String(preferences.batteryFloor)}
                  onValueChange={(value) => void updatePreference({ batteryFloor: Number(value) })}
                  disabled={busy || !status || preferences.acOnly}
                >
                  <SelectTrigger
                    aria-label="Battery floor"
                    placeholder="Battery floor"
                    className="h-8 min-w-[92px] px-2 text-xs"
                  />
                  <SelectContent>
                    {[15, 20, 25, 30].map((value, index) => (
                      <SelectItem key={value} value={String(value)} index={index}>
                        {`${value}%`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </CardFooter>
            </Card>

            <Card className="min-h-0 rounded-none bg-transparent">
              <CardHeader>
                <CardTitle>Maximum run</CardTitle>
                <CardDescription>A hard upper limit per run.</CardDescription>
              </CardHeader>
              <CardFooter>
                <Select
                  value={String(preferences.maxDurationMinutes)}
                  onValueChange={(value) =>
                    void updatePreference({ maxDurationMinutes: Number(value) })
                  }
                  disabled={busy || !status}
                >
                  <SelectTrigger
                    aria-label="Maximum run duration"
                    placeholder="Maximum run"
                    className="h-8 min-w-[112px] px-2 text-xs"
                  />
                  <SelectContent>
                    {[
                      [60, "1 hour"],
                      [120, "2 hours"],
                      [240, "4 hours"],
                      [480, "8 hours"],
                    ].map(([value, label], index) => (
                      <SelectItem key={value} value={String(value)} index={index}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </CardFooter>
            </Card>
          </CardGroup>
        </CardContent>
      </Card>

      {displayedError && (
        <div
          className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs leading-5 text-amber-300"
          role="alert"
        >
          <WarningCircle size={17} weight="fill" className="mt-0.5 shrink-0" />
          <span>{displayedError}</span>
        </div>
      )}

      {!supported && !displayedError && (
        <p className="text-sm text-muted-foreground">This feature is only available on macOS.</p>
      )}

      <div className="flex items-center justify-between gap-3 pt-5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={skip}
          disabled={busy}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          Skip for now
        </Button>
        <Button
          type="button"
          size="md"
          disabled={busy || !status || !supported}
          onClick={() => void enable()}
          trailingIcon={busy ? undefined : configured ? ArrowRight : undefined}
        >
          {busy ? (
            <>
              <CircleNotch size={16} className="mr-2 animate-spin" />
              Installing helper…
            </>
          ) : configured ? (
            "Continue"
          ) : (
            "Enable"
          )}
        </Button>
      </div>
    </div>
  );
}
