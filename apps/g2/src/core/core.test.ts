import { describe, expect, it } from "vitest";
import { CreateAlertResponseSchema } from "@haven/contracts";
import { makeAlertRecord } from "@haven/contracts/testing";
import { FakeBridge } from "../testing";
import { BLANK_HUD_CONTENT, G2_CANVAS, HUD_CONTAINER, createBlankHud } from "./bootstrap";
import { BridgeUnavailableError } from "./bridge";
import { loadG2Config } from "./config";
import { HavenApiError, createHttpClient } from "./http";
import { createMemoryStorage, createSessionStore } from "./session-store";

const TOKEN = `hvn_${"A".repeat(43)}`;

describe("createBlankHud", () => {
  it("creates exactly one blank, full-canvas, event-capturing text container", async () => {
    const bridge = new FakeBridge();
    await createBlankHud(bridge);
    expect(bridge.pages).toHaveLength(1);
    const page = bridge.pages[0]!;
    expect(page.containerTotalNum).toBe(1);
    expect(page.listObject ?? []).toHaveLength(0);
    expect(page.imageObject ?? []).toHaveLength(0);
    expect(page.textObject).toHaveLength(1);
    expect(page.textObject![0]).toMatchObject({
      containerID: HUD_CONTAINER.id,
      containerName: HUD_CONTAINER.name,
      isEventCapture: 1,
      content: BLANK_HUD_CONTENT,
      xPosition: 0,
      yPosition: 0,
      width: G2_CANVAS.width,
      height: G2_CANVAS.height,
      borderWidth: 0,
    });
    expect(BLANK_HUD_CONTENT.trim()).toBe("");
    expect(HUD_CONTAINER.name.length).toBeLessThanOrEqual(16);
  });

  it("reports a non-zero startup result as BridgeUnavailableError", async () => {
    const bridge = new FakeBridge();
    bridge.startUpResult = 1;
    await expect(createBlankHud(bridge)).rejects.toBeInstanceOf(BridgeUnavailableError);
  });
});

describe("session store", () => {
  it("persists, expires, and clears sessions", async () => {
    let now = 1_000;
    const storage = createMemoryStorage();
    const store = createSessionStore(storage, () => now);
    expect(await store.load()).toBeNull();
    await store.save({ token: TOKEN, expiresAt: 5_000 });
    expect(await createSessionStore(storage, () => now).load()).toEqual({
      token: TOKEN,
      expiresAt: 5_000,
    });
    now = 5_000;
    expect(await store.load()).toBeNull();
    await store.clear();
    expect(storage.data.size).toBe(0);
  });

  it("ignores corrupted storage", async () => {
    const storage = createMemoryStorage();
    await storage.set("haven.session.v1", "{not json");
    expect(await createSessionStore(storage).load()).toBeNull();
  });
});

describe("http client", () => {
  async function client(handler: (req: Request) => Response | Promise<Response>, paired = true) {
    const sessions = createSessionStore(createMemoryStorage());
    if (paired) await sessions.save({ token: TOKEN, expiresAt: Date.now() + 60_000 });
    const requests: Request[] = [];
    const http = createHttpClient({
      baseUrl: "http://api.test/",
      sessions,
      defaultTimeoutMs: 50,
      fetch: async (input, init) => {
        const req = new Request(input, init);
        requests.push(req);
        return handler(req);
      },
    });
    return { http, requests };
  }

  it("sends the bearer token and validates the response against the contract", async () => {
    const body = { alert: makeAlertRecord(), created: true };
    const { http, requests } = await client(() => Response.json(body, { status: 201 }));
    const result = await http.json({
      method: "POST",
      path: "/api/v1/alerts",
      body: { hello: "world" },
      schema: CreateAlertResponseSchema,
    });
    expect(result.created).toBe(true);
    expect(requests[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(requests[0]!.headers.get("content-type")).toBe("application/json");
    expect(requests[0]!.url).toBe("http://api.test/api/v1/alerts");
  });

  it("maps the error envelope to HavenApiError", async () => {
    const { http } = await client(() =>
      Response.json(
        { error: { code: "rate_limited", message: "slow down", requestId: "req-1" } },
        { status: 429 },
      ),
    );
    const error = await http
      .json({ method: "GET", path: "/x", schema: CreateAlertResponseSchema })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HavenApiError);
    expect(error).toMatchObject({
      code: "rate_limited",
      status: 429,
      requestId: "req-1",
      retryable: true,
    });
  });

  it("rejects responses that do not match the contract", async () => {
    const { http } = await client(() => Response.json({ alert: { nope: true } }));
    await expect(
      http.json({ method: "GET", path: "/x", schema: CreateAlertResponseSchema }),
    ).rejects.toMatchObject({ code: "invalid_response", retryable: false });
  });

  it("times out and reports network errors as retryable", async () => {
    const { http } = await client(
      (req) =>
        new Promise<Response>((_, reject) =>
          req.signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    await expect(
      http.json({ method: "GET", path: "/slow", schema: CreateAlertResponseSchema }),
    ).rejects.toMatchObject({ code: "timeout", retryable: true });

    const offline = await client(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      offline.http.json({ method: "GET", path: "/x", schema: CreateAlertResponseSchema }),
    ).rejects.toMatchObject({ code: "network_error", retryable: true });
  });

  it("refuses authenticated calls before pairing, but allows auth: false", async () => {
    const { http, requests } = await client(
      () => Response.json({ alert: makeAlertRecord(), created: false }),
      false,
    );
    await expect(
      http.json({ method: "GET", path: "/x", schema: CreateAlertResponseSchema }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await http.json({ method: "GET", path: "/x", schema: CreateAlertResponseSchema, auth: false });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get("authorization")).toBeNull();
  });

  it("uploads binary bodies with query parameters", async () => {
    const { http, requests } = await client(() =>
      Response.json({ alert: makeAlertRecord(), created: false }),
    );
    await http.binary({
      method: "POST",
      path: "/chunks",
      query: { index: 3, skip: undefined },
      body: new Uint8Array([1, 2, 3]),
      contentType: "application/octet-stream",
      schema: CreateAlertResponseSchema,
    });
    const req = requests[0]!;
    expect(req.url).toBe("http://api.test/chunks?index=3");
    expect(new Uint8Array(await req.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("config", () => {
  it("defaults to the local API and rejects invalid URLs", () => {
    expect(loadG2Config({}).apiBaseUrl).toBe("http://localhost:8787");
    expect(loadG2Config({ VITE_HAVEN_API_BASE_URL: "https://haven.example.com/" }).apiBaseUrl).toBe(
      "https://haven.example.com",
    );
    expect(() => loadG2Config({ VITE_HAVEN_API_BASE_URL: "ftp://x" })).toThrow();
  });
});
