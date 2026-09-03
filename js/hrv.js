/**
 * HRV-Analyse-Modul
 * Berechnet RMSSD, LF/HF-Ratio, Kohärenz-Score und Resonanzfrequenz
 * aus RR-Intervallen (in Millisekunden)
 */
import { FFT } from './fft.js';

// Frequenzbänder (Hz)
const BANDS = {
    VLF: { min: 0.003, max: 0.04 },
    LF:  { min: 0.04,  max: 0.15 },
    HF:  { min: 0.15,  max: 0.4  },
};

// Artefakt-Grenzen
const MIN_RR = 300;   // ms
const MAX_RR = 1800;  // ms
const MAX_JUMP = 0.20; // 20% Sprung zum Vorwert

// Abtastrate für Resampling (Hz)
const RESAMPLE_RATE = 4;

export class HRVAnalyzer {
    constructor() {
        this.rrBuffer = [];          // Gefilterte RR-Intervalle (ms)
        this.rrTimestamps = [];      // Kumulierte Zeitstempel (ms)
        this.rrWallTimestamps = [];  // performance.now() je RR-Intervall (für Zyklus-Ausrichtung)
        this.lastRR = null;
        this.windowSizeSeconds = 120; // 2-Minuten gleitendes Fenster
        this.lastFFTResult = null;
        this.coherenceHistory = [];
        this.resonanceFreq = 0.1;    // Standard: 0.1 Hz (6 Atemz./Min.)
    }

    /**
     * Neues RR-Intervall hinzufügen
     * @param {number} rr - RR-Intervall in Millisekunden
     * @returns {boolean} true wenn Wert akzeptiert (kein Artefakt)
     */
    addRR(rr) {
        // Artefakt-Filter
        if (rr < MIN_RR || rr > MAX_RR) return false;

        if (this.lastRR !== null) {
            const jump = Math.abs(rr - this.lastRR) / this.lastRR;
            if (jump > MAX_JUMP) return false;
        }

        this.lastRR = rr;

        const timestamp = this.rrTimestamps.length > 0
            ? this.rrTimestamps[this.rrTimestamps.length - 1] + rr
            : 0;

        this.rrBuffer.push(rr);
        this.rrTimestamps.push(timestamp);
        this.rrWallTimestamps.push(performance.now());

        // Fenster begrenzen
        const windowMs = this.windowSizeSeconds * 1000;
        const cutoff = timestamp - windowMs;
        while (this.rrTimestamps.length > 0 && this.rrTimestamps[0] < cutoff) {
            this.rrBuffer.shift();
            this.rrTimestamps.shift();
            this.rrWallTimestamps.shift();
        }

        return true;
    }

    /**
     * Anzahl der verfügbaren RR-Intervalle
     */
    get rrCount() {
        return this.rrBuffer.length;
    }

    /**
     * Zeitspanne der gepufferten Daten in Sekunden
     */
    get dataSpanSeconds() {
        if (this.rrTimestamps.length < 2) return 0;
        return (this.rrTimestamps[this.rrTimestamps.length - 1] - this.rrTimestamps[0]) / 1000;
    }

    /**
     * RMSSD berechnen (Root Mean Square of Successive Differences)
     * @param {number[]} rr - Optional: eigene RR-Liste
     * @returns {number} RMSSD in ms
     */
    rmssd(rr = this.rrBuffer) {
        if (rr.length < 2) return 0;
        let sumSq = 0;
        for (let i = 1; i < rr.length; i++) {
            const diff = rr[i] - rr[i - 1];
            sumSq += diff * diff;
        }
        return Math.sqrt(sumSq / (rr.length - 1));
    }

    /**
     * RSA-Amplitude: Herzfrequenz-Spanne (Max−Min) im rollenden Zeitfenster.
     * Entspricht dem sinusoidalen HF-Ausschlag pro Atemzyklus in bpm.
     * @param {number} windowSeconds - Fenstergröße (Standard 10s)
     * @returns {number} Amplitude in bpm
     */
    rsaAmplitude(windowSeconds = 10) {
        if (this.rrBuffer.length < 2) return 0;
        const lastTs = this.rrTimestamps[this.rrTimestamps.length - 1];
        const cutoff = lastTs - windowSeconds * 1000;
        const hrs = [];
        for (let i = 0; i < this.rrTimestamps.length; i++) {
            if (this.rrTimestamps[i] >= cutoff && this.rrBuffer[i] > 0) {
                hrs.push(60000 / this.rrBuffer[i]);
            }
        }
        if (hrs.length < 2) return 0;
        return Math.max(...hrs) - Math.min(...hrs);
    }

    /**
     * Höchste Herzfrequenz (bpm) im gegebenen performance.now()-Zeitfenster, oder null ohne Daten.
     */
    maxHRInWindow(startMs, endMs) {
        let max = null;
        for (let i = 0; i < this.rrWallTimestamps.length; i++) {
            const t = this.rrWallTimestamps[i];
            if (t < startMs || t > endMs) continue;
            const rr = this.rrBuffer[i];
            if (rr <= 0) continue;
            const hr = 60000 / rr;
            if (max === null || hr > max) max = hr;
        }
        return max;
    }

    /**
     * Niedrigste Herzfrequenz (bpm) im gegebenen performance.now()-Zeitfenster, oder null ohne Daten.
     */
    minHRInWindow(startMs, endMs) {
        let min = null;
        for (let i = 0; i < this.rrWallTimestamps.length; i++) {
            const t = this.rrWallTimestamps[i];
            if (t < startMs || t > endMs) continue;
            const rr = this.rrBuffer[i];
            if (rr <= 0) continue;
            const hr = 60000 / rr;
            if (min === null || hr < min) min = hr;
        }
        return min;
    }

    /**
     * Mittlere Herzfrequenz (bpm) im gegebenen performance.now()-Zeitfenster, oder null ohne Daten.
     * Für Wendepunkt-/Richtungs-Analyse (steigt/fällt die HF gerade) genutzt.
     */
    meanHRInWindow(startMs, endMs) {
        let sum = 0, n = 0;
        for (let i = 0; i < this.rrWallTimestamps.length; i++) {
            const t = this.rrWallTimestamps[i];
            if (t < startMs || t > endMs) continue;
            const rr = this.rrBuffer[i];
            if (rr <= 0) continue;
            sum += 60000 / rr;
            n++;
        }
        return n ? sum / n : null;
    }

    /**
     * Richtung der HF unmittelbar vor einem Zeitpunkt (z.B. Phasenende): vergleicht
     * die mittlere HF in zwei benachbarten Teilfenstern direkt davor.
     * @param {number} atMs - Zeitpunkt (z.B. Phasenende), performance.now()-Achse
     * @param {number} windowMs - Gesamtbreite des Analysefensters (wird hälftig geteilt)
     * @returns {'rising'|'falling'|'flat'|null}
     */
    hrDirectionBefore(atMs, windowMs = 3000) {
        const half = windowMs / 2;
        const earlyMean = this.meanHRInWindow(atMs - windowMs, atMs - half);
        const lateMean  = this.meanHRInWindow(atMs - half, atMs);
        if (earlyMean === null || lateMean === null) return null;
        const diff = lateMean - earlyMean;
        if (Math.abs(diff) < 0.3) return 'flat'; // < 0,3 bpm Unterschied gilt als Wendepunkt erreicht
        return diff > 0 ? 'rising' : 'falling';
    }

    /**
     * Zyklus-ausgerichtete RSA-Amplitude: HRmax während der Einatemphase minus
     * HRmin während der Ausatemphase (Moonbird-Metrik), statt eines beliebigen
     * rollierenden Zeitfensters. Grenzen kommen von BreathPacer.onPhaseChange.
     * @param {number} inhaleStart - performance.now() bei Beginn Einatmen
     * @param {number} inhaleEnd   - performance.now() bei Ende Einatmen (= Beginn Ausatmen)
     * @param {number} exhaleEnd   - performance.now() bei Ende Ausatmen
     * @returns {number|null} Amplitude in bpm, oder null wenn Daten fehlen
     */
    cycleAmplitude(inhaleStart, inhaleEnd, exhaleEnd) {
        const hrMax = this.maxHRInWindow(inhaleStart, inhaleEnd);
        const hrMin = this.minHRInWindow(inhaleEnd, exhaleEnd);
        if (hrMax === null || hrMin === null) return null;
        return hrMax - hrMin;
    }

    /**
     * SDNN (Standard Deviation of NN intervals) in ms
     */
    sdnn(rr = this.rrBuffer) {
        if (rr.length < 2) return 0;
        const mean = rr.reduce((a, b) => a + b, 0) / rr.length;
        const variance = rr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (rr.length - 1);
        return Math.sqrt(variance);
    }

    /**
     * pNN50 (% aufeinanderfolgender Differenzen > 50 ms) in Prozent (0–100)
     */
    pnn50(rr = this.rrBuffer) {
        if (rr.length < 2) return 0;
        let count = 0;
        for (let i = 1; i < rr.length; i++) {
            if (Math.abs(rr[i] - rr[i - 1]) > 50) count++;
        }
        return Math.round((count / (rr.length - 1)) * 100);
    }

    /**
     * Mittlere Herzfrequenz
     */
    meanHR() {
        if (this.rrBuffer.length === 0) return 0;
        const meanRR = this.rrBuffer.reduce((a, b) => a + b, 0) / this.rrBuffer.length;
        return 60000 / meanRR;
    }

    /**
     * RR-Intervalle auf gleichmäßige Zeitbasis resampeln
     * @param {number[]} rr
     * @param {number[]} timestamps - Kumulierte Zeitstempel in ms
     * @returns {Float64Array} Resampeltes Signal
     */
    resample(rr = this.rrBuffer, timestamps = this.rrTimestamps) {
        return HRVAnalyzer.resampleSeries(rr, timestamps, RESAMPLE_RATE);
    }

    /**
     * RR-Intervalle auf gleichmäßige Zeitbasis resampeln (statische, zustandslose
     * Variante — wiederverwendbar für beliebige RR/Zeitstempel-Ausschnitte, z.B.
     * einzelne Fenster einer Nachtaufnahme, ohne eine HRVAnalyzer-Instanz zu brauchen).
     * @param {number[]} rr
     * @param {number[]} timestamps - Kumulierte Zeitstempel in ms
     * @param {number} rate - Abtastrate in Hz
     * @returns {Float64Array}
     */
    static resampleSeries(rr, timestamps, rate = RESAMPLE_RATE) {
        if (rr.length < 2) return new Float64Array(0);

        const startTime = timestamps[0];
        const endTime = timestamps[timestamps.length - 1];
        const dt = 1000 / rate; // ms pro Sample
        const nSamples = Math.floor((endTime - startTime) / dt);

        if (nSamples < 4) return new Float64Array(0);

        const resampled = new Float64Array(nSamples);

        let rrIdx = 0;
        for (let i = 0; i < nSamples; i++) {
            const t = startTime + i * dt;

            // Lineares Interpolieren
            while (rrIdx < timestamps.length - 1 && timestamps[rrIdx + 1] < t) {
                rrIdx++;
            }

            if (rrIdx >= timestamps.length - 1) {
                resampled[i] = rr[rr.length - 1];
            } else {
                const t0 = timestamps[rrIdx];
                const t1 = timestamps[rrIdx + 1];
                const alpha = (t - t0) / (t1 - t0);
                resampled[i] = rr[rrIdx] + alpha * (rr[rrIdx + 1] - rr[rrIdx]);
            }
        }

        // DC-Anteil entfernen (Mittelwert subtrahieren)
        const mean = resampled.reduce((a, b) => a + b, 0) / nSamples;
        for (let i = 0; i < nSamples; i++) resampled[i] -= mean;

        return resampled;
    }

    /**
     * Atemfrequenz aus einem RR-Fenster via Spektral-Peak im HF-Band (0,15–0,4 Hz).
     * Für natürliche/ungeführte Atmung (z.B. Schlaf, ~12–20/min) — im Gegensatz zum
     * LF-Band-Peak (lfPeakFreq), der auf langsame Resonanzatmung (~4,5–8/min) zielt.
     * Zustandslos, unabhängig von der rollierenden Live-Instanz nutzbar.
     * @param {number[]} rr
     * @param {number[]} timestamps - Kumulierte Zeitstempel in ms
     * @returns {number|null} Atemzüge/Minute, oder null bei unzureichenden Daten
     */
    static breathingRateFromWindow(rr, timestamps) {
        if (rr.length < 2) return null;
        const spanSeconds = (timestamps[timestamps.length - 1] - timestamps[0]) / 1000;
        if (spanSeconds < 30) return null;

        const signal = HRVAnalyzer.resampleSeries(rr, timestamps, RESAMPLE_RATE);
        if (signal.length < 8) return null;

        const { frequencies, power } = FFT.psd(Array.from(signal), RESAMPLE_RATE);
        const { peakFreq, totalPower } = FFT.bandPower(frequencies, power, BANDS.HF.min, BANDS.HF.max);
        if (totalPower <= 0) return null;

        return peakFreq * 60;
    }

    /**
     * Vollständige Frequenzanalyse
     * @returns {object|null} Analyseergebnis oder null bei unzureichenden Daten
     */
    frequencyAnalysis() {
        if (this.dataSpanSeconds < 30) return null; // Mindestens 30s Daten

        const signal = this.resample();
        if (signal.length < 8) return null;

        const { frequencies, power } = FFT.psd(Array.from(signal), RESAMPLE_RATE);

        const lf = FFT.bandPower(frequencies, power, BANDS.LF.min, BANDS.LF.max);
        const hf = FFT.bandPower(frequencies, power, BANDS.HF.min, BANDS.HF.max);
        const vlf = FFT.bandPower(frequencies, power, BANDS.VLF.min, BANDS.VLF.max);

        const totalPower = lf.totalPower + hf.totalPower + vlf.totalPower;
        const lfHfRatio = hf.totalPower > 0 ? lf.totalPower / hf.totalPower : 0;

        // Kohärenz: Spektralleistung bei Resonanzfrequenz / Gesamtleistung
        const resonanceWindow = 0.02; // ±0.02 Hz um Resonanzfrequenz
        const resonanceBand = FFT.bandPower(
            frequencies, power,
            this.resonanceFreq - resonanceWindow,
            this.resonanceFreq + resonanceWindow
        );

        const coherenceScore = totalPower > 0
            ? Math.min(100, (resonanceBand.totalPower / totalPower) * 100 * 3)
            : 0;

        this.lastFFTResult = {
            frequencies: Array.from(frequencies),
            power: Array.from(power),
            lf, hf, vlf,
            lfHfRatio,
            totalPower,
            coherenceScore: Math.round(coherenceScore),
            resonanceFreq: this.resonanceFreq,
            lfPeakFreq: lf.peakFreq,
        };

        this.coherenceHistory.push(coherenceScore);
        if (this.coherenceHistory.length > 60) this.coherenceHistory.shift();

        return this.lastFFTResult;
    }

    /**
     * Kohärenz-Score aus dem letzten FFT-Ergebnis
     */
    get coherenceScore() {
        return this.lastFFTResult ? this.lastFFTResult.coherenceScore : 0;
    }

    /**
     * Resonanzfrequenz aus LF-Peak-Analyse ermitteln und speichern
     * Gibt neue Resonanzfrequenz zurück wenn genügend Daten vorhanden
     */
    updateResonanceFrequency() {
        if (!this.lastFFTResult) return null;
        const candidate = this.lastFFTResult.lfPeakFreq;
        if (candidate >= BANDS.LF.min && candidate <= BANDS.LF.max) {
            // Exponentielles Glätten
            this.resonanceFreq = 0.8 * this.resonanceFreq + 0.2 * candidate;
            return this.resonanceFreq;
        }
        return null;
    }

    /**
     * Praktische Atemfrequenz: Resonanzfrequenz wenn ≥ 4.5/min,
     * sonst 2. Harmonische (doppelt). Verhindert unpraktikable
     * Empfehlungen bei Menschen mit sehr niedriger Mayer-Wellen-Frequenz.
     */
    get practicalBreathFreq() {
        const f = this.resonanceFreq;
        return f < 0.075 ? f * 2 : f;   // < 4.5/min → 2. Harmonische
    }

    /**
     * Atemfrequenz aus Resonanzfrequenz in Atemzüge/Minute
     */
    get breathRateFromResonance() {
        return Math.round(this.practicalBreathFreq * 60 * 10) / 10;
    }

    /**
     * Optimalen Atemrhythmus (Sekunden) für gegebene Atemfrequenz
     * @param {number} breathsPerMin
     * @returns {{ inhale, holdIn, exhale, holdOut }}
     */
    static optimalBreathRhythm(breathsPerMin = 6) {
        const cycleSeconds = 60 / breathsPerMin;
        // Standard: gleichmäßig geteilt (oder 40/60 Einatmen/Ausatmen)
        const inhale = cycleSeconds * 0.4;
        const exhale = cycleSeconds * 0.6;
        return {
            inhale: Math.round(inhale * 10) / 10,
            holdIn: 0,
            exhale: Math.round(exhale * 10) / 10,
            holdOut: 0,
        };
    }

    /**
     * Datenqualitäts-Indikator (0-100%)
     */
    get dataQuality() {
        const span = this.dataSpanSeconds;
        if (span >= 60) return 100;
        if (span >= 30) return 70;
        if (span >= 10) return 40;
        return Math.min(40, Math.round((span / 10) * 40));
    }

    /**
     * Alle Daten zurücksetzen
     */
    reset() {
        this.rrBuffer = [];
        this.rrTimestamps = [];
        this.rrWallTimestamps = [];
        this.lastRR = null;
        this.lastFFTResult = null;
        this.coherenceHistory = [];
    }
}
