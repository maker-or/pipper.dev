import { useEffect, useRef, useState } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import { shapeMap, useShape } from "@/lib/shape-context";
import { useAgentStore } from "@/store/agent-store";
import type { InlineWidgetDocument, InlineWidgetRef } from "../../contracts/acp.ts";

/**
 * A widget an agent showed with `show_widget`, rendered in a sandboxed frame.
 *
 * The frame runs with `allow-scripts` only: no same-origin access, no
 * navigation, no popups. It can only talk to the app through postMessage,
 * and only these messages are honoured: resize, ready, openLink (https,
 * after confirmation) and sendPrompt (the widget runtime only sends it from
 * a click or keypress).
 */

type Status = "loading" | "ready" | "missing" | "error";

const MIN_HEIGHT = 24;
const MAX_HEIGHT = 4000;
const LOADING_HEIGHT = 120;

function currentTheme(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Follows the app's light/dark class on <html>. */
function useDocumentTheme(): "light" | "dark" {
  const [theme, setTheme] = useState(currentTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

export function InlineWidget({
  widgetRef,
  threadId,
}: {
  widgetRef: InlineWidgetRef;
  threadId: string | null;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [widget, setWidget] = useState<InlineWidgetDocument | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [height, setHeight] = useState(LOADING_HEIGHT);
  const [revision, setRevision] = useState(0);
  const theme = useDocumentTheme();
  const shape = useShape() === shapeMap.pill ? "pill" : "rounded";
  // The document is fetched in the theme current at load time; later theme
  // changes are posted to the frame instead of reloading it.
  const loadTheme = useRef(theme);
  loadTheme.current = theme;
  // The ref object is rebuilt on every render; load once per widget.
  const latestRef = useRef(widgetRef);
  latestRef.current = widgetRef;
  const refKey = "id" in widgetRef ? widgetRef.id : `${widgetRef.title}\0${widgetRef.code}`;
  const widgetId = widget?.id ?? null;

  useEffect(() => {
    let disposed = false;
    setStatus((current) => (current === "ready" ? current : "loading"));
    window.omni.widgets
      .getDocument(latestRef.current, loadTheme.current)
      .then((doc) => {
        if (disposed) return;
        setWidget(doc);
        setStatus(doc ? "loading" : "missing");
      })
      .catch(() => {
        if (!disposed) setStatus("error");
      });
    return () => {
      disposed = true;
    };
  }, [refKey, revision]);

  // update_widget replaces the code; reload the frame when it does.
  useEffect(() => {
    if (!widgetId) return;
    return window.omni.agent.onEvent((event) => {
      if (event.type === "widget-updated" && event.widgetId === widgetId) {
        setRevision((value) => value + 1);
      }
    });
  }, [widgetId]);

  useEffect(() => {
    const frame = frameRef.current?.contentWindow;
    if (!frame || status !== "ready") return;
    frame.postMessage({ type: "theme", theme }, "*");
    frame.postMessage({ type: "shape", shape }, "*");
  }, [theme, shape, status]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const data = event.data as { source?: unknown; type?: unknown; [key: string]: unknown };
      if (!data || data.source !== "pipper-widget") return;
      if (data.type === "resize" && typeof data.height === "number") {
        setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(data.height))));
      } else if (data.type === "ready") {
        setStatus("ready");
      } else if (data.type === "openLink" && typeof data.url === "string") {
        void openWidgetLink(data.url);
      } else if (data.type === "sendPrompt" && typeof data.text === "string") {
        const text = data.text.trim().slice(0, 4000);
        if (!text) return;
        const store = useAgentStore.getState();
        void store.sendPrompt({
          threadId,
          message: text,
          ...(store.state?.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [threadId]);

  if (status === "missing" || status === "error") {
    return (
      <div
        data-pipper-id="inline-widget-unavailable"
        className="flex items-start gap-2 rounded-xl border border-border/70 px-3 py-2 text-[12px] text-muted-foreground"
      >
        <WarningCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          {status === "missing"
            ? "This visual is no longer available."
            : "This visual couldn't be loaded."}
          {widget?.summary ? ` ${widget.summary}` : ""}
        </span>
      </div>
    );
  }

  return (
    <figure
      data-pipper-id="inline-widget"
      data-widget-id={widgetId ?? undefined}
      className="m-0 w-full"
    >
      {widget && (
        <iframe
          ref={frameRef}
          key={`${widget.id}:${widget.updatedAt}`}
          title={widget.title.replace(/_/g, " ")}
          aria-label={widget.summary}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={widget.document}
          className="block w-full border-0 bg-transparent transition-opacity duration-150"
          style={{ height, opacity: status === "ready" ? 1 : 0 }}
        />
      )}
      {!widget && <div style={{ height }} aria-busy="true" />}
      {widget?.summary && <figcaption className="sr-only">{widget.summary}</figcaption>}
    </figure>
  );
}

async function openWidgetLink(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "https:") return;
  if (!window.confirm(`Open ${parsed.toString()} in your browser?`)) return;
  await window.omni.shell.openHttps(parsed.toString());
}
