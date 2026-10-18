import { G2_PCM_BYTES_PER_SECOND, G2_PCM_FORMAT } from "@haven/contracts";

/** PCM samples are copied byte-for-byte; only the RIFF/WAVE container is added. */
export function encodeWav(pcm: Uint8Array): Uint8Array {
  if (!pcm.length || pcm.length % 2) throw new Error("Expected complete signed 16-bit PCM samples");
  const wav = new Uint8Array(44 + pcm.length);
  const view = new DataView(wav.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) wav[offset + i] = value.charCodeAt(i);
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, G2_PCM_FORMAT.channels, true);
  view.setUint32(24, G2_PCM_FORMAT.sampleRateHz, true);
  view.setUint32(28, G2_PCM_BYTES_PER_SECOND, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, G2_PCM_FORMAT.bitsPerSample, true);
  text(36, "data");
  view.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);
  return wav;
}
