'use client'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface DeltaChipProps {
  /** b − a; positive = more effort in B (red), negative = less (green) */
  delta: number
  label?: string
  'data-testid'?: string
}

export function DeltaChip({ delta, label, 'data-testid': testId }: DeltaChipProps) {
  const sign = delta > 0 ? '+' : ''
  const color =
    delta < 0
      ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
      : delta > 0
        ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
        : 'bg-muted text-muted-foreground'

  const tooltip =
    delta < 0
      ? 'B has less effort than A'
      : delta > 0
        ? 'B has more effort than A'
        : 'No difference'

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger>
          <span
            data-testid={testId ?? 'delta-chip'}
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums',
              color,
            )}
          >
            {label && <span className="mr-1 opacity-70">{label}</span>}
            {sign}{delta}
          </span>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
