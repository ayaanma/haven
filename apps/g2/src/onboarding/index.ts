import {
  MAX_EMERGENCY_CONTACTS,
  SaveContactsRequestSchema,
  type EmergencyContact,
  type EmergencyContactInput,
} from "@haven/contracts";
import type { HavenAppContext } from "../core/app-context";

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function labeledInput(label: string, input: HTMLInputElement): HTMLLabelElement {
  const wrapper = element("label");
  wrapper.style.display = "grid";
  wrapper.style.gap = "4px";
  wrapper.style.marginBlock = "10px";
  wrapper.append(element("span", label), input);
  return wrapper;
}

function setBusy(button: HTMLButtonElement, busy: boolean, label: string): void {
  button.disabled = busy;
  button.textContent = busy ? "Working..." : label;
}

export function mountOnboarding(root: HTMLElement, ctx: HavenAppContext | null): void {
  root.replaceChildren();
  root.append(element("h1", "Haven"));
  if (!ctx) {
    root.append(element("p", "Open Haven from the Even Realities app to finish setup."));
    return;
  }

  const status = element("p");
  status.setAttribute("role", "status");
  root.append(status);

  const showError = (error: unknown) => {
    status.textContent = error instanceof Error ? error.message : String(error);
  };

  const renderPairing = () => {
    root.replaceChildren(element("h1", "Haven"), status);
    root.append(
      element(
        "p",
        "Pair this G2 with your Haven server. The pairing code creates a private session for contacts and alerts.",
      ),
    );
    const form = element("form");
    const code = element("input");
    code.name = "pairingCode";
    code.type = "password";
    code.autocomplete = "one-time-code";
    code.required = true;
    code.maxLength = 128;
    const label = element("input");
    label.name = "deviceLabel";
    label.value = "My G2";
    label.maxLength = 64;
    const submit = element("button", "Pair G2");
    submit.type = "submit";
    form.append(labeledInput("Pairing code", code), labeledInput("Device label", label), submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      status.textContent = "";
      setBusy(submit, true, "Pair G2");
      void ctx.api
        .createSession({
          pairingCode: code.value,
          ...(label.value.trim() ? { deviceLabel: label.value.trim() } : {}),
        })
        .then(() => renderContacts())
        .catch(showError)
        .finally(() => setBusy(submit, false, "Pair G2"));
    });
    root.append(form);
  };

  const renderContacts = async () => {
    root.replaceChildren(element("h1", "Haven"), status);
    status.textContent = "Loading emergency contacts...";
    let contacts: EmergencyContact[];
    try {
      contacts = (await ctx.api.getContacts()).contacts;
    } catch (error) {
      showError(error);
      const retry = element("button", "Retry");
      retry.addEventListener("click", () => void renderContacts());
      root.append(retry);
      return;
    }
    status.textContent = "";
    root.append(
      element(
        "p",
        "Each enabled contact must first text the Haven number shown next to their name to opt in (contacts can be assigned different numbers). Pending or revoked contacts are never sent an alert.",
      ),
    );

    const disclosure = element("section");
    disclosure.append(
      element("h2", "Before using Haven"),
      element(
        "p",
        "Allow phone location and G2 microphone access. After an SOS is accepted by the messaging provider, Haven automatically records from the glasses until you click once to send it.",
      ),
      element(
        "p",
        "Haven asks your contacts to call 911; it never contacts police directly. Keep Haven open on G2, and keep the phone powered on, nearby, and connected.",
      ),
    );
    root.append(disclosure);

    const editor = element("form");
    const rows = element("div");
    const draft: EmergencyContactInput[] = contacts.map((contact) => ({
      id: contact.id,
      displayName: contact.displayName,
      phoneNumber: contact.phoneNumber,
      enabled: contact.enabled,
    }));

    const drawRows = () => {
      rows.replaceChildren();
      draft.forEach((contact, index) => {
        const persisted = contact.id ? contacts.find((item) => item.id === contact.id) : undefined;
        const fieldset = element("fieldset");
        const legend = element("legend", `Emergency contact ${index + 1}`);
        const name = element("input");
        name.value = contact.displayName;
        name.required = true;
        name.maxLength = 40;
        name.autocomplete = "name";
        name.addEventListener("input", () => (contact.displayName = name.value));
        const phone = element("input");
        phone.type = "tel";
        phone.value = contact.phoneNumber;
        phone.required = true;
        phone.placeholder = "+14155550123";
        phone.autocomplete = "tel";
        phone.addEventListener("input", () => (contact.phoneNumber = phone.value));
        const enabled = element("input");
        enabled.type = "checkbox";
        enabled.checked = contact.enabled;
        enabled.addEventListener("change", () => (contact.enabled = enabled.checked));
        const enabledLabel = element("label", " Enabled for alerts");
        enabledLabel.prepend(enabled);
        const consent = element(
          "p",
          persisted
            ? consentText(persisted)
            : "Consent: pending after save — this contact must text Haven to opt in.",
        );
        const remove = element("button", "Remove");
        remove.type = "button";
        remove.addEventListener("click", () => {
          draft.splice(index, 1);
          drawRows();
        });
        fieldset.append(
          legend,
          labeledInput("Display name", name),
          labeledInput("Phone number (E.164)", phone),
          enabledLabel,
          consent,
          remove,
        );
        rows.append(fieldset);
      });
      add.disabled = draft.length >= MAX_EMERGENCY_CONTACTS;
    };

    const add = element("button", "Add contact");
    add.type = "button";
    add.addEventListener("click", () => {
      if (draft.length >= MAX_EMERGENCY_CONTACTS) return;
      draft.push({ displayName: "", phoneNumber: "", enabled: true });
      drawRows();
    });
    const save = element("button", "Save contacts");
    save.type = "submit";
    editor.addEventListener("submit", (event) => {
      event.preventDefault();
      status.textContent = "";
      const parsed = SaveContactsRequestSchema.safeParse({ contacts: draft });
      if (!parsed.success) {
        status.textContent = parsed.error.issues[0]?.message ?? "Check the contact details.";
        return;
      }
      setBusy(save, true, "Save contacts");
      void ctx.api
        .saveContacts(parsed.data.contacts)
        .then(() => {
          status.textContent = "Contacts saved.";
          return renderContacts();
        })
        .catch(showError)
        .finally(() => setBusy(save, false, "Save contacts"));
    });
    editor.append(rows, add, save);
    root.append(editor);

    const reset = element("button", "Reset error on glasses");
    reset.type = "button";
    reset.style.marginTop = "20px";
    reset.addEventListener("click", () => {
      window.dispatchEvent(new Event("haven:reset"));
      status.textContent = "Glasses error reset requested.";
    });
    root.append(reset);
    drawRows();
  };

  void ctx.sessions
    .load()
    .then((session) => (session ? renderContacts() : renderPairing()))
    .catch(showError);
}

/** Shown when the Even App bridge is unavailable (plain browser, or startup failed). */
export function mountBridgeUnavailable(root: HTMLElement, message: string): void {
  root.replaceChildren();
  const title = document.createElement("h1");
  title.textContent = "Haven";
  const note = document.createElement("p");
  note.textContent = `Open Haven from the Even Realities app with your G2 connected. (${message})`;
  root.append(title, note);
}

/** Consent line for a saved contact, naming the exact number they must text to opt in. */
export function consentText(contact: Pick<EmergencyContact, "consent" | "optInNumber">): string {
  const target = contact.optInNumber ? `text ${contact.optInNumber}` : "text Haven";
  switch (contact.consent.status) {
    case "pending":
      return `Consent: pending — ask this contact to ${target} to opt in.`;
    case "revoked":
      return `Consent: revoked — they opted out. They can ${target} with START to opt back in.`;
    default:
      return contact.optInNumber
        ? `Consent: verified — alerts come from ${contact.optInNumber}.`
        : "Consent: verified";
  }
}
