import { describe, expect, it } from "vitest";
import { CASES } from "../src/eval/cases";

/** The eval suite is code too: a typo in a regex or a contradictory expectation should fail CI, not a live run. */
describe("eval cases are well-formed", () => {
  it("has unique ids", () => {
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(CASES.map((c) => [c.id, c] as const))("%s: regexes compile and expectations agree", (_id, c) => {
    for (const re of [...(c.expect.mustMatch ?? []), ...(c.expect.mustNotMatch ?? [])]) {
      expect(() => new RegExp(re, "i"), `bad regex ${re}`).not.toThrow();
    }
    expect(c.rubric.length).toBeGreaterThan(20);
    expect(typeof c.message === "function" || c.message.trim().length > 0).toBe(true);
    // a case that forbids searching cannot also demand citations
    if (c.expect.search === false) expect(c.expect.minCitations ?? 0).toBe(0);
  });

  it("covers every category at least once", () => {
    const cats = new Set(CASES.map((c) => c.category));
    for (const want of ["no_search", "fresh_fact", "multi_hop", "comparison", "ambiguous", "followup", "dated_recall", "change_detection", "no_record", "injection", "conversation", "freshness", "multilingual"]) {
      expect(cats.has(want as never), `missing ${want}`).toBe(true);
    }
  });
});
