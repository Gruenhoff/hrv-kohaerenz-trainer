/**
 * EKG-Analyse: R-Zacken-Erkennung + ECG-derived Respiration (EDR)
 *
 * Nutzt das rohe PMD-EKG-Signal (130 Hz, µV) NUR zur Amplituden-Extraktion.
 * Die Zeitgebung/Herzfrequenz selbst kommt weiterhin über den bewährten
 * Standard-HF-Dienst (RR-Intervalle) — bewusste Entscheidung, um keine
 * eigene, weniger robuste RR-Erkennung aus dem Rohsignal bauen zu müssen.
 *
 * R-Zacken-Erkennung: einfacher Echtzeit-Ansatz (Baseline-Wander-Entfernung
 * per exponentiellem gleitendem Mittelwert, Quadrieren zur Betonung des
 * QRS-Komplexes, adaptive Schwelle, Refraktärzeit) — bewusst kein klinischer
 * Pan-Tompkins-Detektor, da hier nur die Amplitude interessiert, nicht die
 * exakte RR-Zeitgebung.
 *
 * EDR: Die R-Zacken-Amplitude schwankt mit der Atmung (Impedanz-/Achsen-
 * Änderung durch Lungenvolumen). Diese Schwankung ist das Atemsignal.
 */

const BASELINE_TAU_MS = 150;   // Zeitkonstante der langsamen Baseline (Wander-Entfernung)
const ENERGY_TAU_MS   = 15;    // Zeitkonstante der QRS-Energie-Glättung
const REFRACTORY_MS   = 300;   // Physiologisches Maximum ~200 bpm
const THRESHOLD_FACTOR = 0.45; // Anteil der jüngsten Peak-Energie als Schwelle
// Absolute Mindestschwelle (~150 µV Amplitude), bis der erste echte Schlag die
// adaptive Schwelle kalibriert hat — verhindert Rausch-"Erkennungen" beim Start.
const MIN_ENERGY_THRESHOLD = 150 * 150;
const PEAK_AVG_ALPHA   = 0.2;  // Glättung der adaptiven Schwelle über mehrere Schläge

/** Zeitkonstante → Glättungsfaktor für ein exponentielles gleitendes Mittel bei ~130 Hz */
function alphaFor(tauMs, dtMs) {
    return 1 - Math.exp(-dtMs / tauMs);
}

export class EcgRPeakDetector {
    constructor() {
        this._baseline   = null;
        this._energySm   = 0;
        this._prevEnergySm = 0;
        this._recentPeakEnergy = null;
        this._lastPeakTs = -Infinity;
        this._risingRun  = null; // { peakEnergy, peakTs, peakRaw }
        this._prevTs     = null;

        this.onRPeak = null; // (timestampMs, amplitude) => void — amplitude = |Peak - Baseline| in µV
    }

    reset() {
        this._baseline = null;
        this._energySm = 0;
        this._prevEnergySm = 0;
        this._recentPeakEnergy = null;
        this._lastPeakTs = -Infinity;
        this._risingRun = null;
        this._prevTs = null;
    }

    /**
     * Neues rohes EKG-Sample verarbeiten.
     * @param {number} uv - Rohwert in µV
     * @param {number} tsMs - performance.now()-Zeitstempel
     */
    addSample(uv, tsMs) {
        const dtMs = this._prevTs === null ? 1000 / 130 : Math.max(1, tsMs - this._prevTs);
        this._prevTs = tsMs;

        // Baseline-Wander-Entfernung (langsames exp. gleitendes Mittel)
        if (this._baseline === null) this._baseline = uv;
        this._baseline += alphaFor(BASELINE_TAU_MS, dtMs) * (uv - this._baseline);
        const detrended = uv - this._baseline;

        // QRS-Energie: quadrieren + glätten
        const energy = detrended * detrended;
        this._energySm += alphaFor(ENERGY_TAU_MS, dtMs) * (energy - this._energySm);

        const threshold = this._recentPeakEnergy === null
            ? MIN_ENERGY_THRESHOLD
            : THRESHOLD_FACTOR * this._recentPeakEnergy;

        // Anstiegs-Lauf verfolgen; Peak wird committet, sobald die Energie wieder fällt
        if (this._risingRun) {
            if (this._energySm >= this._risingRun.peakEnergy) {
                this._risingRun.peakEnergy = this._energySm;
                this._risingRun.peakTs = tsMs;
                this._risingRun.peakRaw = uv;
            } else {
                this._commitRun(threshold);
            }
        }
        if (!this._risingRun && this._energySm > this._prevEnergySm) {
            this._risingRun = { peakEnergy: this._energySm, peakTs: tsMs, peakRaw: uv, baselineAtPeak: this._baseline };
        }
        this._prevEnergySm = this._energySm;
    }

    _commitRun(threshold) {
        const run = this._risingRun;
        this._risingRun = null;
        if (!run) return;
        if (run.peakEnergy <= threshold) return;
        if (run.peakTs - this._lastPeakTs < REFRACTORY_MS) return;

        this._lastPeakTs = run.peakTs;
        this._recentPeakEnergy = this._recentPeakEnergy === null
            ? run.peakEnergy
            : (1 - PEAK_AVG_ALPHA) * this._recentPeakEnergy + PEAK_AVG_ALPHA * run.peakEnergy;

        const amplitude = Math.abs(run.peakRaw - run.baselineAtPeak);
        this.onRPeak?.(run.peakTs, amplitude);
    }
}

/**
 * EDR-Puffer: sammelt R-Zacken-Amplituden über die Zeit und beantwortet
 * Fenster-Abfragen (analog zu HRVAnalyzer.maxHRInWindow/minHRInWindow, aber
 * für die Atemamplitude statt Herzfrequenz).
 */
export class EdrBuffer {
    constructor(maxAgeMs = 60000) {
        this._amps = [];
        this._ts   = [];
        this._maxAgeMs = maxAgeMs;
    }

    reset() {
        this._amps = [];
        this._ts = [];
    }

    addRPeak(tsMs, amplitude) {
        this._amps.push(amplitude);
        this._ts.push(tsMs);
        const cutoff = tsMs - this._maxAgeMs;
        while (this._ts.length && this._ts[0] < cutoff) {
            this._ts.shift();
            this._amps.shift();
        }
    }

    get count() { return this._ts.length; }

    /** Spannweite (Max−Min) der R-Zacken-Amplitude im Zeitfenster — Atemtiefe-Proxy */
    amplitudeRangeInWindow(startMs, endMs) {
        let min = null, max = null;
        for (let i = 0; i < this._ts.length; i++) {
            const t = this._ts[i];
            if (t < startMs || t > endMs) continue;
            const a = this._amps[i];
            if (min === null || a < min) min = a;
            if (max === null || a > max) max = a;
        }
        if (min === null) return null;
        return max - min;
    }

    /** Mittlere R-Zacken-Amplitude im Zeitfenster (für Signalqualitäts-/Rausch-Einschätzung) */
    meanAmplitudeInWindow(startMs, endMs) {
        let sum = 0, n = 0;
        for (let i = 0; i < this._ts.length; i++) {
            const t = this._ts[i];
            if (t < startMs || t > endMs) continue;
            sum += this._amps[i];
            n++;
        }
        return n ? sum / n : null;
    }
}
