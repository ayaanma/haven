// Owner: Agent 2. Emergency messaging through Photon 2.0 (Beta) only:
// https://photon.codes/docs/beta and https://api.photon.codes/v1 via `@photon-ai/api`.
// Not the Stable/Spectrum API (`spectrum-ts`, spectrum.photon.codes).
//
// PHOTON_MODE=mock (default) never contacts anyone: messages go to `mock_outbox`, and the
// live transport is never constructed or loaded. See notification-service.ts for the
// delivery model and webhook-handler.ts for inbound events.
import type {
  HavenNotificationService,
  PhotonWebhookHandler,
  ServiceContext,
} from "../lib/interfaces";
import { createPhotonNotificationService } from "./notification-service";
import { createWebhookHandler } from "./webhook-handler";

export function createNotificationService(ctx: ServiceContext): HavenNotificationService {
  return createPhotonNotificationService(ctx);
}

export function createPhotonWebhookHandler(ctx: ServiceContext): PhotonWebhookHandler {
  return createWebhookHandler(ctx);
}
