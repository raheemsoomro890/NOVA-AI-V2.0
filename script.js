'use strict';

/* =============================================================
   NOVA-AI-V2.0 — script.js
   Voice Recognition, Speech Synthesis, Microphone Permissions,
   a finite State Machine, and a real-time Audio Visualizer.

   Vanilla JS, dependency-free. Defensive against missing DOM
   hooks and unsupported browser APIs so it degrades gracefully.
============================================================= */

(() => {
  /* -----------------------------------------------------------
     1. Constants
  ----------------------------------------------------------- */
  const STATES = Object.freeze({
    IDLE: 'idle',
    REQUESTING_PERMISSION: 'requesting_permission',
    LISTENING: 'listening',
    PROCESSING: 'processing',
    SPEAKING: 'speaking',
    ERROR: 'error',
  });

  const EVENTS = Object.freeze({
    MIC_BUTTON_CLICKED: 'MIC_BUTTON_CLICKED',
    PERMISSION_GRANTED: 'PERMISSION_GRANTED',
    PERMISSION_DENIED: 'PERMISSION_DENIED',
    SPEECH_RESULT: 'SPEECH_RESULT',
    SPEECH_ENDED: 'SPEECH_ENDED',
    SPEECH_ERROR: 'SPEECH_ERROR',
    PROCESSING_COMPLETE: 'PROCESSING_COMPLETE',
    SYNTHESIS_STARTED: 'SYNTHESIS_STARTED',
    SYNTHESIS_ENDED: 'SYNTHESIS_ENDED',
    RESET: 'RESET',
    FATAL_ERROR: 'FATAL_ERROR',
  });

  const DOM_IDS = Object.freeze({
    micButton: 'mic-button',
    statusText: 'status-text',
    transcript: 'transcript',
    visualizerCanvas: 'visualizer-canvas',
    errorBanner: 'error-banner',
  });

  const CONFIG = Object.freeze({
    recognitionLang: 'en-US',
    recognitionInterimResults: true,
    recognitionContinuous: false,
    recognitionMaxAlternatives: 1,
    synthesisRate: 1,
    synthesisPitch: 1,
    synthesisVolume: 1,
    fftSize: 256,
    visualizerBarGap: 2,
    visualizerSmoothing: 0.8,
    autoRestartOnNoSpeechErrorMs: 0, // 0 = disabled
  });

  /* -----------------------------------------------------------
     2. Tiny Event Bus
  ----------------------------------------------------------- */
  class EventBus extends EventTarget {
    emit(type, detail) {
      this.dispatchEvent(new CustomEvent(type, { detail }));
    }
    on(type, handler) {
      this.addEventListener(type, handler);
      return () => this.removeEventListener(type, handler);
    }
  }

  /* -----------------------------------------------------------
     3. Finite State Machine
  ----------------------------------------------------------- */
  class VoiceStateMachine {
    constructor(bus) {
      this.bus = bus;
      this.state = STATES.IDLE;
      this.previousState = null;

      this.transitions = {
        [STATES.IDLE]: {
          [EVENTS.MIC_BUTTON_CLICKED]: STATES.REQUESTING_PERMISSION,
        },
        [STATES.REQUESTING_PERMISSION]: {
          [EVENTS.PERMISSION_GRANTED]: STATES.LISTENING,
          [EVENTS.PERMISSION_DENIED]: STATES.ERROR,
          [EVENTS.FATAL_ERROR]: STATES.ERROR,
        },
        [STATES.LISTENING]: {
          [EVENTS.SPEECH_RESULT]: STATES.PROCESSING,
          [EVENTS.SPEECH_ENDED]: STATES.IDLE,
          [EVENTS.SPEECH_ERROR]: STATES.ERROR,
          [EVENTS.MIC_BUTTON_CLICKED]: STATES.IDLE,
        },
        [STATES.PROCESSING]: {
          [EVENTS.PROCESSING_COMPLETE]: STATES.SPEAKING,
          [EVENTS.SPEECH_ERROR]: STATES.ERROR,
          [EVENTS.RESET]: STATES.IDLE,
        },
        [STATES.SPEAKING]: {
          [EVENTS.SYNTHESIS_ENDED]: STATES.IDLE,
          [EVENTS.SPEECH_ERROR]: STATES.ERROR,
        },
        [STATES.ERROR]: {
          [EVENTS.RESET]: STATES.IDLE,
          [EVENTS.MIC_BUTTON_CLICKED]: STATES.REQUESTING_PERMISSION,
        },
      };
    }

    can(event) {
      return Boolean(this.transitions[this.state]?.[event]);
    }

    dispatch(event, payload) {
      const nextState = this.transitions[this.state]?.[event];
      if (!nextState) {
        console.warn(`[FSM] Invalid transition: "${event}" from state "${this.state}"`);
        return false;
      }
      this.previousState = this.state;
      this.state = nextState;
      this.bus.emit('state:change', {
        from: this.previousState,
        to: this.state,
        event,
        payload,
      });
      return true;
    }

    is(state) {
      return this.state === state;
    }
  }

  /* -----------------------------------------------------------
     4. Microphone Permission Manager
  ----------------------------------------------------------- */
  class MicrophonePermissionManager {
    constructor() {
      this.stream = null;
    }

    isSupported() {
      return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }

    async request() {
      if (!this.isSupported()) {
        throw new Error('MediaDevices API is not supported in this browser.');
      }
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        return this.stream;
      } catch (err) {
        const reason =
          err && err.name === 'NotAllowedError'
            ? 'Microphone permission was denied.'
            : `Microphone access failed: ${err?.message || 'unknown error'}`;
        throw new Error(reason);
      }
    }

    release() {
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
    }

    async queryPermissionState() {
      if (!navigator.permissions || !navigator.permissions.query) return 'unknown';
      try {
        const status = await navigator.permissions.query({ name: 'microphone' });
        return status.state; // 'granted' | 'denied' | 'prompt'
      } catch {
        return 'unknown';
      }
    }
  }

  /* -----------------------------------------------------------
     5. Voice Recognition Wrapper (Web Speech API)
  ----------------------------------------------------------- */
  class VoiceRecognitionService {
    constructor(bus) {
      this.bus = bus;
      const SpeechRecognitionImpl =
        window.SpeechRecognition || window.webkitSpeechRecognition || null;
      this.SpeechRecognitionImpl = SpeechRecognitionImpl;
      this.recognition = null;
      this.isListening = false;
      this.finalTranscript = '';
    }

    isSupported() {
      return Boolean(this.SpeechRecognitionImpl);
    }

    init() {
      if (!this.isSupported()) return;

      this.recognition = new this.SpeechRecognitionImpl();
      this.recognition.lang = CONFIG.recognitionLang;
      this.recognition.interimResults = CONFIG.recognitionInterimResults;
      this.recognition.continuous = CONFIG.recognitionContinuous;
      this.recognition.maxAlternatives = CONFIG.recognitionMaxAlternatives;

      this.recognition.onstart = () => {
        this.isListening = true;
        this.finalTranscript = '';
        this.bus.emit('recognition:start');
      };

      this.recognition.onresult = (event) => {
        let interim = '';
        let final = '';

        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const text = result[0]?.transcript ?? '';
          if (result.isFinal) {
            final += text;
          } else {
            interim += text;
          }
        }

        if (final) {
          this.finalTranscript += final;
        }

        this.bus.emit('recognition:transcript', {
          interim,
          final: this.finalTranscript,
          isFinal: Boolean(final),
        });

        if (final) {
          this.bus.emit(EVENTS.SPEECH_RESULT, { transcript: this.finalTranscript.trim() });
        }
      };

      this.recognition.onerror = (event) => {
        this.isListening = false;
        const message = this._describeError(event.error);
        this.bus.emit(EVENTS.SPEECH_ERROR, { message, code: event.error });
      };

      this.recognition.onend = () => {
        this.isListening = false;
        this.bus.emit('recognition:end');
        if (!this.finalTranscript) {
          this.bus.emit(EVENTS.SPEECH_ENDED);
        }
      };
    }

    _describeError(code) {
      const map = {
        'no-speech': 'No speech was detected. Please try again.',
        'audio-capture': 'No microphone was found or it is unavailable.',
        'not-allowed': 'Microphone permission was denied.',
        network: 'A network error interrupted speech recognition.',
        aborted: 'Speech recognition was aborted.',
      };
      return map[code] || `Speech recognition error: ${code}`;
    }

    start() {
      if (!this.recognition) this.init();
      if (!this.recognition) {
        this.bus.emit(EVENTS.SPEECH_ERROR, {
          message: 'Speech recognition is not supported in this browser.',
          code: 'unsupported',
        });
        return;
      }
      if (this.isListening) return;
      try {
        this.recognition.start();
      } catch (err) {
        this.bus.emit(EVENTS.SPEECH_ERROR, {
          message: `Unable to start recognition: ${err.message}`,
          code: 'start-failed',
        });
      }
    }

    stop() {
      if (this.recognition && this.isListening) {
        this.recognition.stop();
      }
    }

    abort() {
      if (this.recognition) {
        this.recognition.abort();
        this.isListening = false;
      }
    }
  }

  /* -----------------------------------------------------------
     6. Speech Synthesis Wrapper
  ----------------------------------------------------------- */
  class SpeechSynthesisService {
    constructor(bus) {
      this.bus = bus;
      this.synth = window.speechSynthesis || null;
      this.queue = [];
      this.speaking = false;
      this.voices = [];

      if (this.isSupported()) {
        this._loadVoices();
        if ('onvoiceschanged' in this.synth) {
          this.synth.onvoiceschanged = () => this._loadVoices();
        }
      }
    }

    isSupported() {
      return Boolean(this.synth);
    }

    _loadVoices() {
      this.voices = this.synth.getVoices();
    }

    _pickVoice(preferredLang) {
      if (!this.voices.length) return null;
      return (
        this.voices.find((v) => v.lang === preferredLang) ||
        this.voices.find((v) => v.lang?.startsWith(preferredLang?.split('-')[0])) ||
        this.voices[0]
      );
    }

    speak(text, options = {}) {
      if (!this.isSupported()) {
        this.bus.emit(EVENTS.SPEECH_ERROR, {
          message: 'Speech synthesis is not supported in this browser.',
          code: 'unsupported',
        });
        return;
      }
      if (!text || !text.trim()) return;

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = options.lang || CONFIG.recognitionLang;
      utterance.rate = options.rate ?? CONFIG.synthesisRate;
      utterance.pitch = options.pitch ?? CONFIG.synthesisPitch;
      utterance.volume = options.volume ?? CONFIG.synthesisVolume;

      const voice = this._pickVoice(utterance.lang);
      if (voice) utterance.voice = voice;

      utterance.onstart = () => {
        this.speaking = true;
        this.bus.emit(EVENTS.SYNTHESIS_STARTED, { text });
      };

      utterance.onend = () => {
        this.speaking = false;
        this._processQueue();
        this.bus.emit(EVENTS.SYNTHESIS_ENDED, { text });
      };

      utterance.onerror = (event) => {
        this.speaking = false;
        this.bus.emit(EVENTS.SPEECH_ERROR, {
          message: `Speech synthesis error: ${event.error}`,
          code: event.error,
        });
      };

      this.queue.push(utterance);
      this._processQueue();
    }

    _processQueue() {
      if (this.speaking || this.queue.length === 0) return;
      const next = this.queue.shift();
      this.synth.speak(next);
    }

    cancel() {
      if (this.isSupported()) {
        this.queue = [];
        this.synth.cancel();
        this.speaking = false;
      }
    }
  }

  /* -----------------------------------------------------------
     7. Audio Visualizer (Web Audio API + Canvas)
  ----------------------------------------------------------- */
  class AudioVisualizer {
    constructor(canvas) {
      this.canvas = canvas || null;
      this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
      this.audioContext = null;
      this.analyser = null;
      this.source = null;
      this.dataArray = null;
      this.animationFrameId = null;
      this.resizeObserver = null;
    }

    isSupported() {
      return Boolean(this.canvas && this.ctx && (window.AudioContext || window.webkitAudioContext));
    }

    attach(stream) {
      if (!this.isSupported() || !stream) return;

      const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioContextImpl();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = CONFIG.fftSize;
      this.analyser.smoothingTimeConstant = CONFIG.visualizerSmoothing;

      this.source = this.audioContext.createMediaStreamSource(stream);
      this.source.connect(this.analyser);

      this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

      this._resizeCanvas();
      this.resizeObserver = new ResizeObserver(() => this._resizeCanvas());
      this.resizeObserver.observe(this.canvas);

      this._draw();
    }

    _resizeCanvas() {
      if (!this.canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const rect = this.canvas.getBoundingClientRect();
      this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    _draw() {
      if (!this.analyser) return;

      this.animationFrameId = requestAnimationFrame(() => this._draw());
      this.analyser.getByteFrequencyData(this.dataArray);

      const rect = this.canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;

      this.ctx.clearRect(0, 0, width, height);

      const barCount = this.dataArray.length;
      const gap = CONFIG.visualizerBarGap;
      const barWidth = width / barCount - gap;

      const style = getComputedStyle(document.documentElement);
      const barColor = style.getPropertyValue('--color-brand').trim() || '#6366f1';

      this.ctx.fillStyle = barColor || '#6366f1';

      for (let i = 0; i < barCount; i += 1) {
        const value = this.dataArray[i] / 255;
        const barHeight = Math.max(2, value * height);
        const x = i * (barWidth + gap);
        const y = height - barHeight;
        this.ctx.fillRect(x, y, barWidth, barHeight);
      }
    }

    detach() {
      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
      if (this.resizeObserver && this.canvas) {
        this.resizeObserver.unobserve(this.canvas);
        this.resizeObserver = null;
      }
      if (this.source) {
        try {
          this.source.disconnect();
        } catch {
          /* already disconnected */
        }
        this.source = null;
      }
      if (this.audioContext) {
        this.audioContext.close().catch(() => {});
        this.audioContext = null;
      }
      this.analyser = null;
      this.dataArray = null;
      if (this.ctx && this.canvas) {
        const rect = this.canvas.getBoundingClientRect();
        this.ctx.clearRect(0, 0, rect.width, rect.height);
      }
    }
  }

  /* -----------------------------------------------------------
     8. UI Binder — connects state/events to DOM (defensive)
  ----------------------------------------------------------- */
  class UIBinder {
    constructor() {
      this.micButton = document.getElementById(DOM_IDS.micButton);
      this.statusText = document.getElementById(DOM_IDS.statusText);
      this.transcript = document.getElementById(DOM_IDS.transcript);
      this.visualizerCanvas = document.getElementById(DOM_IDS.visualizerCanvas);
      this.errorBanner = document.getElementById(DOM_IDS.errorBanner);
    }

    setStatus(text) {
      if (this.statusText) {
        this.statusText.textContent = text;
      }
    }

    setTranscript(text) {
      if (this.transcript) {
        this.transcript.textContent = text;
      }
    }

    showError(message) {
      if (this.errorBanner) {
        this.errorBanner.textContent = message;
        this.errorBanner.hidden = false;
      }
      console.error(`[NOVA-AI] ${message}`);
    }

    clearError() {
      if (this.errorBanner) {
        this.errorBanner.hidden = true;
        this.errorBanner.textContent = '';
      }
    }

    setMicActive(isActive) {
      if (this.micButton) {
        this.micButton.setAttribute('aria-pressed', String(isActive));
        this.micButton.classList.toggle('is-active', isActive);
      }
    }

    onMicClick(handler) {
      this.micButton?.addEventListener('click', handler);
    }
  }

  /* -----------------------------------------------------------
     9. Application Controller
  ----------------------------------------------------------- */
  class NovaVoiceApp {
    constructor() {
      this.bus = new EventBus();
      this.fsm = new VoiceStateMachine(this.bus);
      this.micManager = new MicrophonePermissionManager();
      this.recognition = new VoiceRecognitionService(this.bus);
      this.synthesis = new SpeechSynthesisService(this.bus);
      this.ui = new UIBinder();
      this.visualizer = new AudioVisualizer(this.ui.visualizerCanvas);
    }

    init() {
      this._bindUIEvents();
      this._bindDomainEvents();
      this._bindStateRenderer();
      this.ui.setStatus('Idle. Tap the microphone to begin.');
    }

    _bindUIEvents() {
      this.ui.onMicClick(() => {
        if (this.fsm.is(STATES.LISTENING)) {
          this.recognition.stop();
          this.fsm.dispatch(EVENTS.MIC_BUTTON_CLICKED);
          return;
        }
        this.ui.clearError();
        this.fsm.dispatch(EVENTS.MIC_BUTTON_CLICKED);
        this._handlePermissionFlow();
      });
    }

    async _handlePermissionFlow() {
      try {
        const stream = await this.micManager.request();
        this.fsm.dispatch(EVENTS.PERMISSION_GRANTED);
        this.visualizer.attach(stream);
        this.recognition.start();
      } catch (err) {
        this.fsm.dispatch(EVENTS.PERMISSION_DENIED, { message: err.message });
        this.ui.showError(err.message);
      }
    }

    _bindDomainEvents() {
      this.bus.on('recognition:transcript', (event) => {
        const { interim, final } = event.detail;
        this.ui.setTranscript(final || interim);
      });

      this.bus.on(EVENTS.SPEECH_RESULT, (event) => {
        const { transcript } = event.detail;
        this.fsm.dispatch(EVENTS.SPEECH_RESULT, { transcript });
        this._processTranscript(transcript);
      });

      this.bus.on(EVENTS.SPEECH_ENDED, () => {
        if (this.fsm.can(EVENTS.SPEECH_ENDED)) {
          this.fsm.dispatch(EVENTS.SPEECH_ENDED);
        }
        this._teardownListening();
      });

      this.bus.on(EVENTS.SPEECH_ERROR, (event) => {
        const { message } = event.detail;
        this.ui.showError(message);
        if (this.fsm.can(EVENTS.SPEECH_ERROR)) {
          this.fsm.dispatch(EVENTS.SPEECH_ERROR, event.detail);
        }
        this._teardownListening();
      });

      this.bus.on(EVENTS.SYNTHESIS_ENDED, () => {
        this.fsm.dispatch(EVENTS.SYNTHESIS_ENDED);
      });
    }

    _teardownListening() {
      this.visualizer.detach();
      this.micManager.release();
    }

    /**
     * Placeholder response pipeline. No business logic / AI provider
     * is implemented yet — this simply echoes the transcript back
     * through speech synthesis so the full pipeline is exercised
     * end-to-end (mic -> recognition -> "processing" -> synthesis).
     */
    _processTranscript(transcript) {
      this.fsm.dispatch(EVENTS.PROCESSING_COMPLETE, { transcript });
      const reply = transcript ? `You said: ${transcript}` : 'I did not catch that.';
      this.synthesis.speak(reply);
    }

    _bindStateRenderer() {
      this.bus.on('state:change', (event) => {
        const { to } = event.detail;
        this.ui.setMicActive(to === STATES.LISTENING);

        const statusMap = {
          [STATES.IDLE]: 'Idle. Tap the microphone to begin.',
          [STATES.REQUESTING_PERMISSION]: 'Requesting microphone permission…',
          [STATES.LISTENING]: 'Listening…',
          [STATES.PROCESSING]: 'Processing…',
          [STATES.SPEAKING]: 'Speaking…',
          [STATES.ERROR]: 'An error occurred. Tap the microphone to retry.',
        };
        this.ui.setStatus(statusMap[to] || '');
      });
    }
  }

  /* -----------------------------------------------------------
     10. Bootstrap
  ----------------------------------------------------------- */
  function bootstrap() {
    const app = new NovaVoiceApp();
    app.init();
    window.__NOVA_AI__ = app; // exposed for debugging/inspection only
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
