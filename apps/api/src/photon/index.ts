// Owner: Agent 2. Placeholder created by the foundation commit.
//
// Photon 2.0 (Beta) only: https://photon.codes/docs/beta/ and https://api.photon.codes/v1.
// Use the `@photon-ai/api` client (pinned 0.5.0) or plain fetch with
// `Authorization: Bearer ${PHOTON_API_KEY}`. Do NOT use spectrum-ts or other Stable APIs.
//
// Verified from the Photon 2.0 OpenAPI spec (2026-10-18):
//   - POST /v1/projects/{id}/users      createOrGetUser  { handle, platform }
//   - POST /v1/projects/{id}/spaces     createOrGetSpace { participantIds, platform }
//   - POST /v1/projects/{id}/messages   sendMessage { spaceId, senderId, content } with a
//     required `idempotency-key` header. 202 = persisted for async delivery (status dispatched).
//   - Status events: message.dispatched | message.accepted | message.delivered | message.failed
//     (see NotificationStatusSchema for the Haven mapping).
//   - A shared iMessage line can message a peer only after that peer messaged it.
//   - Webhook signing secrets start with `whsec_`; the signature header format is NOT
//     documented in the Beta docs. Verify it against a real delivery before relying on it.
import { NotImplementedError } from "../lib/errors";
import type {
  HavenNotificationService,
  PhotonWebhookHandler,
  ServiceContext,
} from "../lib/interfaces";

export function createNotificationService(ctx: ServiceContext): HavenNotificationService {
  // PHOTON_MODE=mock (default) must never contact anyone: record to `mock_outbox` instead.
  const mode = ctx.config.photon.mode;
  return {
    async sendInitialSOS() {
      throw new NotImplementedError(`notifications.sendInitialSOS [${mode}] (Agent 2)`);
    },
    async sendContextUpdate() {
      throw new NotImplementedError(`notifications.sendContextUpdate [${mode}] (Agent 2)`);
    },
    async sendRecordingNotification() {
      throw new NotImplementedError(`notifications.sendRecordingNotification [${mode}] (Agent 2)`);
    },
  };
}

export function createPhotonWebhookHandler(_ctx: ServiceContext): PhotonWebhookHandler {
  return {
    async handle() {
      throw new NotImplementedError("photon webhook handling (Agent 2)");
    },
  };
}
