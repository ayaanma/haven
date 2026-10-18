import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureId, fixtureUuid } from "@haven/contracts/testing";
import { createAudioJournal, type AudioCheckpoint } from "./journal";
import { fakeAudioIndexedDB } from "./testing/fake-indexed-db";

function checkpoint(): AudioCheckpoint {
  return {
    alertId: fixtureId("alt"),
    recordingId: fixtureUuid(),
    startedAtMs: 1000,
    totalBytes: 4,
    nextIndex: 1,
    uploadedChunks: 0,
    chunks: [{ index: 0, bytes: new Uint8Array([0, 128, 255, 127]) }],
    tail: new Uint8Array(),
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("audio evidence checkpoints", () => {
  it("survives service recreation and does not retain SDK buffer references", async () => {
    vi.stubGlobal("indexedDB", fakeAudioIndexedDB().factory);
    const journal = createAudioJournal();
    const original = checkpoint();
    const save = journal.save(original);
    original.chunks[0]!.bytes.fill(0);
    await save;
    expect((await createAudioJournal().load())?.chunks[0]?.bytes).toEqual(
      new Uint8Array([0, 128, 255, 127]),
    );
    await journal.save(null);
    expect(await createAudioJournal().load()).toBeNull();
  });
  it("coalesces slow writes to the newest bounded snapshot, including deletion", async () => {
    const fake = fakeAudioIndexedDB();
    vi.stubGlobal("indexedDB", fake.factory);
    const journal = createAudioJournal();
    fake.block();
    const first = journal.save(checkpoint());
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = journal.save({ ...checkpoint(), uploadedChunks: 1, chunks: [] });
    const last = journal.save(null);
    fake.unblock();
    await Promise.all([first, second, last]);
    expect(await createAudioJournal().load()).toBeNull();
  });
});
