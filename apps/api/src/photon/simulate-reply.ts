// Simulate an emergency contact texting Haven's Photon line, against a local API running
// with PHOTON_MODE=mock. The first message from a pending contact is their opt-in; later
// messages during an active alert appear on the HUD as "<name>: <text>".
//
//   npx tsx apps/api/src/photon/simulate-reply.ts --from +14155550123 --text "I'm calling 911"
//   [--url http://localhost:8787] [--reply-to <photon message id>]
//
// It refuses to run against a server that is not in mock mode, and live mode never accepts
// the mock signing secret anyway.
import { parseArgs } from "node:util";
import { ROUTES } from "@haven/contracts";
import { buildMessageReceivedEvent, signedWebhookRequest } from "./mock-webhook";

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    text: { type: "string" },
    url: { type: "string", default: "http://localhost:8787" },
    "reply-to": { type: "string" },
  },
});

if (!values.from || !values.text) {
  console.error('Usage: simulate-reply.ts --from +14155550123 --text "message" [--url ...]');
  process.exit(2);
}

const base = values.url.replace(/\/+$/, "");
const health = (await (await fetch(`${base}${ROUTES.health}`)).json()) as { photonMode?: string };
if (health.photonMode !== "mock") {
  console.error("Refusing: the server is not running with PHOTON_MODE=mock.");
  process.exit(1);
}

const event = buildMessageReceivedEvent({
  fromHandle: values.from,
  text: values.text,
  atMs: Date.now(),
  ...(values["reply-to"] ? { parentMessageId: values["reply-to"] } : {}),
});
const { rawBody, headers } = signedWebhookRequest(event, {
  ...(process.env.PHOTON_WEBHOOK_SECRET ? { secret: process.env.PHOTON_WEBHOOK_SECRET } : {}),
  timestampMs: Date.now(),
});
const response = await fetch(`${base}${ROUTES.photonWebhooks}`, {
  method: "POST",
  headers,
  body: rawBody,
});
console.log(response.status, await response.text());
