import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  CompleteAudioResponseSchema,
  type CompleteAudioRequest,
  type CompleteAudioResponse,
} from "@haven/contracts";
import type { ServiceContainer } from "../container";
import { NotImplementedError, unavailable } from "../lib/errors";

/** Durable notification receipts contain counts and metadata, never the capability URL. */
export function createAudioCompletion(container: ServiceContainer) {
  const inFlight = new Map<string, Promise<CompleteAudioResponse>>();
  const directory = path.join(container.config.audioStoragePath, ".notification-receipts");
  function filename(recordingId: string) {
    return path.join(directory, createHash("sha256").update(recordingId).digest("hex") + ".json");
  }
  function receipt(recordingId: string): CompleteAudioResponse | "pending" | null {
    let raw: string;
    try {
      raw = readFileSync(filename(recordingId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw unavailable("Recording notification receipt is unavailable");
    }
    if (raw === "pending") return "pending";
    try {
      return CompleteAudioResponseSchema.parse(JSON.parse(raw));
    } catch {
      throw unavailable("Recording notification receipt is invalid");
    }
  }
  function persist(recordingId: string, response?: CompleteAudioResponse) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = filename(recordingId);
    const temporary = response ? target + "." + randomUUID() : target;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, response ? JSON.stringify(response) : "pending");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (response) renameSync(temporary, target);
  }
  function announce(response: CompleteAudioResponse) {
    const { recording, notification } = response;
    const type =
      notification.acceptedCount > 0 ? "recording.notification_accepted" : "recording.failed";
    if (
      container.db.get(
        "SELECT id FROM alert_events WHERE alert_id = ? AND type = ? AND json_extract(payload_json, '$.recordingId') = ?",
        recording.alertId,
        type,
        recording.recordingId,
      )
    )
      return;
    if (notification.acceptedCount > 0) {
      container.events.append(recording.alertId, {
        type: "recording.notification_accepted",
        payload: { recordingId: recording.recordingId, ...notification },
      });
    } else {
      container.events.append(recording.alertId, {
        type: "recording.failed",
        payload: { recordingId: recording.recordingId, reason: "notification_failed" },
      });
    }
  }
  async function complete(
    alertId: string,
    input: CompleteAudioRequest,
  ): Promise<CompleteAudioResponse> {
    // Always check the recording's alert and immutable completion parameters, including on retries.
    const recording = await container.recordings.finalizeRecording({ alertId, ...input });
    const previous = receipt(input.recordingId);
    if (previous === "pending") {
      // A crash/transport failure may have happened after Photon accepted the send. Do not
      // send twice. Reconciliation requires Agent 2's persisted notification/webhook status.
      const statuses = container.db.all<{ status: string }>(
        "SELECT status FROM alert_notifications WHERE alert_id = ? AND kind = 'recording_link'",
        alertId,
      );
      const acceptedCount = statuses.filter((row) =>
        ["photon_accepted", "delivery_unconfirmed", "delivered"].includes(row.status),
      ).length;
      if (
        acceptedCount > 0 ||
        (statuses.length > 0 && statuses.every((row) => row.status === "failed"))
      ) {
        const response = {
          recording,
          notification: { acceptedCount, totalRecipients: statuses.length },
        };
        persist(input.recordingId, response);
        announce(response);
        return response;
      }
      throw unavailable("Recording is saved; notification outcome is pending reconciliation");
    }
    if (previous) {
      announce(previous);
      return previous;
    }
    const link = await container.recordings.createSecureShareLink({
      alertId,
      recordingId: input.recordingId,
    });
    // Exclusive durable claim also prevents another API process from sending concurrently.
    try {
      persist(input.recordingId);
    } catch {
      throw unavailable("Recording notification could not be claimed; retry completion");
    }
    let response: CompleteAudioResponse;
    try {
      const notification = await container.notifications.sendRecordingNotification(
        alertId,
        link.url,
      );
      response = CompleteAudioResponseSchema.parse({
        recording,
        notification: {
          acceptedCount: notification.acceptedCount,
          totalRecipients: notification.totalRecipients,
        },
      });
      if (
        notification.acceptedCount === 0 &&
        notification.totalRecipients > notification.failedCount
      ) {
        throw unavailable("Recording notification is queued; acceptance is pending");
      }
      persist(input.recordingId, response);
    } catch (error) {
      // The foundation placeholder has no side effects. Leave completion retryable once
      // Agent 2 lands instead of creating a permanently ambiguous notification claim.
      if (error instanceof NotImplementedError) {
        rmSync(filename(input.recordingId), { force: true });
        throw error;
      }
      throw unavailable("Recording is saved; notification outcome is pending reconciliation");
    }
    announce(response);
    return response;
  }
  return (alertId: string, input: CompleteAudioRequest): Promise<CompleteAudioResponse> => {
    const key = JSON.stringify([alertId, input]);
    const active = inFlight.get(key);
    if (active) return active;
    const task = complete(alertId, input).finally(() => inFlight.delete(key));
    inFlight.set(key, task);
    return task;
  };
}
