import { describe, expect, it } from "vitest";
import { makeContact } from "@haven/contracts/testing";
import { consentText } from "./index";

describe("consent text", () => {
  it("tells the wearer exactly which number a pending contact must text", () => {
    const contact = makeContact({ consent: { status: "pending", updatedAt: null } });
    expect(consentText(contact)).toBe(
      "Consent: pending — ask this contact to text +16283167976 to opt in.",
    );
    expect(consentText({ ...contact, optInNumber: null })).toBe(
      "Consent: pending — ask this contact to text Haven to opt in.",
    );
  });

  it("shows where alerts come from once verified and how to opt back in after STOP", () => {
    expect(consentText(makeContact())).toBe("Consent: verified — alerts come from +16283167976.");
    expect(consentText(makeContact({ consent: { status: "revoked", updatedAt: 1 } }))).toContain(
      "text +16283167976 with START",
    );
  });
});
