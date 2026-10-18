// Scriptable fakes of the G2 module interfaces, so Agent 1 can build and test the SOS
// workflow before devices (Agent 3), audio (Agent 4), and the backend (Agent 2) exist.
import type {
  AlertEvent,
  AlertEventsPage,
  AlertRecord,
  ContactsResponse,
  CreateAlertResponse,
  EmergencySensorSnapshot,
  SOSRequest,
} from "@haven/contracts";
import { FIXTURE_NOW_MS, makeAlertRecord, makeContact } from "@haven/contracts/testing";
import type {
  AudioRecordingProgress,
  HavenApiClient,
  HavenAudioService,
  HavenDeviceService,
  HavenInputController,
  HavenInputEvent,
  RecordingStartResult,
  RecordingSubmitResult,
} from "../core/interfaces";

/** Input controller driven directly by tests (bypasses normalization). */
export class FakeInputController implements HavenInputController {
  private listener: ((event: HavenInputEvent) => void) | null = null;
  disposed = false;
  subscribe(callback: (event: HavenInputEvent) => void) {
    this.listener = callback;
  }
  unsubscribe() {
    this.listener = null;
  }
  dispose() {
    this.disposed = true;
    this.listener = null;
  }
  emit(event: HavenInputEvent) {
    this.listener?.(event);
  }
  press(pressedAtMs: number, resolvedAtMs = pressedAtMs) {
    this.emit({
      kind: "single_press",
      pressedAtMs,
      resolvedAtMs,
      channel: "sys",
      source: "glasses_right",
      eventTypeOmitted: true,
    });
  }
}

export class MockDeviceService implements HavenDeviceService {
  started = false;
  snapshot: EmergencySensorSnapshot = {
    capturedAtMs: FIXTURE_NOW_MS,
    location: null,
    motionSummary: null,
    diagnostics: [],
  };
  async startSensorCollection() {
    this.started = true;
  }
  async getEmergencySnapshot() {
    return this.snapshot;
  }
  async stopSensorCollection() {
    this.started = false;
  }
}

export class MockAudioService implements HavenAudioService {
  readonly calls: string[] = [];
  startResult: RecordingStartResult = {
    ok: true,
    recordingId: "rec-1",
    startedAtMs: FIXTURE_NOW_MS,
  };
  submitResult: RecordingSubmitResult = {
    ok: true,
    recordingId: "rec-1",
    durationMs: 12_000,
    chunkCount: 3,
    notification: { acceptedCount: 1, totalRecipients: 1 },
  };
  private listeners = new Set<(progress: AudioRecordingProgress) => void>();

  async startRecording(alertId: string) {
    this.calls.push(`start:${alertId}`);
    return this.startResult;
  }
  async stopAndSendRecording(alertId: string) {
    this.calls.push(`stop:${alertId}`);
    return this.submitResult;
  }
  async disposeRecording() {
    this.calls.push("dispose");
  }
  onProgress(listener: (progress: AudioRecordingProgress) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emitProgress(progress: AudioRecordingProgress) {
    for (const listener of this.listeners) listener(progress);
  }
}

/**
 * In-memory API. `createAlert` is idempotent on clientAlertId like the real backend;
 * tests push events with `pushEvent` and the client polls them with getAlertEvents.
 */
export class MockApiClient implements HavenApiClient {
  readonly createAlertRequests: SOSRequest[] = [];
  alert: AlertRecord = makeAlertRecord();
  contacts: ContactsResponse = { contacts: [makeContact()] };
  createAlertError: Error | null = null;
  private events: AlertEvent[] = [];
  private seenClientAlertIds = new Set<string>();

  async createSession() {
    return {
      sessionToken: `hvn_${"A".repeat(43)}`,
      tokenType: "Bearer" as const,
      expiresAt: FIXTURE_NOW_MS + 86_400_000,
      scopes: ["alerts:write" as const],
    };
  }
  async createAlert(request: SOSRequest): Promise<CreateAlertResponse> {
    this.createAlertRequests.push(request);
    if (this.createAlertError) throw this.createAlertError;
    const created = !this.seenClientAlertIds.has(request.clientAlertId);
    this.seenClientAlertIds.add(request.clientAlertId);
    return { alert: { ...this.alert, clientAlertId: request.clientAlertId }, created };
  }
  async getAlert() {
    return this.alert;
  }
  async getAlertEvents(_alertId: string, cursor?: string | null): Promise<AlertEventsPage> {
    const after = cursor ? Number(cursor) : 0;
    const events = this.events.filter((e) => e.id > after);
    const last = events.at(-1);
    return { events, nextCursor: last ? String(last.id) : (cursor ?? null), hasMore: false };
  }
  async getContacts() {
    return this.contacts;
  }
  async saveContacts() {
    return this.contacts;
  }
  pushEvent(event: AlertEvent) {
    this.events.push(event);
  }
}
