#!/usr/bin/env node
// Manage Haven's Photon 2.0 webhook destination (needs PHOTON_API_KEY and PHOTON_PROJECT_ID).
//
//   npm run photon:webhook -w @haven/api -- list
//   npm run photon:webhook -w @haven/api -- create https://api.example.com
//   npm run photon:webhook -w @haven/api -- update <destinationId> https://api.example.com
//   npm run photon:webhook -w @haven/api -- disable <destinationId>
//
// `create` prints the signing secret ONCE: put it in PHOTON_WEBHOOK_SECRET on the server.
import { randomUUID } from "node:crypto";

const EVENTS = [
  "message.received",
  "message.dispatched",
  "message.accepted",
  "message.delivered",
  "message.failed",
];
const API_VERSION = "2026-07-01";
const WEBHOOK_PATH = "/api/v1/photon/webhooks";

const { PHOTON_API_KEY: key, PHOTON_PROJECT_ID: project } = process.env;
if (!key?.startsWith("pho_sk_") || !project?.startsWith("pho_prj_")) {
  console.error("Set PHOTON_API_KEY (pho_sk_...) and PHOTON_PROJECT_ID (pho_prj_...) first.");
  process.exit(2);
}

const base = `https://api.photon.codes/v1/projects/${project}/webhooks/destinations`;
async function call(method, path = "", body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body
        ? { "Content-Type": "application/json", "Idempotency-Key": `haven-${randomUUID()}` }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(
      `Photon answered ${response.status}: ${json.code ?? ""} ${json.detail ?? json.title ?? ""}`,
    );
    process.exit(1);
  }
  return json;
}

function webhookUrl(origin) {
  const url = new URL(origin);
  if (url.protocol !== "https:") throw new Error("Photon needs an HTTPS URL");
  return `${url.origin}${WEBHOOK_PATH}`;
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "list": {
    const { destinations } = await call("GET");
    for (const d of destinations) console.log(`${d.destinationId}  ${d.status}  ${d.url}`);
    if (destinations.length === 0) console.log("(no destinations)");
    break;
  }
  case "create": {
    const created = await call("POST", "", {
      apiVersion: API_VERSION,
      name: "Haven",
      url: webhookUrl(args[0]),
      enabledEvents: EVENTS,
    });
    console.log(`Created ${created.destination.destinationId} -> ${created.destination.url}`);
    console.log("Set this on the server (shown only once):");
    console.log(`PHOTON_WEBHOOK_SECRET=${created.signingSecret}`);
    break;
  }
  case "update": {
    const updated = await call("PATCH", `/${args[0]}`, {
      url: webhookUrl(args[1]),
      status: "enabled",
    });
    console.log(`Updated ${updated.destinationId ?? args[0]} -> ${updated.url}`);
    break;
  }
  case "disable": {
    await call("PATCH", `/${args[0]}`, { status: "disabled" });
    console.log(`Disabled ${args[0]}`);
    break;
  }
  default:
    console.error(
      "Usage: photon-webhook.mjs list | create <https-origin> | update <id> <https-origin> | disable <id>",
    );
    process.exit(2);
}
