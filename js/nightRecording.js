/**
 * Nacht-Atemfrequenz-Messung — einmalige passive Aufnahme über Stunden
 * (kein Atem-Pacer, keine geführte Atmung), zur Verifikation gegen z.B.
 * Fitbit. Sammelt rohe RR-Intervalle unabhängig vom rollierenden Live-
 * HRVAnalyzer und wertet nachträglich in 5-Minuten-Fenstern aus
 * (HF-Band-Spektral-Peak, siehe hrv.js:breathingRateFromWindow).
 */
import { HRVAnalyzer } from './hrv.js';

const MIN_RR = 300;    // ms
const MAX_RR = 1800;   // ms
const MAX_JUMP = 0.20; // 20% Sprung zum Vorwert

const WINDOW_MS = 5 * 60 * 1000;        // 5 Minuten pro Auswertungsfenster
const MAX_DURATION_MS = 12 * 60 * 60 * 1000; // Sicherheits-Cap: 12h

export class NightRecording {
    constructor() {
        this._rr = [];           // Gefilterte RR-Intervalle (ms)
        this._timestamps = [];   // Kumulierte Zeitstempel seit Start (ms)
        this._lastRR = null;
        this._startWallTime = null;
        this._active = false;

        this.onMaxDurationReached = null; // () => void — 12h-Cap erreicht
    }

    get active() { return this._active; }

    /** Bisherige Aufnahmedauer in ms */
    get durationMs() {
        return this._timestamps.length ? this._timestamps[this._timestamps.length - 1] : 0;
    }

    get rrCount() { return this._rr.length; }

    start() {
        this._rr = [];
        this._timestamps = [];
        this._lastRR = null;
        this._startWallTime = Date.now();
        this._active = true;
    }

    /**
     * Neues RR-Intervall hinzufügen.
     * @param {number} rr - RR-Intervall in Millisekunden
     * @returns {boolean} true wenn akzeptiert (kein Artefakt)
     */
    addRR(rr) {
        if (!this._active) return false;
        if (rr < MIN_RR || rr > MAX_RR) return false;

        if (this._lastRR !== null) {
            const jump = Math.abs(rr - this._lastRR) / this._lastRR;
            if (jump > MAX_JUMP) return false;
        }
        this._lastRR = rr;

        const ts = this._timestamps.length
            ? this._timestamps[this._timestamps.length - 1] + rr
            : 0;
        this._rr.push(rr);
        this._timestamps.push(ts);

        if (ts >= MAX_DURATION_MS) {
            this._active = false;
            this.onMaxDurationReached?.();
        }
        return true;
    }

    stop() {
        this._active = false;
    }

    /**
     * Nacht in 5-Minuten-Fenster zerlegen, pro Fenster Atemfrequenz via HF-Peak.
     * @returns {{
     *   startWallTime: number, durationSec: number,
     *   windows: {startOffsetSec: number, breathingRate: number}[],
     *   avgBreathingRate: number|null, totalRRCount: number, validWindowCount: number
     * }}
     */
    analyze() {
        const windows = [];
        const totalMs = this.durationMs;

        for (let winStart = 0; winStart < totalMs; winStart += WINDOW_MS) {
            const winEnd = winStart + WINDOW_MS;
            const idxStart = this._timestamps.findIndex(t => t >= winStart);
            if (idxStart === -1) continue;
            let idxEnd = this._timestamps.findIndex(t => t >= winEnd);
            if (idxEnd === -1) idxEnd = this._timestamps.length;

            const winRR = this._rr.slice(idxStart, idxEnd);
            const winTs = this._timestamps.slice(idxStart, idxEnd);
            const rate = HRVAnalyzer.breathingRateFromWindow(winRR, winTs);

            if (rate !== null) {
                windows.push({
                    startOffsetSec: Math.round(winStart / 1000),
                    breathingRate: Math.round(rate * 10) / 10,
                });
            }
        }

        const rates = windows.map(w => w.breathingRate);
        const avgBreathingRate = rates.length
            ? Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 10) / 10
            : null;

        return {
            startWallTime: this._startWallTime,
            durationSec: Math.round(totalMs / 1000),
            windows,
            avgBreathingRate,
            totalRRCount: this._rr.length,
            validWindowCount: windows.length,
        };
    }
}
