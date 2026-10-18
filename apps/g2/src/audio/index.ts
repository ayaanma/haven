// Owner: Agent 4. Placeholder created by the foundation commit.
//
// Implement with the bridge (Even Hub SDK 0.0.16):
//   - bridge.audioControl(true, AudioInputSource.Glasses) after the startup page exists
//     (core/bootstrap.ts creates it before this service is used).
//   - PCM arrives on onEvenHubEvent as event.audioEvent.audioPcm (16 kHz s16le mono, G2_PCM_FORMAT).
//   - Buffer into chunks ≤ MAX_AUDIO_CHUNK_BYTES, upload with deps.http.binary to
//     apiPaths.audioChunks(alertId) (query: recordingId, index, sha256), retrying safely,
//     then POST apiPaths.audioComplete(alertId).
//   - Capture stops if the WebView is suspended; report it rather than pretending to record.
import type {
  AudioServiceDeps,
  HavenAudioService,
  RecordingStartResult,
  RecordingSubmitResult,
} from "../core/interfaces";

export function createAudioService(deps: AudioServiceDeps): HavenAudioService {
  return {
    async startRecording(): Promise<RecordingStartResult> {
      deps.log.warn("recording not implemented yet (Agent 4)");
      return { ok: false, reason: "not_implemented" };
    },
    async stopAndSendRecording(): Promise<RecordingSubmitResult> {
      return { ok: false, reason: "not_implemented", retryable: false };
    },
    async disposeRecording() {},
    onProgress() {
      return () => {};
    },
  };
}
