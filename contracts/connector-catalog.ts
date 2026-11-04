/**
 * Remote MCP servers Pipper vouches for. Adding one from here needs no URL:
 * Pipper fills it in, and the card shows the service rather than a bare
 * address. Each was checked to answer at its URL and, for OAuth ones, to let
 * Pipper register itself with a loopback redirect (Figma, for one, doesn't).
 */

export type ConnectorCatalogAuth =
  /** Signs in in the browser; Pipper registers itself with the service. */
  | { kind: "oauth" }
  /** Open: no sign-in. */
  | { kind: "none" }
  /** A key the user pastes, sent as a header. */
  | {
      kind: "key";
      header: string;
      /** Put before the key in the header, such as "Bearer ". */
      prefix?: string;
      /** What the service calls it: "Personal access token". */
      label: string;
      /** Where the user makes one. */
      helpUrl: string;
    };

export interface ConnectorCatalogEntry {
  id: string;
  name: string;
  /** One line: what the agent can do with it. */
  description: string;
  url: string;
  auth: ConnectorCatalogAuth;
  category: ConnectorCategoryId;
}

export type ConnectorCategoryId = "work" | "engineering" | "cloud" | "docs";

/** Settings shows the catalog in these groups, in this order. */
export const CONNECTOR_CATEGORIES: ReadonlyArray<{ id: ConnectorCategoryId; label: string }> = [
  { id: "work", label: "Work and planning" },
  { id: "engineering", label: "Engineering" },
  { id: "cloud", label: "Cloud and databases" },
  { id: "docs", label: "Docs and search" },
];

export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  {
    id: "linear",
    name: "Linear",
    description: "Find, create and update issues, projects and comments.",
    url: "https://mcp.linear.app/mcp",
    auth: { kind: "oauth" },
    category: "work",
  },
  {
    id: "github",
    name: "GitHub",
    description: "Issues, pull requests, code search and Actions.",
    url: "https://api.githubcopilot.com/mcp/",
    auth: {
      kind: "key",
      header: "Authorization",
      prefix: "Bearer ",
      label: "Personal access token",
      helpUrl: "https://github.com/settings/personal-access-tokens/new",
    },
    category: "engineering",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search, read and edit pages and databases.",
    url: "https://mcp.notion.com/mcp",
    auth: { kind: "oauth" },
    category: "work",
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Look up errors, issues and releases.",
    url: "https://mcp.sentry.dev/mcp",
    auth: { kind: "oauth" },
    category: "engineering",
  },
  {
    id: "atlassian",
    name: "Atlassian",
    description: "Jira issues and Confluence pages.",
    url: "https://mcp.atlassian.com/v1/mcp",
    auth: { kind: "oauth" },
    category: "work",
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Customers, payments, products and the Stripe docs.",
    url: "https://mcp.stripe.com",
    auth: { kind: "oauth" },
    category: "engineering",
  },
  {
    id: "vercel",
    name: "Vercel",
    description: "Projects, deployments and their logs.",
    url: "https://mcp.vercel.com",
    auth: { kind: "oauth" },
    category: "cloud",
  },
  {
    id: "supabase",
    name: "Supabase",
    description: "Databases, SQL, migrations and edge functions.",
    url: "https://mcp.supabase.com/mcp",
    auth: { kind: "oauth" },
    category: "cloud",
  },
  {
    id: "neon",
    name: "Neon",
    description: "Postgres projects, branches and queries.",
    url: "https://mcp.neon.tech/mcp",
    auth: { kind: "oauth" },
    category: "cloud",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "Workers, DNS, storage and the rest of your Cloudflare account.",
    url: "https://mcp.cloudflare.com/mcp",
    auth: { kind: "oauth" },
    category: "cloud",
  },
  {
    id: "posthog",
    name: "PostHog",
    description: "Product analytics, feature flags and experiments.",
    url: "https://mcp.posthog.com/mcp",
    auth: { kind: "oauth" },
    category: "engineering",
  },
  {
    id: "monday",
    name: "monday.com",
    description: "Boards, items and updates.",
    url: "https://mcp.monday.com/mcp",
    auth: { kind: "oauth" },
    category: "work",
  },
  {
    id: "canva",
    name: "Canva",
    description: "Find, create and export designs.",
    url: "https://mcp.canva.com/mcp",
    auth: { kind: "oauth" },
    category: "work",
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    description: "Search models, datasets, Spaces and papers.",
    url: "https://huggingface.co/mcp",
    auth: { kind: "none" },
    category: "docs",
  },
  {
    id: "context7",
    name: "Context7",
    description: "Current docs and code examples for libraries.",
    url: "https://mcp.context7.com/mcp",
    auth: { kind: "none" },
    category: "docs",
  },
  {
    id: "deepwiki",
    name: "DeepWiki",
    description: "Ask questions about public GitHub repositories.",
    url: "https://mcp.deepwiki.com/mcp",
    auth: { kind: "none" },
    category: "docs",
  },
  {
    id: "exa",
    name: "Exa",
    description: "Web search and page contents.",
    url: "https://mcp.exa.ai/mcp",
    auth: { kind: "none" },
    category: "docs",
  },
];

export function connectorCatalogEntry(id: string | null | undefined): ConnectorCatalogEntry | null {
  return CONNECTOR_CATALOG.find((entry) => entry.id === id) ?? null;
}
