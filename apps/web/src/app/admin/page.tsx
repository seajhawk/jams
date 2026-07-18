import { AlertTriangle, ShieldAlert } from "lucide-react"
import Link from "next/link"
import { Fragment } from "react"

import { AdminActionButton } from "@/components/admin/AdminActionButton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import {
  type AdminRunFilter,
  type AdminRunRow,
  listAdminRuns,
} from "@/lib/admin-runs"
import { peekAnalysisPoisonMessages } from "@/lib/queue"

export const dynamic = "force-dynamic"

const filters: AdminRunFilter[] = ["failed", "partial", "stuck"]

function parseFilter(value: string | string[] | undefined): AdminRunFilter {
  const raw = Array.isArray(value) ? value[0] : value
  return raw === "partial" || raw === "stuck" ? raw : "failed"
}

function formatDate(value: Date | null) {
  return value?.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }) ?? "Not started"
}

function formatJson(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2)
}

function RunActions({ run, filter }: { run: AdminRunRow; filter: AdminRunFilter }) {
  return (
    <div className="flex flex-wrap gap-2">
      <AdminActionButton
        endpoint={`/api/admin/runs/${run.id}/requeue`}
        label="Requeue"
      />
      {filter === "stuck" && (
        <AdminActionButton
          endpoint={`/api/admin/runs/${run.id}/mark-failed`}
          label="Mark failed"
          variant="destructive"
        />
      )}
    </div>
  )
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { status } = await searchParams
  const filter = parseFilter(status)
  const [runs, poisonResult] = await Promise.all([
    listAdminRuns(filter),
    peekAnalysisPoisonMessages().then(
      (messages) => ({ ok: true as const, messages }),
      (error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : "Unable to load poison queue",
      })
    ),
  ])

  return (
    <main className="min-h-screen bg-muted/25">
      <section className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 md:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <ShieldAlert className="size-5 text-primary" />
              <h1 className="text-2xl font-semibold">Platform admin</h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Platform-wide analysis run triage and poison queue recovery.
            </p>
          </div>
          <Button variant="outline" nativeButton={false} render={<Link href="/library" />}>
            Back to app
          </Button>
        </div>

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>Runs</CardTitle>
              <div className="flex flex-wrap gap-2">
                {filters.map((item) => (
                  <Button
                    key={item}
                    size="sm"
                    variant={item === filter ? "default" : "outline"}
                    nativeButton={false}
                    render={<Link href={`/admin?status=${item}`} />}
                  >
                    {item}
                  </Button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Org</th>
                    <th className="py-2 pr-3 font-medium">Video</th>
                    <th className="py-2 pr-3 font-medium">Stage</th>
                    <th className="py-2 pr-3 font-medium">Error</th>
                    <th className="py-2 pr-3 font-medium">Attempt</th>
                    <th className="py-2 pr-3 font-medium">Started</th>
                    <th className="py-2 pr-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <Fragment key={run.id}>
                      <tr className="border-b align-top">
                        <td className="py-3 pr-3 font-mono text-xs">{run.orgId}</td>
                        <td className="py-3 pr-3">
                          <div className="max-w-56">
                            <p className="truncate font-medium">
                              {run.videoTitle ?? run.videoId}
                            </p>
                            <p className="truncate font-mono text-xs text-muted-foreground">
                              {run.videoId}
                            </p>
                          </div>
                        </td>
                        <td className="py-3 pr-3">
                          <Badge variant="outline">{run.stage}</Badge>
                        </td>
                        <td className="py-3 pr-3">
                          {run.errorCode ?? (
                            <span className="text-muted-foreground">None</span>
                          )}
                        </td>
                        <td className="py-3 pr-3 tabular-nums">{run.attempt}</td>
                        <td className="py-3 pr-3">{formatDate(run.startedAt)}</td>
                        <td className="py-3 pr-3">
                          <RunActions run={run} filter={filter} />
                        </td>
                      </tr>
                      <tr className="border-b last:border-0">
                        <td colSpan={7} className="pb-3">
                          <details className="rounded-md border bg-background p-3">
                            <summary className="cursor-pointer text-sm font-medium">
                              Error detail and provider results
                            </summary>
                            <div className="mt-3 grid gap-3 border-t pt-3 lg:grid-cols-2">
                              <div>
                                <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">
                                  Error detail
                                </p>
                                <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">
                                  {run.stageDetail ?? "No detail recorded."}
                                </pre>
                              </div>
                              <div>
                                <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">
                                  Provider results
                                </p>
                                <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">
                                  {formatJson(run.providerResults)}
                                </pre>
                              </div>
                            </div>
                          </details>
                        </td>
                      </tr>
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>

            {runs.length === 0 && (
              <div className="py-10 text-center text-sm text-muted-foreground">
                No {filter} runs found.
              </div>
            )}

          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-600" />
              <CardTitle>Poison queue</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            {!poisonResult.ok ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {poisonResult.error}
              </div>
            ) : poisonResult.messages.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No poison messages visible.
              </p>
            ) : (
              <div className="space-y-3">
                {poisonResult.messages.map((message) => (
                  <div key={message.id} className="rounded-md border bg-background p-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs">{message.id}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Dequeued {message.dequeueCount} times
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <AdminActionButton
                          endpoint={`/api/admin/poison/${message.id}/requeue`}
                          label="Requeue"
                        />
                        <AdminActionButton
                          endpoint={`/api/admin/poison/${message.id}/delete`}
                          label="Delete"
                          variant="destructive"
                        />
                      </div>
                    </div>
                    <Separator className="my-3" />
                    <pre className="max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs">
                      {message.body}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </main>
  )
}
