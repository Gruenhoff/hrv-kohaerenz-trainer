/**
 * Herzfrequenz-Sonifikation (Closed-Loop Audio Biofeedback)
 *
 * Kontinuierlicher Sinus-Ton, dessen Tonhöhe der momentanen Herzfrequenz folgt.
 * Während der RSA-Welle steigt die HF beim Einatmen → Ton steigt;
 * fällt beim Ausatmen → Ton fällt. Der Nutzer *hört* seine HRV.
 *
 * Mapping:
 *   HF 45 bpm  → 180 Hz (tiefes A3-)
 *   HF 100 bpm → 600 Hz (hohes D5)
 *   Logarithmisch interpoliert → musikalisch gleichmäßig.
 *
 * Lautstärke:
 *   Kohärenz 0%   → 30% Grundvolumen (immer hörbar)
 *   Kohärenz 100% → 100% Volumen (klingt voller / präsenter)
 *
 * Es gibt keine anderen Töne mehr (keine Atempacer-Sounds, keine Chimes).
 */
export class HRSonification {
    constructor() {
        this._ctx        = null;
        this._osc        = null;
        this._gain       = null;
        this.enabled     = true;
        this.volume      = 0.35;          // Master-Volume vom Slider (0..1)
        this._isRunning  = false;
        this._coherence  = 0;             // 0..100
        this._currentHr  = 65;            // bpm – startet bei realistischer Ruhe-HF
    }

    _context() {
        if (!this._ctx) {
            this._ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this._ctx.state === 'suspended') this._ctx.resume();
        return this._ctx;
    }

    /** HF in bpm → Frequenz in Hz (logarithmische Skala 45–100 bpm → 180–600 Hz) */
    _hrToFreq(hr) {
        const HR_MIN = 45,  HR_MAX = 100;
        const F_MIN  = 180, F_MAX  = 600;
        const clamped = Math.max(HR_MIN, Math.min(HR_MAX, hr));
        const t = (clamped - HR_MIN) / (HR_MAX - HR_MIN);
        // log-Interpolation für angenehme Tonleiter
        return F_MIN * Math.pow(F_MAX / F_MIN, t);
    }

    /** Aktuelles Ziel-Volumen aus Master-Volume und Kohärenz */
    _targetGain() {
        const cohBoost = 0.3 + 0.7 * (this._coherence / 100);  // 30..100 %
        return this.volume * cohBoost * 0.6;                    // 0.6 = Sicherheits-Cap
    }

    /** Sonifikation starten (oder unstummschalten wenn schon läuft) */
    start() {
        if (!this.enabled) return;
        if (this._isRunning) return;
        const ctx = this._context();
        this._osc  = ctx.createOscillator();
        this._gain = ctx.createGain();
        this._osc.type = 'sine';
        this._osc.frequency.setValueAtTime(this._hrToFreq(this._currentHr), ctx.currentTime);
        this._gain.gain.setValueAtTime(0, ctx.currentTime);
        this._gain.gain.linearRampToValueAtTime(this._targetGain(), ctx.currentTime + 0.4);
        this._osc.connect(this._gain);
        this._gain.connect(ctx.destination);
        this._osc.start();
        this._isRunning = true;
    }

    /** Sonifikation stoppen (Fade-out 0.3 s) */
    stop() {
        if (!this._isRunning) return;
        try {
            const ctx = this._context();
            const now = ctx.currentTime;
            this._gain.gain.cancelScheduledValues(now);
            this._gain.gain.setValueAtTime(this._gain.gain.value, now);
            this._gain.gain.linearRampToValueAtTime(0, now + 0.3);
            this._osc.stop(now + 0.35);
        } catch (_) {}
        this._osc  = null;
        this._gain = null;
        this._isRunning = false;
    }

    /** Neue HF (bpm) → Frequenz sanft auf neuen Wert rampen (~250 ms) */
    updateHeartRate(bpm) {
        if (!bpm || bpm < 30 || bpm > 220) return;
        this._currentHr = bpm;
        if (!this._isRunning || !this._osc) return;
        const ctx = this._context();
        const now = ctx.currentTime;
        const target = this._hrToFreq(bpm);
        this._osc.frequency.cancelScheduledValues(now);
        this._osc.frequency.setValueAtTime(this._osc.frequency.value, now);
        this._osc.frequency.linearRampToValueAtTime(target, now + 0.25);
    }

    /** Neue Kohärenz (0..100) → Volumen sanft anpassen (~500 ms) */
    updateCoherence(score) {
        this._coherence = Math.max(0, Math.min(100, score));
        if (!this._isRunning || !this._gain) return;
        const ctx = this._context();
        const now = ctx.currentTime;
        const target = this._targetGain();
        this._gain.gain.cancelScheduledValues(now);
        this._gain.gain.setValueAtTime(this._gain.gain.value, now);
        this._gain.gain.linearRampToValueAtTime(target, now + 0.5);
    }

    /** Lautstärke vom Slider (0..1) */
    setVolume(v) {
        this.volume = Math.max(0, Math.min(1, v));
        if (this._isRunning && this._gain) {
            const ctx = this._context();
            this._gain.gain.linearRampToValueAtTime(this._targetGain(), ctx.currentTime + 0.2);
        }
    }

    /** Ein/Aus */
    setEnabled(on) {
        this.enabled = on;
        if (!on && this._isRunning) this.stop();
    }

    /** AudioContext bei erster User-Geste entsperren */
    unlock() {
        try { this._context(); } catch (_) {}
    }
}
