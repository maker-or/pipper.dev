'use client'

import type { RefObject } from 'react'
import { type SetController, useDataState } from '../kit/source-kit'
import styles from './copy.module.css'

// A copy button. Copying sets data-copied; the copy icon blurs, shrinks and fades out while the check does the
// reverse, on one clock.
export function SourceCopy({ rootRef, controllerRef }: { rootRef: RefObject<HTMLButtonElement | null>; controllerRef: RefObject<SetController | null> }) {
  useDataState(rootRef, controllerRef, 'copied')
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const
  return (
    <button ref={rootRef} type="button" aria-label="Copy link" className={styles.button} data-copied="false" data-source-copy style={{ background: '#f7f7f7', color: '#242529' }}>
      <svg className={`${styles.icon} ${styles.copy}`} data-copy-icon width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="2" {...stroke} /><path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" {...stroke} /></svg>
      <svg className={`${styles.icon} ${styles.check}`} data-check-icon width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" {...stroke} /></svg>
    </button>
  )
}
