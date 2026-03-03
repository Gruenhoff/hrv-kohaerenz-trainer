/**
 * Atemführungs-Modul (Breath Pacer)
 * Animierter expandierender/kontrahierender Kreis mit Phasenanzeige
 */

export class BreathPacer {
    /**
     * @param {HTMLElement} container - Container-Element für den Pacer
     * @param {object} rhythm - Atemrhythmus in Sekunden
     */
    constructor(container, rhythm = null) {
        this.container = container;
        this.rhythm = rhythm || { inhale: 5, holdIn: 0, exhale: 5, holdOut: 0 };
        this.isRunning = false;
        this.phase = 'inhale'; // 'inhale' | 'holdIn' | 'exhale' | 'holdOut'
        this.phaseProgress = 0; // 0-1
        this.startTime = null;
        this.animFrame = null;
        this.onPhaseChange = null; // (phase: string) => void

        this._buildDOM();
    }

    _buildDOM() {
        this.container.innerHTML = `
            <div class="pacer-wrapper">
                <div class="pacer-ring pacer-ring-outer"></div>
                <div class="pacer-ring pacer-ring-mid"></div>
                <div class="pacer-circle">
                    <span class="pacer-phase-text">Bereit</span>
                    <span class="pacer-count-text"></span>
                </div>
            </div>
        `;

        this.circle     = this.container.querySelector('.pacer-circle');
        this.ringOuter  = this.container.querySelector('.pacer-ring-outer');
        this.ringMid    = this.container.querySelector('.pacer-ring-mid');
        this.phaseText  = this.container.querySelector('.pacer-phase-text');
        this.countText  = this.container.querySelector('.pacer-count-text');
    }

    get cycleDuration() {
        return this.rhythm.inhale + this.rhythm.holdIn + this.rhythm.exhale + this.rhythm.holdOut;
    }

    /**
     * Atemrhythmus aktualisieren
     */
    setRhythm(rhythm) {
        this.rhythm = rhythm;
    }

    start() {
        this.isRunning = true;
        this.startTime = performance.now();
        this._tick();
    }

    stop() {
        this.isRunning = false;
        if (this.animFrame) cancelAnimationFrame(this.animFrame);
        this.phaseText.textContent = 'Pausiert';
        this.countText.textContent = '';
    }

    _tick() {
        if (!this.isRunning) return;

        const now = performance.now();
        const elapsed = ((now - this.startTime) / 1000) % this.cycleDuration;
        const { inhale, holdIn, exhale, holdOut } = this.rhythm;

        let phase, progress, remaining;

        if (elapsed < inhale) {
            phase = 'inhale';
            progress = elapsed / inhale;
            remaining = inhale - elapsed;
        } else if (elapsed < inhale + holdIn) {
            phase = 'holdIn';
            progress = 1;
            remaining = inhale + holdIn - elapsed;
        } else if (elapsed < inhale + holdIn + exhale) {
            phase = 'exhale';
            progress = 1 - (elapsed - inhale - holdIn) / exhale;
            remaining = inhale + holdIn + exhale - elapsed;
        } else {
            phase = 'holdOut';
            progress = 0;
            remaining = this.cycleDuration - elapsed;
        }

        if (phase !== this.phase) {
            this.phase = phase;
            if (this.onPhaseChange) this.onPhaseChange(phase);
        }

        this.phaseProgress = progress;
        this._render(phase, progress, remaining);

        this.animFrame = requestAnimationFrame(() => this._tick());
    }

    _render(phase, progress, remaining) {
        // Kreis-Größe: 60px (min) bis 140px (max) — CSS-Skalierung via transform
        const minScale = 0.6;
        const maxScale = 1.4;
        const scale = minScale + progress * (maxScale - minScale);

        // Sanfte Ease-Funktion
        const eased = this._ease(progress, phase);
        const easeScale = minScale + eased * (maxScale - minScale);

        this.circle.style.transform = `scale(${easeScale})`;

        // Ring-Animation
        const ringProgress = (phase === 'inhale' || phase === 'holdIn') ? progress : 1 - progress;
        this.ringOuter.style.transform = `scale(${1 + ringProgress * 0.3})`;
        this.ringOuter.style.opacity = 0.2 + ringProgress * 0.5;
        this.ringMid.style.transform = `scale(${1 + ringProgress * 0.15})`;
        this.ringMid.style.opacity = 0.3 + ringProgress * 0.4;

        // Phasen-Text und Farbe
        const labels = {
            inhale:  'Einatmen',
            holdIn:  'Halten',
            exhale:  'Ausatmen',
            holdOut: 'Pause',
        };

        const colors = {
            inhale:  '#00d4ff',
            holdIn:  '#c9a84c',
            exhale:  '#00e5a0',
            holdOut: '#7a9bc0',
        };

        this.phaseText.textContent = labels[phase];
        this.circle.style.borderColor = colors[phase];
        this.circle.style.boxShadow = `0 0 ${20 + progress * 30}px ${colors[phase]}44`;

        // Countdown
        this.countText.textContent = remaining > 0.1 ? Math.ceil(remaining) : '';
    }

    _ease(t, phase) {
        // Cubic ease-in für Einatmen, ease-out für Ausatmen
        if (phase === 'inhale') return 1 - Math.pow(1 - t, 3);
        if (phase === 'exhale') return 1 - Math.pow(1 - t, 3);
        return t;
    }

    destroy() {
        this.stop();
        this.container.innerHTML = '';
    }
}
