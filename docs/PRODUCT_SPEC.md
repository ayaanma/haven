# Haven product specification

Haven is a personal safety plugin for the Even Realities G2 glasses. It is built on the official
Even Hub SDK and runs inside the Even Realities companion app on iOS and Android.

## Operating assumptions

- The wearer keeps **Haven open as the active G2 plugin**. Haven does not need to run in the
  background or outside the active plugin.
- During normal operation the HUD shows **nothing**.
- The only activation gesture is a **normal single press** on the glasses (temple touchpad or
  R1 ring). Long press is not used.
- The platform's **double press** exit gesture is preserved: it always opens the system exit dialog.

## User workflow

### 1. Idle

- Haven is the active plugin; the HUD is blank.
- Motion sensing (G2 IMU) and recent phone-location caching may run inside the active plugin.
- **No audio is recorded.**
- Haven waits for a single press.

### 2. Single-press SOS activation

On one normal single press, the HUD shows:

```
Are you in danger?
If not, click to disable.
Sending message in...
        5
```

A prominent countdown starts at 5 seconds. The copy is fixed (`HUD_COPY` in `@haven/contracts`).

### 3. Cancellation

Another single press during the countdown:

- immediately cancels the pending SOS,
- contacts no one,
- records no audio,
- clears the countdown and returns to the blank HUD.

A press counts as a cancel if it happened **before** the 5-second deadline, even if input
disambiguation confirms it a few hundred milliseconds later (`isCancelPressInTime`).

### 4. Emergency message

If the countdown expires without cancellation:

1. Collect the latest available phone GPS location.
2. Collect recent G2 head-motion observations.
3. Send an authenticated SOS request to the Haven backend.
4. The backend **immediately** sends emergency messages through Photon 2.0:
   - only to the wearer's **configured, enabled, opted-in** emergency contacts;
   - saying the wearer activated a danger alert and needs help;
   - asking the contact to **call 911** and share the location;
   - including a Google Maps link, timestamps, and the GPS accuracy when available
     (a stale fix is labeled "last known", and a missing fix is stated plainly).
5. Haven never messages 911 or the police directly.
6. The first SOS message is **never delayed** for AI processing.

### 5. AI emergency context

- Google **Gemini 2.5 Flash-Lite** (`gemini-2.5-flash-lite`) analyzes recent head movement and
  location context. No other model is used.
- It may describe, with hedging, things like rapid or abrupt head movement, unusual motion,
  proximity to a road or recognizable place, or uncertain circumstances that warrant concern.
- It must **never invent incidents** (falls, attacks, injuries, vehicles, intent).
- The context goes out as a **separate Photon message** after the initial alert.
- If analysis fails, times out, or reports insufficient information, the SOS is unaffected.

### 6. Automatic recording

After the backend confirms that Photon **accepted at least one** initial emergency message
(event `alert.initial_notification_accepted`):

- microphone capture from the G2 glasses starts automatically, with no extra press;
- the HUD shows `SOS sent` with the accurate provider status (e.g. "accepted by Photon 2/3",
  and "delivered 1/3" only when the provider confirms delivery);
- the HUD shows `Recording...` with a running timer and `Click to send audio`.

### 7. Single-press recording submission

While recording, the next single press:

- stops microphone capture and finalizes the audio;
- uploads any remaining chunks;
- sends the recording (or a secure recording link) to the emergency contacts through Photon;
- shows the upload and notification status.

This press must **not** start another SOS.

### 8. Emergency contact replies

- Contacts reply from their existing messaging apps. They install nothing.
- Photon delivers replies to Haven's backend, which associates them with the active alert.
- While Haven is active, new replies appear on the HUD, e.g. `Mom: I received your alert.`,
  `Dad: I'm calling 911.`
- Only actual, authenticated messages are shown. Haven never fabricates acknowledgments or claims
  help is coming without evidence.

## G2 interaction contract

| Application state  | Single press                                         |
| ------------------ | ---------------------------------------------------- |
| IDLE               | Start the 5-second countdown                         |
| COUNTDOWN          | Cancel the emergency                                 |
| SUBMITTING_SOS     | Ignore                                               |
| WAITING_FOR_PHOTON | Ignore                                               |
| RECORDING          | Stop and submit audio                                |
| UPLOADING_AUDIO    | Ignore                                               |
| ACTIVE_ALERT       | Ignore                                               |
| ERROR              | Do not trigger a new alert without an explicit reset |

Encoded as `SINGLE_PRESS_BEHAVIOR` in `packages/contracts/src/client-state.ts` and tested.

## Emergency contacts

- Up to 5 contacts, each with a display name and an E.164 phone number.
- The wearer can enable or disable each contact.
- A contact receives alerts only after **opting in**: they text Haven's Photon line, and the
  backend marks them `verified`. Photon requires this for shared iMessage lines, and it ensures
  people consented to emergency messages. A contact who opts out (`revoked`) is never messaged.
- If no contact is eligible, the SOS fails honestly: the HUD says no message was sent.

## Explicitly excluded from the MVP

- Long-press SOS activation
- Direct police or 911 API integration
- Automated outbound voice calls
- Fetch.ai agent orchestration
- Scheduled safety check-ins
- Fall detection as an independent SOS trigger
- Always-on operation outside the active Haven plugin
- Extra apps that wearers or emergency contacts must install
