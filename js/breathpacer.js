/**
 * Atemführungs-Animation – professionelles Redesign
 * Timing in Millisekunden · Audio-Support · dreischichtige Orb-Animation
 */
export class BreathPacer {
    /**
     * @param {HTMLElement} orbContainer  – Container für die Orb-Animation
     * @param {object}      rhythm        – Timing in ms: { inhale, holdIn, exhale, holdOut }
     * @param {HTMLElement} [labelEl]     – Element für Phasenbeschriftung
     * @param {HTMLElement} [countdownEl] – Element für Countdown-Zahl
     * @param {BreathAudio} [audio]       – Audio-Instanz
     */
    constructor(orbContainer, rhythm, labelEl, countdownEl, audio) {
        this.container   = orbContainer;
        this.rhythm      = rhythm || { inhale: 5000, holdIn: 0, exhale: 5000, holdOut: 0 };
        this.labelEl     = labelEl     || null;
        this.countdownEl = countdownEl || null;
        this.audio       = audio       || null;

        this.isRunning   = false;
        this.phase       = 'inhale';
        this.startTime   = null;
        this.animFrame   = null;

        this.onPhaseChange = null; // (phase: string) => void

        this._buildOrb();
    }

    _buildOrb() {
        this.container.innerHTML = `
            <div class="breath-orb-wrapper">
                <div class="breath-ring breath-ring-3"></div>
                <div class="breath-ring breath-ring-2"></div>
                <div class="breath-ring breath-ring-1"></div>
                <div class="breath-core"></div>
            </div>
        `;
        this.ring1 = this.container.querySelector('.breath-ring-1');
        this.ring2 = this.container.querySelector('.breath-ring-2');
        this.ring3 = this.container.querySelector('.breath-ring-3');
        this.core  = this.container.querySelector('.breath-core');
    }

    get cycleDurationMs() {
        const r = this.rhythm;
        return r.inhale + r.holdIn + r.exhale + r.holdOut;
    }

    setRhythm(rhythm) { this.rhythm = rhythm; }

    start() {
        this.isRunning = true;
        this.startTime = performance.now();
        this._tick();
    }

    stop() {
        this.isRunning = false;
        if (this.animFrame) cancelAnimationFrame(this.animFrame);
        if (this.audio) this.audio.stopTone();
        if (this.labelEl)     this.labelEl.textContent    = 'Pausiert';
        if (this.countdownEl) this.countdownEl.textContent = '';
        this._applyVisual(0, 'holdOut');
    }

    _tick() {
        if (!this.isRunning) return;

        const now     = performance.now();
        const elapsed = (now - this.startTime) % this.cycleDurationMs;
        const { inhale, holdIn, exhale, holdOut } = this.rhythm;

        let phase, progress, remainingMs;

        if (elapsed < inhale) {
            phase = 'inhale';
            progress = elapsed / inhale;
            remainingMs = inhale - elapsed;
        } else if (elapsed < inhale + holdIn) {
            phase = 'holdIn';
            progress = 1;
            remainingMs = inhale + holdIn - elapsed;
        } else if (elapsed < inhale + holdIn + exhale) {
            phase = 'exhale';
            progress = 1 - (elapsed - inhale - holdIn) / exhale;
            remainingMs = inhale + holdIn + exhale - elapsed;
        } else {
            phase = 'holdOut';
            progress = 0;
            remainingMs = this.cycleDurationMs - elapsed;
        }

        if (phase !== this.phase) {
            this.phase = phase;
            this._onPhaseStart(phase);
        }

        this._applyVisual(this._ease(progress, phase), phase);
        this._updateText(phase, remainingMs);

        this.animFrame = requestAnimationFrame(() => this._tick());
    }

    _ease(t, phase) {
        if (phase === 'inhale') return 1 - Math.pow(1 - t, 2.5);  // ease-out (schwillt sanft an)
        if (phase === 'exhale') return Math.pow(1 - t, 2);         // ease-in  (lässt sanft nach)
        return t;
    }

    _onPhaseStart(phase) {
        if (this.onPhaseChange) this.onPhaseChange(phase);
        if (this.audio) {
            const r = this.rhythm;
            if (phase === 'inhale')  this.audio.onInhale(r.inhale);
            if (phase === 'holdIn')  this.audio.onHoldIn(r.holdIn);
            if (phase === 'exhale')  this.audio.onExhale(r.exhale);
            if (phase === 'holdOut') this.audio.onHoldOut(r.holdOut);
        }
    }

    _applyVisual(t, phase) {
        // t: 0 = kleinster Zustand, 1 = größter Zustand
        const minScale = 0.5, maxScale = 1.0;
        const scale    = minScale + t * (maxScale - minScale);

        const COLORS = {
            inhale:  { hex: '#00d4ff', rgb: '0,212,255' },
            holdIn:  { hex: '#c9a84c', rgb: '201,168,76' },
            exhale:  { hex: '#00e5a0', rgb: '0,229,160' },
            holdOut: { hex: '#7a9bc0', rgb: '122,155,192' },
        };
        const c = COLORS[phase];

        if (this.core) {
            this.core.style.transform   = `scale(${scale.toFixed(3)})`;
            this.core.style.borderColor = c.hex;
            this.core.style.boxShadow   = `
                0 0 ${Math.round(15 + t * 45)}px rgba(${c.rgb},${(0.12 + t * 0.38).toFixed(2)}),
                inset 0 0 ${Math.round(8 + t * 20)}px rgba(${c.rgb},${(0.06 + t * 0.18).toFixed(2)})
            `;
            this.core.style.background = `radial-gradient(circle,
                rgba(${c.rgb},${(0.12 + t * 0.2).toFixed(2)}) 0%,
                rgba(${c.rgb},0.03) 65%, transparent 100%)`;
        }

        const ring = (el, s, alpha) => {
            if (!el) return;
            el.style.transform   = `scale(${s.toFixed(3)})`;
            el.style.borderColor = `rgba(${c.rgb},${(alpha * t).toFixed(2)})`;
        };
        ring(this.ring1, 0.65 + t * 0.55, 0.50);
        ring(this.ring2, 0.55 + t * 0.65, 0.32);
        ring(this.ring3, 0.45 + t * 0.75, 0.18);
    }

    _updateText(phase, remainingMs) {
        const LABELS = {
            inhale:  'Einatmen',
            holdIn:  'Halten',
            exhale:  'Ausatmen',
            holdOut: 'Pause',
        };
        if (this.labelEl) {
            this.labelEl.textContent    = LABELS[phase];
            this.labelEl.dataset.phase  = phase;
        }
        if (this.countdownEl) {
            const secs = Math.ceil(remainingMs / 1000);
            this.countdownEl.textContent = secs > 0 ? secs : '';
        }
    }

    destroy() {
        this.stop();
        this.container.innerHTML = '';
    }
}
