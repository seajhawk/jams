import { expect, test } from "@playwright/test"

// Regression: --font-sans once referred to itself, so every page fell back to the browser's
// default serif (Times New Roman). The landing page is public, so no sign-in is needed.
test("pages render in the app's sans font, not the browser's serif fallback", async ({ page }) => {
  await page.goto("/")
  const fontFamily = await page.evaluate(() => getComputedStyle(document.body).fontFamily)
  expect(fontFamily).toMatch(/Geist/i)
  expect(fontFamily).not.toMatch(/Times/i)
})
