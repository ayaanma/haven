// Test doubles for module interfaces, so each agent can test its module before the
// others land. None of these make network calls.
import {
  isAcceptedNotificationStatus,
  type AlertRecord,
  type ContextAnalysisOutcome,
  type ContextResult,
  type EmergencySensorSnapshot,
  type NotificationKind,
  type NotificationStatus,
} from "@haven/contracts";
import type {
  HavenContextService,
  HavenNotificationService,
  NotificationBatchResult,
} from "../lib/interfaces";

type NotificationCall =
  | { method: "sendInitialSOS"; alert: AlertRecord }
  | { method: "sendContextUpdate"; alertId: string; context: ContextResult }
  | { method: "sendRecordingNotification"; alertId: string; secureUrl: string };

/** Records calls; every recipient gets `status` (default photon_accepted). */
export class FakeNotificationService implements HavenNotificationService {
  readonly calls: NotificationCall[] = [];
  constructor(
    public status: NotificationStatus = "photon_accepted",
    public recipients: { contactId: string }[] = [],
  ) {}

  private batch(kind: NotificationKind, contactIds: string[]): NotificationBatchResult {
    const results = contactIds.map((contactId, i) => ({
      contactId,
      status: this.status,
      providerMessageId: this.status === "failed" ? null : `fake_msg_${kind}_${i}`,
      failureCode: this.status === "failed" ? "fake_failure" : null,
    }));
    const acceptedCount = results.filter((r) => isAcceptedNotificationStatus(r.status)).length;
    return {
      kind,
      totalRecipients: results.length,
      acceptedCount,
      failedCount: results.filter((r) => r.status === "failed").length,
      results,
    };
  }

  async sendInitialSOS(alert: AlertRecord) {
    this.calls.push({ method: "sendInitialSOS", alert });
    return this.batch(
      "initial_sos",
      alert.recipients.map((r) => r.contactId),
    );
  }
  async sendContextUpdate(alertId: string, context: ContextResult) {
    this.calls.push({ method: "sendContextUpdate", alertId, context });
    return this.batch(
      "context_update",
      this.recipients.map((r) => r.contactId),
    );
  }
  async sendRecordingNotification(alertId: string, secureUrl: string) {
    this.calls.push({ method: "sendRecordingNotification", alertId, secureUrl });
    return this.batch(
      "recording_link",
      this.recipients.map((r) => r.contactId),
    );
  }
}

/** Returns a fixed outcome, optionally after a delay (to test that the SOS never waits). */
export class FakeContextService implements HavenContextService {
  readonly calls: { alert: AlertRecord; sensorData: EmergencySensorSnapshot }[] = [];
  constructor(
    public outcome: ContextAnalysisOutcome = { status: "failed", reason: "not_configured" },
    public delayMs = 0,
  ) {}

  async analyzeEmergencyContext(alert: AlertRecord, sensorData: EmergencySensorSnapshot) {
    this.calls.push({ alert, sensorData });
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.outcome;
  }
}
