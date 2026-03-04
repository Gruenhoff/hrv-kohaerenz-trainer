/**
 * Atemführungs-Audio – Web Audio API
 * Sanfte Töne für Einatmen / Halten / Ausatmen
 */
export class BreathAudio {
    constructor() {
        this._audioCtx  = null;
        this.enabled    = true;
        this.volume     = 0.35;
        this._lastChime = 0;
    }

    _context() {
        if (!this._audioCtx) {
            this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this._audioCtx.state === 'suspended') this._audioCtx.resume();
        return this._audioCtx;
    }

    _tone(frequency, durationSec, volMult = 1, type = 'sine') {
        if (!this.enabled) return;
        try {
            const ctx  = this._context();
            const now  = ctx.currentTime;
            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = type;
            osc.frequency.setValueAtTime(frequency, now);
            const vol = this.volume * volMult;
            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(vol, now + 0.06);
            gain.gain.setValueAtTime(vol, now + Math.max(durationSec - 0.12, 0.06));
            gain.gain.linearRampToValueAtTime(0, now + durationSec);
            osc.start(now);
            osc.stop(now + durationSec);
        } catch (e) { /* AudioContext nicht verfügbar */ }
    }

    // Phasen-Töne (pentatonische Frequenzen, angenehm und klar)
    onInhale()  { this._tone(396, 0.22); }   // G4 – öffnend, aufsteigend
    onHoldIn()  { this._tone(352, 0.15); }   // F4 – neutral
    onExhale()  { this._tone(264, 0.22); }   // C4 – loslassen, entspannend
    onHoldOut() { this._tone(220, 0.15); }   // A3 – still, ruhend

    // Kohärenz-Chime: G-Dur-Dreiklang (max. 1× pro 30s)
    onCoherenceAchieved() {
        const now = Date.now();
        if (now - this._lastChime < 30000) return;
        this._lastChime = now;
        [392, 494, 587].forEach((f, i) =>
            setTimeout(() => this._tone(f, 0.5, 0.55), i * 90)
        );
    }

    // AudioContext entsperren – muss bei erster User-Geste aufgerufen werden
    unlock() {
        try { this._context(); } catch (_) {}
    }
}
