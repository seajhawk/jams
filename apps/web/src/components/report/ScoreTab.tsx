'use client'

import { useCallback, useState } from 'react'
import { Check, Loader2, Save } from 'lucide-react'
import type { ReportPayload, MeasureKind } from '@/lib/report-contract'
import { normalize, score } from '@/lib/effort-score'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { EffortScoreDial } from './EffortScoreDial'

interface ScoreTabProps {
  payload: ReportPayload
  weights: Partial<Record<MeasureKind, number>>
  onWeightsChange: (weights: Partial<Record<MeasureKind, number>>) => void
  readOnly?: boolean
}

export function ScoreTab({ payload, weights, onWeightsChange, readOnly = false }: ScoreTabProps) {
  const normalized = normalize(payload.measures, payload.video, payload.score.profile.normalization)
  const liveScore = score(normalized, weights)

  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const saveAsDefault = useCallback(async () => {
    setSaving(true)
    setSaved(false)
    setSaveError(null)
    try {
      const res = await fetch(`/api/weight-profiles/${payload.score.profile.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ weights }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? 'Failed to save')
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }, [payload.score.profile.id, weights])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <EffortScoreDial score={liveScore.total} />
          <div>
            <div className="text-2xl font-bold">{liveScore.total}</div>
            <div className="text-sm text-muted-foreground">Effort Score</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {saveError && (
            <span className="text-xs text-destructive">{saveError}</span>
          )}
          {!readOnly && (
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={saveAsDefault}
            >
              {saving ? (
                <Loader2 data-icon="inline-start" className="size-4 animate-spin" />
              ) : saved ? (
                <Check data-icon="inline-start" className="size-4 text-green-600" />
              ) : (
                <Save data-icon="inline-start" className="size-4" />
              )}
              {saved ? 'Saved' : 'Save as org default'}
            </Button>
          )}
          <button
            onClick={() => onWeightsChange(payload.score.profile.weights)}
            className="text-sm text-muted-foreground hover:text-foreground underline underline-offset-2"
          >
            Reset to profile
          </button>
        </div>
      </div>

      <div className="space-y-6">
        {liveScore.breakdown.map(item => (
          <div key={item.kind} className="space-y-2">
            <div className="flex items-center gap-4 text-sm">
              <span className="w-32 font-medium capitalize">
                {item.kind.replace(/_/g, ' ')}
              </span>
              <span className="w-16 text-muted-foreground">{item.raw} raw</span>
              <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all"
                  style={{ width: `${item.normalized}%` }}
                />
              </div>
              <span className="w-8 text-right">{item.normalized}</span>
              <span className="text-muted-foreground">× {item.weight}</span>
              <div className="w-24 h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-amber-500 rounded-full transition-all"
                  style={{ width: `${Math.min(100, item.contribution)}%` }}
                />
              </div>
              <span className="w-8 text-right text-muted-foreground">{item.contribution}</span>
            </div>
            <div className="pl-32">
              <Slider
                min={0}
                max={10}
                step={1}
                value={[weights[item.kind] ?? 0]}
                onValueChange={(vals) => {
                  // vals is readonly number[] when value is an array
                  const val = Array.isArray(vals) ? vals[0] : vals
                  onWeightsChange({ ...weights, [item.kind]: val })
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
