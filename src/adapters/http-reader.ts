import { Readability } from "@mozilla/readability";
import { lookup as dnsLookup } from "node:dns";
import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { parseHTML } from "linkedom";
import type { PageContent, PageReader } from "../ports";

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 5_000;
const UA = "Mozilla/5.0 (compatible; OrbitAgent/0.1; +https://example.invalid/bot)";

/** Refuse non-web schemes and obviously internal hosts. Search results are the only URL source. */
export function isSafeUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return false;
  if (/^\[?::1\]?$/.test(h) || /^\[?(fc|fd|fe80)/i.test(h)) return false;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
  }
  return true;
}

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses (IPv4 and IPv6). */
export function isPrivateIp(ip: string): boolean {
  let a = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = a.match(/^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) a = mapped[1]!;
  const v4 = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [x, y] = [Number(v4[1]), Number(v4[2])];
    return (
      x === 0 || x === 10 || x === 127 || x >= 224 ||
      (x === 100 && y >= 64 && y <= 127) ||
      (x === 169 && y === 254) ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && (y === 168 || y === 0)) ||
      (x === 198 && (y === 18 || y === 19))
    );
  }
  if (a.includes(":")) return a === "::" || a === "::1" || /^(fc|fd|fe[89ab]|ff)/.test(a);
  return false;
}

export type Resolver = (host: string) => Promise<string[]>;
const defaultResolve: Resolver = async (host) => (await lookup(host, { all: true })).map((r) => r.address);

/** Syntax check plus DNS: every address the name resolves to must be public. */
export async function isPublicUrl(raw: string, resolve: Resolver = defaultResolve): Promise<boolean> {
  if (!isSafeUrl(raw)) return false;
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
  if (isPrivateIp(host)) return false;
  if (/^[\d.]+$/.test(host) || host.includes(":")) return true; // a public literal IP
  try {
    const addrs = await resolve(host);
    return addrs.length > 0 && addrs.every((x) => !isPrivateIp(x));
  } catch {
    return false;
  }
}

/**
 * The address a connection actually dials is checked here, inside the socket's own DNS lookup, so there is
 * no gap between "we checked this name" and "we connected to it": a name that resolves to a public address
 * for our check and a private one for the connection (DNS rebinding) is refused at connect time.
 */
export const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return (callback as (e: Error) => void)(err);
    const list = addrs as { address: string; family: number }[];
    if (list.length === 0 || list.some((a) => isPrivateIp(a.address))) {
      return (callback as (e: Error) => void)(new Error(`blocked: ${hostname} resolves to a non-public address`));
    }
    if (options.all) (callback as (e: null, a: unknown) => void)(null, list);
    else (callback as (e: null, a: string, f: number) => void)(null, list[0]!.address, list[0]!.family);
  });
};

const pinnedAgent = new Agent({ connect: { lookup: safeLookup } });
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
const pinnedFetch: Fetcher = (url, init) =>
  undiciFetch(url, { ...init, dispatcher: pinnedAgent } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  void reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).toString("utf8");
}

function metaDate(doc: Document): string | undefined {
  const sel = [
    'meta[property="article:published_time"]',
    'meta[property="og:published_time"]',
    'meta[name="date"]',
    'meta[name="pubdate"]',
    'meta[itemprop="datePublished"]',
    'meta[name="publish-date"]',
  ];
  for (const s of sel) {
    const v = doc.querySelector(s)?.getAttribute("content");
    if (v && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString().slice(0, 10);
  }
  const t = doc.querySelector("time[datetime]")?.getAttribute("datetime");
  if (t && !Number.isNaN(Date.parse(t))) return new Date(t).toISOString().slice(0, 10);
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    const m = s.textContent?.match(/"datePublished"\s*:\s*"([^"]+)"/);
    if (m?.[1] && !Number.isNaN(Date.parse(m[1]))) return new Date(m[1]).toISOString().slice(0, 10);
  }
  return undefined;
}

function blocksOf(html: string): string {
  const { document } = parseHTML(`<body>${html}</body>`);
  const out: string[] = [];
  for (const el of Array.from(document.querySelectorAll("h1,h2,h3,h4,p,li,pre,td,blockquote"))) {
    const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (t.length > 1) out.push(/^H[1-4]$/.test(el.tagName) ? `## ${t}` : t);
  }
  return out.join("\n\n");
}

export interface ReadResult extends PageContent {
  publishedDate?: string;
}

export class HttpPageReader implements PageReader {
  constructor(
    private readonly resolve: Resolver = defaultResolve,
    private readonly fetcher: Fetcher = pinnedFetch,
  ) {}

  async read(url: string, signal?: AbortSignal): Promise<ReadResult | null> {
    if (!(await isPublicUrl(url, this.resolve))) return null;
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      // Follow redirects by hand so every hop is checked, not only the first URL.
      let current = url;
      let res: Response | null = null;
      for (let hop = 0; hop < 5; hop++) {
        const r = await this.fetcher(current, {
          signal: sig,
          redirect: "manual",
          headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.8" },
        });
        if (r.status >= 300 && r.status < 400) {
          const loc = r.headers.get("location");
          if (!loc) return null;
          current = new URL(loc, current).toString();
          if (!(await isPublicUrl(current, this.resolve))) return null;
          continue;
        }
        res = r;
        break;
      }
      if (!res || !res.ok) return null;
      const type = res.headers.get("content-type") ?? "";
      if (!/html|text\/plain|xml/i.test(type)) return null;
      const raw = await readCapped(res);
      if (/text\/plain/i.test(type)) return { url, text: raw.slice(0, 60_000) };

      const { document } = parseHTML(raw);
      const publishedDate = metaDate(document as unknown as Document);
      const title = document.querySelector("title")?.textContent?.trim() || undefined;
      let text = "";
      // Readability edits the document it parses, so take the plain-text fallback first.
      const bodyText = (document.body?.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      try {
        const article = new Readability(document as unknown as Document, { charThreshold: 200 }).parse();
        if (article?.content) text = blocksOf(article.content);
      } catch {
        /* fall through to body text */
      }
      if (text.length < 300 && bodyText.length > text.length) text = bodyText;
      if (text.length < 120) return null;
      return { url, title, text: text.slice(0, 80_000), publishedDate };
    } catch {
      return null;
    }
  }
}
