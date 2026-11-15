import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { MemoryStore } from "../memory/store";

/**
 * Anonymous, per-browser accounts. A session is `userId.signature`, where the signature is an HMAC of the
 * user id under a server secret, so a client cannot invent or alter an id to read someone else's memory.
 * It is deliberately small: swap `Sessions` for a real identity provider and the rest of the server
 * only ever sees a verified `userId`.
 */
export class Sessions {
  constructor(private readonly secret: string) {}

  /** Uses the configured secret, or one generated once and kept in the database, so tokens survive restarts. */
  static open(store: MemoryStore, configured?: string): Sessions {
    let secret = configured ?? store.getMeta("auth_secret");
    if (!secret) {
      secret = randomBytes(32).toString("base64url");
      store.setMeta("auth_secret", secret);
    }
    return new Sessions(secret);
  }

  private sign(userId: string): string {
    return createHmac("sha256", this.secret).update(userId).digest("base64url");
  }

  create(): { userId: string; token: string } {
    const userId = `u_${randomBytes(16).toString("base64url")}`;
    return { userId, token: `${userId}.${this.sign(userId)}` };
  }

  /** The user id, or null when the token is missing, malformed or not signed by this server. */
  verify(token: string | undefined | null): string | null {
    if (!token) return null;
    const dot = token.lastIndexOf(".");
    if (dot < 3) return null;
    const userId = token.slice(0, dot);
    const sig = Buffer.from(token.slice(dot + 1));
    const want = Buffer.from(this.sign(userId));
    return sig.length === want.length && timingSafeEqual(sig, want) ? userId : null;
  }
}

export function bearer(header: string | undefined | null): string | null {
  const m = header?.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1]! : null;
}
