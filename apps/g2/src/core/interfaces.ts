/**
 * G2 module boundaries (foundation-owned). Agents implement these in their own
 * directories; core/app-context.ts wires them together. Propose changes instead of
 * editing this file. See docs/INTEGRATION.md.
 */
import type {
  AlertEventsPage,
  AlertRecord,
  ContactsResponse,
  CreateAlertResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  EmergencyContactInput,
  EmergencySensorSnapshot,
  SOSRequest,
} from "@haven/contracts";
import type { HavenBridge } from "./bridge";
import type { HavenHttpClient } from "./http";
import type { InputSource, LifecycleKind } from "./input/event-types";
import type { InputChannel } from "./input/normalize";
import type { Log } from "./log";
import type { Scheduler } from "./scheduler";
import type { SessionStore } from "./session-store";

// ── Input (foundation implements: core/input/controller.ts; Agent 1 consumes) ───────

export type HavenInputEvent =
  | {
      kind: "single_press";
      /** Raw arrival time. Compare THIS against countdown deadlines (isCancelPressInTime). */
      pressedAtMs: number;
      /** When disambiguation emitted the press (pressedAtMs + window). */
      resolvedAtMs: number;
      channel: InputChannel;
      source: InputSource;
      eventTypeOmitted: boolean;
    }
  | {
      /**
       * Platform exit gesture. The controller has already asked the OS to show the exit
       * dialog (shutDownPageContainer(1)). Never treat this as cancel or SOS.
       */
      kind: "double_press";
      pressedAtMs: number;
      channel: InputChannel;
      source: InputSource;
    }
  | { kind: "lifecycle"; lifecycle: LifecycleKind; atMs: number };

export interface HavenInputController {
  /** Register the single listener (replaces any previous one). Presses before this are dropped. */
  subscribe(callback: (event: HavenInputEvent) => void): void;
  unsubscribe(): void;
  /** Detach from the bridge and cancel pending timers. */
  dispose(): void;
}

// ── Devices (Agent 3: src/devices) ───────────────────────────────────────────────

/** Upper bound for getEmergencySnapshot; the SOS must not wait longer for sensors. */
export const EMERGENCY_SNAPSHOT_TIMEOUT_MS = 1_500;

export interface HavenDeviceService {
  /** Start IMU sampling and phone-location caching. Safe to call repeatedly. */
  startSensorCollection(): Promise<void>;
  /**
   * Latest location and recent motion summary. MUST resolve (never reject) within
   * EMERGENCY_SNAPSHOT_TIMEOUT_MS, with nulls and diagnostics when data is missing.
   */
  getEmergencySnapshot(): Promise<EmergencySensorSnapshot>;
  stopSensorCollection(): Promise<void>;
}

export interface DeviceServiceDeps {
  bridge: HavenBridge;
  scheduler: Scheduler;
  log: Log;
}

// ── Audio (Agent 4: src/audio) ───────────────────────────────────────────────────

export type RecordingStartResult =
  | { ok: true; recordingId: string; startedAtMs: number }
  | {
      ok: false;
      reason: "already_recording" | "microphone_unavailable" | "bridge_error" | "not_implemented";
      detail?: string;
    };

export type RecordingSubmitResult =
  | {
      ok: true;
      recordingId: string;
      durationMs: number;
      chunkCount: number;
      /** Recording-link messages Photon accepted. Acceptance is not delivery. */
      notification: { acceptedCount: number; totalRecipients: number };
    }
  | {
      ok: false;
      reason: "not_recording" | "upload_failed" | "finalize_failed" | "not_implemented";
      retryable: boolean;
      detail?: string;
    };

export interface AudioRecordingProgress {
  phase: "idle" | "recording" | "stopping" | "uploading" | "notifying" | "sent" | "failed";
  recordingId: string | null;
  /** Recording timer source for the HUD. */
  elapsedMs: number;
  uploadedChunks: number;
  pendingChunks: number;
}

export interface HavenAudioService {
  /** Start glasses-mic capture for an alert and begin streaming chunks to the backend. */
  startRecording(alertId: string): Promise<RecordingStartResult>;
  /** Stop capture, upload remaining chunks, complete the upload, and trigger contact notification. */
  stopAndSendRecording(alertId: string): Promise<RecordingSubmitResult>;
  /** Stop capture and release resources without sending (app shutdown, reset). */
  disposeRecording(): Promise<void>;
  /** Progress updates for the HUD. Returns an unsubscribe function. */
  onProgress(listener: (progress: AudioRecordingProgress) => void): () => void;
}

export interface AudioServiceDeps {
  bridge: HavenBridge;
  http: HavenHttpClient;
  scheduler: Scheduler;
  log: Log;
}

// ── API client (Agent 1: src/services) ───────────────────────────────────────────

export interface HavenApiClient {
  /** Exchange the pairing code and persist the session (onboarding). */
  createSession(request: CreateSessionRequest): Promise<CreateSessionResponse>;
  /** Idempotent on request.clientAlertId; safe to retry with the same request. */
  createAlert(request: SOSRequest): Promise<CreateAlertResponse>;
  getAlert(alertId: string): Promise<AlertRecord>;
  getAlertEvents(alertId: string, cursor?: string | null): Promise<AlertEventsPage>;
  getContacts(): Promise<ContactsResponse>;
  saveContacts(contacts: EmergencyContactInput[]): Promise<ContactsResponse>;
}

export interface ApiClientDeps {
  http: HavenHttpClient;
  sessions: SessionStore;
}
