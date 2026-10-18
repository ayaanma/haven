import { describe, expect, it } from "vitest";
import { idPattern } from "@haven/contracts";
import { constantTimeEqual, newId, randomToken, sha256Hex } from "./crypto";
import { createLogger } from "./logger";
import { createRateLimiter } from "./rate-limit";

describe("crypto", () => {
  it("mints IDs matching the contract pattern", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId("alt")));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(idPattern("alt"));
  });

  it("hashes and compares", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(constantTimeEqual("same", "same")).toBe(true);
    expect(constantTimeEqual("same", "different-length")).toBe(false);
    expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("logger", () => {
  it("redacts sensitive keys at any depth", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l) });
    log.info("x", {
      phoneNumber: "+14155550123",
      nested: { latitude: 34.1, sessionToken: "hvn_secret", text: "help" },
      contextStatus: "completed",
    });
    const out = lines.join();
    expect(out).not.toContain("+14155550123");
    expect(out).not.toContain("34.1");
    expect(out).not.toContain("hvn_secret");
    expect(out).not.toContain("help");
    expect(out).toContain("completed");
  });
});

describe("rate limiter", () => {
  it("allows `limit` attempts per window", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1_000, clock: { now: () => now } });
    expect([limiter.attempt("a"), limiter.attempt("a"), limiter.attempt("a")]).toEqual([
      true,
      true,
      false,
    ]);
    expect(limiter.attempt("b")).toBe(true);
    now = 1_000;
    expect(limiter.attempt("a")).toBe(true);
  });
});
