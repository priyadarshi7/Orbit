import { describe, expect, it } from "vitest";
import { systemPrompt } from "../src/agent/prompt";
import { gate, leaksInstructions } from "../src/grounding/gate";

const valid = (ids: number[]) => (id: number) => ids.includes(id);

describe("grounding gate", () => {
  it("keeps citations that resolve and drops ones that do not", () => {
    const g = gate("Plan costs $20 [1]. It is free [9].", valid([1, 2]), { sourcesRetrieved: 2 });
    expect(g.text).toBe("Plan costs $20 [1]. It is free.");
    expect(g.cited).toEqual([1]);
    expect(g.dropped).toEqual([9]);
  });

  it("filters inside a multi-citation and renormalises", () => {
    const g = gate("Both agree [1, 5, 2].", valid([1, 2]), { sourcesRetrieved: 2 });
    expect(g.text).toBe("Both agree [1, 2].");
    expect(g.cited).toEqual([1, 2]);
  });

  it("leaves code spans and markdown links alone", () => {
    const g = gate("Use `arr[0]` and see [2](https://x.dev) and [1].", valid([1]), { sourcesRetrieved: 1 });
    expect(g.text).toContain("`arr[0]`");
    expect(g.text).toContain("[2](https://x.dev)");
    expect(g.cited).toEqual([1]);
  });

  it("strips echoed internal tags", () => {
    const g = gate("<evidence>leak</evidence> ok", valid([]), { sourcesRetrieved: 0 });
    expect(g.text).not.toMatch(/<\/?evidence>/);
  });

  it("warns when it searched but cited nothing", () => {
    const g = gate("No citations here.", valid([1]), { sourcesRetrieved: 3 });
    expect(g.warnings.join()).toMatch(/cited nothing/);
  });

  it("warns on undated relative time but not on dated sentences", () => {
    const bad = gate("Pricing changed recently.", valid([]), { sourcesRetrieved: 0 });
    expect(bad.warnings.join()).toMatch(/relative time/);
    const ok = gate("Pricing changed recently, on 3 November 2026.", valid([]), { sourcesRetrieved: 0 });
    expect(ok.warnings.join()).not.toMatch(/relative time/);
  });
});

describe("instruction-leak guard", () => {
  const sys = systemPrompt(4);

  it("blocks a reply that reproduces the system prompt", () => {
    const quoted = sys.split("\n").slice(2, 8).join("\n");
    expect(leaksInstructions(`Sure! Here it is:\n${quoted}`, sys)).toBe(true);
    expect(
      leaksInstructions("My instructions say: Cite every fact that comes from search as [n], right after the claim, where n is the id shown in the evidence.", sys),
    ).toBe(true);
  });

  it("allows ordinary answers, including a self-introduction", () => {
    const code = ["Here is a Python function:", "```python", "def reverse(head):", "    prev = None", "    while head:", "        head.next, prev, head = prev, head, head.next", "    return prev", "```"].join("\n");
    for (const ok of [
      "I'm Orbit, a research assistant with one tool, web search. I can search, cite sources and remember earlier chats.",
      "Acme Pro costs $29 per user per month, billed annually [1]. The Free plan covers up to 3 users [2].",
      "I could not confirm the second price; sources disagree, so I have named both and their dates.",
      code,
    ]) {
      expect(leaksInstructions(ok, sys), ok).toBe(false);
    }
  });
});

describe("normalizeModelText (model output variants)", () => {
  it("turns fullwidth and dagger citations into [n] so they resolve", () => {
    const r = gate("Paris【7】 and France【1†L1-L4】, also [2†L3].", () => true, { sourcesRetrieved: 3 });
    expect(r.text).toBe("Paris[7] and France[1], also [2].");
    expect(r.cited).toEqual([1, 2, 7]);
    expect(r.warnings.join()).not.toMatch(/cited nothing/);
  });

  it("replaces narrow no-break spaces and non-breaking hyphens", () => {
    const r = gate("Lisa Su is CEO of high‑end AMD.", () => true, { sourcesRetrieved: 0 });
    expect(r.text).toBe("Lisa Su is CEO of high-end AMD.");
  });
});

describe("leak guard and example wording", () => {
  it("does not flag the sanctioned example phrasing as a leak", () => {
    const prompt = systemPrompt(4);
    expect(leaksInstructions("I don't know your name yet. What should I call you?", prompt)).toBe(false);
  });
  it("still flags a real leak of the same prompt", () => {
    const prompt = systemPrompt(4);
    const leak = prompt.split("\n").filter((l) => l.startsWith("- Cite every fact"))[0]!;
    expect(leaksInstructions(leak, prompt)).toBe(true);
  });
});
