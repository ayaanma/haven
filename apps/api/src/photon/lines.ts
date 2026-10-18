// Photon shared iMessage line assignments (Agent 2).
//
// A shared iMessage line only reaches a person who has an active Assignment and has messaged
// the assigned line since. Photon allocates the line per person, so different contacts may
// get different Haven numbers. In live mode with PHOTON_LINE_MODE=shared, Haven creates an
// Assignment for each emergency contact's number (POST /v1/projects/{id}/platforms/imessage/
// assignments, permission `platforms:write`, one plan seat each) and shows the assigned number
// to the wearer as `optInNumber`. Released when the contact is removed or changes number.
//
// Mock mode and dedicated lines make no calls: every contact texts PHOTON_LINE_NUMBER.
import type { Photon } from "@photon-ai/api";
import type { HavenConfig } from "../lib/config";
import type { Logger } from "../lib/logger";
import { problemCode } from "./errors";

export interface LineAssignment {
  lineNumber: string;
  assignmentId: string;
}

export interface PhotonLineService {
  /** True when contacts need their own Assignment (live mode, shared lines). */
  readonly perContact: boolean;
  /** Assign (or find) the contact's shared line; null when it cannot be done right now. */
  assign(contact: { id: string; phoneNumber: string }): Promise<LineAssignment | null>;
  release(assignmentId: string): Promise<void>;
}

export interface LineServiceOptions {
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
}

export function createLineService(
  config: HavenConfig,
  logger: Logger,
  options: LineServiceOptions = {},
): PhotonLineService {
  const { mode, lineMode, apiKey, projectId, platform } = config.photon;
  if (
    mode !== "live" ||
    lineMode !== "shared" ||
    platform !== "imessage" ||
    !apiKey ||
    !projectId
  ) {
    return { perContact: false, assign: async () => null, release: async () => {} };
  }
  const log = logger.child({ module: "photon-lines" });

  let client: Promise<Photon> | null = null;
  const photon = (): Promise<Photon> => {
    client ??= import("@photon-ai/api")
      .then(
        ({ Photon: PhotonClient }) =>
          new PhotonClient({
            headers: { Authorization: `Bearer ${apiKey}` },
            timeoutMs: 10_000,
            ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
            ...(options.fetch ? { fetch: options.fetch } : {}),
          }),
      )
      .catch((error: unknown) => {
        client = null;
        throw error;
      });
    return client;
  };

  async function findExisting(api: Photon, handle: string): Promise<LineAssignment | null> {
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await api.projects.platforms.imessage.assignments.list({
        path: { id: projectId! },
        query: { pageSize: 100, ...(pageToken ? { pageToken } : {}) },
      });
      const match = result.assignments.find((a) => a.handle === handle && !a.releasedAt);
      if (match) return { lineNumber: match.assignedPhoneNumber, assignmentId: match.assignmentId };
      if (!result.nextPageToken) return null;
      pageToken = result.nextPageToken;
    }
    return null;
  }

  return {
    perContact: true,
    async assign(contact) {
      try {
        const api = await photon();
        try {
          const created = await api.projects.platforms.imessage.assignments.create({
            path: { id: projectId },
            body: { handle: contact.phoneNumber },
            headers: { idempotencyKey: `haven-assign:${contact.id}:${contact.phoneNumber}` },
          });
          log.info("shared line assigned", { contactId: contact.id });
          return { lineNumber: created.assignedPhoneNumber, assignmentId: created.assignmentId };
        } catch (error) {
          if (problemCode(error) !== "ASSIGNMENT_EXISTS") throw error;
          return await findExisting(api, contact.phoneNumber);
        }
      } catch (error) {
        log.warn("shared line assignment failed", {
          contactId: contact.id,
          // Problem codes only: Photon's detail text can contain the phone number.
          problem: problemCode(error),
          errorName: error instanceof Error ? error.name : "unknown",
        });
        return null;
      }
    },
    async release(assignmentId) {
      try {
        const api = await photon();
        await api.projects.platforms.imessage.assignments.release({
          path: { id: projectId, assignmentId },
        });
        log.info("shared line released", { assignmentId });
      } catch (error) {
        log.warn("shared line release failed", {
          assignmentId,
          problem: problemCode(error),
          errorName: error instanceof Error ? error.name : "unknown",
        });
      }
    },
  };
}
