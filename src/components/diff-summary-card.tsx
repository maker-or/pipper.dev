import type { DiffTurnSummary } from "@/store/diff-store";
import { openDiffView } from "@/lib/diff-actions";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";

interface DiffSummaryCardProps {
  summary: DiffTurnSummary;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function DiffSummaryCard({ summary }: DiffSummaryCardProps) {
  const visibleFiles = summary.files.slice(0, 6);
  const remainingFiles = summary.files.length - visibleFiles.length;

  return (
    <section
      data-pipper-id="diff-summary-card"
      className="mt-3 overflow-hidden rounded-2xl border border-border/70 bg-surface-2/70 text-[12px]"
      aria-label="Changed files"
    >
      <div className="flex items-center gap-3 border-b border-border/60 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">Edited {summary.files.length}</div>
          <div className="mt-1 flex items-center gap-2 text-[11px] tabular-nums">
            <span className="text-emerald-500">+{summary.additions}</span>
            <span className="text-red-400">-{summary.deletions}</span>
          </div>
        </div>
        <Button
          type="button"
          variant="tertiary"
          size="sm"
          onClick={openDiffView}
          aria-label="Open latest changes"
        >
          Open
        </Button>
      </div>

      <Table className="text-[11px]">
        <caption className="sr-only">Files edited in this turn</caption>
        <TableBody>
          {visibleFiles.map((file, index) => (
            <TableRow key={file.path} index={index} className="border-border/50">
              <TableCell className="max-w-0 px-3 py-2">
                <span className="block truncate font-mono text-[11px]" title={file.path}>
                  {fileName(file.path)}
                </span>
              </TableCell>
              <TableCell className="px-3 py-2 text-right">
                <span className="inline-flex items-center gap-2 font-mono tabular-nums">
                  <span className="text-emerald-500">+{file.additions}</span>
                  <span className="text-red-400">-{file.deletions}</span>
                </span>
              </TableCell>
            </TableRow>
          ))}
          {remainingFiles > 0 && (
            <TableRow className="border-border/50">
              <TableCell colSpan={2} className="px-3 py-2 text-[11px] text-muted-foreground">
                +{remainingFiles} more
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </section>
  );
}
