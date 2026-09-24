import { describe, expect, it } from "vitest"

import { csvEscape } from "@/lib/report-export"

describe("csvEscape", () => {
  it.each([
    ["=HYPERLINK(\"https://evil.example\",\"open\")", "\"'=HYPERLINK(\"\"https://evil.example\"\",\"\"open\"\")\""],
    ["+1 555 0100", "'+1 555 0100"],
    ["-5 dollars off", "'-5 dollars off"],
    ["@SUM(A1:A9)", "'@SUM(A1:A9)"],
    ["\tleading tab", "'\tleading tab"],
  ])("neutralizes text that a spreadsheet would run as a formula: %s", (input, expected) => {
    expect(csvEscape(input)).toBe(expected)
  })

  it("keeps a negative number numeric, so sentiment scores still sort and sum", () => {
    expect(csvEscape(-0.82)).toBe("-0.82")
  })

  it("leaves ordinary speech alone", () => {
    expect(csvEscape("Where is the checkout button")).toBe("Where is the checkout button")
  })

  it("still quotes commas, quotes and newlines", () => {
    expect(csvEscape("one, two")).toBe("\"one, two\"")
    expect(csvEscape("say \"hi\"")).toBe("\"say \"\"hi\"\"\"")
    expect(csvEscape("line\nbreak")).toBe("\"line\nbreak\"")
  })

  it("writes nothing for a missing value", () => {
    expect(csvEscape(null)).toBe("")
  })
})
