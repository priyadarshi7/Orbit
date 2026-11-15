import { describe, expect, it } from "vitest";
import { groundedFacts } from "../src/memory/writer";

describe("groundedFacts", () => {
  it("drops the chat date mistaken for a birthday (the reported bug)", () => {
    const msg = "On which date did I tell you about my birthday?";
    expect(groundedFacts(["Birthday is 14 November"], msg)).toEqual([]);
    expect(groundedFacts(["Birthday is on 14 November 2026"], msg)).toEqual([]);
  });
  it("keeps facts the user actually stated", () => {
    expect(groundedFacts(["Birthday is 30 April 2005"], "My birthday is 30th April 2005")).toEqual(["Birthday is 30 April 2005"]);
    expect(groundedFacts(["Works on a 20-person sales team"], "I work on a 20 person sales team, which CRM?")).toEqual(["Works on a 20-person sales team"]);
    expect(groundedFacts(["Lives in Canberra"], "I live in canberra")).toEqual(["Lives in Canberra"]);
  });
  it("drops invented names and numbers but keeps plain paraphrase", () => {
    expect(groundedFacts(["Lives in Sydney"], "I live in Canberra")).toEqual([]);
    expect(groundedFacts(["Has a team of 12"], "we are a small team")).toEqual([]);
    expect(groundedFacts(["Prefers short answers"], "please keep answers short")).toEqual(["Prefers short answers"]);
  });
});
