// Owner: Agent 1. Placeholder created by the foundation commit.
//
// Phone-side UI rendered in the Even Realities app WebView: pairing (ctx.api.createSession),
// emergency contacts (getContacts/saveContacts), and each contact's consent state. Explain that
// a contact receives alerts only after they text Haven's line to opt in.
import type { HavenAppContext } from "../core/app-context";

export function mountOnboarding(root: HTMLElement, _ctx: HavenAppContext | null): void {
  root.replaceChildren();
  const title = document.createElement("h1");
  title.textContent = "Haven";
  const note = document.createElement("p");
  note.textContent = "Pairing and emergency-contact setup will appear here.";
  root.append(title, note);
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
