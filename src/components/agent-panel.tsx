"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  CheckIcon as ModelCheckIcon,
  ChatCircleTextIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { ChatMessage } from "@/components/ui/chat-message";
import { ThreadComposer, initialDraftContent } from "@/components/thread-composer";
import { ConversationTurnIdentity } from "@/components/conversation-turn-identity";
import { AgentRuntimeControls } from "@/components/agent-runtime-controls";
import { AgentAuthBanner } from "@/components/agent-auth-actions";
import type { MentionProvider } from "@/components/mention-popover";
import { useIcon } from "@/lib/icon-context";
import { Elevated } from "@/lib/elevated";
import { useProjectStore } from "@/store/project-store";
import { useThreadStore } from "@/store/thread-store";
import { useAgentStore } from "@/store/agent-store";
import { useAgentRegistryStore } from "@/store/agent-registry-store";
import { useModelCatalogStore } from "@/store/model-catalog-store";
import { useWorktreeStore } from "@/store/worktree-store";
import { useUiModeStore } from "@/store/ui-mode-store";
import { useIsDiffSplit, useWorkspaceViewStore } from "@/store/workspace-view-store";
import { useDiffStore, type DiffTurnSummary } from "@/store/diff-store";
import { normalizeWorkspacePath } from "../../contracts/workspace-scope.ts";
import type { ComposerContent } from "../../contracts/composer.ts";
import {
  assertCreatable,
  blankContent,
  buildContent,
  extractModelId,
  extractModelToken,
  extractProjectId,
  extractTextContent,
  getEntityTokens,
  getFreeText,
  removeEntityKind,
  resolveAgentId,
  setFreeText,
  stripEntityKinds,
  titleFromText,
  upsertEntity,
} from "@/lib/composer-tokens";
import { selectThread } from "@/lib/thread-actions";
import { invalidateProjectFiles, useProjectFileIndex } from "@/lib/project-file-index";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { InlineWidget } from "@/components/inline-widget";
import { buildMessageBodyBlocks, type MessageBodyBlock } from "@/lib/inline-widgets";
import { AssistantTraceDeck } from "@/components/ui/assistant-trace-deck";
import { ThinkingIndicator } from "@/components/ui/thinking-indicator";
import { AgentSlashCommandMenu } from "@/components/agent-slash-command-menu";
import { AgentContinueMenu } from "@/components/agent-continue-menu";
import { AgentQuestionCard, AgentQuestionDock } from "@/components/agent-question";
import { cn } from "@/lib/utils";
import { isInstanceSelected } from "@/lib/agent-selection";
import { beginRendererInteraction } from "@/lib/monitor-runtime-observer";
import { toast } from "@/components/ui/toast";
import type { AgentPanelSnapshot } from "@/store/agent-store";
import { useContinuationStore } from "@/store/continuation-store";
import {
  budgetTranscript,
  buildContinuationText,
  extractConversation,
  hasConversation,
  type TranscriptSourceMessage,
} from "@/lib/acp-transcript";
import type { ContentBlock } from "../../contracts/acp.ts";
import { assemblePromptBlocks } from "@/lib/acp-session-reducer";
import { stringifyMessageContent, type MessageLike } from "@/lib/message-utils";
import {
  extractGroupedMessageImages,
  fileToPromptImage,
  hasPendingImages,
  MAX_AGENT_IMAGES,
  partitionValidImageFiles,
  type ChatImageAttachment,
} from "@/lib/agent-message-images";
import { CONTINUE_COMMAND, matchAgentCommands, mergeAgentCommands } from "@/lib/agent-commands";
import { isSubagentTrigger, SUBAGENT_COMMAND } from "@/lib/subagent-orchestration";
import { SubagentComposer, type SubagentComposerSubmit } from "@/components/subagent-composer";
import { SubagentActivity } from "@/components/subagent-activity";
import { DiffSummaryCard } from "@/components/diff-summary-card";
/** Max agents shown in (and selectable from) the `/continue` picker. */
const MAX_CONTINUE_AGENTS = 8;
const SCROLL_LIVE_EDGE_PX = 24;
const SCROLL_ANCHOR_TOP_PX = 72;
const messageTimeFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const iconButtonClass =
  "inline-flex size-6 items-center justify-center rounded-full  text-muted-foreground/60 hover:text-foreground hover:bg-hover transition-colors duration-100 cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-ring";
const COMPOSER_TURN_MARKER = <ConversationTurnIdentity role="user" emphasis="composer" />;

type ComposerProjectContext = {
  id: string;
  name: string;
  icon?: string | null;
};

function withProjectChip(
  content: ComposerContent,
  project: ComposerProjectContext,
): ComposerContent {
  const entities = getEntityTokens(content).filter((entity) => entity.kind !== "project");
  return buildContent(
    [{ kind: "project", id: project.id, label: project.name, icon: project.icon }, ...entities],
    getFreeText(content),
  );
}

type ConversationScrollMode = "reading" | "anchoring" | "following";
type PendingScrollAction = {
  kind: "restore" | "new-turn";
  threadId: string | null;
};

export function formatProviderName(provider: string): string {
  return provider
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getProviderIconKind(provider: string): string {
  const key = provider.toLowerCase();
  if (key.includes("cursor")) return "cursor";
  if (key.includes("codex")) return "openai-codex";
  if (key.includes("copilot") || key.includes("github")) return "github-copilot";
  if (key.includes("anthropic") || key.includes("claude")) return "anthropic";
  if (key.includes("groq")) return "groq";
  if (key.includes("xai") || key.includes("grok")) return "xai";
  if (key.includes("openrouter")) return "openrouter";
  if (key.includes("opencode")) return "opencode";
  if (key.includes("kimi") || key.includes("moonshot")) return "kimi-coding";
  if (key.includes("antigravity") || key.includes("agy")) return "antigravity";
  if (key.includes("devin")) return "devin";
  if (key.includes("gemini") || key.includes("google")) return "gemini";
  if (key.includes("openai")) return "openai";
  return "generic";
}

export function ProviderMark({ provider, className }: { provider: string; className?: string }) {
  const kind = getProviderIconKind(provider);
  const label = formatProviderName(provider) || "Provider";
  const iconClassName = cn("h-4 w-4 shrink-0", className);

  if (kind === "cursor") {
    return (
      <svg aria-label={label} className={iconClassName} viewBox="0 0 466.73 532.09" role="img">
        <path
          fill="currentColor"
          d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z"
        />
      </svg>
    );
  }

  if (kind === "openai-codex") {
    return (
      <svg aria-label={label} className={iconClassName} viewBox="0 0 20 20" fill="none" role="img">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M6.7381 0.381875C7.54086 0.0519699 8.41467 -0.0670822 9.27643 0.036042C10.3873 0.163542 11.3773 0.636042 12.2464 1.45271C12.2581 1.4638 12.2724 1.47181 12.288 1.47602C12.3035 1.48024 12.3199 1.48053 12.3356 1.47688C13.5089 1.18854 14.6373 1.29021 15.7198 1.78188L15.7723 1.80688L15.9006 1.87021C17.0314 2.45604 17.8423 3.34521 18.3323 4.53521C18.5639 5.10104 18.6806 5.69188 18.6831 6.30688C18.6994 6.76481 18.6489 7.22269 18.5331 7.66604C18.5274 7.68864 18.5275 7.71231 18.5333 7.73488C18.5391 7.75745 18.5505 7.77819 18.5664 7.79521C19.2216 8.4594 19.6772 9.29409 19.8814 10.2044C20.2023 11.7885 19.8731 13.2169 18.8956 14.4877L18.7439 14.671C18.0966 15.4124 17.2468 15.9485 16.2989 16.2135C16.2782 16.2195 16.2593 16.2303 16.2436 16.2451C16.228 16.2599 16.2161 16.2782 16.2089 16.2985C15.9964 16.9119 15.7831 17.4352 15.3864 17.9585C14.3873 19.2769 12.9181 20.0102 11.2631 20.001C9.94393 19.9944 8.77476 19.5119 7.75476 18.5544C7.7393 18.5402 7.72042 18.5303 7.69996 18.5256C7.67951 18.5209 7.65818 18.5216 7.6381 18.5277C7.20643 18.6669 6.77143 18.6869 6.30143 18.6819C5.55055 18.6758 4.81096 18.4985 4.13893 18.1635C3.43551 17.8146 2.82317 17.3064 2.35059 16.6794C2.18143 16.4552 2.01393 16.2444 1.89143 15.9952C1.72248 15.6518 1.58443 15.294 1.47893 14.926C1.25741 14.09 1.25254 13.2112 1.46476 12.3727C1.47162 12.3529 1.4739 12.3318 1.47143 12.311C1.4673 12.2904 1.45646 12.2716 1.44059 12.2577C0.926911 11.7381 0.534239 11.1115 0.290595 10.4227C0.129283 9.99859 0.0356402 9.55174 0.0130947 9.09854C-0.0272048 8.50178 0.0256504 7.90238 0.169761 7.32188C0.544761 6.08521 1.26059 5.11521 2.31726 4.41104C2.55226 4.25438 2.77559 4.13271 2.98559 4.04604C3.22393 3.94604 3.46309 3.86271 3.70309 3.79271C3.72026 3.78762 3.73588 3.77832 3.74855 3.76566C3.76121 3.753 3.7705 3.73737 3.77559 3.72021C3.95759 3.06602 4.27059 2.45562 4.69559 1.92604C5.26226 1.22104 5.9431 0.706042 6.7381 0.381875ZM6.06809 6.92354C5.97505 6.76077 5.82115 6.64162 5.64026 6.59231C5.45936 6.54301 5.26629 6.56758 5.10351 6.66063C4.94073 6.75367 4.82159 6.90757 4.77228 7.08847C4.72298 7.26936 4.74755 7.46243 4.84059 7.62521L6.25226 10.096L4.84559 12.4694C4.75935 12.6302 4.73858 12.8181 4.78762 12.9939C4.83667 13.1697 4.95173 13.3197 5.10877 13.4126C5.26582 13.5056 5.4527 13.5342 5.63038 13.4926C5.80806 13.451 5.9628 13.3424 6.06226 13.1894L7.67893 10.4627C7.74269 10.3552 7.77682 10.2327 7.77784 10.1077C7.77887 9.98265 7.74675 9.8596 7.68476 9.75104L6.06809 6.92354ZM10.6064 12.1235C10.4264 12.1343 10.2572 12.2133 10.1335 12.3446C10.0099 12.4759 9.94097 12.6494 9.94097 12.8298C9.94097 13.0102 10.0099 13.1837 10.1335 13.315C10.2572 13.4463 10.4264 13.5253 10.6064 13.536H14.6464C14.8279 13.5272 14.999 13.4489 15.1244 13.3174C15.2497 13.1858 15.3196 13.0111 15.3196 12.8294C15.3196 12.6477 15.2497 12.4729 15.1244 12.3414C14.999 12.2098 14.8279 12.1315 14.6464 12.1227H10.6064V12.1235Z"
          fill="currentColor"
        />
      </svg>
    );
  }

  if (kind === "openai") {
    return (
      <svg aria-label={label} className={iconClassName} viewBox="0 0 20 20" fill="none" role="img">
        <path
          d="M18.6863 8.16932C18.913 7.49711 18.9914 6.78502 18.9163 6.0806C18.8411 5.37617 18.6142 4.69564 18.2506 4.08447C17.1447 2.18901 14.9219 1.21401 12.751 1.67216C12.15 1.01385 11.3835 0.522841 10.5287 0.24846C9.67395 -0.025921 8.76089 -0.0740183 7.88124 0.108998C7.0016 0.292015 6.18635 0.699703 5.51737 1.29112C4.84838 1.88253 4.34922 2.63685 4.07002 3.47832C3.36515 3.62063 2.69925 3.90944 2.11683 4.32544C1.5344 4.74145 1.04887 5.27506 0.692672 5.89062C-0.425297 7.78309 -0.171469 10.1702 1.32025 11.7937C1.09271 12.4656 1.0135 13.1776 1.08794 13.882C1.16238 14.5864 1.38875 15.2671 1.75189 15.8785C2.85923 17.7746 5.08345 18.7495 7.25549 18.2908C7.73304 18.8203 8.31981 19.2433 8.97663 19.5318C9.63346 19.8202 10.3452 19.9673 11.0644 19.9634C13.2895 19.9653 15.2608 18.551 15.9405 16.4649C16.6452 16.3223 17.311 16.0334 17.8934 15.6174C18.4758 15.2014 18.9614 14.6679 19.3177 14.0525C20.4222 12.1635 20.1674 9.78932 18.6863 8.16932ZM11.0644 18.6569C10.1762 18.6582 9.31592 18.3517 8.63431 17.7911L8.75423 17.7242L12.791 15.4299C12.8914 15.3719 12.9748 15.2892 13.033 15.1898C13.0912 15.0905 13.1221 14.9779 13.1227 14.8632V9.25939L14.8294 10.2314C14.8464 10.2399 14.8583 10.256 14.8613 10.2747V14.9183C14.857 16.9812 13.1595 18.6525 11.0644 18.6569ZM2.90298 15.2253C2.45757 14.468 2.29765 13.5804 2.45134 12.7185L2.57119 12.7893L6.61197 15.0836C6.71195 15.1414 6.82577 15.1718 6.9417 15.1718C7.05762 15.1718 7.17144 15.1414 7.27142 15.0836L12.2074 12.2817V14.2218C12.207 14.2318 12.2042 14.2416 12.1994 14.2505C12.1945 14.2594 12.1877 14.267 12.1795 14.2729L8.0908 16.5948C6.27384 17.6254 3.95252 17.0125 2.90298 15.2253ZM1.83978 6.56755C2.28829 5.80541 2.99621 5.2241 3.83822 4.92655V9.64885C3.8367 9.76295 3.86631 9.87536 3.92395 9.97435C3.9816 10.0733 4.06517 10.1553 4.16595 10.2116L9.07798 13.0018L7.37134 13.9738C7.36211 13.9786 7.35183 13.9811 7.34138 13.9811C7.33094 13.9811 7.32065 13.9786 7.31142 13.9738L3.23072 11.656C1.41736 10.6211 0.795485 8.33724 1.83978 6.54793V6.56755ZM15.8606 9.77485L10.9324 6.95716L12.6352 5.98909C12.6444 5.98426 12.6547 5.98173 12.6652 5.98173C12.6756 5.98173 12.6859 5.98426 12.6952 5.98909L16.7759 8.31093C17.3998 8.66541 17.9085 9.18733 18.2424 9.81577C18.5764 10.4442 18.7219 11.1532 18.662 11.86C18.6021 12.5668 18.3392 13.2423 17.904 13.8075C17.4688 14.3727 16.8793 14.8044 16.2043 15.0521V10.3297C16.2008 10.2158 16.1672 10.1048 16.107 10.0075C16.0467 9.91024 15.9618 9.83007 15.8606 9.77485ZM17.5592 7.26024L17.4392 7.18932L13.4065 4.87539C13.3059 4.81728 13.1914 4.78664 13.0748 4.78664C12.9582 4.78664 12.8436 4.81728 12.7431 4.87539L7.81095 7.67739V5.73732C7.8099 5.72745 7.81158 5.71749 7.8158 5.70849C7.82002 5.69949 7.82663 5.69177 7.83494 5.68616L11.9156 3.36824C12.5411 3.01349 13.2561 2.84141 13.9772 2.87212C14.6983 2.90284 15.3956 3.13507 15.9876 3.54167C16.5796 3.94827 17.0417 4.51242 17.32 5.16814C17.5983 5.82387 17.6812 6.54405 17.5591 7.24447V7.26024H17.5592ZM6.87978 10.6996L5.17314 9.73155C5.16461 9.72647 5.15732 9.71961 5.15178 9.71144C5.14625 9.70328 5.1426 9.69402 5.14111 9.68432V5.05255C5.14206 4.342 5.34842 3.6464 5.73608 3.04707C6.12374 2.44775 6.67666 1.96947 7.33022 1.66816C7.98377 1.36684 8.71093 1.25494 9.42669 1.34554C10.1425 1.43614 10.8172 1.7255 11.3721 2.17978L11.2522 2.2467L7.21548 4.54093C7.11503 4.59895 7.03162 4.68171 6.97347 4.78106C6.91531 4.88041 6.8844 4.99295 6.88377 5.10762L6.87978 10.6997V10.6996ZM7.80697 8.73193L10.0052 7.48447L12.2074 8.73201V11.2269L10.0132 12.4745L7.81103 11.2269L7.80697 8.73193Z"
          fill="currentColor"
        />
      </svg>
    );
  }

  if (kind === "github-copilot") {
    return (
      <svg
        aria-label={label}
        className={cn("h-4 w-5 shrink-0", className)}
        viewBox="0 0 25 20"
        fill="none"
        role="img"
      >
        <path
          d="M19.7404 3.01923C21.0865 4.44231 21.6635 6.40385 21.9038 9.13462C22.5385 9.13462 23.1346 9.27885 23.5385 9.82692L24.2885 10.8462C24.5 11.1346 24.6154 11.4808 24.6154 11.8462V14.6058C24.6139 14.7833 24.5715 14.958 24.4914 15.1165C24.4114 15.2749 24.2959 15.4127 24.1538 15.5192C20.7596 18 16.5673 20 12.3077 20C7.59615 20 2.86538 17.2788 0.461538 15.5192C0.319527 15.4127 0.204002 15.2749 0.123952 15.1165C0.0439012 14.958 0.00148389 14.7833 0 14.6058L0 11.8462C0 11.4808 0.115385 11.1346 0.326923 10.8365L1.07692 9.82692C1.48077 9.27885 2.07692 9.13462 2.71154 9.13462C2.95192 6.40385 3.51923 4.44231 4.875 3.01923C7.43269 0.307692 10.8269 0 12.2692 0H12.3077C13.7212 0 17.1538 0.278846 19.7404 3.01923ZM12.3077 7.56731C12.0192 7.56731 11.6827 7.58654 11.3173 7.625C11.2263 8.05529 11.0278 8.45554 10.7404 8.78846C10.3351 9.1892 9.85466 9.50591 9.32663 9.72043C8.7986 9.93494 8.23339 10.043 7.66346 10.0385C7.00962 10.0385 6.32692 9.89423 5.76923 9.53846C5.24038 9.72115 4.73077 9.97115 4.69231 10.5962C4.64423 11.7692 4.63462 12.9519 4.63462 14.1346C4.63462 14.7212 4.63462 15.3173 4.61538 15.9135C4.61538 16.2596 4.82692 16.5769 5.14423 16.7212C7.68269 17.875 10.0962 18.4615 12.3077 18.4615C14.5192 18.4615 16.9231 17.8846 19.4712 16.7212C19.6266 16.6503 19.7588 16.5368 19.8524 16.3938C19.9461 16.2509 19.9972 16.0843 20 15.9135C20.0288 14.1442 20 12.3558 19.9231 10.5962C19.8846 9.96154 19.375 9.72115 18.8462 9.53846C18.2885 9.89423 17.5962 10.0288 16.9519 10.0288C16.3827 10.0347 15.8179 9.92811 15.2899 9.71526C14.7619 9.50241 14.2811 9.18746 13.875 8.78846C13.5876 8.45554 13.3891 8.05529 13.2981 7.625C12.9712 7.58654 12.6346 7.57692 12.3077 7.56731ZM9.71154 11.7981C10.2692 11.7981 10.7212 12.2404 10.7212 12.7981V14.6442C10.7212 14.9094 10.6158 15.1638 10.4283 15.3513C10.2407 15.5389 9.98637 15.6442 9.72115 15.6442C9.45594 15.6442 9.20158 15.5389 9.01405 15.3513C8.82651 15.1638 8.72115 14.9094 8.72115 14.6442V12.7885C8.72115 12.2308 9.16346 11.7885 9.72115 11.7885L9.71154 11.7981ZM14.8462 11.7981C15.4038 11.7981 15.8462 12.2404 15.8462 12.7981V14.6442C15.8462 14.9094 15.7408 15.1638 15.5533 15.3513C15.3657 15.5389 15.1114 15.6442 14.8462 15.6442C14.5809 15.6442 14.3266 15.5389 14.139 15.3513C13.9515 15.1638 13.8462 14.9094 13.8462 14.6442V12.7885C13.8462 12.2308 14.2981 11.7885 14.8462 11.7885V11.7981ZM7.82692 2.72115C6.75 2.82692 5.84615 3.18269 5.38462 3.68269C4.38462 4.76923 4.59615 7.53846 5.17308 8.125C5.74351 8.60002 6.4698 8.84668 7.21154 8.81731C7.86538 8.81731 9.09615 8.67308 10.1058 7.64423C10.5577 7.21154 10.8269 6.13462 10.7981 5.04808C10.7692 4.17308 10.5192 3.44231 10.1538 3.13462C9.75 2.78846 8.84615 2.63462 7.82692 2.72115ZM14.4615 3.13462C14.0962 3.44231 13.8462 4.17308 13.8173 5.04808C13.7885 6.13462 14.0577 7.21154 14.5096 7.64423C14.8879 8.02225 15.338 8.32078 15.8334 8.52224C16.3288 8.7237 16.8595 8.82403 17.3942 8.81731C18.25 8.81731 19.0288 8.53846 19.4423 8.125C20.0192 7.53846 20.2308 4.76923 19.2308 3.67308C18.7692 3.19231 17.8654 2.82692 16.7885 2.72115C15.7692 2.625 14.8654 2.78846 14.4615 3.13462ZM12.3077 5.38462C12.0577 5.38462 11.7692 5.40385 11.4423 5.43269C11.4808 5.59615 11.4904 5.78846 11.5096 5.98077C11.5096 6.125 11.5096 6.26923 11.4904 6.41346C11.7981 6.38462 12.0673 6.38462 12.3077 6.38462C12.5577 6.38462 12.8173 6.38462 13.125 6.41346C13.1058 6.25962 13.1058 6.125 13.1058 5.98077C13.125 5.78846 13.1346 5.59615 13.1731 5.43269C12.8462 5.40385 12.5577 5.38462 12.3077 5.38462Z"
          fill="currentColor"
        />
      </svg>
    );
  }

  if (kind === "anthropic") {
    return (
      <svg aria-label={label} className={iconClassName} viewBox="0 0 20 20" role="img">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M11.5225 2.93359H14.525L20 16.6669H16.9975L11.5225 2.93359ZM5.47417 2.93359H8.61333L14.0883 16.6669H11.0267L9.9075 13.7828H4.18083L3.06083 16.6661H0L5.475 2.93526L5.47417 2.93359ZM8.9175 11.2328L7.04417 6.40609L5.17083 11.2336H8.91667L8.9175 11.2328Z"
          fill="currentColor"
        />
      </svg>
    );
  }

  if (kind === "groq") {
    return (
      <svg aria-label={label} className={iconClassName} viewBox="0 0 20 20" role="img">
        <rect width="20" height="20" rx="4" fill="currentColor" />
        <path
          d="M12.7359 4.87543L12.9245 5.02668C13.5654 5.60061 13.9899 6.41673 14.129 7.26349C14.1386 7.44489 14.1437 7.62648 14.145 7.80817L14.148 8.13125L14.1492 8.47772L14.1509 8.83722C14.1519 9.08817 14.1525 9.33911 14.1529 9.58996C14.1538 9.97205 14.1569 10.3541 14.16 10.7363C14.1607 10.9806 14.1612 11.2249 14.1616 11.4691L14.1654 11.813C14.1621 12.9789 13.8298 13.9852 13.0236 14.8525C12.5707 15.2734 12.1134 15.5861 11.5419 15.8207L11.3044 15.9257C10.3815 16.2595 9.2845 16.1642 8.38111 15.8132C7.88201 15.5764 7.47007 15.2988 7.0643 14.9252C7.43027 14.4748 7.80161 14.09 8.25833 13.7312L8.5631 13.9675C9.11753 14.3613 9.67106 14.486 10.3479 14.4277C11.0404 14.29 11.5872 13.9797 12.0394 13.4326C12.4547 12.7576 12.4961 12.2165 12.4903 11.4332L12.4915 11.0877C12.4918 10.8475 12.491 10.6074 12.4893 10.3672C12.4873 10.001 12.4893 9.63484 12.4919 9.26867C12.4916 9.03454 12.4911 8.80051 12.4903 8.56638L12.4928 8.23683C12.483 7.4412 12.3204 6.9224 11.828 6.29951C11.1528 5.75643 10.524 5.4825 9.64748 5.52419C8.91843 5.6424 8.32629 5.99185 7.87862 6.57902C7.50927 7.16518 7.34887 7.76797 7.46231 8.45752C7.68032 9.20847 7.96171 9.84538 8.65634 10.2486C9.23823 10.5531 9.74012 10.5991 10.3915 10.6155L10.6695 10.6258C10.8939 10.6339 11.1184 10.6404 11.3429 10.6466V12.2386C9.683 12.3056 8.39614 12.3037 7.07902 11.1592C6.25514 10.3337 5.75186 9.21394 5.71484 8.04708C5.75405 7.06499 6.10589 6.26658 6.66629 5.47245L6.83425 5.21742C8.42728 3.53842 10.9499 3.42628 12.7359 4.87543Z"
          fill="var(--surface-3)"
        />
      </svg>
    );
  }

  if (kind === "xai") {
    return (
      <svg
        aria-label={label}
        className={cn("h-4 w-[22px] shrink-0", className)}
        viewBox="0 0 841.89 595.28"
        role="img"
      >
        <path
          d="m557.09 211.99 8.31 326.37h66.56l8.32-445.18zM640.28 56.91H538.72L379.35 284.53l50.78 72.52zM201.61 538.36h101.56l50.79-72.52-50.79-72.53zM201.61 211.99l228.52 326.37h101.56L303.17 211.99z"
          fill="currentColor"
        />
      </svg>
    );
  }

  if (kind === "openrouter") {
    return (
      <svg aria-label={label} className={iconClassName} viewBox="0 0 20 20" role="img">
        <path
          d="M0.117188 9.72267C0.703125 9.72267 2.96875 9.217 4.14062 8.55294C5.3125 7.88888 5.3125 7.88888 7.73438 6.17013C10.8007 3.99408 12.9688 4.72267 16.5234 4.72267"
          stroke="currentColor"
          strokeWidth="3.51562"
        />
        <path d="M19.9609 4.74483L13.9551 8.21233V1.27734L19.9609 4.74483Z" fill="currentColor" />
        <path
          d="M0 9.72656C0.585938 9.72656 2.85156 10.2322 4.02344 10.8963C5.19531 11.5604 5.19531 11.5604 7.61719 13.2791C10.6835 15.4552 12.8516 14.7266 16.4062 14.7266"
          stroke="currentColor"
          strokeWidth="3.51562"
        />
        <path d="M19.8438 14.7057L13.8379 11.2383V18.1732L19.8438 14.7057Z" fill="currentColor" />
      </svg>
    );
  }

  if (kind === "opencode") {
    return (
      <svg
        aria-label={label}
        className={cn("h-4 w-[13px] shrink-0", className)}
        viewBox="0 0 16 20"
        role="img"
      >
        <path d="M12 8V16H4V8H12Z" fill="var(--surface-4)" />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M16 20H0V0H16V20ZM12 4H4V16H12V4Z"
          fill="currentColor"
        />
      </svg>
    );
  }

  if (kind === "kimi-coding") {
    return (
      <svg aria-label={label} className={iconClassName} viewBox="0 0 20 20" role="img">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M19.6484 4.46484V15.4023C19.6484 17.7739 17.723 19.6992 15.3516 19.6992H4.41406C2.04254 19.6992 0.117188 17.7739 0.117188 15.4023V4.46484C0.117188 2.09336 2.04254 0.167969 4.41406 0.167969H15.3516C17.723 0.167969 19.6484 2.09336 19.6484 4.46484Z"
          fill="currentColor"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M13.3623 7.41301C13.436 7.31848 13.5006 7.23215 13.5689 7.14855C13.6005 7.10922 13.5978 7.07937 13.5671 7.03824C13.271 6.64898 13.243 6.21683 13.4134 5.77832C13.5413 5.44832 13.8243 5.29371 14.1701 5.26074C14.3858 5.24039 14.5973 5.26254 14.7935 5.36738C15.0512 5.50527 15.2013 5.71551 15.2501 6.0057C15.289 6.23719 15.2817 6.4632 15.2162 6.68742C15.1 7.08433 14.8148 7.29004 14.4237 7.34203C14.0991 7.38539 13.7701 7.39086 13.4428 7.41301C13.4175 7.4148 13.3917 7.41301 13.3623 7.41301Z"
          fill="var(--surface-3)"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M12.5591 5.63672H10.6034L9.05512 9.16734H6.86621V5.65211H5.11719V14.7485H6.86668V10.9164H9.95156C10.4827 10.9164 10.9678 10.6067 11.1916 10.1253V14.7485H12.9411V10.9164C12.9411 10.0046 12.2286 9.23785 11.3191 9.17141V9.16688H10.3584C10.5899 9.08784 10.8026 8.96196 10.9833 8.79707C11.164 8.63218 11.3087 8.43183 11.4086 8.20852L12.5591 5.63672Z"
          fill="var(--surface-3)"
        />
      </svg>
    );
  }

  if (kind === "antigravity") {
    return (
      <svg aria-label={label} className={iconClassName} viewBox="0 0 16 15" fill="none" role="img">
        <path
          d="M14.0777 13.984C14.945 14.6345 16.2458 14.2008 15.0533 13.0084C11.476 9.53949 12.2349 0 7.79033 0C3.34579 0 4.10461 9.53949 0.527295 13.0084C-0.773543 14.3092 0.635692 14.6345 1.50293 13.984C4.86344 11.7076 4.64663 7.69664 7.79033 7.69664C10.934 7.69664 10.7172 11.7076 14.0777 13.984Z"
          fill="currentColor"
        />
      </svg>
    );
  }

  if (kind === "devin") {
    return (
      <svg aria-label={label} className={iconClassName} viewBox="0 0 24 24" fill="none" role="img">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M2.033 9.867l2.554 1.483a.589.589 0 00.592 0l2.554-1.483.01-.008a.608.608 0 00.11-.084l.013-.015a.631.631 0 00.076-.1c.003-.005.008-.01.01-.016a.558.558 0 00.052-.125l.007-.028a.611.611 0 00.019-.14V7.868c0-.572.307-1.105.8-1.392a1.595 1.595 0 011.598 0l1.277.742a.54.54 0 00.129.053l.028.01c.044.01.088.015.133.016h.006l.013-.002a.587.587 0 00.27-.074l.011-.004 2.554-1.483a.596.596 0 00.297-.516V2.253a.595.595 0 00-.297-.516L12.293.257a.587.587 0 00-.591 0L9.148 1.737l-.01.01a.609.609 0 00-.109.083l-.014.015a.632.632 0 00-.076.1c-.003.005-.008.01-.01.016a.57.57 0 00-.052.124l-.007.028a.612.612 0 00-.018.14v1.483c0 .572-.307 1.105-.8 1.393a1.597 1.597 0 01-1.599 0l-1.276-.742a.603.603 0 00-.13-.053l-.028-.008a.658.658 0 00-.133-.018h-.02a.57.57 0 00-.269.074c-.003.002-.008.002-.012.005L2.033 5.872a.596.596 0 00-.297.515v2.966c0 .213.113.41.297.515z"
          fill="currentColor"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M15.943 10.607a1.596 1.596 0 011.599 0l1.276.74c.041.025.085.04.13.055l.028.008c.043.01.088.016.133.018h.005c.005 0 .01-.002.014-.003a.474.474 0 00.122-.016l.021-.005a.616.616 0 00.126-.052c.004-.002.009-.002.013-.005l2.554-1.482a.597.597 0 00.297-.516V6.383a.596.596 0 00-.297-.515l-2.552-1.483a.587.587 0 00-.592 0l-2.553 1.482-.011.008a.61.61 0 00-.108.084l-.014.016a.637.637 0 00-.076.1c-.003.005-.008.01-.01.016a.57.57 0 00-.052.124l-.007.029a.612.612 0 00-.018.14v1.482c0 .572-.307 1.105-.8 1.393a1.597 1.597 0 01-1.599 0l-1.276-.742a.584.584 0 00-.13-.053l-.028-.008a.62.62 0 00-.133-.018h-.02a.587.587 0 00-.269.074l-.012.004L9.15 10a.596.596 0 00-.296.516v2.966c0 .212.112.409.296.515l2.554 1.483s.008.002.012.005c.04.022.082.04.126.052l.02.004a.57.57 0 00.123.017l.014.002h.006c.054 0 .108-.01.16-.025a.587.587 0 00.13-.054l1.277-.741a1.597 1.597 0 012.398 1.392v1.482c0 .049.007.095.019.14l.007.028a.619.619 0 00.051.125c.004.006.008.01.01.016a.6.6 0 00.076.1l.014.015c.033.032.069.06.108.084.004.002.006.006.011.008l2.554 1.483a.59.59 0 00.593 0l2.554-1.483a.597.597 0 00.296-.516v-2.965a.595.595 0 00-.296-.516l-2.554-1.483s-.008-.002-.012-.005a.54.54 0 00-.126-.051c-.007-.003-.013-.003-.02-.005a.635.635 0 00-.125-.017h-.018a.557.557 0 00-.16.026.588.588 0 00-.13.053l-1.276.742a1.595 1.595 0 01-1.598 0 1.615 1.615 0 010-2.785l-.005-.001z"
          fill="currentColor"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M14.848 18.265l-2.554-1.482-.012-.005a.526.526 0 00-.126-.052c-.007-.002-.014-.002-.02-.005a.64.64 0 00-.124-.017h-.02a.56.56 0 00-.16.026.588.588 0 00-.13.053l-1.276.742a1.594 1.594 0 01-1.598 0c-.493-.286-.8-.82-.8-1.393V14.65a.563.563 0 00-.018-.14l-.008-.028a.604.604 0 00-.051-.124l-.01-.017a.603.603 0 00-.076-.1l-.014-.015a.596.596 0 00-.109-.084c-.003-.002-.005-.006-.01-.008L5.178 12.65a.587.587 0 00-.591 0l-2.554 1.483a.596.596 0 00-.297.516v2.965c0 .213.113.41.297.516l2.554 1.483.012.004a.618.618 0 00.267.074l.016.002h.007a.55.55 0 00.16-.026.584.584 0 00.129-.053l1.277-.742a1.597 1.597 0 012.398 1.393v1.482c0 .05.007.095.019.14l.007.028c.013.044.03.085.051.125l.01.016c.022.036.047.07.076.1l.014.015c.032.032.069.06.109.084l.01.008 2.554 1.483a.587.587 0 00.593 0l2.554-1.483a.596.596 0 00.296-.515v-2.966a.596.596 0 00-.296-.516h-.002z"
          fill="currentColor"
        />
      </svg>
    );
  }

  return (
    <svg aria-label={label} className={iconClassName} viewBox="0 0 20 20" role="img">
      <path
        d="M4.25 10C4.25 6.82436 6.82436 4.25 10 4.25C13.1756 4.25 15.75 6.82436 15.75 10C15.75 13.1756 13.1756 15.75 10 15.75C6.82436 15.75 4.25 13.1756 4.25 10Z"
        fill="currentColor"
      />
      <path d="M10 1.75L11.85 5.5H8.15L10 1.75Z" fill="currentColor" />
      <path d="M10 18.25L8.15 14.5H11.85L10 18.25Z" fill="currentColor" />
    </svg>
  );
}

// Stable component identity: hoisted to module scope so it isn't recreated on
// every AgentPanel render, which would otherwise remount every visible
// message's copy button on every keystroke/streaming token.
function CopyButton({ isCopied, onCopy }: { isCopied: boolean; onCopy: () => void }) {
  const CopyIcon = useIcon("copy");
  const CheckIcon = useIcon("check");
  return (
    <button type="button" aria-label="Copy message" className={iconButtonClass} onClick={onCopy}>
      {isCopied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
    </button>
  );
}

function getToolSummary(message: MessageLike): string | null {
  const content = (message as unknown as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const toolNames = content
    .map((part) =>
      part &&
      typeof part === "object" &&
      "type" in part &&
      (part as { type?: string; name?: string }).type === "toolCall"
        ? (part as { name?: string }).name
        : null,
    )
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (!toolNames.length) return null;
  return toolNames.join(", ");
}

export function getMessageStructureKey(message: MessageLike): string {
  const content = (message as unknown as { content?: unknown }).content;
  if (!Array.isArray(content)) return stringifyMessageContent(message).length.toString();
  return content
    .map((part, index) => {
      if (!part || typeof part !== "object") return `${index}:empty`;
      const typed = part as {
        type?: string;
        id?: string;
        name?: string;
        toolCallId?: string;
        text?: string;
        thinking?: string;
      };
      return [
        index,
        typed.type ?? "unknown",
        typed.id ?? "",
        typed.toolCallId ?? "",
        typed.name ?? "",
        typed.text?.length ?? 0,
        typed.thinking?.length ?? 0,
      ].join("/");
    })
    .join("|");
}

export interface GroupedMessageEntry {
  key: string;
  role: "user" | "assistant";
  messages: MessageLike[];
  originalIndex: number;
  isStreaming: boolean;
}

export function groupConversationMessages(
  activeMessages: MessageLike[],
  streamingMessage: MessageLike | null,
): GroupedMessageEntry[] {
  const rawEntries = activeMessages
    .map((message, index) => ({
      message,
      originalIndex: index,
      isStreaming: false,
    }))
    .filter(({ message }) => message.role === "user" || message.role === "assistant");

  if (streamingMessage) {
    rawEntries.push({
      message: streamingMessage,
      originalIndex: activeMessages.length,
      isStreaming: true,
    });
  }

  const grouped: GroupedMessageEntry[] = [];
  let lastUserIndex: number | null = null;

  for (const entry of rawEntries) {
    const lastGroup = grouped[grouped.length - 1];
    const role = entry.message.role === "user" ? "user" : "assistant";
    const groupKey =
      role === "user"
        ? `user-${entry.originalIndex}`
        : lastUserIndex == null
          ? "assistant-start"
          : `assistant-after-${lastUserIndex}`;

    if (lastGroup && lastGroup.role === role) {
      lastGroup.messages.push(entry.message);
      if (entry.isStreaming) {
        lastGroup.isStreaming = true;
      }
    } else {
      grouped.push({
        key: groupKey,
        role,
        messages: [entry.message],
        originalIndex: entry.originalIndex,
        isStreaming: entry.isStreaming,
      });
    }

    if (role === "user") {
      lastUserIndex = entry.originalIndex;
    }
  }

  return grouped;
}

export function buildConversationScrollKey(
  threadId: string,
  allMessages: GroupedMessageEntry[],
  isStreaming: boolean,
): string {
  const latest = allMessages[allMessages.length - 1];
  if (!latest) return `${threadId}:empty:${isStreaming}`;

  const lastMessage = latest.messages[latest.messages.length - 1];
  return [
    threadId,
    allMessages.length,
    isStreaming ? "streaming" : "settled",
    latest.role ?? "unknown",
    stringifyMessageContent(lastMessage).length,
    latest.messages.map(getMessageStructureKey).join(","),
  ].join(":");
}

export function shouldPreserveComposerLiveEdge(
  mode: ConversationScrollMode,
  distanceAfterResize: number,
  composerGrowth: number,
): boolean {
  return (
    mode === "following" || distanceAfterResize - Math.max(0, composerGrowth) <= SCROLL_LIVE_EDGE_PX
  );
}

function MessageBody({
  messages,
  threadId = null,
  isStreaming = false,
  activeMessages = [],
  diffSummary,
  traceDeckOpen,
  onTraceDeckOpenChange,
}: {
  messages: MessageLike[];
  threadId?: string | null;
  isStreaming?: boolean;
  activeMessages?: MessageLike[];
  diffSummary?: DiffTurnSummary;
  traceDeckOpen?: boolean;
  onTraceDeckOpenChange?: (open: boolean) => void;
}) {
  const role = messages[0]?.role;
  const assistantContent = useMemo(() => {
    if (role !== "assistant") {
      return { allTraceParts: [] as any[], bodyBlocks: [] as MessageBodyBlock[] };
    }

    const allTraceParts: any[] = [];
    // Text and shown widgets, in timeline order across the turn's messages.
    const bodyParts: unknown[] = [];

    for (const msg of messages) {
      const content = (msg as unknown as { content?: unknown }).content;
      if (typeof content === "string") {
        const body = stringifyMessageContent(msg);
        if (body.trim()) bodyParts.push({ type: "text", text: body });
      } else if (Array.isArray(content)) {
        const traceParts = content.filter(
          (part) => part && (part.type === "thinking" || part.type === "toolCall"),
        );
        allTraceParts.push(...traceParts);
        for (const part of content) {
          if (part && (part.type === "text" || part.type === "toolCall")) bodyParts.push(part);
        }
      }
    }

    return {
      allTraceParts,
      bodyBlocks: buildMessageBodyBlocks(bodyParts, threadId),
    };
  }, [messages, role, threadId]);

  if (role === "assistant") {
    const { allTraceParts, bodyBlocks } = assistantContent;

    return (
      <div className="space-y-3">
        {allTraceParts.length > 0 && (
          <AssistantTraceDeck
            traceParts={allTraceParts}
            isStreaming={isStreaming}
            activeMessages={activeMessages}
            open={traceDeckOpen}
            defaultOpen={false}
            onOpenChange={onTraceDeckOpenChange}
          />
        )}

        {bodyBlocks.map((block, index) =>
          block.kind === "widget" ? (
            <InlineWidget key={block.key} widgetRef={block.ref} threadId={threadId} />
          ) : (
            <div
              key={`text-${index}`}
              data-pipper-id="assistant-markdown"
              className="prose prose-sm max-w-none prose-neutral dark:prose-invert"
            >
              <MarkdownRenderer isStreaming={isStreaming && index === bodyBlocks.length - 1}>
                {block.text}
              </MarkdownRenderer>
            </div>
          ),
        )}

        {!isStreaming && diffSummary && <DiffSummaryCard summary={diffSummary} />}
      </div>
    );
  }

  const combinedBody = messages
    .map((m) => stringifyMessageContent(m))
    .filter(Boolean)
    .join("\n\n");
  return (
    <div className="whitespace-pre-wrap break-words text-[14px] leading-6">{combinedBody}</div>
  );
}

const ANSI_PATTERN = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "g");

function cleanRuntimeStatusText(text: string | null | undefined): string | null {
  const cleaned = text?.replace(ANSI_PATTERN, "").trim();
  return cleaned ? cleaned : null;
}

function isAntigravityAuthFailure(message: string): boolean {
  return /auth(?:entication)?[\s_-]*(?:required|failed)|not authenticated|sign in to .*antigravity/i.test(
    message,
  );
}

function sendFailureToast(
  error: unknown,
  agentId: string | null | undefined,
  fallbackTitle: string,
) {
  if (
    agentId === "antigravity-acp" &&
    error instanceof Error &&
    isAntigravityAuthFailure(error.message)
  ) {
    return {
      title: "Antigravity not authenticated",
      description: "Sign in to Antigravity, then try again.",
    };
  }
  return {
    title: fallbackTitle,
    description: error instanceof Error ? error.message : "The agent did not accept the message.",
  };
}

export function getRuntimeStatusItems(snapshot: AgentPanelSnapshot | null): string[] {
  if (!snapshot) return [];

  const items: string[] = [];
  if (snapshot.authRequiredMessage) items.push(snapshot.authRequiredMessage);
  if (snapshot.switchingAgent) items.push("Switching agent…");
  if (snapshot.workingVisible) {
    const workingMessage = cleanRuntimeStatusText(snapshot.workingMessage);
    if (workingMessage) items.push(workingMessage);
  }

  for (const value of Object.values(snapshot.status)) {
    const statusText = cleanRuntimeStatusText(value);
    if (statusText) items.push(statusText);
  }

  const hiddenThinkingLabel = cleanRuntimeStatusText(snapshot.hiddenThinkingLabel);
  if (hiddenThinkingLabel && snapshot.isStreaming) items.push(`Thinking: ${hiddenThinkingLabel}`);
  const editorText = cleanRuntimeStatusText(snapshot.editorText);
  if (editorText) items.push(`Draft: ${editorText}`);
  if (snapshot.isCompacting) items.push("Compacting");
  if (snapshot.isRetrying) items.push("Retrying");

  return items.filter((item, index, all) => all.indexOf(item) === index);
}

export interface AgentPanelProps {
  /**
   * Static preview support for environments such as Remotion. The production
   * workspace never supplies this value; its composer remains fully
   * interactive and controlled by local user input.
   */
  demoInputValue?: string;
}

export function AgentPanel({ demoInputValue }: AgentPanelProps = {}) {
  "use no memo";
  const { activeProject } = useProjectStore();
  const { threads, loadProjectThreads } = useThreadStore();
  const {
    snapshot,
    error: agentError,
    isConnecting,
    authMethods,
    uiRequest,
    uiRequestQueue,
    subagentRuns,
    connect,
    refresh,
    hydrateToolCalls,
    sendPrompt,
    replacePrompt,
    abort,
    createThread,
    respondToUiRequest,
    setModel,
    setConfigOption,
  } = useAgentStore();
  const [projectsList, setProjectsList] = useState<
    Array<{ id: string; name: string; icon: string; path?: string }>
  >([]);
  const [inputValue, setInputValue] = useState(demoInputValue ?? "");
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Optimistic turn shown the instant a draft send starts, so the user sees
  // their message (text + images) and a thinking indicator while a cold agent
  // (e.g. Antigravity) is still starting up — before the thread/session exists.
  const [pendingDraftTurn, setPendingDraftTurn] = useState<{
    text: string;
    images: ChatImageAttachment[];
  } | null>(null);
  const [isAborting, setIsAborting] = useState(false);
  const [isRuntimeActionPending, setIsRuntimeActionPending] = useState(false);
  const [streamingBehavior, setStreamingBehavior] = useState<"followUp" | "steer">("followUp");
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [continuePickerOpen, setContinuePickerOpen] = useState(false);
  const [continueSelectedIndex, setContinueSelectedIndex] = useState(0);
  const [orchestrationOpen, setOrchestrationOpen] = useState(false);
  const [orchestrationSeed, setOrchestrationSeed] = useState("");
  const [editState, setEditState] = useState<{
    targetEntryId: string;
    images: ChatImageAttachment[];
  } | null>(null);
  const [previewImage, setPreviewImage] = useState<ChatImageAttachment | null>(null);
  const [dismissedAgentError, setDismissedAgentError] = useState<string | null>(null);
  const [traceDeckOpenByKey, setTraceDeckOpenByKey] = useState<Record<string, boolean>>({});
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const composerRegionRef = useRef<HTMLDivElement>(null);
  const composerResizeRafRef = useRef<number | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const anchorRafRef = useRef<number | null>(null);
  const programmaticScrollRef = useRef(false);
  const programmaticScrollClearRef = useRef<number | null>(null);
  const conversationScrollModeRef = useRef<ConversationScrollMode>("reading");
  const pendingScrollActionRef = useRef<PendingScrollAction | null>(null);
  const awaitingAssistantAfterUserRef = useRef<number | null>(null);
  const [conversationScrollMode, setConversationScrollMode] =
    useState<ConversationScrollMode>("reading");
  const [hasUnreadConversationContent, setHasUnreadConversationContent] = useState(false);
  const [isAtConversationLiveEdge, setIsAtConversationLiveEdge] = useState(false);
  const [scrollPastSpacerHeight, setScrollPastSpacerHeight] = useState(0);
  const scrollPastSpacerHeightRef = useRef(0);
  scrollPastSpacerHeightRef.current = scrollPastSpacerHeight;
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const PencilIcon = useIcon("pencil");
  const RotateCcwIcon = useIcon("rotate-ccw");

  // Remotion (and other static previews) can supply a deterministic composer
  // value without adding a separate visual clone of this component.
  useEffect(() => {
    if (demoInputValue !== undefined) setInputValue(demoInputValue);
  }, [demoInputValue]);

  // The active thread + switch machinery is owned by the header tab strip
  // (GlobalTabBar); the panel just follows it. `requestedThreadId` is the
  // optimistic switch target so the conversation can show a switching veil
  // before the agent snapshot catches up.
  const requestedThreadId = useWorkspaceViewStore((state) => state.requestedThreadId);
  const draft = useWorkspaceViewStore((state) => state.draft);
  const beginDraft = useWorkspaceViewStore((state) => state.beginDraft);
  const completeDraft = useWorkspaceViewStore((state) => state.completeDraft);
  const setDraftProject = useWorkspaceViewStore((state) => state.setDraftProject);
  const setDraftAgent = useWorkspaceViewStore((state) => state.setDraftAgent);
  const setDraftModel = useWorkspaceViewStore((state) => state.setDraftModel);
  const setDraftDirty = useWorkspaceViewStore((state) => state.setDraftDirty);
  const markDraftUserEditedProject = useWorkspaceViewStore(
    (state) => state.markDraftUserEditedProject,
  );
  const isDraftMode = draft != null;
  // Advanced workspace UI: the selected workspace already fixes the project
  // (and worktree), so the @project composer chip is redundant and hidden.
  const isAdvancedUI = useUiModeStore((state) => state.mode) === "advanced";
  const liveComposerProject = useMemo<ComposerProjectContext | null>(() => {
    if (isDraftMode || isAdvancedUI) return null;
    const projectId = snapshot?.projectId ?? activeProject?.id ?? null;
    if (!projectId) return null;
    return (
      projectsList.find((project) => project.id === projectId) ??
      (activeProject?.id === projectId ? activeProject : null)
    );
  }, [activeProject, isAdvancedUI, isDraftMode, projectsList, snapshot?.projectId]);
  const isDiffSplit = useIsDiffSplit();
  const selectedWorktreePathByProject = useWorktreeStore(
    (state) => state.selectedWorktreePathByProject,
  );
  const selectedAgentIds = useAgentRegistryStore((state) => state.selectedAgentIds);
  const selectedAgentKey = selectedAgentIds.join("\0");
  const [draftContent, setDraftContent] = useState<ComposerContent>(blankContent());
  const [liveContent, setLiveContent] = useState<ComposerContent>(blankContent());
  const draftBootstrappedRef = useRef(false);

  // When in agent view with no active thread, no requested thread, and no draft,
  // automatically bootstrap into draft mode so the composer is always ready.
  useEffect(() => {
    if (window.omni?.benchmark?.enabled) return;
    if (isDraftMode) {
      // Project hydration can finish after the initial blank draft was
      // created. Bind only untouched drafts so their project/CWD context is
      // still auto-populated without overwriting user choices.
      if (!draft?.projectId && !draft?.dirty && activeProject) {
        const worktreePath = normalizeWorkspacePath(
          selectedWorktreePathByProject[activeProject.id],
          activeProject.path,
        );
        beginDraft({
          projectId: activeProject.id,
          previousActiveProjectId: activeProject.id,
          worktreePath,
        });
      }
      return;
    }
    if (requestedThreadId || snapshot?.threadId) return;
    const project = activeProject;
    const worktreePath = project
      ? normalizeWorkspacePath(selectedWorktreePathByProject[project.id], project.path)
      : null;
    beginDraft({
      projectId: project?.id ?? null,
      previousActiveProjectId: project?.id ?? null,
      worktreePath,
    });
  }, [
    isDraftMode,
    draft?.projectId,
    draft?.dirty,
    requestedThreadId,
    snapshot?.threadId,
    activeProject,
    selectedWorktreePathByProject,
    beginDraft,
  ]);

  // Seed draft composer once when a draft session starts (soft-default project chip).
  useEffect(() => {
    if (!draft) {
      draftBootstrappedRef.current = false;
      setDraftContent(blankContent());
      return;
    }
    if (draftBootstrappedRef.current) return;
    draftBootstrappedRef.current = true;
    const projectObj =
      draft.projectId != null
        ? (projectsList.find((p) => p.id === draft.projectId) ??
          (activeProject?.id === draft.projectId ? activeProject : null))
        : null;
    const softProject =
      draft.projectId != null
        ? {
            id: draft.projectId,
            name: projectObj?.name ?? "Project",
            icon: projectObj?.icon ?? null,
          }
        : null;
    const content = initialDraftContent(isAdvancedUI ? null : softProject);
    // Soft-default agent into draft state (no @agent chip — model-first UX).
    // Prefer the currently connected agent when it is in the user's pool.
    const registry = useAgentRegistryStore.getState();
    const availableAgents = registry.agents.filter(
      (a) => isInstanceSelected(a, registry.selectedAgentIds) && a.available !== false,
    );
    const pool =
      availableAgents.length > 0
        ? availableAgents
        : registry.agents.filter((a) => a.available !== false);
    if (pool.length > 0) {
      const connectedId = useAgentStore.getState().state?.agentId ?? null;
      const preferred = (connectedId ? pool.find((a) => a.id === connectedId) : null) ?? pool[0]!;
      setDraftAgent(preferred.id);
    }
    setDraftContent(content);
    requestAnimationFrame(() => composerTextareaRef.current?.focus());
  }, [draft, projectsList, activeProject, isAdvancedUI, setDraftAgent]);

  // External chrome (title-bar project switcher) can change draft.projectId;
  // keep the composer chip in sync without wiping free text. Also clear agent
  // when the project identity changes so @agent is offered again.
  useEffect(() => {
    if (!draft || isAdvancedUI) return;
    const contentProject = extractProjectId(draftContent);
    if ((draft.projectId ?? null) === (contentProject ?? null)) return;
    if (draft.projectId) {
      const projectObj =
        projectsList.find((p) => p.id === draft.projectId) ??
        (activeProject?.id === draft.projectId ? activeProject : null);
      const name = projectObj?.name ?? "Project";
      const icon = projectObj?.icon ?? null;
      setDraftContent((prev) => {
        let next = upsertEntity(prev, {
          kind: "project",
          id: draft.projectId!,
          label: name,
          icon,
        });
        if (contentProject != null && contentProject !== draft.projectId) {
          next = removeEntityKind(removeEntityKind(next, "agent"), "model");
          // Keep a soft-default agent so send still works without an @agent chip.
          const registry = useAgentRegistryStore.getState();
          const pool = registry.agents.filter(
            (a) =>
              (registry.selectedAgentIds.length === 0 ||
                isInstanceSelected(a, registry.selectedAgentIds)) &&
              a.available !== false,
          );
          setDraftAgent(pool[0]?.id ?? null);
          setDraftModel(null);
        }
        return next;
      });
    } else {
      setDraftContent((prev) => removeEntityKind(prev, "project"));
    }
    // Only react to store project id and the UI mode — not every content
    // keystroke. Returning to Basic must re-add the chip the Advanced-mode
    // strip below removed, or the first send fails with `missing_project`.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: store → chip bridge
  }, [draft?.projectId, isAdvancedUI]);
  // Advanced UI keeps no project chip: the workspace owns the project context.
  // Strip any legacy chip that arrives (e.g. restored content) without wiping text.
  useEffect(() => {
    if (!isAdvancedUI || !draft) return;
    if (extractProjectId(draftContent) == null) return;
    setDraftContent((prev) => removeEntityKind(prev, "project"));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: one-way chip strip
  }, [isAdvancedUI, draft, draftContent]);

  // Keep draft store fields aligned with chips so chrome can bind.
  const handleDraftContentChange = (next: ComposerContent) => {
    const prevProject = extractProjectId(draftContent);
    const nextProject = extractProjectId(next);
    let content = next;
    // Switching project invalidates a prior model pick; agent is inferred from
    // the model (or the soft default in draft.agentId), not a user chip step.
    if (nextProject !== prevProject && prevProject != null) {
      content = removeEntityKind(removeEntityKind(content, "agent"), "model");
    }
    setDraftContent(content);
    setDraftProject(nextProject);
    // Prefer explicit agent chip / model.owner; keep soft default when neither
    // is present so multi-agent drafts still create without an @agent step.
    const inferredAgent = resolveAgentId(content);
    if (inferredAgent) setDraftAgent(inferredAgent);
    setDraftModel(extractModelId(content));
    if (nextProject !== prevProject) {
      markDraftUserEditedProject();
      // A draft project chip is only a creation target. Activating the project
      // in main would restore its last thread while this draft is still open.
      if (!isDraftMode && nextProject && window.omni?.projects?.setActive) {
        void window.omni.projects.setActive(nextProject).catch(() => {
          /* soft-sync is best-effort */
        });
      }
    }
    // Once the user types or changes chips, stay dirty until send/discard.
    // Never flip dirty back to false mid-edit (would skip discard confirm).
    const becameDirty =
      Boolean(extractTextContent(content)) ||
      nextProject !== (draft?.projectId ?? null) ||
      (inferredAgent != null && inferredAgent !== (draft?.agentId ?? null)) ||
      extractModelId(content) !== (draft?.modelId ?? null);
    if (becameDirty || draft?.dirty) setDraftDirty(true);
  };

  const commands = useMemo(
    () => mergeAgentCommands(snapshot?.commands ?? []),
    [snapshot?.commands],
  );
  const registryAgents = useAgentRegistryStore((state) => state.agents);
  // Agents offered by `/continue` — only ones the user can actually connect to,
  // bounded to what the picker renders so display and keyboard selection share
  // one collection (no selecting an off-list, invisible agent).
  const continuableAgents = useMemo(
    () => registryAgents.filter((agent) => agent.available !== false).slice(0, MAX_CONTINUE_AGENTS),
    [registryAgents],
  );
  // Carry-over transcript staged for the currently-viewed thread, if any.
  const pendingContinuation = useContinuationStore((state) =>
    snapshot?.threadId ? (state.pendingByThreadId[snapshot.threadId] ?? null) : null,
  );
  const models = snapshot?.models ?? [];

  // ── Thinking level options ────────────────────────────────────────────
  const thoughtLevelOpts = useMemo(() => {
    const opts = snapshot?.configOptions ?? [];
    return (
      opts.find((o: any) => o.category === "thought_level") ??
      opts.find((o: any) => o.id === "thought_level") ??
      opts.find((o: any) => o.id?.includes?.("thought_level"))
    );
  }, [snapshot?.configOptions]);

  const thoughtLevelValues = useMemo(() => {
    if (!thoughtLevelOpts || (thoughtLevelOpts as any).type !== "select") return [];
    const raw = (thoughtLevelOpts as any).options;
    if (!Array.isArray(raw)) return [];
    const out: Array<{ value: string; name: string }> = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      if ("value" in item && "name" in item) {
        out.push({ value: String((item as any).value), name: String((item as any).name) });
      } else if ("options" in item && Array.isArray((item as any).options)) {
        for (const nested of (item as any).options) {
          if (nested && typeof nested === "object" && "value" in nested) {
            out.push({ value: String(nested.value), name: String(nested.name ?? nested.value) });
          }
        }
      }
    }
    return out;
  }, [thoughtLevelOpts]);

  const thoughtLevelConfigId = useMemo(() => {
    if (!thoughtLevelOpts) return null;
    return (thoughtLevelOpts as any).id ?? null;
  }, [thoughtLevelOpts]);

  const currentThoughtIndex = useMemo(() => {
    if (!thoughtLevelValues.length || !snapshot?.thinkingLevel) return 0;
    const idx = thoughtLevelValues.findIndex((v) => v.value === snapshot.thinkingLevel);
    return idx >= 0 ? idx : 0;
  }, [thoughtLevelValues, snapshot?.thinkingLevel]);

  const formatMessageTime = (message: MessageLike): string | undefined => {
    const meta = message as { timestamp?: number; created_at?: string };
    const timeVal = meta.timestamp ?? (meta.created_at ? Date.parse(meta.created_at) : null);
    if (!timeVal) return undefined;
    const date = new Date(timeVal);
    if (isNaN(date.getTime())) return undefined;
    return messageTimeFormatter.format(date);
  };

  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleCopy = async (msgId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageId(msgId);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        setCopiedMessageId((prev) => (prev === msgId ? null : prev));
        copyTimerRef.current = null;
      }, 2000);
    } catch (err) {
      toast({
        icon: <WarningIcon className="size-5 text-red-500" />,
        title: "Copy failed",
        description: err instanceof Error ? err.message : "Clipboard access was denied.",
      });
    }
  };

  const handleRegenerate = async (currentIndex: number) => {
    try {
      for (let i = currentIndex - 1; i >= 0; i--) {
        const msg = activeMessages[i] as MessageLike;
        if (msg.role === "user") {
          const promptText = stringifyMessageContent(msg);
          const entryId = snapshot?.messageEntryRefs[i]?.entryId;
          const images = extractGroupedMessageImages([msg]).map(({ type, data, mimeType }) => ({
            type,
            data,
            mimeType,
          }));
          if (hasPendingImages(images)) {
            toast({
              icon: <WarningIcon className="size-5 text-red-500" />,
              title: "Images are still loading",
              description: "Try again once the message's images have loaded.",
            });
            break;
          }
          if (entryId && snapshot?.threadId)
            await replacePrompt({
              threadId: snapshot.threadId,
              targetUserEntryId: entryId,
              message: promptText,
              images,
            });
          break;
        }
      }
    } catch (err) {
      toast({
        icon: <WarningIcon className="size-5 text-red-500" />,
        title: "Regenerate failed",
        description: err instanceof Error ? err.message : "The agent did not accept the request.",
      });
    }
  };

  useEffect(() => {
    void connect();
  }, [connect]);

  useEffect(() => {
    async function loadProjects() {
      const list = await window.omni.projects.list();
      setProjectsList(list);
    }
    void loadProjects();
  }, []);

  useEffect(() => {
    if (activeProject?.id) {
      void refresh();
    }
  }, [activeProject?.id, refresh]);

  useEffect(() => {
    if (!uiRequest?.timeoutMs) return;
    const timeout = window.setTimeout(() => {
      void respondToUiRequest({
        requestId: uiRequest.id,
        value: uiRequest.kind === "confirm" ? false : undefined,
      });
    }, uiRequest.timeoutMs + 250);
    return () => window.clearTimeout(timeout);
  }, [respondToUiRequest, uiRequest]);

  const snapshotThreadId = snapshot?.threadId ?? "";
  // Conversation data remains authoritative for snapshotThreadId until the
  // target session publishes its complete session-state. Using the optimistic
  // target here makes scroll/virtualization state claim to belong to a thread
  // whose messages are not authoritative yet.
  const threadId = snapshotThreadId;
  const isSwitchingThread = Boolean(requestedThreadId && requestedThreadId !== snapshotThreadId);
  // Match by the agent session id the request carries against the session the
  // user is currently viewing — this is the identity the agent itself used, so
  // it's reliable even when the main process couldn't resolve the request's
  // threadId. A question for the viewed session morphs the composer in place
  // (see the InputMessage/AgentQuestionCard swap below); everything else is
  // handled by AgentQuestionDock. Only the head for this session shows — the
  // rest wait their turn.
  const activeSessionId = snapshot?.agentSessionId ?? null;
  const inlineRequest =
    uiRequestQueue.find((r) => activeSessionId != null && r.sessionId === activeSessionId) ?? null;
  const activeMessages = snapshot?.messages ?? [];
  const diffSummaries = useDiffStore((state) => state.summaries);
  const isStreaming = snapshot?.isStreaming ?? false;
  const streamingMessage = isStreaming ? (snapshot?.streamingMessage ?? null) : null;
  // Slash detection reads whichever composer is active: draft free text while
  // creating a thread, the live input otherwise (inputValue mirrors liveContent).
  const composerFreeText = isDraftMode ? getFreeText(draftContent) : inputValue;
  const slashMatches = useMemo(() => {
    const trimmed = composerFreeText.trimStart();
    if (!trimmed.startsWith("/")) return [];
    const query = trimmed.slice(1).split(/\s+/, 1)[0].toLowerCase();
    return matchAgentCommands(commands, query);
  }, [commands, composerFreeText]);

  const allMessages = useMemo(
    () =>
      groupConversationMessages(
        activeMessages as MessageLike[],
        streamingMessage as MessageLike | null,
      ),
    [activeMessages, streamingMessage],
  );

  const conversationVirtualizer = useVirtualizer({
    count: allMessages.length,
    getScrollElement: () => messagesScrollRef.current,
    estimateSize: (index) => (allMessages[index]?.role === "user" ? 96 : 180),
    getItemKey: (index) => allMessages[index]?.key ?? index,
    overscan: 6,
    // When the reader is away from the live edge, compensate for measured
    // height changes above the viewport so images/markdown do not steal their
    // place. While following, the bottom-follow loop owns the position.
    shouldAdjustScrollPositionOnItemSizeChange: () =>
      conversationScrollModeRef.current !== "following",
  });

  useEffect(() => {
    if (
      !window.omni?.benchmark?.enabled ||
      !threadId ||
      isSwitchingThread ||
      allMessages.length === 0
    ) {
      return;
    }

    let paintFrame = 0;
    let settledFrame = 0;
    paintFrame = requestAnimationFrame(() => {
      settledFrame = requestAnimationFrame(() => {
        const visibleRows =
          messagesScrollRef.current?.querySelectorAll(
            '[data-pipper-id="messages-list"] [data-index]',
          ).length ?? 0;
        if (visibleRows === 0) return;
        window.omni.benchmark.reportRendererReady({
          threadId,
          totalRows: allMessages.length,
          visibleRows,
          renderedAt: Date.now(),
        });
      });
    });

    return () => {
      cancelAnimationFrame(paintFrame);
      cancelAnimationFrame(settledFrame);
    };
  }, [allMessages.length, isSwitchingThread, threadId]);

  const latestConversationScrollKey = useMemo(
    () => buildConversationScrollKey(threadId, allMessages, isStreaming),
    [allMessages, isStreaming, threadId],
  );

  const cancelConversationScrollAnimation = () => {
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
  };

  const cancelConversationAnchor = () => {
    if (anchorRafRef.current !== null) {
      cancelAnimationFrame(anchorRafRef.current);
      anchorRafRef.current = null;
    }
  };

  const updateConversationScrollMode = (mode: ConversationScrollMode) => {
    conversationScrollModeRef.current = mode;
    setConversationScrollMode((current) => (current === mode ? current : mode));
  };

  const markProgrammaticScroll = () => {
    programmaticScrollRef.current = true;
    if (programmaticScrollClearRef.current !== null) {
      window.clearTimeout(programmaticScrollClearRef.current);
    }
    programmaticScrollClearRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticScrollClearRef.current = null;
    }, 120);
  };

  useEffect(() => {
    const composer = composerRegionRef.current;
    const scrollContainer = messagesScrollRef.current;
    if (!composer || !scrollContainer) return;

    const updateSpacer = () => {
      if (isDraftMode || allMessages.length === 0) {
        if (scrollPastSpacerHeightRef.current !== 0) {
          scrollPastSpacerHeightRef.current = 0;
          setScrollPastSpacerHeight(0);
        }
        return;
      }
      const containerHeight = scrollContainer.clientHeight;
      const composerHeight = composer.offsetHeight;
      const targetTopOffset = 16;
      const nextSpacer = Math.max(0, containerHeight - composerHeight - targetTopOffset);
      if (Math.abs(scrollPastSpacerHeightRef.current - nextSpacer) > 1) {
        scrollPastSpacerHeightRef.current = nextSpacer;
        setScrollPastSpacerHeight(nextSpacer);
      }
    };

    updateSpacer();
  }, [allMessages.length, isDraftMode]);

  useEffect(() => {
    const composer = composerRegionRef.current;
    const scrollContainer = messagesScrollRef.current;
    if (!composer || !scrollContainer || typeof ResizeObserver === "undefined") return;

    let previousHeight = composer.getBoundingClientRect().height;
    let shouldKeepLiveEdge = false;
    const resizeObserver = new ResizeObserver(() => {
      if (!isDraftMode && allMessages.length > 0) {
        const containerHeight = scrollContainer.clientHeight;
        const composerHeight = composer.offsetHeight;
        const targetTopOffset = 16;
        const nextSpacer = Math.max(0, containerHeight - composerHeight - targetTopOffset);
        if (Math.abs(scrollPastSpacerHeightRef.current - nextSpacer) > 1) {
          scrollPastSpacerHeightRef.current = nextSpacer;
          setScrollPastSpacerHeight(nextSpacer);
        }
      }

      const nextHeight = composer.getBoundingClientRect().height;
      const growth = Math.max(0, nextHeight - previousHeight);
      previousHeight = nextHeight;

      const naturalBottom = Math.max(
        0,
        scrollContainer.scrollHeight -
          scrollPastSpacerHeightRef.current -
          scrollContainer.clientHeight,
      );
      const distanceAfterResize = Math.max(0, naturalBottom - scrollContainer.scrollTop);
      shouldKeepLiveEdge ||= shouldPreserveComposerLiveEdge(
        conversationScrollModeRef.current,
        distanceAfterResize,
        growth,
      );

      if (composerResizeRafRef.current !== null) return;
      composerResizeRafRef.current = requestAnimationFrame(() => {
        if (shouldKeepLiveEdge) {
          markProgrammaticScroll();
          const targetBottom = Math.max(
            0,
            scrollContainer.scrollHeight -
              scrollPastSpacerHeightRef.current -
              scrollContainer.clientHeight,
          );
          scrollContainer.scrollTop = targetBottom;
          setIsAtConversationLiveEdge(true);
          setHasUnreadConversationContent(false);
        }
        shouldKeepLiveEdge = false;
        composerResizeRafRef.current = null;
      });
    });

    resizeObserver.observe(composer);
    resizeObserver.observe(scrollContainer);
    return () => {
      resizeObserver.disconnect();
      if (composerResizeRafRef.current !== null) {
        cancelAnimationFrame(composerResizeRafRef.current);
        composerResizeRafRef.current = null;
      }
    };
  }, [allMessages.length, isDraftMode]);

  const stopConversationFollowing = () => {
    programmaticScrollRef.current = false;
    pendingScrollActionRef.current = null;
    awaitingAssistantAfterUserRef.current = null;
    cancelConversationScrollAnimation();
    cancelConversationAnchor();
    updateConversationScrollMode("reading");
    setHasUnreadConversationContent(true);
  };

  useEffect(() => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;

    const getDistanceFromBottom = () => {
      const naturalBottom = Math.max(
        0,
        scrollContainer.scrollHeight -
          scrollPastSpacerHeightRef.current -
          scrollContainer.clientHeight,
      );
      return naturalBottom - scrollContainer.scrollTop;
    };

    const updateScrollModeFromPosition = () => {
      const distanceFromBottom = getDistanceFromBottom();
      const atLiveEdge = Math.abs(distanceFromBottom) <= SCROLL_LIVE_EDGE_PX;
      setIsAtConversationLiveEdge(atLiveEdge);
      if (atLiveEdge) {
        updateConversationScrollMode("following");
        setHasUnreadConversationContent(false);
      } else {
        updateConversationScrollMode("reading");
        if (distanceFromBottom > SCROLL_LIVE_EDGE_PX) {
          setHasUnreadConversationContent(true);
        }
      }
    };

    const onScroll = () => {
      beginRendererInteraction("scroll");
      if (programmaticScrollRef.current) {
        programmaticScrollRef.current = false;
        return;
      }
      updateScrollModeFromPosition();
    };

    const stopOnReaderIntent = () => {
      stopConversationFollowing();
    };

    // A reader can express intent without changing scrollTop: selecting text,
    // dragging a link, using keyboard navigation, opening browser find, or
    // touching the transcript should all stop the live-follow loop.
    const intentEvents: Array<keyof HTMLElementEventMap> = [
      "wheel",
      "touchstart",
      "pointerdown",
      "selectstart",
    ];
    for (const eventName of intentEvents) {
      scrollContainer.addEventListener(eventName, stopOnReaderIntent, { passive: true });
    }
    document.addEventListener("keydown", stopOnReaderIntent, true);

    const distanceFromBottom = getDistanceFromBottom();
    if (distanceFromBottom <= SCROLL_LIVE_EDGE_PX) {
      // This is only a position observation. Thread restoration deliberately
      // keeps the mode in `reading` until the reader explicitly returns to the
      // live edge or presses Jump to latest.
      if (conversationScrollModeRef.current === "following") {
        setHasUnreadConversationContent(false);
      }
    }

    scrollContainer.addEventListener("scroll", onScroll, {
      passive: true,
    });
    return () => {
      scrollContainer.removeEventListener("scroll", onScroll);
      for (const eventName of intentEvents) {
        scrollContainer.removeEventListener(eventName, stopOnReaderIntent);
      }
      document.removeEventListener("keydown", stopOnReaderIntent, true);
    };
  }, [threadId]);

  useEffect(() => {
    setTraceDeckOpenByKey({});
  }, [threadId, requestedThreadId]);

  useEffect(() => {
    if (!threadId) return;

    const pending = pendingScrollActionRef.current;
    if (!pending || (pending.threadId !== null && pending.threadId !== threadId)) {
      pendingScrollActionRef.current = { kind: "restore", threadId };
    }
    cancelConversationScrollAnimation();
    cancelConversationAnchor();
    awaitingAssistantAfterUserRef.current = null;
    updateConversationScrollMode("reading");
    setHasUnreadConversationContent(false);
    setIsAtConversationLiveEdge(false);
  }, [threadId]);

  useEffect(() => {
    const pending = pendingScrollActionRef.current;
    if (!pending || !threadId || (pending.threadId !== null && pending.threadId !== threadId)) {
      return;
    }

    const targetIndex =
      pending.kind === "new-turn"
        ? allMessages.findLastIndex((entry) => entry.role === "user")
        : allMessages.findLastIndex((entry) => entry.role === "user") >= 0
          ? allMessages.findLastIndex((entry) => entry.role === "user")
          : allMessages.length - 1;
    if (targetIndex < 0) return;

    pendingScrollActionRef.current = null;
    awaitingAssistantAfterUserRef.current = pending.kind === "new-turn" ? targetIndex : null;
    cancelConversationAnchor();
    markProgrammaticScroll();
    conversationVirtualizer.scrollToIndex(targetIndex, { align: "start", behavior: "auto" });
    anchorRafRef.current = requestAnimationFrame(() => {
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer) {
        anchorRafRef.current = null;
        return;
      }

      const target = scrollContainer.querySelector<HTMLElement>(`[data-index="${targetIndex}"]`);
      if (target) {
        const containerRect = scrollContainer.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const targetTop =
          scrollContainer.scrollTop + targetRect.top - containerRect.top - SCROLL_ANCHOR_TOP_PX;
        markProgrammaticScroll();
        scrollContainer.scrollTop = Math.max(0, targetTop);
      }

      updateConversationScrollMode(pending.kind === "new-turn" ? "anchoring" : "reading");
      setHasUnreadConversationContent(false);
      setIsAtConversationLiveEdge(false);
      anchorRafRef.current = null;
    });
  }, [allMessages, conversationVirtualizer, threadId]);

  useEffect(() => {
    const scrollContainer = messagesScrollRef.current;
    const awaitingAssistantIndex = awaitingAssistantAfterUserRef.current;
    const hasAnswerStarted =
      awaitingAssistantIndex !== null &&
      allMessages.slice(awaitingAssistantIndex + 1).some((entry) => entry.role === "assistant");
    if (conversationScrollMode === "anchoring") {
      if (!hasAnswerStarted) return;
      awaitingAssistantAfterUserRef.current = null;
      updateConversationScrollMode("following");
      return;
    }
    if (!scrollContainer || conversationScrollMode !== "following") return;

    if (!isStreaming) {
      cancelConversationScrollAnimation();
      scrollRafRef.current = requestAnimationFrame(() => {
        const el = messagesScrollRef.current;
        if (el && conversationScrollModeRef.current === "following") {
          markProgrammaticScroll();
          el.scrollTop = Math.max(
            0,
            el.scrollHeight - scrollPastSpacerHeightRef.current - el.clientHeight,
          );
          setHasUnreadConversationContent(false);
        }
        scrollRafRef.current = null;
      });
      return;
    }

    if (scrollRafRef.current !== null) return;

    const tick = () => {
      const el = messagesScrollRef.current;
      if (!el || conversationScrollModeRef.current !== "following") {
        scrollRafRef.current = null;
        return;
      }

      const dest = Math.max(
        0,
        el.scrollHeight - scrollPastSpacerHeightRef.current - el.clientHeight,
      );
      const delta = dest - el.scrollTop;
      if (Math.abs(delta) <= 0.5) {
        markProgrammaticScroll();
        el.scrollTop = dest;
        setHasUnreadConversationContent(false);
        scrollRafRef.current = null;
        return;
      }

      markProgrammaticScroll();
      el.scrollTop += delta * 0.2;
      scrollRafRef.current = requestAnimationFrame(tick);
    };

    scrollRafRef.current = requestAnimationFrame(tick);
  }, [
    conversationScrollMode,
    latestConversationScrollKey,
    isStreaming,
    allMessages,
    allMessages.length,
  ]);

  useEffect(() => {
    const refreshLiveEdge = requestAnimationFrame(() => {
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer) return;
      const naturalBottom = Math.max(
        0,
        scrollContainer.scrollHeight -
          scrollPastSpacerHeightRef.current -
          scrollContainer.clientHeight,
      );
      const distanceFromBottom = naturalBottom - scrollContainer.scrollTop;
      setIsAtConversationLiveEdge(Math.abs(distanceFromBottom) <= SCROLL_LIVE_EDGE_PX);
    });
    return () => cancelAnimationFrame(refreshLiveEdge);
  }, [latestConversationScrollKey, allMessages.length, threadId]);

  useEffect(() => {
    return () => {
      cancelConversationScrollAnimation();
      cancelConversationAnchor();
      if (programmaticScrollClearRef.current !== null) {
        window.clearTimeout(programmaticScrollClearRef.current);
        programmaticScrollClearRef.current = null;
      }
    };
  }, [threadId]);

  const prepareNewTurnScroll = (targetThreadId: string | null) => {
    pendingScrollActionRef.current = { kind: "new-turn", threadId: targetThreadId };
    awaitingAssistantAfterUserRef.current = null;
    cancelConversationScrollAnimation();
    cancelConversationAnchor();
    updateConversationScrollMode("reading");
    setHasUnreadConversationContent(false);
  };

  const openOrchestration = (seed: string) => {
    setOrchestrationSeed(seed);
    setOrchestrationOpen(true);
    setInputValue("");
    setSelectedCommandIndex(0);
  };

  const handleLiveComposerSend = async (content: ComposerContent, sendFiles: File[]) => {
    const modelToken = extractModelToken(content);
    const textOnly = stripEntityKinds(content, ["model"]);
    const trimmed = extractTextContent(textOnly);
    if (modelToken) {
      setIsRuntimeActionPending(true);
      try {
        const success = await setModel({ modelId: modelToken.id });
        if (success) {
          toast({
            title: "Model switched",
            description: modelToken.label,
          });
        } else {
          toast({
            icon: <WarningIcon className="size-5 text-red-500" />,
            title: "Model change failed",
            description: "The selected model was not applied.",
          });
        }
      } catch (err) {
        toast({
          icon: <WarningIcon className="size-5 text-red-500" />,
          title: "Model change failed",
          description: err instanceof Error ? err.message : "The selected model was not applied.",
        });
      } finally {
        setIsRuntimeActionPending(false);
      }
      setLiveContent(textOnly);
      setInputValue(getFreeText(textOnly));
      if (!trimmed && !sendFiles.length && !editState?.images.length) return;
    }
    await handleSend(trimmed || getFreeText(textOnly), sendFiles);
    setLiveContent(
      liveComposerProject ? withProjectChip(blankContent(), liveComposerProject) : blankContent(),
    );
    setInputValue("");
  };

  const handleLiveContentChange = (next: ComposerContent) => {
    const content = liveComposerProject ? withProjectChip(next, liveComposerProject) : next;
    setLiveContent(content);
    setInputValue(getFreeText(content));
  };

  const handleDraftSend = async (content: ComposerContent, files: File[]) => {
    const check = assertCreatable(content, {
      defaultAgentId: draft?.agentId ?? null,
      // Advanced UI: no project chip — the workspace owns the project context.
      defaultProjectId: isAdvancedUI ? (draft?.projectId ?? activeProject?.id ?? null) : null,
    });
    if (!check.ok) {
      const description =
        check.reason === "missing_project"
          ? "Add a @project chip before sending."
          : check.reason === "missing_agent"
            ? "Pick a @model (or enable an agent in settings) before sending."
            : "Write a message to start the thread.";
      toast({
        icon: <WarningIcon className="size-5 text-amber-500" />,
        title: "Cannot create thread",
        description,
      });
      return;
    }
    if (isSubmitting) return;
    setIsSubmitting(true);
    // Turn the question into a bubble immediately, before the (possibly slow)
    // agent startup/handshake, so the user always sees their message land.
    const previousDraftContent = draftContent;
    setPendingDraftTurn({ text: check.text, images: [] });
    setDraftContent(blankContent());
    setAttachedFiles([]);
    try {
      // Read attachments up front so the optimistic bubble can show them and
      // the same blocks feed the prompt (no double read).
      const newImages = await Promise.all(files.map(fileToPromptImage));
      if (newImages.length) {
        setPendingDraftTurn((current) =>
          current
            ? {
                ...current,
                images: newImages.map((image, index) => ({
                  ...image,
                  id: `pending-image-${index}`,
                  name: files[index]?.name,
                })),
              }
            : current,
        );
      }
      const projectPath =
        projectsList.find((p) => p.id === check.projectId)?.path ??
        (activeProject?.id === check.projectId ? activeProject.path : null) ??
        null;
      const worktreePath = normalizeWorkspacePath(
        draft?.worktreePath ?? selectedWorktreePathByProject[check.projectId] ?? null,
        projectPath,
      );
      const title = titleFromText(check.text);
      const thread = await createThread(
        check.projectId,
        title,
        null,
        check.agentId,
        worktreePath,
        check.modelId,
      );
      await loadProjectThreads(check.projectId, { reset: true });
      await selectThread(thread.id);
      completeDraft(thread.id);
      setDraftContent(blankContent());

      if (newImages.length > MAX_AGENT_IMAGES) {
        toast({
          icon: <WarningIcon className="size-5 text-red-500" />,
          title: "Attachment rejected",
          description: `A prompt can contain at most ${MAX_AGENT_IMAGES} images.`,
        });
        return;
      }
      prepareNewTurnScroll(thread.id);
      sendPrompt({
        threadId: thread.id,
        message: check.text,
        images: newImages.length ? newImages : undefined,
      }).catch((err) => {
        const failure = sendFailureToast(err, check.agentId, "Send failed");
        toast({
          icon: <WarningIcon className="size-5 text-red-500" />,
          ...failure,
        });
      });
      setAttachedFiles([]);
    } catch (err) {
      // Thread creation failed before the turn was sent: drop the speculative
      // bubble and put the draft text + attachments back so nothing is lost.
      setPendingDraftTurn(null);
      setDraftContent(previousDraftContent);
      setAttachedFiles(files);
      const failure = sendFailureToast(err, check.agentId, "Create thread failed");
      toast({
        icon: <WarningIcon className="size-5 text-red-500" />,
        ...failure,
      });
    } finally {
      setIsSubmitting(false);
      // The real optimistic user turn (from sendPrompt) now owns the view;
      // retire the speculative bubble in the same render.
      setPendingDraftTurn(null);
    }
  };

  const handleSend = async (text: string, files: File[]) => {
    const trimmed = text.trim();
    if (!trimmed && !files.length && !editState?.images.length) return;
    // Client-side command: morph the composer instead of prompting the agent.
    // Any remainder text seeds the orchestration goal.
    if (isSubagentTrigger(trimmed)) {
      openOrchestration(trimmed.replace(/^\/\S+\s*/, ""));
      return;
    }
    const [token, ...args] = trimmed.split(/\s+/);
    if (token === "/abort" && args.length === 0) {
      setIsSubmitting(true);
      try {
        await abort();
        setInputValue("");
      } catch (err) {
        toast({
          icon: <WarningIcon className="size-5 text-red-500" />,
          title: "Abort failed",
          description: err instanceof Error ? err.message : "The agent did not stop.",
        });
      } finally {
        setIsSubmitting(false);
      }
      return;
    }
    // Hardcoded /compact removed — agents advertise commands via available_commands_update.
    const operationThreadId = snapshot?.threadId;
    setIsSubmitting(true);
    try {
      const newImages = await Promise.all(files.map(fileToPromptImage));
      const retained = (editState?.images ?? []).map(({ type, data, mimeType }) => ({
        type,
        data,
        mimeType,
      }));
      const images = [...retained, ...newImages];
      if (hasPendingImages(images)) {
        toast({
          icon: <WarningIcon className="size-5 text-red-500" />,
          title: "Images are still loading",
          description: "Try again once the message's images have loaded.",
        });
        return;
      }
      if (images.length > MAX_AGENT_IMAGES) {
        toast({
          icon: <WarningIcon className="size-5 text-red-500" />,
          title: "Attachment rejected",
          description: `A prompt can contain at most ${MAX_AGENT_IMAGES} images.`,
        });
        return;
      }
      if (!editState) {
        prepareNewTurnScroll(operationThreadId ?? threadId);
      }
      // A `/continue` thread carries an unsent transcript: send it as its own
      // content block alongside the user's message so the agent gets the prior
      // context, while `message` (the optimistic bubble) stays just the user's
      // own text — the transcript never renders as a giant user bubble.
      const pendingTranscript = operationThreadId
        ? useContinuationStore.getState().getPending(operationThreadId)
        : null;
      // The underlying ACP call only resolves once the agent finishes its
      // entire turn, so we deliberately don't await it here — awaiting would
      // hold composerDisabled (and this stale draft text) for the whole turn.
      // The optimistic user message + isStreaming are already applied
      // synchronously by the store before any IPC round-trip, so it's safe to
      // clear the composer now and just report failures asynchronously.
      const sendOp =
        editState && operationThreadId
          ? replacePrompt({
              threadId: operationThreadId,
              targetUserEntryId: editState.targetEntryId,
              message: trimmed,
              images,
            })
          : pendingTranscript
            ? sendPrompt({
                threadId: operationThreadId,
                message: trimmed,
                // Lead with the transcript as its own context block, then reuse
                // the shared block builder for the user's message + images so the
                // target agent's image capability is honored. Building the image
                // blocks by hand here would bypass that filter (a supplied
                // `prompt` short-circuits assemblePromptBlocks in the main path).
                prompt: [
                  { type: "text", text: buildContinuationText(pendingTranscript) },
                  ...assemblePromptBlocks({
                    message: trimmed,
                    images: newImages,
                    allowImage: canAttachImage(),
                  }),
                ] as ContentBlock[],
                // Keep the optimistic user bubble in sync with the prompt
                // even though the transcript is sent as a prebuilt prompt.
                images: newImages.length ? newImages : undefined,
                streamingBehavior: isStreaming ? streamingBehavior : undefined,
              })
            : sendPrompt({
                threadId: operationThreadId,
                message: trimmed,
                images: newImages.length ? newImages : undefined,
                streamingBehavior: isStreaming ? streamingBehavior : undefined,
              });
      sendOp.catch((err) => {
        const failure = sendFailureToast(
          err,
          snapshot?.agentId,
          editState ? "Edit failed" : "Send failed",
        );
        toast({
          icon: <WarningIcon className="size-5 text-red-500" />,
          ...failure,
        });
      });
      if (useAgentStore.getState().state?.threadId === operationThreadId) {
        setInputValue("");
        setAttachedFiles([]);
        setEditState(null);
        // Chip is consumed on send. Optimistic clear: the message is already
        // in flight, and a failed first send is recoverable by re-running
        // `/continue` from the source thread.
        if (pendingTranscript && operationThreadId) {
          useContinuationStore.getState().clearPending(operationThreadId);
        }
      }
      setStreamingBehavior("followUp");
    } catch (err) {
      const failure = sendFailureToast(
        err,
        snapshot?.agentId,
        editState ? "Edit failed" : "Send failed",
      );
      toast({
        icon: <WarningIcon className="size-5 text-red-500" />,
        ...failure,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFilesChange = (files: File[]) => {
    const { valid, errors } = partitionValidImageFiles(files, editState?.images.length ?? 0);
    setAttachedFiles(valid);
    if (errors.length)
      toast({
        icon: <WarningIcon className="size-5 text-red-500" />,
        title: "Attachment rejected",
        description: errors.join(" "),
      });
  };

  const handleFilesRejected = (files: File[], reason: "type" | "limit") => {
    const description =
      reason === "type"
        ? `${files.length} file${files.length === 1 ? "" : "s"} did not match the supported image types.`
        : `A prompt can contain at most ${MAX_AGENT_IMAGES} images.`;
    toast({
      icon: <WarningIcon className="size-5 text-red-500" />,
      title: "Attachment rejected",
      description,
    });
  };

  const handleAbort = async () => {
    if (isAborting) return;
    setIsAborting(true);
    try {
      await abort();
    } catch (err) {
      toast({
        icon: <WarningIcon className="size-5 text-red-500" />,
        title: "Stop failed",
        description: err instanceof Error ? err.message : "The agent did not stop.",
      });
    } finally {
      setIsAborting(false);
    }
  };

  const applyCommand = (commandName: string) => {
    // Route composer-text writes through the active stage so a command picked
    // from the draft menu lands in draftContent, not just the live input.
    const setComposerText = (text: string) => {
      if (isDraftMode) handleDraftContentChange(setFreeText(draftContent, text));
      else setInputValue(text);
    };
    if (commandName === SUBAGENT_COMMAND) {
      openOrchestration("");
      return;
    }
    if (commandName === CONTINUE_COMMAND) {
      if (!hasConversation(activeMessages as TranscriptSourceMessage[])) {
        toast({
          icon: <WarningIcon className="size-5 text-red-500" />,
          title: "Nothing to continue",
          description: "This conversation has no messages to carry over yet.",
        });
        setComposerText("");
        return;
      }
      if (continuableAgents.length === 0) {
        toast({
          icon: <WarningIcon className="size-5 text-red-500" />,
          title: "No agents available",
          description: "Install or sign in to another agent to continue this conversation.",
        });
        setComposerText("");
        return;
      }
      setComposerText("");
      setSelectedCommandIndex(0);
      setContinueSelectedIndex(0);
      setContinuePickerOpen(true);
      return;
    }
    setComposerText(`/${commandName} `);
    setSelectedCommandIndex(0);
  };

  // `/continue` picks a target agent, snapshots this thread's user/assistant
  // transcript, and opens a fresh thread on that agent seeded with the
  // transcript (staged as a composer chip until the user sends).
  const handleContinueWithAgent = async (agentId: string) => {
    setContinuePickerOpen(false);
    const turns = extractConversation(activeMessages as TranscriptSourceMessage[]);
    if (turns.length === 0) {
      toast({
        icon: <WarningIcon className="size-5 text-red-500" />,
        title: "Nothing to continue",
        description: "This conversation has no messages to carry over yet.",
      });
      return;
    }
    const projectId = activeProject?.id ?? snapshot?.projectId ?? null;
    if (!projectId) {
      toast({
        icon: <WarningIcon className="size-5 text-red-500" />,
        title: "No project",
        description: "Open a project before continuing a conversation.",
      });
      return;
    }
    setIsSubmitting(true);
    try {
      // The new thread binds to the workspace the user is looking at, like any
      // other new thread.
      const worktreePath = normalizeWorkspacePath(
        useWorktreeStore.getState().selectedWorktreePathByProject[projectId],
        activeProject?.path ?? null,
      );
      const thread = await createThread(
        projectId,
        `Continued: ${snapshot?.title ?? "conversation"}`,
        snapshot?.threadId ?? null,
        agentId,
        worktreePath,
      );
      // Stage the transcript before selecting the thread so the chip is present
      // the moment its composer renders. Bounded to a token budget so a long
      // source thread can't blow the new thread's context on the first send.
      useContinuationStore.getState().setPending(thread.id, budgetTranscript(turns).text);
      await loadProjectThreads(projectId, { reset: true });
      await selectThread(thread.id);
    } catch (err) {
      toast({
        icon: <WarningIcon className="size-5 text-red-500" />,
        title: "Continue failed",
        description: err instanceof Error ? err.message : "Could not start the new conversation.",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Shared composer key handling for both stages: /continue agent picker,
  // slash-command menu navigation, and command accept (Tab / Enter).
  const handleComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (continuePickerOpen && continuableAgents.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setContinueSelectedIndex(
          (current) =>
            (current + (event.key === "ArrowDown" ? 1 : -1) + continuableAgents.length) %
            continuableAgents.length,
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const agent = continuableAgents[continueSelectedIndex] ?? continuableAgents[0];
        if (agent) void handleContinueWithAgent(agent.id);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setContinuePickerOpen(false);
        return;
      }
    }
    if (slashMatches.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setSelectedCommandIndex(
        (current) =>
          (current + (event.key === "ArrowDown" ? 1 : -1) + slashMatches.length) %
          slashMatches.length,
      );
      return;
    }
    if (
      slashMatches.length &&
      (event.key === "Tab" || (event.key === "Enter" && !/\s/.test(composerFreeText.trimStart())))
    ) {
      event.preventDefault();
      applyCommand(slashMatches[selectedCommandIndex]?.name ?? slashMatches[0]!.name);
      return;
    }
    if (event.key === "Escape") {
      setSelectedCommandIndex(0);
    }
  };

  const handleOrchestrationSubmit = async ({
    prompt,
    orchestratorAgentId,
  }: SubagentComposerSubmit) => {
    setIsSubmitting(true);
    try {
      // The orchestrator runs in a thread owned by its agent. Reuse the
      // current thread when it already is that agent; otherwise start one.
      let threadId = snapshot?.threadId ?? null;
      const needsNewThread = !threadId || orchestratorAgentId !== (snapshot?.agentId ?? null);
      if (needsNewThread) {
        const projectId = activeProject?.id;
        if (!projectId) throw new Error("Open a project before orchestrating subagents.");
        const count = threads.filter((thread) => thread.project_id === projectId).length + 1;
        // Orchestration threads bind to the current workspace like any other
        // thread, so the orchestrator (and its subagents, which inherit the
        // session cwd) runs in the tree the user is looking at.
        const worktreePath = normalizeWorkspacePath(
          useWorktreeStore.getState().selectedWorktreePathByProject[projectId],
          activeProject?.path ?? null,
        );
        const thread = await createThread(
          projectId,
          `Orchestration #${count}`,
          snapshot?.threadId ?? null,
          orchestratorAgentId,
          worktreePath,
        );
        await loadProjectThreads(projectId, { reset: true });
        await selectThread(thread.id);
        threadId = thread.id;
      }
      // Fire-and-forget like handleSend: the ACP call resolves only when the
      // whole orchestration turn ends, and optimistic state is already applied.
      prepareNewTurnScroll(threadId);
      sendPrompt({ threadId, message: prompt }).catch((err) => {
        toast({
          icon: <WarningIcon className="size-5 text-red-500" />,
          title: "Orchestration failed",
          description:
            err instanceof Error ? err.message : "The orchestrator did not accept the prompt.",
        });
      });
      setOrchestrationOpen(false);
      setOrchestrationSeed("");
    } catch (err) {
      toast({
        icon: <WarningIcon className="size-5 text-red-500" />,
        title: "Orchestration failed",
        description: err instanceof Error ? err.message : "The orchestration was not started.",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Antigravity sign-in failures are rendered as the persistent auth banner
  // above (with in-place sign-in buttons), not as a dismissible switch error.
  // Suppress the raw error only when that banner actually renders; a text
  // match without an auth_required message must stay visible.
  const authBannerVisible = Boolean(snapshot?.authRequiredMessage);
  const visibleAgentError =
    agentError &&
    agentError !== dismissedAgentError &&
    !(snapshot?.agentId === "antigravity-acp" && authBannerVisible)
      ? agentError
      : null;
  const runtimeControlsDisabled =
    isRuntimeActionPending || isSwitchingThread || isConnecting || !snapshot;
  const composerDisabled = isDraftMode
    ? false
    : isSwitchingThread ||
      isConnecting ||
      !snapshot ||
      isSubmitting ||
      isAborting ||
      Boolean(editState && isStreaming);

  const draftProjectItems = useMemo(
    () =>
      projectsList.map((p) => ({
        id: p.id,
        label: p.name,
        description: "path" in p && typeof p.path === "string" ? p.path : undefined,
        icon: p.icon ?? null,
      })),
    [projectsList],
  );
  // Draft agent picker: prefer the user's selected agents, but never show an
  // empty list when other available agents exist (common when registry loaded
  // late or selectedAgentIds is still empty).
  const draftAgentItems = useMemo(() => {
    const available = registryAgents.filter((a) => a.available !== false);
    const selected = available.filter((a) => isInstanceSelected(a, selectedAgentIds));
    const pool = selected.length > 0 ? selected : available;
    return pool.map((a) => ({
      id: a.id,
      label: a.displayName,
      description: a.name,
    }));
  }, [registryAgents, selectedAgentIds]);

  // Ensure the agent catalog is loaded for draft model ownership labels.
  // Cached catalogs start nothing. Only the provider the draft targets is
  // started for its catalog, and only while it has none: that provider is the
  // one the next thread will use, so starting it also warms the thread start.
  const draftAgentId = draft?.agentId ?? null;
  useEffect(() => {
    void (async () => {
      await useAgentRegistryStore.getState().load();
      const known = useModelCatalogStore.getState().byAgentId;
      const refresh = draftAgentId && !known[draftAgentId]?.length ? [draftAgentId] : [];
      const catalogs = await window.omni?.agent?.getModelCatalogs?.({ refresh });
      if (!catalogs) return;
      const remember = useModelCatalogStore.getState().remember;
      for (const [agentId, models] of Object.entries(catalogs)) {
        remember(agentId, models);
      }
    })();
  }, [selectedAgentKey, draftAgentId]);
  const catalogByAgentId = useModelCatalogStore((state) => state.byAgentId);
  /**
   * Draft model list is agent-scoped via the learned catalog — never the active
   * session alone. That was the OpenCode-only bug: draft @model always showed
   * whichever agent happened to be connected.
   *
   * Live model list remains the current session's config options.
   */
  const modelMentionItems = useMemo(() => {
    if (!isDraftMode) {
      const providerId = snapshot?.agentId ?? models[0]?.provider;
      const providerLabel =
        registryAgents.find((agent) => agent.id === snapshot?.agentId)?.displayName ??
        (providerId ? formatProviderName(providerId) : undefined);
      return models.map((model) => ({
        id: model.modelId,
        label: model.name,
        description: formatProviderName(model.provider),
        agentId: snapshot?.agentId ?? undefined,
        providerId,
        providerLabel,
      }));
    }

    const agentNameById = new Map(draftAgentItems.map((a) => [a.id, a.label]));
    const agentIds =
      draftAgentItems.length > 0 ? draftAgentItems.map((a) => a.id) : Object.keys(catalogByAgentId);

    const items: Array<{
      id: string;
      label: string;
      description?: string;
      agentId?: string;
      providerId?: string;
      providerLabel?: string;
    }> = [];
    const seen = new Set<string>();

    for (const agentId of agentIds) {
      // Prefer live session models when this agent is currently connected —
      // freshest catalog. Otherwise fall back to last-seen models for that agent.
      const liveForAgent =
        snapshot?.agentId === agentId && models.length > 0
          ? models.map((m) => ({ modelId: m.modelId, name: m.name, provider: m.provider }))
          : null;
      const source = liveForAgent ?? catalogByAgentId[agentId] ?? [];
      const agentLabel = agentNameById.get(agentId) ?? formatProviderName(agentId);
      for (const model of source) {
        const key = `${agentId}:${model.provider ?? ""}:${model.modelId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          id: model.modelId,
          label: model.name,
          description: model.provider ? formatProviderName(model.provider) : agentLabel,
          agentId,
          providerId: agentId,
          providerLabel: agentLabel,
        });
      }
    }
    return items;
  }, [isDraftMode, models, snapshot?.agentId, draftAgentItems, catalogByAgentId, registryAgents]);

  const modelProviderItems = useMemo<MentionProvider[]>(() => {
    if (isDraftMode) return draftAgentItems.map(({ id, label }) => ({ id, label }));
    const providerId = snapshot?.agentId ?? models[0]?.provider;
    if (!providerId) return [];
    return [
      {
        id: providerId,
        label:
          registryAgents.find((agent) => agent.id === snapshot?.agentId)?.displayName ??
          formatProviderName(providerId),
      },
    ];
  }, [isDraftMode, draftAgentItems, snapshot?.agentId, models, registryAgents]);

  // File list for smart @file mentions (draft needs a project; live uses active cwd).
  // Nothing is scanned until the file mention menu opens; the list is then
  // shared per workspace and reused until invalidated or stale.
  const fileProjectId = useMemo(
    () =>
      isDraftMode
        ? (draft?.projectId ?? extractProjectId(draftContent))
        : (snapshot?.projectId ?? activeProject?.id ?? null),
    [isDraftMode, draft?.projectId, draftContent, snapshot?.projectId, activeProject?.id],
  );
  const fileWorktreePath = useMemo(
    () =>
      isDraftMode
        ? (draft?.worktreePath ??
          selectedWorktreePathByProject[fileProjectId ?? ""] ??
          activeProject?.path ??
          null)
        : (snapshot?.cwd ??
          selectedWorktreePathByProject[fileProjectId ?? ""] ??
          activeProject?.path ??
          null),
    [
      isDraftMode,
      draft?.worktreePath,
      snapshot?.cwd,
      selectedWorktreePathByProject,
      fileProjectId,
      activeProject?.path,
    ],
  );
  const projectFileSource = useMemo(
    () => ({ projectId: fileProjectId, worktreePath: fileWorktreePath }),
    [fileProjectId, fileWorktreePath],
  );
  const { items: projectFileItems, request: refreshProjectFiles } =
    useProjectFileIndex(projectFileSource);
  // A finished turn may have created or deleted files in this workspace.
  useEffect(() => {
    if (!isStreaming) invalidateProjectFiles(projectFileSource);
  }, [isStreaming, projectFileSource]);

  // Keep live free-text content aligned when not using entity chips from draft.
  useEffect(() => {
    if (isDraftMode) return;
    setLiveContent((prev) => {
      const entities = getEntityTokens(prev);
      return buildContent(entities, inputValue);
    });
  }, [inputValue, isDraftMode]);

  // Keep the project entity bound to the active thread internally. The live
  // composer hides it because an existing thread already fixes the project.
  useEffect(() => {
    if (isDraftMode || !liveComposerProject) return;
    setLiveContent((prev) => {
      if (extractProjectId(prev) === liveComposerProject.id) return prev;
      return withProjectChip(prev, liveComposerProject);
    });
  }, [isDraftMode, liveComposerProject]);

  const handleReasoningChange = (value: string) => {
    if (!thoughtLevelConfigId) return;
    setConfigOption(thoughtLevelConfigId, value).catch((err) => {
      toast({
        icon: <WarningIcon className="size-5 text-red-500" />,
        title: "Reasoning level failed",
        description: err instanceof Error ? err.message : "The reasoning level was not changed.",
      });
    });
  };

  const handleRuntimeModelChange = async (modelId: string) => {
    setIsRuntimeActionPending(true);
    try {
      const success = await setModel({ modelId });
      toast({
        ...(success ? {} : { icon: <WarningIcon className="size-5 text-red-500" /> }),
        title: success ? "Model switched" : "Model change failed",
        description: success ? modelId : "The selected model was not applied.",
      });
    } catch (err) {
      toast({
        icon: <WarningIcon className="size-5 text-red-500" />,
        title: "Model change failed",
        description: err instanceof Error ? err.message : "The selected model was not applied.",
      });
    } finally {
      setIsRuntimeActionPending(false);
    }
  };

  return (
    <section
      data-pipper-id="agent-panel"
      className="relative z-20 h-full w-full flex flex-col bg-surface-1  overflow-visible"
    >
      <AgentQuestionDock activeSessionId={activeSessionId} />
      {previewImage && (
        <div
          className="fixed inset-0 z-[4000] flex items-center justify-center bg-black/75 p-8"
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
          onClick={() => setPreviewImage(null)}
        >
          <img
            src={`data:${previewImage.mimeType};base64,${previewImage.data}`}
            alt="Message attachment preview"
            className="max-h-full max-w-full object-contain"
          />
        </div>
      )}

      <div className="flex-1 flex flex-col min-h-0">
        <div className="relative flex-1 overflow-hidden mt-4  min-h-0 flex flex-col">
          <div
            data-pipper-id="reading-column"
            data-thread-id={threadId || undefined}
            data-benchmark-ready={
              threadId && allMessages.length > 0 && !isSwitchingThread ? "true" : "false"
            }
            className={cn(
              "relative z-10 flex min-h-0 w-full flex-1 flex-col",
              // A full-bleed conversation reads badly, so the global view caps
              // it to a centred column. Inside the diff split the panel is
              // already narrow, so it uses the full width.
              !isDiffSplit && "mx-auto w-full max-w-4xl xl:max-w-5xl",
            )}
          >
            <div
              ref={messagesScrollRef}
              className="relative min-h-0 flex-1 overflow-y-auto"
              aria-busy={isSwitchingThread}
            >
              <div className="flex min-h-full flex-col">
                {isDraftMode || allMessages.length === 0 ? (
                  pendingDraftTurn ? (
                    <div className="p-4" data-pipper-id="pending-draft-turn">
                      <ChatMessage
                        from="user"
                        pipperId="user-message"
                        images={pendingDraftTurn.images}
                        onImageClick={setPreviewImage}
                      >
                        <div className="whitespace-pre-wrap break-words text-[14px] leading-6">
                          {pendingDraftTurn.text}
                        </div>
                      </ChatMessage>
                      <div
                        className="flex shrink-0 items-start gap-3 px-4 py-2"
                        data-pipper-id="Thinking-indicator"
                      >
                        <ThinkingIndicator showIcon className="h-9 p-0" />
                      </div>
                    </div>
                  ) : null
                ) : (
                  <>
                    <div
                      data-pipper-id="messages-list"
                      className="relative p-4"
                      style={{
                        height: `${conversationVirtualizer.getTotalSize()}px`,
                      }}
                    >
                      {conversationVirtualizer.getVirtualItems().map((virtualRow) => {
                        const entry = allMessages[virtualRow.index];
                        if (!entry) return null;
                        const { key, role, messages, originalIndex, isStreaming } = entry;
                        const from = role;
                        const msgId = key;
                        const firstToolCallId =
                          from === "assistant"
                            ? (messages
                                .flatMap((message) =>
                                  "toolCallIds" in message && Array.isArray(message.toolCallIds)
                                    ? message.toolCallIds
                                    : [],
                                )
                                .at(0) ?? undefined)
                            : undefined;
                        const bodyText = messages
                          .map((m) => stringifyMessageContent(m))
                          .filter(Boolean)
                          .join("\n\n");
                        const groupedImages = extractGroupedMessageImages(messages);
                        const timeStr = isStreaming
                          ? undefined
                          : formatMessageTime(messages[messages.length - 1]);
                        const hasContent =
                          bodyText.trim() !== "" ||
                          groupedImages.length > 0 ||
                          (from === "assistant" &&
                            messages.some((m) => getToolSummary(m) !== null));

                        const actions =
                          from === "user" ? (
                            <div data-pipper-id="user-actions-buttons">
                              <CopyButton
                                isCopied={copiedMessageId === msgId}
                                onCopy={() => void handleCopy(msgId, bodyText)}
                              />
                              <button
                                type="button"
                                aria-label="Edit message"
                                title={
                                  messages.length > 1
                                    ? "Grouped messages cannot be edited together"
                                    : "Edit message"
                                }
                                className={iconButtonClass}
                                disabled={
                                  isStreaming ||
                                  isSubmitting ||
                                  messages.length > 1 ||
                                  !snapshot?.messageEntryRefs[originalIndex]
                                }
                                onClick={() => {
                                  setInputValue(bodyText);
                                  setAttachedFiles([]);
                                  setEditState({
                                    targetEntryId:
                                      snapshot!.messageEntryRefs[originalIndex]!.entryId,
                                    images: groupedImages,
                                  });
                                  if (composerTextareaRef.current) {
                                    composerTextareaRef.current.focus();
                                  }
                                }}
                              >
                                <PencilIcon size={13} />
                              </button>
                            </div>
                          ) : (
                            <div data-pipper-id="agent-actions-buttons">
                              <CopyButton
                                isCopied={copiedMessageId === msgId}
                                onCopy={() => void handleCopy(msgId, bodyText)}
                              />
                              {!isStreaming && (
                                <button
                                  type="button"
                                  aria-label="Regenerate response"
                                  className={iconButtonClass}
                                  disabled={
                                    isSubmitting || snapshot?.isCompacting || snapshot?.isRetrying
                                  }
                                  onClick={() => handleRegenerate(originalIndex)}
                                >
                                  <RotateCcwIcon size={13} />
                                </button>
                              )}
                            </div>
                          );

                        return (
                          <div
                            key={virtualRow.key}
                            ref={conversationVirtualizer.measureElement}
                            data-index={virtualRow.index}
                            className="absolute left-0 top-0 w-full px-4 pb-3"
                            style={{
                              transform: `translateY(${virtualRow.start}px)`,
                            }}
                          >
                            <ChatMessage
                              from={from}
                              pipperId={from === "assistant" ? "assistant-message" : "user-message"}
                              time={timeStr}
                              actions={actions}
                              images={groupedImages}
                              onImageClick={setPreviewImage}
                            >
                              {hasContent ? (
                                <MessageBody
                                  messages={messages}
                                  threadId={snapshot?.threadId ?? null}
                                  isStreaming={isStreaming}
                                  activeMessages={activeMessages}
                                  diffSummary={
                                    firstToolCallId ? diffSummaries[firstToolCallId] : undefined
                                  }
                                  traceDeckOpen={traceDeckOpenByKey[msgId] ?? false}
                                  onTraceDeckOpenChange={(open) => {
                                    setTraceDeckOpenByKey((current) => ({
                                      ...current,
                                      [msgId]: open,
                                    }));
                                    if (open && snapshot?.threadId) {
                                      const toolCallIds = messages.flatMap((message) => {
                                        const content = (message as { content?: unknown }).content;
                                        if (!Array.isArray(content)) return [];
                                        return content
                                          .filter(
                                            (part): part is { type: "toolCall"; id: string } =>
                                              Boolean(
                                                part &&
                                                typeof part === "object" &&
                                                (part as { type?: string }).type === "toolCall" &&
                                                typeof (part as { id?: unknown }).id === "string",
                                              ),
                                          )
                                          .map((part) => part.id);
                                      });
                                      void hydrateToolCalls(snapshot.threadId, toolCallIds);
                                    }
                                  }}
                                />
                              ) : undefined}
                            </ChatMessage>
                          </div>
                        );
                      })}
                    </div>
                    {isStreaming && !streamingMessage && (
                      <div
                        className="flex shrink-0 items-start gap-3 px-4 py-2"
                        data-pipper-id="Thinking-indicator"
                      >
                        <ThinkingIndicator showIcon className="h-9 p-0" />
                      </div>
                    )}
                    <div ref={messagesEndRef} aria-hidden="true" />
                  </>
                )}

                {(conversationScrollMode === "reading" || conversationScrollMode === "anchoring") &&
                  isStreaming && (
                    <div className="sr-only" aria-live="polite">
                      A response is still streaming. Jump to latest to follow it.
                    </div>
                  )}

                <div
                  ref={composerRegionRef}
                  data-pipper-id="input-area"
                  className={cn(
                    "relative z-10 px-3 pb-5 transition-colors duration-300",
                    isDraftMode || allMessages.length === 0 ? "mt-2 pt-0" : "pt-6",
                  )}
                >
                  <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
                    {snapshot?.authRequiredMessage && (
                      <AgentAuthBanner
                        message={snapshot.authRequiredMessage}
                        agentId={snapshot.agentId}
                        methods={authMethods}
                        onAuthenticated={() => refresh()}
                      />
                    )}
                    {visibleAgentError && (
                      <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-500">
                        <WarningIcon className="mt-0.5 size-4 shrink-0" />
                        <span className="min-w-0 flex-1">{visibleAgentError}</span>
                        <button
                          type="button"
                          className="shrink-0 text-red-500/80 hover:text-red-500"
                          onClick={() => setDismissedAgentError(visibleAgentError)}
                        >
                          Dismiss
                        </button>
                      </div>
                    )}
                    {isConnecting && (
                      <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-[12px] text-muted-foreground">
                        Connecting to agent runtime...
                      </div>
                    )}
                    {snapshot?.queue.steering.length || snapshot?.queue.followUp.length ? (
                      <div className="rounded-lg border border-border bg-surface-2 p-2 text-xs">
                        {snapshot.queue.steering.length > 0 && (
                          <div>
                            <span className="font-medium">Steering</span>
                            {snapshot.queue.steering.map((item, index) => (
                              <div
                                key={index}
                                className="line-clamp-2 text-muted-foreground"
                                title={item}
                              >
                                {item}
                              </div>
                            ))}
                          </div>
                        )}
                        {snapshot.queue.followUp.length > 0 && (
                          <div className="mt-1">
                            <span className="font-medium">Next</span>
                            {snapshot.queue.followUp.map((item, index) => (
                              <div
                                key={index}
                                className="line-clamp-2 text-muted-foreground"
                                title={item}
                              >
                                {item}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : null}
                    {editState && (
                      <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-xs">
                        <span>Editing message · {editState.images.length} retained image(s)</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditState(null);
                            setInputValue("");
                            setAttachedFiles([]);
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    )}
                    <div className="relative isolate">
                      {snapshot?.plan && snapshot.plan.length > 0 && isStreaming ? (
                        <div
                          data-pipper-id="plan-popover"
                          className="absolute right-0 bottom-full mb-1.5 z-[240] w-[280px]"
                        >
                          <Elevated
                            offset={2}
                            shadowLevel={4}
                            className="rounded-xl border border-border/80 p-2"
                          >
                            <div className="px-1.5 pb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                              Plan
                            </div>
                            <ul className="flex flex-col gap-1">
                              {snapshot.plan.map((entry, index) => (
                                <li
                                  key={`${entry.content}-${index}`}
                                  className="flex items-start gap-2 rounded-lg px-1.5 py-1 text-[12px] text-foreground"
                                >
                                  <span className="mt-0.5 size-3.5 shrink-0 text-muted-foreground">
                                    {entry.status === "completed" ? (
                                      <ModelCheckIcon size={14} className="text-emerald-500" />
                                    ) : (
                                      <span className="inline-block size-2.5 rounded-full border border-border" />
                                    )}
                                  </span>
                                  <span
                                    className={
                                      entry.status === "completed"
                                        ? "text-muted-foreground line-through"
                                        : undefined
                                    }
                                  >
                                    {entry.content}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </Elevated>
                        </div>
                      ) : null}
                      <AgentSlashCommandMenu
                        anchorRef={composerTextareaRef}
                        commands={slashMatches}
                        selectedIndex={selectedCommandIndex}
                        onSelect={applyCommand}
                      />

                      {continuePickerOpen ? (
                        <AgentContinueMenu
                          agents={continuableAgents}
                          selectedIndex={continueSelectedIndex}
                          onSelect={(agentId) => void handleContinueWithAgent(agentId)}
                        />
                      ) : null}

                      <SubagentActivity
                        runs={subagentRuns}
                        agents={registryAgents}
                        activeSessionId={activeSessionId}
                        className="relative z-10 mb-1.5"
                      />

                      {isDraftMode ? (
                        <ThreadComposer
                          mode="draft"
                          className="relative z-10"
                          turnMarker={COMPOSER_TURN_MARKER}
                          content={draftContent}
                          onContentChange={handleDraftContentChange}
                          onSend={(content, files) => void handleDraftSend(content, files)}
                          disabled={composerDisabled}
                          isSubmitting={isSubmitting}
                          projects={isAdvancedUI ? [] : draftProjectItems}
                          agents={[]}
                          models={modelMentionItems}
                          modelProviders={modelProviderItems}
                          projectFiles={projectFileItems}
                          onFileMentionOpen={refreshProjectFiles}
                          files={attachedFiles}
                          onFilesChange={handleFilesChange}
                          onFilesRejected={handleFilesRejected}
                          maxFiles={MAX_AGENT_IMAGES}
                          showImageAttach={false}
                          appearance="plain"
                          hideSendButton
                          hideProjectChip={isAdvancedUI}
                          textareaRef={composerTextareaRef}
                          onTextareaKeyDown={handleComposerKeyDown}
                        />
                      ) : inlineRequest ? (
                        <AgentQuestionCard request={inlineRequest} className="relative z-10" />
                      ) : orchestrationOpen ? (
                        <SubagentComposer
                          className="relative z-10"
                          agents={registryAgents}
                          defaultOrchestratorId={snapshot?.agentId ?? null}
                          initialGoal={orchestrationSeed}
                          isSubmitting={isSubmitting}
                          onSubmit={(payload) => void handleOrchestrationSubmit(payload)}
                          onCancel={() => {
                            setOrchestrationOpen(false);
                            setOrchestrationSeed("");
                          }}
                        />
                      ) : (
                        <>
                          {pendingContinuation ? (
                            <div
                              className="relative z-10 mb-1.5 flex flex-wrap items-center gap-1.5"
                              data-pipper-id="continuation-chip"
                            >
                              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 py-1 pl-2.5 pr-1.5 text-xs text-muted-foreground">
                                <ChatCircleTextIcon size={13} />
                                Transcript from previous conversation
                                <button
                                  type="button"
                                  aria-label="Remove transcript"
                                  data-pipper-id="continuation-chip-remove"
                                  className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-hover hover:text-foreground"
                                  onClick={() => {
                                    if (snapshot?.threadId) {
                                      useContinuationStore
                                        .getState()
                                        .clearPending(snapshot.threadId);
                                    }
                                  }}
                                >
                                  <XIcon size={11} />
                                </button>
                              </span>
                            </div>
                          ) : null}
                          <ThreadComposer
                            mode="live"
                            className="relative z-10"
                            turnMarker={COMPOSER_TURN_MARKER}
                            content={liveContent}
                            onContentChange={handleLiveContentChange}
                            onSend={(content, sendFiles) =>
                              void handleLiveComposerSend(content, sendFiles)
                            }
                            disabled={composerDisabled}
                            isSubmitting={isSubmitting}
                            isStreaming={isStreaming}
                            projects={projectsList}
                            models={modelMentionItems}
                            modelProviders={modelProviderItems}
                            projectFiles={projectFileItems}
                            onFileMentionOpen={refreshProjectFiles}
                            files={attachedFiles}
                            onFilesChange={handleFilesChange}
                            onFilesRejected={handleFilesRejected}
                            maxFiles={Math.max(
                              0,
                              MAX_AGENT_IMAGES - (editState?.images.length ?? 0),
                            )}
                            showImageAttach={false}
                            appearance="plain"
                            hideSendButton
                            hideProjectChip
                            textareaRef={composerTextareaRef}
                            placeholder={
                              isConnecting ? "Connecting to agent runtime..." : undefined
                            }
                            onTextareaKeyDown={handleComposerKeyDown}
                          />
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {scrollPastSpacerHeight > 0 && (
                  <div
                    data-pipper-id="scroll-past-spacer"
                    aria-hidden="true"
                    style={{ height: `${scrollPastSpacerHeight}px` }}
                    className="shrink-0 pointer-events-none"
                  />
                )}
              </div>
            </div>

            <div data-pipper-id="composer-rail" className="relative z-20 shrink-0 mt-6 px-3 py-2">
              <div className="mx-auto flex min-h-9 w-full max-w-4xl items-center">
                {!isDraftMode && (
                  <AgentRuntimeControls
                    reasoningLevels={thoughtLevelValues}
                    currentReasoningIndex={currentThoughtIndex}
                    currentReasoningLabel={snapshot?.thinkingLevel ?? undefined}
                    disabled={runtimeControlsDisabled}
                    onReasoningChange={handleReasoningChange}
                    isStreaming={isStreaming}
                    isStopping={isAborting}
                    onStop={handleAbort}
                    contextUsage={
                      snapshot?.stats && snapshot.stats.size > 0
                        ? {
                            tokens: snapshot.stats.used,
                            contextWindow: snapshot.stats.size,
                            percent: (snapshot.stats.used / snapshot.stats.size) * 100,
                          }
                        : undefined
                    }
                    modelName={snapshot?.model?.name}
                    modelId={snapshot?.model?.modelId}
                    modelItems={modelMentionItems}
                    modelProviders={modelProviderItems}
                    onModelChange={(modelId) => void handleRuntimeModelChange(modelId)}
                    autoCompactionEnabled={snapshot?.autoCompactionEnabled}
                    sessionTokens={snapshot?.stats?.used}
                    sessionCost={snapshot?.stats?.cost?.amount}
                    rateLimit={snapshot?.usage?.rateLimit}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
