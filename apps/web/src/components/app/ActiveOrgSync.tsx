"use client"

import { useEffect } from "react"
import { useAuth, useClerk } from "@clerk/nextjs"

export function ActiveOrgSync({ orgId }: { orgId: string }) {
  const { isLoaded, orgId: activeOrgId } = useAuth()
  const clerk = useClerk()

  useEffect(() => {
    if (!isLoaded || activeOrgId || !orgId) {
      return
    }

    void clerk.setActive({ organization: orgId })
  }, [activeOrgId, clerk, isLoaded, orgId])

  return null
}
