import atlassian from "@/assets/connector-logos/atlassian.svg";
import canva from "@/assets/connector-logos/canva.svg";
import cloudflare from "@/assets/connector-logos/cloudflare.svg";
import githubDark from "@/assets/connector-logos/github-dark.svg";
import githubLight from "@/assets/connector-logos/github-light.svg";
import huggingface from "@/assets/connector-logos/huggingface.svg";
import linear from "@/assets/connector-logos/linear.svg";
import neon from "@/assets/connector-logos/neon.svg";
import notion from "@/assets/connector-logos/notion.svg";
import posthogDark from "@/assets/connector-logos/posthog-dark.svg";
import posthog from "@/assets/connector-logos/posthog.svg";
import sentryDark from "@/assets/connector-logos/sentry-dark.svg";
import sentry from "@/assets/connector-logos/sentry.svg";
import stripe from "@/assets/connector-logos/stripe.svg";
import supabase from "@/assets/connector-logos/supabase.svg";
import vercelDark from "@/assets/connector-logos/vercel-dark.svg";
import vercelLight from "@/assets/connector-logos/vercel-light.svg";

/**
 * Logos for catalog connectors, from svgl.app (https://svgl.app), shipped
 * with the app so Settings needs no network. `dark` is the version for a dark
 * theme when the mark would vanish on a dark tile. Catalog ids without a
 * logo here show their initial.
 */
export const CONNECTOR_LOGOS: Record<string, { light: string; dark?: string }> = {
  atlassian: { light: atlassian },
  canva: { light: canva },
  cloudflare: { light: cloudflare },
  github: { light: githubLight, dark: githubDark },
  huggingface: { light: huggingface },
  linear: { light: linear },
  neon: { light: neon },
  notion: { light: notion },
  posthog: { light: posthog, dark: posthogDark },
  sentry: { light: sentry, dark: sentryDark },
  stripe: { light: stripe },
  supabase: { light: supabase },
  vercel: { light: vercelLight, dark: vercelDark },
};
