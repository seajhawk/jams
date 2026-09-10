import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const spec = readFileSync(new URL("./eval.yaml", import.meta.url), "utf8");
const match = spec.match(/pattern: '([^']+)'/g)?.at(-1);
assert.ok(match, "The no-LLM file-matches pattern must exist.");
const pattern = match.slice("pattern: '".length, -1);
const grader = new RegExp(pattern.replace(/^\(\?is\)/, ""), "is");

for (const example of [
  "Tests and CI make no LLM calls.",
  "No LLM calls are allowed in tests or CI.",
  "An LLM must never be invoked in CI.",
]) {
  assert.match(example, grader, `Expected compliant wording to pass: ${example}`);
}

for (const example of [
  "Use no LLM initially. In CI use LLM calls for tests.",
  "Tests will call an LLM. CI runs the same tests.",
]) {
  assert.doesNotMatch(example, grader, `Expected non-compliant wording to fail: ${example}`);
}
