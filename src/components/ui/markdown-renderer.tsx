import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  memo,
  useContext,
  useMemo,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openMarkdownLink } from "@/lib/file-preview-actions";
import { classifyMarkdownHref } from "@/lib/markdown-links";
import rehypeSanitize from "rehype-sanitize";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { ShikiCodeBlock } from "@/components/ui/shiki-code-block";
import { typeScale, useTypeScale, type TypeScaleRole } from "@/lib/size-context";
import { fontWeights } from "@/lib/font-weight";
import { useShape } from "@/lib/shape-context";

type WithNode<T> = T & ExtraProps;
type TableRowElement = ReactElement<{ index?: number }>;

type MarkdownRendererProps = {
  children: string;
  className?: string;
  components?: Components;
  isStreaming?: boolean;
};

type MarkdownScale = Record<TypeScaleRole, number>;

/** Default-column scale, used before a SizeProvider resolves one. */
const DEFAULT_SCALE: MarkdownScale = {
  display: typeScale.display.default,
  title: typeScale.title.default,
  subtitle: typeScale.subtitle.default,
  body: typeScale.body.default,
  caption: typeScale.caption.default,
};

const MarkdownRenderContext = createContext<{ isStreaming: boolean; scale: MarkdownScale }>({
  isStreaming: false,
  scale: DEFAULT_SCALE,
});

function omitNode<T extends { node?: unknown }>(props: T) {
  const { node, ...rest } = props;
  void node;
  return rest;
}

const MarkdownTable = memo((props: WithNode<ComponentPropsWithoutRef<"table">>) => {
  const { className, children, ...rest } = omitNode(props);

  return (
    <div className="min-w-0 max-w-full overflow-x-auto" data-markdown="table-wrapper">
      <Table className={className} data-markdown="table" {...rest}>
        {children}
      </Table>
    </div>
  );
});

MarkdownTable.displayName = "MarkdownTable";

const MarkdownTableHeader = memo((props: WithNode<ComponentPropsWithoutRef<"thead">>) => {
  const { className, ...rest } = omitNode(props);
  return <TableHeader className={className} data-markdown="table-header" {...rest} />;
});

MarkdownTableHeader.displayName = "MarkdownTableHeader";

function indexBodyRows(children: ReactNode): ReactNode {
  let rowIndex = 0;

  return Children.map(children, (child) => {
    if (!isValidElement(child)) return child;

    const indexedChild = cloneElement(child as TableRowElement, {
      index: rowIndex,
    });
    rowIndex += 1;
    return indexedChild;
  });
}

const MarkdownTableBody = memo((props: WithNode<ComponentPropsWithoutRef<"tbody">>) => {
  const { children, className, ...rest } = omitNode(props);
  return (
    <TableBody className={className} data-markdown="table-body" {...rest}>
      {indexBodyRows(children)}
    </TableBody>
  );
});

MarkdownTableBody.displayName = "MarkdownTableBody";

const MarkdownTableRow = memo(
  (props: WithNode<ComponentPropsWithoutRef<"tr"> & { index?: number }>) => {
    const { className, index, ...rest } = omitNode(props);
    return <TableRow className={className} data-markdown="table-row" index={index} {...rest} />;
  },
);

MarkdownTableRow.displayName = "MarkdownTableRow";

const MarkdownTableHead = memo((props: WithNode<ComponentPropsWithoutRef<"th">>) => {
  const { className, ...rest } = omitNode(props);
  return (
    <TableHead
      className={cn("whitespace-normal break-words align-top", className)}
      data-markdown="table-header-cell"
      {...rest}
    />
  );
});

MarkdownTableHead.displayName = "MarkdownTableHead";

const MarkdownTableCell = memo((props: WithNode<ComponentPropsWithoutRef<"td">>) => {
  const { className, ...rest } = omitNode(props);
  return (
    <TableCell
      className={cn("whitespace-normal break-words align-top", className)}
      data-markdown="table-cell"
      {...rest}
    />
  );
});

MarkdownTableCell.displayName = "MarkdownTableCell";

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeSanitize];

function MarkdownCode({
  className,
  children,
  ...props
}: WithNode<ComponentPropsWithoutRef<"code">>) {
  const rest = omitNode(props);
  const language = /language-([^\s]+)/.exec(className ?? "")?.[1];
  const code = String(children).replace(/\n$/, "");
  const isBlock = language || String(children).includes("\n");
  const { isStreaming } = useContext(MarkdownRenderContext);
  const shape = useShape();

  if (isBlock) {
    return <ShikiCodeBlock code={code} isStreaming={isStreaming} language={language ?? "text"} />;
  }

  return (
    <code
      className={cn(
        shape.item,
        "bg-muted px-1.5 py-0.5 font-mono text-[0.9em] break-words [overflow-wrap:anywhere]",
        className,
      )}
      {...rest}
    >
      {children}
    </code>
  );
}

/** Headings read their size from the active type scale and their weight from
 *  the shared variable-font weights, so markdown matches the design system. */
function MarkdownHeading({
  level,
  scaleRole,
  weight,
  tone,
  className,
  ...props
}: {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  scaleRole: TypeScaleRole;
  weight: keyof typeof fontWeights;
  tone: string;
} & WithNode<ComponentPropsWithoutRef<"h2">>) {
  const { scale } = useContext(MarkdownRenderContext);
  const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  return (
    <Tag
      className={cn("break-words [overflow-wrap:anywhere]", tone, className)}
      style={{ fontSize: `${scale[scaleRole]}px`, fontVariationSettings: fontWeights[weight] }}
      {...omitNode(props)}
    />
  );
}

/**
 * Links are followed in-app, not by a new window: main only lets a fixed
 * allowlist of hosts open that way, so agent links did nothing. Web pages
 * open in the browser, file paths in the workspace's preview.
 */
function MarkdownLink({
  className,
  href,
  onClick,
  ...props
}: WithNode<ComponentPropsWithoutRef<"a">>) {
  const rest = omitNode(props);
  const target = classifyMarkdownHref(href);
  return (
    <a
      className={cn(
        "cursor-pointer text-link underline decoration-link/40 underline-offset-2 break-words [overflow-wrap:anywhere] hover:decoration-link",
        target.kind === "file" && "font-mono text-[0.9em]",
        className,
      )}
      href={href}
      rel="noreferrer"
      title={target.kind === "web" ? target.url : target.kind === "file" ? target.path : undefined}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        openMarkdownLink(href);
      }}
      {...rest}
    />
  );
}

const defaultMarkdownComponents = {
  table: MarkdownTable,
  thead: MarkdownTableHeader,
  tbody: MarkdownTableBody,
  tr: MarkdownTableRow,
  th: MarkdownTableHead,
  td: MarkdownTableCell,
  p: ({ className, ...props }: WithNode<ComponentPropsWithoutRef<"p">>) => {
    const rest = omitNode(props);
    return (
      <p className={cn("leading-6 break-words [overflow-wrap:anywhere]", className)} {...rest} />
    );
  },
  ul: ({ className, ...props }: WithNode<ComponentPropsWithoutRef<"ul">>) => {
    const rest = omitNode(props);
    return <ul className={cn("list-outside list-disc pl-5 space-y-1 my-2", className)} {...rest} />;
  },
  ol: ({ className, ...props }: WithNode<ComponentPropsWithoutRef<"ol">>) => {
    const rest = omitNode(props);
    return (
      <ol className={cn("list-outside list-decimal pl-5 space-y-1 my-2", className)} {...rest} />
    );
  },
  li: ({ className, ...props }: WithNode<ComponentPropsWithoutRef<"li">>) => {
    const rest = omitNode(props);
    return (
      <li
        className={cn(
          "py-0.5 break-words [overflow-wrap:anywhere] [&>p]:inline [&>p:not(:first-child)]:block [&>p:not(:first-child)]:mt-2",
          className,
        )}
        {...rest}
      />
    );
  },
  h1: (props: WithNode<ComponentPropsWithoutRef<"h1">>) => (
    <MarkdownHeading
      level={1}
      scaleRole="title"
      weight="semibold"
      tone="text-foreground"
      {...props}
    />
  ),
  h2: (props: WithNode<ComponentPropsWithoutRef<"h2">>) => (
    <MarkdownHeading
      level={2}
      scaleRole="subtitle"
      weight="semibold"
      tone="text-foreground"
      {...props}
    />
  ),
  h3: (props: WithNode<ComponentPropsWithoutRef<"h3">>) => (
    <MarkdownHeading
      level={3}
      scaleRole="body"
      weight="semibold"
      tone="text-foreground"
      {...props}
    />
  ),
  h4: (props: WithNode<ComponentPropsWithoutRef<"h4">>) => (
    <MarkdownHeading level={4} scaleRole="body" weight="medium" tone="text-foreground" {...props} />
  ),
  h5: (props: WithNode<ComponentPropsWithoutRef<"h5">>) => (
    <MarkdownHeading
      level={5}
      scaleRole="caption"
      weight="medium"
      tone="text-muted-foreground"
      {...props}
    />
  ),
  h6: (props: WithNode<ComponentPropsWithoutRef<"h6">>) => (
    <MarkdownHeading
      level={6}
      scaleRole="caption"
      weight="medium"
      tone="text-muted-foreground"
      {...props}
    />
  ),
  blockquote: ({ className, ...props }: WithNode<ComponentPropsWithoutRef<"blockquote">>) => {
    const rest = omitNode(props);
    return (
      <blockquote
        className={cn(
          "border-muted-foreground/30 border-l-4 pl-4 text-muted-foreground italic",
          className,
        )}
        {...rest}
      />
    );
  },
  strong: ({ className, ...props }: WithNode<ComponentPropsWithoutRef<"strong">>) => (
    <strong
      className={cn("text-foreground", className)}
      style={{ fontVariationSettings: fontWeights.semibold }}
      {...omitNode(props)}
    />
  ),
  code: MarkdownCode,
  pre: ({ children }: WithNode<ComponentPropsWithoutRef<"pre">>) => <>{children}</>,
  a: MarkdownLink,
} satisfies Components;

function MarkdownRendererBase({
  children,
  className,
  components,
  isStreaming = false,
}: MarkdownRendererProps) {
  const scale = useTypeScale();
  const contextValue = useMemo(() => ({ isStreaming, scale }), [isStreaming, scale]);
  return (
    <div
      data-pipper-id="assistant-markdown"
      className={cn(
        "min-w-0 max-w-full space-y-3 overflow-hidden whitespace-normal break-words [overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
    >
      <MarkdownRenderContext.Provider value={contextValue}>
        <ReactMarkdown
          components={
            components ? { ...defaultMarkdownComponents, ...components } : defaultMarkdownComponents
          }
          rehypePlugins={rehypePlugins}
          remarkPlugins={remarkPlugins}
        >
          {children}
        </ReactMarkdown>
      </MarkdownRenderContext.Provider>
    </div>
  );
}

export const MarkdownRenderer = memo(
  MarkdownRendererBase,
  (prev, next) =>
    prev.children === next.children &&
    prev.className === next.className &&
    prev.components === next.components &&
    prev.isStreaming === next.isStreaming,
);
