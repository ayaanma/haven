import { afterEach, describe, expect, it } from "vitest";
import {
  ApiErrorBodySchema,
  ContactsResponseSchema,
  ROUTES,
  type EmergencyContact,
} from "@haven/contracts";
import { fixtureId } from "@haven/contracts/testing";
import { createPhotonHarness, type PhotonHarness } from "../photon/testing";
import { normalizePhoneHandle, phoneNumberProblem } from "./phone";
import { setContactConsent } from "./repository";

let h: PhotonHarness;
afterEach(() => h?.close());

async function put(contacts: unknown[]) {
  return h.json("PUT", ROUTES.contacts, { contacts });
}

async function saved(contacts: unknown[]): Promise<EmergencyContact[]> {
  const res = await put(contacts);
  expect(res.status).toBe(200);
  return ContactsResponseSchema.parse(await res.json()).contacts;
}

async function list(): Promise<EmergencyContact[]> {
  const res = await h.json("GET", ROUTES.contacts);
  expect(res.status).toBe(200);
  return ContactsResponseSchema.parse(await res.json()).contacts;
}

describe("contacts API", () => {
  it("starts empty and adds new contacts as pending, in display order", async () => {
    h = createPhotonHarness();
    expect(await list()).toEqual([]);

    const contacts = await saved([
      { displayName: "Mom", phoneNumber: "+14155550123", enabled: true },
      { displayName: "Dad", phoneNumber: "+14155550124", enabled: false },
    ]);
    expect(contacts.map((c) => c.displayName)).toEqual(["Mom", "Dad"]);
    for (const contact of contacts) {
      expect(contact.id).toMatch(/^ctc_[0-9a-z]{24}$/);
      expect(contact.consent).toEqual({ status: "pending", updatedAt: null });
      expect(contact.createdAt).toBe(h.clock.now());
    }
    expect(contacts[1]?.enabled).toBe(false);
    expect(await list()).toEqual(contacts);
  });

  it("persists across service instances sharing the database", async () => {
    h = createPhotonHarness();
    const contacts = await saved([
      { displayName: "Mom", phoneNumber: "+14155550123", enabled: true },
    ]);
    const restarted = createPhotonHarness({ db: h.db });
    const res = await restarted.json("GET", ROUTES.contacts);
    expect(ContactsResponseSchema.parse(await res.json()).contacts).toEqual(contacts);
  });

  it("keeps consent while the number is unchanged and resets it when the number changes", async () => {
    h = createPhotonHarness();
    const [mom, dad] = await saved([
      { displayName: "Mom", phoneNumber: "+14155550123", enabled: true },
      { displayName: "Dad", phoneNumber: "+14155550124", enabled: true },
    ]);
    setContactConsent(h.db, mom!.id, "verified", h.clock.now());
    setContactConsent(h.db, dad!.id, "verified", h.clock.now());
    h.clock.advance(1_000);

    const updated = await saved([
      { id: mom!.id, displayName: "Mother", phoneNumber: "+14155550123", enabled: false },
      { id: dad!.id, displayName: "Dad", phoneNumber: "+14155550199", enabled: true },
    ]);
    expect(updated[0]).toMatchObject({
      id: mom!.id,
      displayName: "Mother",
      enabled: false,
      consent: { status: "verified" },
      updatedAt: h.clock.now(),
    });
    expect(updated[1]).toMatchObject({
      id: dad!.id,
      phoneNumber: "+14155550199",
      consent: { status: "pending", updatedAt: h.clock.now() },
    });
  });

  it("deletes omitted contacts and lets two contacts swap numbers", async () => {
    h = createPhotonHarness();
    const [a, b, c] = await saved([
      { displayName: "A", phoneNumber: "+14155550101", enabled: true },
      { displayName: "B", phoneNumber: "+14155550102", enabled: true },
      { displayName: "C", phoneNumber: "+14155550103", enabled: true },
    ]);
    const result = await saved([
      { id: b!.id, displayName: "B", phoneNumber: "+14155550101", enabled: true },
      { id: a!.id, displayName: "A", phoneNumber: "+14155550102", enabled: true },
    ]);
    expect(result.map((x) => [x.id, x.phoneNumber])).toEqual([
      [b!.id, "+14155550101"],
      [a!.id, "+14155550102"],
    ]);
    expect(result.some((x) => x.id === c!.id)).toBe(false);
  });

  it("never lets a client set consent", async () => {
    h = createPhotonHarness();
    const res = await put([
      {
        displayName: "Mom",
        phoneNumber: "+14155550123",
        enabled: true,
        consent: { status: "verified", updatedAt: 1 },
      },
    ]);
    expect(res.status).toBe(400);
    expect(await list()).toEqual([]);
  });

  it.each([
    ["more than five contacts", Array.from({ length: 6 }, (_, i) => contact(`+1415555011${i}`))],
    ["duplicate numbers", [contact("+14155550123"), contact("+14155550123")]],
    ["a non-E.164 number", [contact("(415) 555-0123")]],
    ["an empty name", [{ ...contact("+14155550123"), displayName: "  " }]],
    ["a control character in the name", [{ ...contact("+14155550123"), displayName: "Mo\u0007m" }]],
    ["911", [contact("+1911")]],
    ["112", [contact("+112")]],
    ["999 in the UK", [contact("+44999")]],
    ["an N11 area code", [contact("+19115550123")]],
    ["an incomplete NANP number", [contact("+1415555012")]],
  ])("rejects %s with 400 and saves nothing", async (_name, contacts) => {
    h = createPhotonHarness();
    const res = await put(contacts);
    expect(res.status).toBe(400);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe("invalid_request");
    expect(await list()).toEqual([]);
  });

  it("rejects an unknown contact ID without changing anything", async () => {
    h = createPhotonHarness();
    const before = await saved([contact("+14155550123")]);
    const res = await put([{ ...contact("+14155550123"), id: fixtureId("ctc", 42) }]);
    expect(res.status).toBe(400);
    const body = ApiErrorBodySchema.parse(await res.json());
    expect(body.error.issues?.[0]?.path).toBe("contacts.0.id");
    expect(await list()).toEqual(before);
  });

  it("requires a session", async () => {
    h = createPhotonHarness();
    expect((await h.request(ROUTES.contacts)).status).toBe(401);
    const res = await h.request(ROUTES.contacts, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contacts: [contact("+14155550123")] }),
    });
    expect(res.status).toBe(401);
    expect(await list()).toEqual([]);
  });
});

describe("phone number rules", () => {
  it("accepts real subscriber numbers", () => {
    for (const number of ["+14155550123", "+447700900123", "+6831234", "+819012345678"]) {
      expect(phoneNumberProblem(number), number).toBeNull();
    }
  });

  it("rejects emergency and short service numbers", () => {
    for (const number of ["+1911", "+911", "+112", "+999", "+61000", "+33112", "+1911555"]) {
      expect(phoneNumberProblem(number), number).not.toBeNull();
    }
  });

  it("normalizes Photon handles without guessing a country", () => {
    expect(normalizePhoneHandle("+1 (415) 555-0123")).toBe("+14155550123");
    expect(normalizePhoneHandle("tel:+14155550123")).toBe("+14155550123");
    expect(normalizePhoneHandle("4155550123")).toBeNull();
    expect(normalizePhoneHandle("mom@example.com")).toBeNull();
  });
});

function contact(phoneNumber: string) {
  return { displayName: "Mom", phoneNumber, enabled: true };
}
