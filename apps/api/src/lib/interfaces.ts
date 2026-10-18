/**
 * Backend module boundaries. Each interface is implemented by exactly one feature
 * agent inside its own directory and wired together only in src/container.ts.
 * Modules talk to each other through these interfaces, never by importing another
 * agent's internals. Foundation-owned: propose changes, do not edit independently.
 */
import type {
  AlertEventsPage,
  AlertRecord,
  AudioRecordingMetadata,
  ContactId,
  ContextAnalysisOutcome,
  ContextResult,
  CreateAlertResponse,
  EmergencyContact,
  EmergencyContactInput,
  EmergencySensorSnapshot,
  EventCursor,
  NotificationKind,
  NotificationStatus,
  RecordingId,
  SOSRequest,
} from "@haven/contracts";
import type { Db, EventLog } from "../db";
import type { Clock } from "./clock";
import type { HavenConfig } from "./config";
import type { Logger } from "./logger";

/** Shared infrastructure handed to every module factory. */
export interface ServiceContext {
  config: HavenConfig;
  db: Db;
  clock: Clock;
  logger: Logger;
  events: EventLog;
}

// ── Agent 2: contacts/ ─────────────────────────────────────────────────────────

export interface ContactsService {
  listContacts(): Promise<EmergencyContact[]>;
  /** Replace the whole list (PUT semantics; see SaveContactsRequestSchema). */
  replaceContacts(contacts: EmergencyContactInput[]): Promise<EmergencyContact[]>;
}

// ── Agent 2: alerts/ ───────────────────────────────────────────────────────────

export interface AlertService {
  /**
   * Idempotent on `clientAlertId`. Must persist the alert, append `sos.received`, and
   * start the initial SOS dispatch WITHOUT waiting for AI context analysis. Resolves
   * once the alert is persisted; notification progress is reported through events.
   */
  createAlert(request: SOSRequest, sessionId: string): Promise<CreateAlertResponse>;
  getAlert(alertId: string): Promise<AlertRecord | null>;
  /** Null when the alert does not exist. */
  listEvents(
    alertId: string,
    query: { cursor?: EventCursor | undefined; limit: number },
  ): Promise<AlertEventsPage | null>;
}

// ── Agent 2: photon/ ───────────────────────────────────────────────────────────

export interface NotificationResult {
  contactId: ContactId;
  status: NotificationStatus;
  /** Photon Message ID (`pho_msg_...`), or a mock ID in mock mode. */
  providerMessageId: string | null;
  failureCode: string | null;
}

export interface NotificationBatchResult {
  kind: NotificationKind;
  totalRecipients: number;
  /** Results with an accepted status (photon_accepted, delivery_unconfirmed, delivered). */
  acceptedCount: number;
  failedCount: number;
  results: NotificationResult[];
}

/**
 * Emergency messaging through Photon 2.0. Implementations persist per-contact rows in
 * `alert_notifications` and append `notification.*` events. Every send uses a stable
 * Photon `Idempotency-Key` so retries never duplicate a message. Only enabled,
 * verified contacts are messaged. 911 and police are never contacted.
 *
 * PHOTON_MODE=mock implementations MUST NOT make network calls.
 */
export interface HavenNotificationService {
  sendInitialSOS(alert: AlertRecord): Promise<NotificationBatchResult>;
  sendContextUpdate(alertId: string, context: ContextResult): Promise<NotificationBatchResult>;
  sendRecordingNotification(alertId: string, secureUrl: string): Promise<NotificationBatchResult>;
}

export interface PhotonWebhookRequest {
  /** Exact request bytes as text; signature verification needs them unmodified. */
  rawBody: string;
  /** Lowercased header names. */
  headers: Record<string, string>;
}

export type PhotonWebhookResult = { status: "processed" | "duplicate" | "ignored" };

/**
 * Handles `POST /api/v1/photon/webhooks`. Must reject (throw `unauthorized()`) any
 * request whose signature does not verify, and process each Photon event ID once.
 */
export interface PhotonWebhookHandler {
  handle(request: PhotonWebhookRequest): Promise<PhotonWebhookResult>;
}

// ── Agent 3: context/ ──────────────────────────────────────────────────────────

/**
 * AI emergency context (Gemini 2.5 Flash-Lite only). Never rejects: failures, timeouts,
 * and missing data resolve as `failed` / `insufficient_information`. Must never invent
 * incidents; see ContextResultSchema for the output rules.
 */
export interface HavenContextService {
  analyzeEmergencyContext(
    alert: AlertRecord,
    sensorData: EmergencySensorSnapshot,
  ): Promise<ContextAnalysisOutcome>;
}

// ── Agent 4: audio/ ────────────────────────────────────────────────────────────

export interface StoreChunkInput {
  alertId: string;
  recordingId: RecordingId;
  index: number;
  sha256: string;
  bytes: Uint8Array;
}

export interface StoreChunkResult {
  status: "stored" | "duplicate";
  receivedChunkCount: number;
}

export interface FinalizeRecordingInput {
  alertId: string;
  recordingId: RecordingId;
  chunkCount: number;
  durationMs: number;
  startedAt: number;
}

export interface SecureShareLink {
  /** `${PUBLIC_BASE_URL}/r/<token>`; the token is shown once and stored only as a hash. */
  url: string;
  expiresAt: number;
}

export interface SharedRecording {
  mimeType: string;
  byteLength: number;
  filename: string;
  body: Uint8Array;
}

/**
 * Durable storage for emergency audio. `storeChunk` is retry-safe: the same
 * (recordingId, index, sha256) is a duplicate, the same index with different bytes
 * throws `conflict()`. `finalizeRecording` is idempotent per recordingId.
 */
export interface HavenRecordingStorage {
  storeChunk(input: StoreChunkInput): Promise<StoreChunkResult>;
  finalizeRecording(input: FinalizeRecordingInput): Promise<AudioRecordingMetadata>;
  createSecureShareLink(input: {
    alertId: string;
    recordingId: RecordingId;
    ttlMs?: number;
  }): Promise<SecureShareLink>;
  /** Resolve `/r/:token`. Null for unknown, expired, or revoked tokens. */
  openSharedRecording(token: string): Promise<SharedRecording | null>;
}
