"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Diamond,
  FileCode,
  FolderGit2,
  GitBranch,
  History,
  Minus,
  PanelLeft,
  Play,
  Rabbit,
} from "lucide-react";
import { Tabs, TabsList, TabItem } from "@/components/ui/tabs";
import type { ProjectShapeId } from "../../../contracts/projects.ts";
import { projectShapePath } from "../../../src/lib/project-shapes.ts";

/**
 * Static replica of the hybrid shell (`src/components/hybrid-shell.tsx`): the
 * project rail, the inset thread card and the session panel. It mirrors that
 * layout, the shapes in `src/lib/project-shapes.ts` and the git-state colours
 * in `src/lib/workspace-tone.ts`, without the Electron runtime.
 */

/** Git-state tone, copied from `workspace-tone.ts`. "action" = PR open with
 *  checks still running. */
const TONE_COLOR = "#B1620D";
const HERO_ORANGE = "#FFAA4F";
const HERO_ORANGE_INK = "#A65B0E";
const toneInsetShadow = `inset 0 0 22px 2px ${TONE_COLOR}, inset 0 0 48px 8px ${TONE_COLOR}`;
const toneWash = `linear-gradient(to bottom, ${TONE_COLOR}100 0%, ${TONE_COLOR}1f 85%, ${TONE_COLOR}00 100%)`;

/** The rail's projects; the selected one has its thread on screen, so its
 *  shape takes the thread's git state (a PR with checks running). */
const PROJECTS: { name: string; shape: ProjectShapeId; active?: boolean }[] = [
  { name: "pipper", shape: "flower", active: true },
  { name: "nucleus", shape: "cookie-9" },
  { name: "marketing", shape: "heart" },
  { name: "api", shape: "gem" },
  { name: "docs", shape: "clover-4" },
  { name: "infra", shape: "arch" },
];

const sessions = [
  { value: "tab-1", label: "surprise", icon: FileCode },
  { value: "tab-2", label: "click here", icon: Play },
];

/** Static preview of the draft ThreadComposer and its turn identity marker. */
function Composer() {
  return (
    <div className="flex items-center gap-3" data-pipper-id="product-demo-composer">
      <span className="block size-8 shrink-0" data-pipper-id="user-turn-identity">
        <svg
          viewBox="0 0 29 29"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="block size-full"
          aria-hidden="true"
        >
          <rect width="29" height="29" rx="14.5" fill={HERO_ORANGE} />
          <path
            d="M6.84425 15.494C6.84425 10.8139 9.98266 7.77648 14.5159 7.77648C18.783 7.77648 21.8572 10.4652 21.8572 14.6498C21.8572 17.3936 20.5358 19.3666 18.3976 19.3666C17.2597 19.3666 16.3971 18.8251 16.2319 17.8983H16.1402C15.7364 18.8343 14.9105 19.3666 13.846 19.3666C11.9556 19.3666 10.6617 17.7882 10.6617 15.4848C10.6617 13.2182 11.9556 11.6765 13.7818 11.6765C14.7912 11.6765 15.6446 12.1446 16.0209 12.9613H16.1126V12.5024C16.1126 11.9885 16.4155 11.6765 16.9018 11.6765C17.3974 11.6765 17.691 11.9885 17.691 12.5024V17.054C17.691 17.6781 18.0489 18.0359 18.7096 18.0359C19.7282 18.0359 20.4257 16.687 20.4257 14.7599C20.4257 11.0617 17.7736 9.05203 14.4976 9.05203C10.7443 9.05203 8.2758 11.7041 8.2758 15.5491C8.2758 19.5226 10.937 21.8167 14.883 21.8167C15.7823 21.8167 16.4155 21.6882 17.2414 21.4864C17.3882 21.4588 17.5075 21.4497 17.5993 21.4497C17.9755 21.4497 18.1866 21.6515 18.1866 21.9727C18.1866 22.2939 17.9939 22.5417 17.4433 22.7252C16.7642 22.9546 15.7456 23.1014 14.5985 23.1014C10.0928 23.1014 6.84425 20.2659 6.84425 15.494ZM14.1672 17.935C15.3143 17.935 16.0576 16.9898 16.0576 15.4848C16.0576 14.0166 15.3235 13.0806 14.1672 13.0806C13.0385 13.0806 12.3594 13.9799 12.3594 15.494C12.3594 17.0173 13.0293 17.935 14.1672 17.935Z"
            fill={HERO_ORANGE_INK}
          />
        </svg>
      </span>
      <input
        aria-label="Prompt"
        className="min-h-11 min-w-0 flex-1 bg-transparent px-2 py-2 text-[14px] leading-5 text-foreground outline-none placeholder:text-muted-foreground"
        placeholder="@ a model, then describe the task…"
      />
    </div>
  );
}

/**
 * A project shape as the rail draws it: at rest a raised surface edged with
 * the theme's shadow ring; the active project lit in its git-state colour.
 */
function ShapeIcon({ shape, active }: { shape: ProjectShapeId; active?: boolean }) {
  const gradientId = `demo-shape-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg
      viewBox="0 0 100 100"
      aria-hidden="true"
      className="size-12 overflow-visible"
      style={{
        filter: "drop-shadow(0 1px 1px var(--dm-drop)) drop-shadow(0 3px 3px var(--dm-drop))",
      }}
    >
      {active ? (
        <defs>
          <radialGradient id={gradientId} cx="38%" cy="30%" r="75%">
            <stop offset="0%" stopColor={`color-mix(in srgb, ${HERO_ORANGE} 72%, white)`} />
            <stop offset="55%" stopColor={HERO_ORANGE} />
            <stop offset="100%" stopColor={`color-mix(in srgb, ${HERO_ORANGE} 82%, black)`} />
          </radialGradient>
        </defs>
      ) : null}
      <path
        d={projectShapePath(shape)}
        fill={active ? `url(#${gradientId})` : "var(--surface-3)"}
        stroke="var(--dm-ring-high)"
        strokeWidth={2}
        strokeLinejoin="round"
        paintOrder="stroke"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** The project rail: one shape per project, spread to fill the height. */
function ProjectRail() {
  return (
    <nav
      aria-label="Projects"
      className="flex w-[5.5rem] shrink-0 flex-col px-2 pb-2 pt-12 max-[1100px]:hidden"
    >
      {PROJECTS.map((project) => (
        <span
          key={project.name}
          aria-current={project.active ? "page" : undefined}
          className={
            "flex min-h-[82px] flex-1 flex-col items-center justify-center gap-1.5 " +
            (project.active ? "text-foreground" : "text-muted-foreground")
          }
        >
          <ShapeIcon shape={project.shape} active={project.active} />
          <span className="w-full truncate text-center text-[11px] font-medium leading-4">
            {project.name}
          </span>
        </span>
      ))}
    </nav>
  );
}

const CHECKS: { label: string; state: "passing" | "skipped"; showLink?: boolean }[] = [
  { label: "react-doctor", state: "passing" },
  { label: "Macroscope - Correctness Check", state: "skipped" },
  { label: "CodeRabbit", state: "passing", showLink: false },
  { label: "GitGuardian Security Checks", state: "passing" },
  { label: "Greptile Review", state: "passing" },
  { label: "React Doctor", state: "passing" },
  { label: "Vercel", state: "passing" },
  { label: "Vercel Preview Comments", state: "passing" },
];

const REVIEW_COMMENTS = [
  { name: "coderabbitai", count: 3, inline: 2, avatar: "rabbit" as const },
  { name: "greptile-apps", count: 12, inline: 12, avatar: "greptile" as const },
  { name: "github-actions", count: 1, avatar: "github" as const },
  { name: "qodo-code-review", count: 1, avatar: "qodo" as const },
];

function StateIcon({ state }: { state: "passing" | "skipped" }) {
  return state === "passing" ? (
    <Check size={16} strokeWidth={2.5} className="text-[#00c58d]" />
  ) : (
    <Minus size={16} strokeWidth={2.5} className="text-muted-foreground/60" />
  );
}

function ReviewAvatar({ kind }: { kind: (typeof REVIEW_COMMENTS)[number]["avatar"] }) {
  const colors = {
    rabbit: "bg-[#ff5a13] text-white",
    greptile: "bg-[#25d99a] text-[#003d30]",
    github: "bg-black text-white",
    qodo: "bg-[#6557c7] text-white",
  };
  const icon = {
    rabbit: <Rabbit size={16} fill="currentColor" />,
    greptile: <Diamond size={17} strokeWidth={3} />,
    github: <GitBranch size={16} strokeWidth={2.5} />,
    qodo: <span className="text-[15px] font-bold leading-none">Q</span>,
  }[kind];

  return (
    <span className={`grid size-5 shrink-0 place-items-center rounded-full ${colors[kind]}`}>
      {icon}
    </span>
  );
}

/** A row in the session panel's header: icon, label, optional trailing. */
function HeaderRow({
  icon,
  children,
  trailing,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <span className="flex min-h-8 items-center gap-2.5 text-[13px] text-white">
      <span className="grid size-4 shrink-0 place-items-center text-white/80">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </span>
  );
}

/** Right panel: the session panel, its git-state header over the tabs. */
function SessionPanel() {
  return (
    <aside
      aria-label="Session"
      className="flex w-[22rem] shrink-0 flex-col overflow-y-auto border-l border-border text-left max-[1100px]:hidden"
    >
      {/* The git state reads as an inset glow behind the header, masked away
          toward the bottom edge so it flows into the body. */}
      <div
        className="relative z-20 flex shrink-0 flex-col gap-3 px-4 pb-5 pt-4"
        style={{ backgroundImage: toneWash }}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            boxShadow: toneInsetShadow,
            maskImage: "linear-gradient(to bottom, #000 60%, transparent 100%)",
            WebkitMaskImage: "linear-gradient(to bottom, #000 60%, transparent 100%)",
          }}
        />
        {/* The next step and the PR, joined into one pill. */}
        <div className="flex min-h-7 items-center">
          <span className="flex h-7 shrink-0 items-center overflow-hidden rounded-full bg-[#FFAA4F] text-[12px] font-semibold text-[#4a2c05]">
            <span className="pl-3 pr-1">Push</span>
            <span className="flex items-center pr-2">
              <ChevronDown size={13} />
            </span>
            <span className="flex h-full items-center gap-1 border-l border-[#4a2c05]/20 px-2.5">
              #142 <ArrowUpRight size={13} />
            </span>
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <HeaderRow icon={<FolderGit2 size={16} />}>antigravity-rewrite</HeaderRow>
          <HeaderRow icon={<GitBranch size={16} />}>feat/antigravity-acp</HeaderRow>
          <HeaderRow
            icon={<ArrowUpRight size={16} />}
            trailing={
              <span className="shrink-0 text-[12px] tabular-nums">
                <span className="text-[#7ee2a8]">+482</span>{" "}
                <span className="text-[#ff9b9b]">−117</span>
              </span>
            }
          >
            pipper-dev/pipper
          </HeaderRow>
        </div>
      </div>

      <div className="border-t border-border px-4 py-3">
        <div className="flex items-center gap-4 text-[13px] font-medium leading-5">
          <span className="text-foreground">Check</span>
          <span className="text-muted-foreground/60">Changes</span>
          <span className="text-muted-foreground/60">Files</span>
        </div>
      </div>

      <div className="flex flex-col gap-7 px-4 pb-4">
        <section className="flex flex-col gap-1.5">
          <h3 className="text-sm font-semibold text-foreground">Deployments</h3>
          <ul className="flex flex-col">
            <li className="flex min-h-8 items-center gap-2.5 py-1 text-[13px]">
              <span className="flex w-4 shrink-0 items-center justify-center">
                <StateIcon state="passing" />
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground">Preview</span>
              <ArrowUpRight size={13} className="shrink-0 text-muted-foreground/70" />
            </li>
          </ul>
        </section>
        <section className="flex flex-col gap-1.5">
          <h3 className="text-sm font-semibold text-foreground">Checks</h3>
          <ul className="flex flex-col">
            {CHECKS.map((check) => (
              <li key={check.label} className="flex min-h-8 items-center gap-2.5 py-1 text-[13px]">
                <span className="flex w-4 shrink-0 items-center justify-center">
                  <StateIcon state={check.state} />
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground">{check.label}</span>
                {check.showLink !== false && (
                  <ArrowUpRight size={13} className="shrink-0 text-muted-foreground/70" />
                )}
              </li>
            ))}
          </ul>
        </section>
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
              Review comments
            </h3>
            <span className="flex items-center gap-1 text-[12px] text-muted-foreground">
              Latest <ChevronDown size={13} />
            </span>
          </div>
          <ul className="flex flex-col">
            {REVIEW_COMMENTS.map((comment) => (
              <li
                key={comment.name}
                className="flex min-h-9 items-center gap-2 border-b border-white/10 px-3 py-1.5 text-[13px]"
              >
                <ReviewAvatar kind={comment.avatar} />
                <span className="min-w-0 truncate text-foreground">{comment.name}</span>
                <span className="text-muted-foreground/70">{comment.count}</span>
                {comment.inline && (
                  <span className="truncate text-[11px] text-muted-foreground/60">
                    {comment.inline} inline
                  </span>
                )}
                <ChevronRight size={16} className="ml-auto shrink-0 text-muted-foreground" />
              </li>
            ))}
          </ul>
        </section>
      </div>
    </aside>
  );
}

const SURPRISE_VIDEO_ID = "dQw4w9WgXcQ";

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

function loadYouTubeAPI(): Promise<any> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.YT?.Player) return Promise.resolve(window.YT);
  return new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(window.YT);
    };
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    }
  });
}

export default function ProductDemo() {
  const [activeSession, setActiveSession] = useState("tab-1");
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;
  const playerHostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);

  // Create the player only after the page is interactive, so the YouTube
  // payload never competes with hero render. It then cues + buffers quietly
  // while the visitor reads, ready before they click.
  useEffect(() => {
    let cancelled = false;
    let idleId: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const init = () => {
      loadYouTubeAPI()
        .then((YT) => {
          if (cancelled || !playerHostRef.current || playerRef.current) return;
          playerRef.current = new YT.Player(playerHostRef.current, {
            videoId: SURPRISE_VIDEO_ID,
            width: "100%",
            height: "100%",
            playerVars: { rel: 0, preload: 1 },
            events: {
              onReady: (event: { target: { playVideo: () => void } }) => {
                if (!cancelled && activeSessionRef.current === "tab-2") event.target.playVideo();
              },
            },
          });
        })
        .catch(() => {});
    };

    if (typeof (window as any).requestIdleCallback === "function") {
      idleId = (window as any).requestIdleCallback(init, { timeout: 4000 });
    } else {
      timer = setTimeout(init, 2500);
    }
    return () => {
      cancelled = true;
      if (idleId !== null) (window as any).cancelIdleCallback?.(idleId);
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Start / stop playback the moment the tab changes — no iframe mount wait.
  useEffect(() => {
    const player = playerRef.current;
    if (!player?.playVideo) return;
    if (activeSession === "tab-1") {
      player.pauseVideo?.();
    } else {
      player.playVideo();
    }
  }, [activeSession]);

  return (
    <section
      data-pipper-id="product-demo"
      aria-label="Pipper workspace preview"
      className="flex w-full shrink-0 justify-center overflow-hidden bg-transparent p-[clamp(0.9rem,2.4vw,3rem)]"
    >
      <div className="dark relative flex h-full min-h-[44rem] w-full max-w-[96rem] overflow-hidden rounded-[18px] border border-white/10 bg-surface-1 text-foreground">
        {/* Left rail: one shape per project. */}
        <ProjectRail />

        {/* The thread and its session panel sit in a raised, inset card. */}
        <main className="relative my-2 mr-2 flex min-w-0 flex-1 overflow-hidden rounded-xl bg-surface-2 shadow-surface-2 max-[1100px]:ml-2">
          <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex h-12 shrink-0 items-center gap-2 px-3">
              <div className="mx-auto mt-2 min-w-0 max-w-[1000px] flex-1 px-4 [&_[role=tablist]]:mx-auto">
                <Tabs value={activeSession} onValueChange={setActiveSession}>
                  <TabsList className="min-w-0 max-w-full gap-1 overflow-x-auto p-1">
                    {sessions.map((session) => (
                      <TabItem
                        key={session.value}
                        value={session.value}
                        label={session.label}
                        icon={session.icon}
                      />
                    ))}
                  </TabsList>
                </Tabs>
              </div>
              <span className="mt-2 flex shrink-0 items-center gap-1 text-muted-foreground">
                <span aria-label="Project threads" className="grid size-8 place-items-center">
                  <History size={16} />
                </span>
                <span aria-label="Hide session panel" className="grid size-8 place-items-center">
                  <PanelLeft size={16} className="-scale-x-100" />
                </span>
              </span>
            </div>

            <div className="relative mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col overflow-hidden">
              <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
                {activeSession === "tab-1" && (
                  <div className="relative z-20 shrink-0 px-3 pb-5 pt-2">
                    <Composer />
                  </div>
                )}
                <div
                  aria-hidden={activeSession !== "tab-2"}
                  className={
                    activeSession === "tab-2"
                      ? "flex h-full items-center justify-center p-4"
                      : "hidden"
                  }
                >
                  <div className="aspect-video w-full max-w-3xl overflow-hidden rounded-xl border border-white/10 bg-black">
                    <div ref={playerHostRef} className="h-full w-full" />
                  </div>
                </div>
              </div>
            </div>
          </section>

          <SessionPanel />
        </main>
      </div>
    </section>
  );
}
