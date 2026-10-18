// PHOTON_MODE=mock: contacts nobody. Each message is written to `mock_outbox` (what would
// have been sent) and reported as accepted. Sending the same notification again returns the
// first outbox entry, mirroring Photon's idempotency-key replay.
import type { ServiceContext } from "../lib/interfaces";
import type { PhotonTransport } from "./transport";

export function createMockPhotonTransport(ctx: ServiceContext): PhotonTransport {
  return {
    mode: "mock",
    async send(message) {
      const existing = ctx.db.get<{ id: number }>(
        "SELECT id FROM mock_outbox WHERE notification_id = ? ORDER BY id ASC LIMIT 1",
        message.notificationId,
      );
      const outboxId =
        existing?.id ??
        ctx.db.run(
          `INSERT INTO mock_outbox (notification_id, kind, to_handle, body, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          message.notificationId,
          message.kind,
          message.recipient.phoneNumber,
          message.text,
          ctx.clock.now(),
        ).lastInsertRowid;
      return {
        ok: true,
        providerMessageId: `mock_msg_${outboxId}`,
        providerStatus: "dispatched",
        failureCode: null,
        replayed: existing !== undefined,
        identity: { userId: message.recipient.userId, spaceId: message.recipient.spaceId },
      };
    },
  };
}
