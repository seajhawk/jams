'use client'

import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'

interface EffortScoreDialProps {
  score: number
  /** Optional data-testid override (default: "score-dial") */
  testId?: string
}

function dialColor(value: number): string {
  if (value <= 33) return 'text-green-500'
  if (value <= 66) return 'text-amber-500'
  return 'text-red-500'
}

export function EffortScoreDial({ score, testId = 'score-dial' }: EffortScoreDialProps) {
  const r = 48
  const cx = 60
  const cy = 60
  const circumference = 2 * Math.PI * r
  const arcLength = (270 / 360) * circumference
  const filled = (score / 100) * arcLength

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<svg data-testid={testId} width={80} height={80} viewBox="0 0 120 120" aria-label={`Effort score: ${score}`} />}>
          {/* Background arc */}
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="currentColor"
            className="text-muted-foreground/20"
            strokeWidth={8}
            strokeDasharray={`${arcLength} ${circumference}`}
            strokeDashoffset={0}
            strokeLinecap="round"
            transform="rotate(135 60 60)"
          />
          {/* Foreground arc */}
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="currentColor"
            className={dialColor(score)}
            strokeWidth={8}
            strokeDasharray={`${filled} ${circumference}`}
            strokeDashoffset={0}
            strokeLinecap="round"
            transform="rotate(135 60 60)"
          />
          <text
            x={60}
            y={55}
            textAnchor="middle"
            className="fill-foreground"
            fontSize={22}
            fontWeight="bold"
          >
            {score}
          </text>
          <text
            x={60}
            y={72}
            textAnchor="middle"
            className="fill-muted-foreground"
            fontSize={11}
          >
            / 100
          </text>
        </TooltipTrigger>
        <TooltipContent>
          <span>Lower is easier</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
