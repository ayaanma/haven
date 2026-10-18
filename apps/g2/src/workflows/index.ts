// Owner: Agent 1. Placeholder created by the foundation commit.
//
// Implement the SOS state machine. Route EVERY single press through
// singlePressAction(state) from @haven/contracts, and:
//   - COUNTDOWN deadline = activation pressedAtMs + SOS_COUNTDOWN_MS. A cancel press counts when
//     isCancelPressInTime(event.pressedAtMs, deadline); submit at deadline + clickDisambiguationMs.
//   - Never treat double_press as cancel or SOS (the controller already opened the exit dialog).
//   - Start recording automatically on `alert.initial_notification_accepted`.
//   - Persist enough state (localStorage) to survive an Android WebView cold start.
import type { HavenAppContext } from "../core/app-context";

/** Starts the workflow; returns a function that stops it. */
export function startHavenWorkflow(ctx: HavenAppContext): () => void {
  ctx.input.subscribe((event) => {
    ctx.log.info(`input ${event.kind}`, event);
  });
  return () => ctx.input.unsubscribe();
}
