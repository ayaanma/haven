import { afterEach, describe, expect, it, vi } from "vitest";
import { ContactsResponseSchema, ROUTES, type EmergencyContact } from "@haven/contracts";
import { getContactRow } from "../contacts/repository";
import { silentLogger } from "../lib/logger";
import { testConfig } from "../testing";
import { buildMessageReceivedEvent } from "./mock-webhook";
import { createLineService, type LineAssignment, type PhotonLineService } from "./lines";
import {
  ScriptedTransport,
  createPhotonHarness,
  postSOS,
  postWebhook,
  waitForEvent,
  type PhotonHarness,
} from "./testing";

const PROJECT = "pho_prj_01k0000000000000000000000a";
const LIVE_SHARED = {
  PHOTON_MODE: "live",
  PHOTON_API_KEY: "pho_sk_test_0123456789",
  PHOTON_PROJECT_ID: PROJECT,
  PHOTON_WEBHOOK_SECRET: `whsec_${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}`,
  PUBLIC_BASE_URL: "https://haven.example",
};

/** In-memory stand-in for Photon's shared-line pool. */
class FakeLines implements PhotonLineService {
  readonly perContact = true;
  readonly assigned: string[] = [];
  readonly released: string[] = [];
  fail = false;
  private next = 0;
  async assign(contact: { id: string; phoneNumber: string }): Promise<LineAssignment | null> {
    if (this.fail) return null;
    this.assigned.push(contact.phoneNumber);
    this.next++;
    return { lineNumber: `+1628316790${this.next}`, assignmentId: `asg_${this.next}` };
  }
  async release(assignmentId: string): Promise<void> {
    this.released.push(assignmentId);
  }
}

let h: PhotonHarness | undefined;
afterEach(() => {
  h?.close();
  h = undefined;
});

async function saveContacts(contacts: unknown[]): Promise<EmergencyContact[]> {
  const res = await h!.json("PUT", ROUTES.contacts, { contacts });
  expect(res.status).toBe(200);
  return ContactsResponseSchema.parse(await res.json()).contacts;
}

async function listContacts(): Promise<EmergencyContact[]> {
  const res = await h!.json("GET", ROUTES.contacts);
  return ContactsResponseSchema.parse(await res.json()).contacts;
}

describe("per-contact shared lines", () => {
  it("assigns each new contact a line and shows it as the opt-in number", async () => {
    const lines = new FakeLines();
    h = createPhotonHarness({ lines });
    const [mom, dad] = await saveContacts([
      { displayName: "Mom", phoneNumber: "+14155550101", enabled: true },
      { displayName: "Dad", phoneNumber: "+14155550102", enabled: true },
    ]);
    expect(mom?.optInNumber).toBe("+16283167901");
    expect(dad?.optInNumber).toBe("+16283167902");
    // Saving again does not assign twice.
    await saveContacts([
      { id: mom!.id, displayName: "Mom", phoneNumber: "+14155550101", enabled: true },
      { id: dad!.id, displayName: "Dad", phoneNumber: "+14155550102", enabled: false },
    ]);
    expect(lines.assigned).toHaveLength(2);
  });

  it("releases the line when a contact is removed or changes number", async () => {
    const lines = new FakeLines();
    h = createPhotonHarness({ lines });
    const [mom, dad] = await saveContacts([
      { displayName: "Mom", phoneNumber: "+14155550101", enabled: true },
      { displayName: "Dad", phoneNumber: "+14155550102", enabled: true },
    ]);
    const after = await saveContacts([
      { id: mom!.id, displayName: "Mom", phoneNumber: "+14155550109", enabled: true },
    ]);
    expect(lines.released.sort()).toEqual(["asg_1", "asg_2"]);
    expect(after[0]).toMatchObject({ optInNumber: "+16283167903", consent: { status: "pending" } });
    expect(after.some((c) => c.id === dad!.id)).toBe(false);
  });

  it("retries a failed assignment on a later read", async () => {
    const lines = new FakeLines();
    lines.fail = true;
    h = createPhotonHarness({ lines });
    const [mom] = await saveContacts([
      { displayName: "Mom", phoneNumber: "+14155550101", enabled: true },
    ]);
    expect(mom?.optInNumber).toBeNull();
    lines.fail = false;
    h.clock.advance(61_000);
    expect((await listContacts())[0]?.optInNumber).toBe("+16283167901");
  });

  it("uses PHOTON_LINE_NUMBER when every contact texts the same line", async () => {
    h = createPhotonHarness({ env: { PHOTON_LINE_NUMBER: "+16283167976" } });
    const [mom] = await saveContacts([
      { displayName: "Mom", phoneNumber: "+14155550101", enabled: true },
    ]);
    expect(mom?.optInNumber).toBe("+16283167976");
  });

  it("learns the contact's line from their opt-in and sends the SOS from it", async () => {
    const transport = new ScriptedTransport();
    h = createPhotonHarness({ env: LIVE_SHARED, transport, lines: new FakeLines() });
    const [mom] = await saveContacts([
      { displayName: "Mom", phoneNumber: "+14155550101", enabled: true },
    ]);
    const line = "pho_usr_01k0000000000000000000line";
    const user = "pho_usr_01k00000000000000000000mom";
    const space = "pho_spc_01k00000000000000000000mom";
    const optIn = buildMessageReceivedEvent({
      fromHandle: "+14155550101",
      text: "yes",
      atMs: h.clock.now(),
      projectId: PROJECT,
      senderUserId: user,
      spaceId: space,
      agentUserId: line,
    });
    const res = await postWebhook(h, optIn, { secret: LIVE_SHARED.PHOTON_WEBHOOK_SECRET });
    expect(res.status).toBe(200);
    expect(getContactRow(h.db, mom!.id)).toMatchObject({
      consent_status: "verified",
      photon_user_id: user,
      photon_space_id: space,
      photon_agent_user_id: line,
    });

    const { body } = await postSOS(h);
    await waitForEvent(h, body.alert.alertId, "alert.initial_notification_accepted");
    expect(transport.calls[0]?.recipient).toMatchObject({
      agentUserId: line,
      userId: user,
      spaceId: space,
    });
  });
});

describe("Photon shared-line assignment API", () => {
  const assignment = (handle: string, number: string, id: string) => ({
    assignmentId: id,
    assignedPhoneNumber: number,
    handle,
    platform: "imessage",
    projectId: PROJECT,
    createdAt: "2026-10-18T19:30:00.000Z",
    updatedAt: "2026-10-18T19:30:00.000Z",
  });

  it("is a no-op outside live shared-line mode", async () => {
    const fetch = vi.fn();
    for (const env of [
      {},
      {
        ...LIVE_SHARED,
        PHOTON_LINE_MODE: "dedicated",
        PHOTON_AGENT_USER_ID: "pho_usr_01k0000000000000000000000a",
      },
    ]) {
      const lines = createLineService(testConfig(env), silentLogger, { fetch });
      expect(lines.perContact).toBe(false);
      expect(await lines.assign({ id: "ctc_x", phoneNumber: "+14155550101" })).toBeNull();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("creates an assignment, reuses an existing one, and releases it", async () => {
    const seen: { method: string; path: string; key: string | null; body: string }[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const body = await request.text();
      seen.push({
        method: request.method,
        path,
        key: request.headers.get("idempotency-key"),
        body,
      });
      const json = (status: number, value: unknown) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (request.method === "POST" && body.includes("+14155550101")) {
        return json(201, assignment("+14155550101", "+16283167976", "asg_1"));
      }
      if (request.method === "POST") {
        return json(409, {
          type: "https://photon.codes/docs/problems/assignment-exists",
          title: "Assignment Exists",
          status: 409,
          code: "ASSIGNMENT_EXISTS",
        });
      }
      if (request.method === "GET") {
        return json(200, { assignments: [assignment("+14155550102", "+16283167977", "asg_2")] });
      }
      return json(200, {
        ...assignment("+14155550101", "+16283167976", "asg_1"),
        releasedAt: "2026-10-18T20:00:00.000Z",
      });
    });
    const lines = createLineService(testConfig(LIVE_SHARED), silentLogger, { fetch });
    expect(lines.perContact).toBe(true);

    expect(await lines.assign({ id: "ctc_mom", phoneNumber: "+14155550101" })).toEqual({
      lineNumber: "+16283167976",
      assignmentId: "asg_1",
    });
    expect(seen[0]).toMatchObject({
      method: "POST",
      path: `/v1/projects/${PROJECT}/platforms/imessage/assignments`,
      key: "haven-assign:ctc_mom:+14155550101",
    });
    expect(JSON.parse(seen[0]!.body)).toEqual({ handle: "+14155550101" });

    expect(await lines.assign({ id: "ctc_dad", phoneNumber: "+14155550102" })).toEqual({
      lineNumber: "+16283167977",
      assignmentId: "asg_2",
    });

    await lines.release("asg_1");
    expect(seen.at(-1)).toMatchObject({
      method: "DELETE",
      path: `/v1/projects/${PROJECT}/platforms/imessage/assignments/asg_1`,
    });
  });

  it("reports failure as null so the contact can be retried", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const lines = createLineService(testConfig(LIVE_SHARED), silentLogger, { fetch });
    expect(await lines.assign({ id: "ctc_mom", phoneNumber: "+14155550101" })).toBeNull();
  });
});
