import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpPageReader, isPrivateIp, isPublicUrl } from "../src/adapters/http-reader";

afterEach(() => vi.unstubAllGlobals());

describe("isPrivateIp", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "[::1]",
  ])("blocks %s", (ip) => expect(isPrivateIp(ip)).toBe(true));

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "93.184.216.34", "2606:4700:4700::1111"])("allows %s", (ip) =>
    expect(isPrivateIp(ip)).toBe(false),
  );
});

describe("isPublicUrl", () => {
  const to = (...addrs: string[]) => async () => addrs;

  it("accepts a name that resolves only to public addresses", async () => {
    expect(await isPublicUrl("https://example.com/a", to("93.184.216.34"))).toBe(true);
  });

  it("rejects a public-looking name that resolves to an internal address (DNS rebinding style)", async () => {
    expect(await isPublicUrl("https://innocent.example.com/", to("127.0.0.1"))).toBe(false);
    expect(await isPublicUrl("https://innocent.example.com/", to("93.184.216.34", "10.0.0.5"))).toBe(false);
  });

  it("rejects when resolution fails or returns nothing", async () => {
    expect(await isPublicUrl("https://nope.example.com/", async () => { throw new Error("ENOTFOUND"); })).toBe(false);
    expect(await isPublicUrl("https://nope.example.com/", to())).toBe(false);
  });

  it("rejects internal literals, odd schemes and encoded IPs without needing DNS", async () => {
    const never = async () => { throw new Error("should not resolve"); };
    expect(await isPublicUrl("http://169.254.169.254/latest/meta-data", never)).toBe(false);
    expect(await isPublicUrl("http://[::1]:8000/", never)).toBe(false);
    expect(await isPublicUrl("http://2130706433/", never)).toBe(false); // decimal 127.0.0.1, normalised by URL
    expect(await isPublicUrl("file:///etc/passwd", never)).toBe(false);
    expect(await isPublicUrl("http://localhost/", never)).toBe(false);
  });
});

describe("HttpPageReader redirects", () => {
  const html = `<html><head><title>Doc</title></head><body><article>${"A real paragraph of useful page text. ".repeat(30)}</article></body></html>`;

  it("does not follow a redirect from a public page to an internal address", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      calls.push(u);
      return u.startsWith("https://public.example.com")
        ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } })
        : new Response("SECRET", { status: 200, headers: { "content-type": "text/plain" } });
    }));
    const reader = new HttpPageReader(async () => ["93.184.216.34"]);
    expect(await reader.read("https://public.example.com/start")).toBeNull();
    expect(calls).toEqual(["https://public.example.com/start"]); // the internal URL was never requested
  });

  it("follows a redirect between public pages and still reads the content", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) =>
      u.endsWith("/old")
        ? new Response(null, { status: 301, headers: { location: "/new" } })
        : new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    ));
    const out = await new HttpPageReader(async () => ["93.184.216.34"]).read("https://public.example.com/old");
    expect(out?.text).toContain("useful page text");
  });

  it("gives up after too many redirects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "/loop" } })));
    expect(await new HttpPageReader(async () => ["93.184.216.34"]).read("https://public.example.com/loop")).toBeNull();
  });
});
