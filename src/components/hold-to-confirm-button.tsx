import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useReducedMotion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { HOLD_TO_CONFIRM_MS, HoldController, displayedFill } from "@/lib/hold-to-confirm";

interface HoldToConfirmButtonProps {
  /** "Hold to delete". */
  label: string;
  /** Read by screen readers: "Hold to delete workspace feature-auth". */
  accessibleLabel: string;
  /** Id of the element describing what is lost. */
  describedBy?: string;
  disabled?: boolean;
  onConfirm: () => void;
}

/**
 * A red button that confirms only after it is held for HOLD_TO_CONFIRM_MS,
 * with the pointer or with Space/Enter. A plain click shows a hint instead.
 */
export function HoldToConfirmButton({
  label,
  accessibleLabel,
  describedBy,
  disabled,
  onConfirm,
}: HoldToConfirmButtonProps) {
  const reducedMotion = useReducedMotion() ?? false;
  const [progress, setProgress] = useState(0);
  const [hint, setHint] = useState(false);
  const frame = useRef<number | null>(null);
  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;
  const controller = useRef<HoldController | null>(null);
  controller.current ??= new HoldController({
    durationMs: HOLD_TO_CONFIRM_MS,
    now: () => performance.now(),
    onProgress: setProgress,
    onComplete: () => onConfirmRef.current(),
  });

  const stopFrames = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };
  const loop = () => {
    controller.current?.tick();
    frame.current = controller.current?.holding ? requestAnimationFrame(loop) : null;
  };
  const start = () => {
    if (disabled || controller.current?.holding) return;
    setHint(false);
    controller.current?.start();
    stopFrames();
    frame.current = requestAnimationFrame(loop);
  };
  const release = () => {
    stopFrames();
    controller.current?.release();
  };

  useEffect(() => stopFrames, []);

  const isHoldKey = (event: KeyboardEvent) => event.key === " " || event.key === "Enter";
  const holding = controller.current.holding;

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        size="sm"
        variant="destructive"
        disabled={disabled}
        aria-label={accessibleLabel}
        aria-describedby={describedBy}
        data-pipper-id="hold-to-confirm"
        fill={displayedFill(progress, reducedMotion)}
        className={
          holding || reducedMotion ? undefined : "[&_[data-button-fill]]:transition-[clip-path]"
        }
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          start();
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        onKeyDown={(event) => {
          if (!isHoldKey(event)) return;
          // The button's own click on Enter/Space must not fire; holding is the act.
          event.preventDefault();
          if (!event.repeat) start();
        }}
        onKeyUp={(event) => {
          if (!isHoldKey(event)) return;
          event.preventDefault();
          release();
        }}
        onBlur={release}
        onClick={() => {
          if (!controller.current?.completed) setHint(true);
        }}
      >
        {label}
      </Button>
      {hint && (
        <span role="status" className="text-[11px] text-muted-foreground">
          Press and hold to confirm
        </span>
      )}
    </div>
  );
}
