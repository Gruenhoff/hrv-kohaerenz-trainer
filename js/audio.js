/**
 * Atemführungs-Audio – Web Audio API
 * Einatmen: gleitend aufsteigend (A3→E4)
 * Ausatmen: gleitend absteigend  (E4→A3)
 * Halten: kurzer Ton zu Beginn der Haltephase
 */
export class BreathAudio {
    constructor() {
        this._audioCtx   = null;
        this.enabled     = true;
        this.volume      = 0.35;
        this._lastChime  = 0;
        this._activeOsc  = null;   // laufender Atemton
        this._activeGain = null;
    }

    _context() {
        if (!this._audioCtx) {
            this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this._audioCtx.state === 'suspended') this._audioCtx.resume();
        return this._audioCtx;
    }

    // ─── Laufenden Atemton sauber beenden (50 ms Fade-out) ───────────────────
    _stopActive() {
        if (!this._activeOsc || !this._activeGain) return;
        try {
            const ctx  = this._context();
            const now  = ctx.currentTime;
            this._activeGain.gain.cancelScheduledValues(now);
            this._activeGain.gain.setValueAtTime(this._activeGain.gain.value, now);
            this._activeGain.gain.linearRampToValueAtTime(0, now + 0.05);
            this._activeOsc.stop(now + 0.06);
        } catch (_) {}
        this._activeOsc  = null;
        this._activeGain = null;
    }

    // ─── Durchgehend gleitender Ton ──────────────────────────────────────────
    //   startHz → endHz über durationSec Sekunden, sanfter Ein- und Ausblend
    _toneGlide(startHz, endHz, durationSec) {
        if (!this.enabled) return;
        this._stopActive();
        try {
            const ctx  = this._context();
            const now  = ctx.currentTime;
            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);

            osc.type = 'sine';
            osc.frequency.setValueAtTime(startHz, now);
            osc.frequency.linearRampToValueAtTime(endHz, now + durationSec);

            // Hüllkurve: 8 % Einblend, 8 % Ausblend, dazwischen konstant
            const fade = Math.min(durationSec * 0.08, 0.25);
            const vol  = this.volume * 0.55;
            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(vol, now + fade);
            gain.gain.setValueAtTime(vol, now + durationSec - fade);
            gain.gain.linearRampToValueAtTime(0, now + durationSec);

            osc.start(now);
            osc.stop(now + durationSec);

            this._activeOsc  = osc;
            this._activeGain = gain;
        } catch (_) {}
    }

    // ─── Kurzer Einzel-Ton (für Haltephasen) ─────────────────────────────────
    _toneShort(frequency, durationSec, volMult = 1) {
        if (!this.enabled) return;
        this._stopActive();
        try {
            const ctx  = this._context();
            const now  = ctx.currentTime;
            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(frequency, now);
            const vol = this.volume * volMult;
            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(vol, now + 0.05);
            gain.gain.setValueAtTime(vol, now + Math.max(durationSec - 0.1, 0.05));
            gain.gain.linearRampToValueAtTime(0, now + durationSec);
            osc.start(now);
            osc.stop(now + durationSec);
        } catch (_) {}
    }

    // ─── Phasen-Callbacks (durationMs = Phasendauer in ms) ───────────────────

    // Einatmen: A3 (220 Hz) → E4 (330 Hz), gleitend aufsteigend
    onInhale(durationMs = 5000) {
        this._toneGlide(220, 330, durationMs / 1000);
    }

    // Halten nach Einatmen: kurzer neutraler Ton zu Beginn
    onHoldIn(durationMs = 0) {
        if (durationMs > 100) this._toneShort(330, Math.min(durationMs / 1000, 0.3), 0.7);
        else this._stopActive();
    }

    // Ausatmen: E4 (330 Hz) → A3 (220 Hz), gleitend absteigend
    onExhale(durationMs = 5000) {
        this._toneGlide(330, 220, durationMs / 1000);
    }

    // Halten nach Ausatmen: kurzer tiefer Ton zu Beginn
    onHoldOut(durationMs = 0) {
        if (durationMs > 100) this._toneShort(220, Math.min(durationMs / 1000, 0.3), 0.5);
        else this._stopActive();
    }

    // Öffentliche Methode – Atemton sofort stoppen (z. B. bei Session-Pause)
    stopTone() { this._stopActive(); }

    // ─── Kohärenz-Chime: G-Dur-Dreiklang (max. 1× pro 30 s) ─────────────────
    onCoherenceAchieved() {
        const now = Date.now();
        if (now - this._lastChime < 30000) return;
        this._lastChime = now;
        [392, 494, 587].forEach((f, i) =>
            setTimeout(() => this._toneShort(f, 0.5, 0.55), i * 90)
        );
    }

    // AudioContext entsperren – muss bei erster User-Geste aufgerufen werden
    unlock() {
        try { this._context(); } catch (_) {}
    }
}
