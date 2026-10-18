// Owner: Agent 4. Placeholder created by the foundation commit.
//
// Store chunks under AUDIO_STORAGE_PATH (tables: recordings, recording_chunks, share_links).
// Finalize by concatenating chunks 0..n-1 into a 16 kHz mono s16le WAV (G2_PCM_FORMAT).
// Share links: random token, store only sha256(token), expire after RECORDING_SHARE_LINK_TTL_MS.
import { NotImplementedError } from "../lib/errors";
import type { HavenRecordingStorage, ServiceContext } from "../lib/interfaces";

export function createRecordingStorage(_ctx: ServiceContext): HavenRecordingStorage {
  return {
    async storeChunk() {
      throw new NotImplementedError("recordings.storeChunk (Agent 4)");
    },
    async finalizeRecording() {
      throw new NotImplementedError("recordings.finalizeRecording (Agent 4)");
    },
    async createSecureShareLink() {
      throw new NotImplementedError("recordings.createSecureShareLink (Agent 4)");
    },
    async openSharedRecording() {
      throw new NotImplementedError("recordings.openSharedRecording (Agent 4)");
    },
  };
}
