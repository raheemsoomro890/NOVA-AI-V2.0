# NOVA AI V2.0 — Architecture Document

## Table of Contents

1. [Overview](#1-overview)
2. [System Diagram](#2-system-diagram)
3. [Frontend Architecture](#3-frontend-architecture)
4. [Backend Architecture](#4-backend-architecture)
5. [Gemini Integration](#5-gemini-integration)
6. [Voice System](#6-voice-system)
7. [State Machine](#7-state-machine)
8. [Data Flow — End to End](#8-data-flow--end-to-end)
9. [Security Model](#9-security-model)
10. [Deployment Architecture](#10-deployment-architecture)
11. [Error Handling Strategy](#11-error-handling-strategy)
12. [Design Decisions & Trade-offs](#12-design-decisions--trade-offs)
13. [Future Evolution](#13-future-evolution)

---

## 1. Overview

NOVA AI V2.0 is a full-stack, voice-driven AI assistant. A user speaks into
the browser; speech is transcribed client-side, sent to a single secure
backend endpoint, processed by Google's Gemini model, and the reply is
spoken back to the user — all coordinated by a predictable client-side
finite state machine.

The system is intentionally small in surface area:

- **One frontend bundle** (`index.html`, `style.css`, `script.js`) served
  as static files.
- **One backend process** (`server.js`) — a single Express app exposing a
  minimal, well-guarded API.
- **One external dependency** — Google Gemini, accessed only from the
  server.

This minimalism is deliberate: fewer moving parts means a smaller attack
surface, simpler deployment, and an easier mental model for anyone joining
the project.

---

## 2. System Diagram

---

## 3. Frontend Architecture

The frontend is a single-page, dependency-free static bundle: no build
step, no framework, no bundler required. It is composed of three files
served directly by Express.

### 3.1 `index.html`
The application shell. Defines the DOM hooks the JavaScript layer binds
to (`#mic-button`, `#status-text`, `#transcript`, `#visualizer-canvas`,
`#error-banner`), plus metadata, CSP, and a `<noscript>` fallback.

### 3.2 `style.css`
A token-driven design system (CSS custom properties for color, spacing,
typography, radius, shadow) with a reset layer, accessibility utilities
(`.sr-only`, `:focus-visible`, skip link), and base shell styling. No
component-specific styling is baked in beyond the boot loader and error
banner, keeping the visual system easy to extend.

### 3.3 `script.js`
The application logic, organized into single-responsibility classes:

| Class                        | Responsibility                                             |
|-------------------------------|-------------------------------------------------------------|
| `EventBus`                   | Internal pub/sub decoupling all other modules              |
| `VoiceStateMachine`          | Enforces valid UI states and transitions (see §7)           |
| `MicrophonePermissionManager`| Requests/releases `getUserMedia` audio streams               |
| `VoiceRecognitionService`    | Wraps the Web Speech API (`SpeechRecognition`)               |
| `SpeechSynthesisService`     | Wraps `speechSynthesis` with a speaking queue                |
| `AudioVisualizer`            | Draws real-time frequency bars via `AnalyserNode` + Canvas   |
| `UIBinder`                   | Reads/writes DOM state; the only class touching the DOM      |
| `NovaVoiceApp`               | Composition root — wires all services together               |

No class reaches into another's internals directly; all cross-module
communication happens through the `EventBus`. This keeps each service
independently testable and replaceable (e.g. swapping the Web Speech API
for a different provider later touches only `VoiceRecognitionService`).

---

## 4. Backend Architecture

The backend is a single Express application (`server.js`) structured in
clear, ordered middleware layers:

The backend deliberately has no persistence layer, no ORM, and no session
management in this version — it is a stateless proxy in front of Gemini.
This keeps it horizontally scalable and trivially deployable to serverless
platforms.

---

## 5. Gemini Integration

All AI calls are isolated behind a single function, `generateChatReply()`,
which is the only place the `@google/generative-ai` SDK is touched.

**Key properties:**

- The `GoogleGenerativeAI` client is instantiated once at server startup
  using `GEMINI_API_KEY` from environment variables (via `dotenv`).
- The API key is read **only** from `process.env` — it is never logged,
  never included in a response body, and never sent to the client.
- The model name (`GEMINI_MODEL`) is also environment-driven, so it can be
  changed per deployment without a code change.
- `POST /api/chat` accepts an optional `history` array so multi-turn
  context can be forwarded to Gemini; both `message` and `history` are
  strictly validated (type, length, shape) before being sent.
- Any failure from the Gemini SDK bubbles up through `next(err)` into the
  centralized error handler rather than leaking stack traces to the
  client.

This isolation means the AI provider is swappable in the future (e.g.
adding a fallback provider) without touching routing, validation, or
frontend code — only `generateChatReply()` and its call site change.

---

## 6. Voice System

The voice system spans both frontend services and is intentionally
split into two independent halves that never call each other directly —
they only communicate through the state machine and event bus.

### 6.1 Input — Voice Recognition
`VoiceRecognitionService` wraps the browser's native `SpeechRecognition`
(with the `webkitSpeechRecognition` fallback). It streams interim and
final transcripts as events, and translates browser-level error codes
(`no-speech`, `not-allowed`, `network`, etc.) into human-readable messages.

### 6.2 Output — Speech Synthesis
`SpeechSynthesisService` wraps `speechSynthesis`/`SpeechSynthesisUtterance`.
It queues utterances (so overlapping `speak()` calls don't collide),
picks the best available voice for the target language, and emits
lifecycle events (`SYNTHESIS_STARTED`, `SYNTHESIS_ENDED`) that drive the
state machine back to idle once speaking finishes.

### 6.3 Microphone Permissions
`MicrophonePermissionManager` centralizes all `getUserMedia` calls,
exposes a `queryPermissionState()` helper for the Permissions API where
supported, and guarantees `stream.getTracks().stop()` is called on
teardown so the microphone indicator is released promptly.

### 6.4 Visualizer
`AudioVisualizer` connects a `MediaStreamAudioSourceNode` to an
`AnalyserNode` and paints frequency-domain bars onto a `<canvas>` every
animation frame. It is fully decoupled from recognition/synthesis — it
only needs a `MediaStream`, so it could equally visualize synthesized
audio in a future iteration.

---

## 7. State Machine

The frontend behavior is governed by an explicit finite state machine
(`VoiceStateMachine`) rather than scattered boolean flags. This guarantees
the UI can never be, for example, "listening" and "speaking" at once.

### 7.1 States

| State                   | Meaning                                      |
|---------------------------|-----------------------------------------------|
| `idle`                   | Waiting for user interaction                  |
| `requesting_permission`  | Awaiting microphone permission                |
| `listening`              | Actively capturing speech                     |
| `processing`             | Transcript captured, awaiting AI response      |
| `speaking`               | Synthesizing/playing the AI's reply            |
| `error`                  | A recoverable failure occurred                 |

### 7.2 Transition Table

Any event not present in the current state's transition map is rejected
and logged as a warning — invalid transitions cannot silently corrupt
application state. Every successful transition emits a `state:change`
event, which `UIBinder` listens to in order to update status text and the
microphone button's `aria-pressed` state, keeping the UI a pure function
of the current state.

---

## 8. Data Flow — End to End

1. User taps the microphone button → `MIC_BUTTON_CLICKED` dispatched.
2. FSM transitions to `requesting_permission`; `getUserMedia` is invoked.
3. On grant, FSM transitions to `listening`; the audio stream is attached
   to both `VoiceRecognitionService` and `AudioVisualizer`.
4. Speech is transcribed in real time; interim results update the
   transcript display live.
5. On a final result, `SPEECH_RESULT` fires → FSM moves to `processing`.
6. The transcript is sent via `fetch()` to `POST /api/chat`.
7. The server validates the payload, calls Gemini, and returns
   `{ success: true, data: { reply } }`.
8. `PROCESSING_COMPLETE` fires → FSM moves to `speaking`; the reply text
   is passed to `SpeechSynthesisService.speak()`.
9. When synthesis finishes, `SYNTHESIS_ENDED` fires → FSM returns to
   `idle`, ready for the next interaction.

Any failure at steps 3–8 routes through `SPEECH_ERROR`, surfaces a message
in the error banner, and returns the FSM to the `error` state, from which
the user can retry.

---

## 9. Security Model

- **Secret isolation** — `GEMINI_API_KEY` exists only in server memory
  (via `process.env`), loaded from `.env` (git-ignored) or platform
  environment variables in production. It is never part of any HTTP
  response, log line, or client bundle.
- **Rate limiting** — two layers: a global limiter (300 req/15 min/IP) and
  a stricter limiter scoped to `POST /api/chat` (20 req/min/IP), reducing
  abuse and controlling Gemini API cost exposure.
- **Input validation** — `message` and `history` are type-checked,
  length-capped, and shape-validated before ever reaching the Gemini SDK.
- **Payload size limits** — the JSON body parser is capped at 32kb,
  rejecting oversized requests before they're processed.
- **CORS** — origin is environment-driven (`CORS_ORIGIN`), defaulting to
  `*` in development but intended to be scoped to the real frontend
  domain in production.
- **Content-Security-Policy** — set in `index.html` to restrict script,
  style, and connection sources to `'self'`.
- **No client-side secrets** — the frontend never holds any API key or
  credential; all privileged calls happen server-side.

---

## 10. Deployment Architecture

NOVA AI V2.0 is designed to deploy as a single unit on **Vercel**, using
`vercel.json` to route traffic:

**Deployment characteristics:**

- The Express app itself is stateless, so it can run identically as a
  long-lived Node process (e.g. `npm start` on a VM/container) or as a
  serverless function on Vercel — no code changes required between the
  two.
- Environment variables (`GEMINI_API_KEY`, `GEMINI_MODEL`, `CORS_ORIGIN`,
  `NODE_ENV`) are configured on the hosting platform, never committed to
  the repository.
- Static assets in `/public` are served directly by the platform's CDN
  layer where available, reducing load on the Node process.
- Graceful shutdown handlers (`SIGTERM`/`SIGINT`) ensure in-flight
  requests complete cleanly on redeploys in non-serverless environments.

---

## 11. Error Handling Strategy

Errors are handled at two coordinated layers:

**Server side** — a single centralized Express error-handling middleware
normalizes every failure (malformed JSON, oversized payload, Gemini SDK
errors, unexpected exceptions) into a consistent shape:

```json
{ "success": false, "error": "Human-readable message" }
```

Stack traces and internal error details are logged server-side only and
never returned to the client. Unhandled promise rejections and uncaught
exceptions are caught at the process level as a last line of defense.

**Client side** — every service (`VoiceRecognitionService`,
`SpeechSynthesisService`, `MicrophonePermissionManager`) translates raw
browser/API errors into a single `SPEECH_ERROR` event carrying a
human-readable message. The FSM routes this into the `error` state
uniformly, regardless of which subsystem failed, so the user always sees
one consistent recovery path: retry via the microphone button.

---

## 12. Design Decisions & Trade-offs

| Decision                                      | Rationale                                                        |
|-------------------------------------------------|---------------------------------------------------------------------|
| No frontend framework                          | Zero build step, minimal dependencies, fastest possible load time  |
| No database in this version                    | Backend stays stateless and trivially scalable/serverless-friendly |
| Single `/api/chat` endpoint                    | Smallest possible API surface to secure and rate-limit             |
| Explicit FSM instead of boolean flags           | Prevents impossible UI states; easier to reason about and extend   |
| Gemini SDK isolated to one function            | Swappable AI provider; single point of validation and error handling |
| Web Speech API (browser-native)                | No extra network hop or third-party STT cost for transcription     |

---

## 13. Future Evolution

The current architecture is intentionally a stable foundation. Documented
extension points, none of which require restructuring the existing
layers:

- **Persistence** — introduce a database-backed conversation history
  behind a new repository interface, without touching `server.js` routing.
- **Streaming responses** — swap `generateContent` for Gemini's streaming
  API and switch the `/api/chat` response to Server-Sent Events.
- **Authentication** — add an auth middleware layer ahead of the existing
  rate limiters; the route handlers themselves stay unchanged.
- **Multi-provider AI** — add a provider abstraction alongside
  `generateChatReply()` so Gemini can be one of several backends.
- **Plugin system** — the voice pipeline's event-bus architecture already
  supports adding new listeners (e.g. a plugin reacting to `SPEECH_RESULT`)
  without modifying `NovaVoiceApp` itself.

  
