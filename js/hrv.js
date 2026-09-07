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

// Mindestbreite des Fensters für hrDirectionBefore(), sonst zu verrauscht/unzuverlässig
const MIN_DIRECTION_WINDOW_MS = 1000;
// Mindestzahl Schläge je Teilfenster — Fensterbreite allein garantiert keine Datenmenge
const MIN_BEATS_PER_HALF = 2;
// Mindestzahl Schläge für eine belastbare Steigungs-Regression bzw. Scheitel-Interpolation
const MIN_BEATS_FOR_SLOPE = 3;

function clampNumber(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

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
     * @param {number} [beatTsMs] - rekonstruierte Schlagzeit auf der performance.now()-
     *   Achse (aus PolarBluetooth._reconstructBeatTimes). Ohne Angabe wird die aktuelle
     *   Zeit genommen — dann sind zyklus-ausgerichtete Auswertungen entsprechend ungenauer.
     * @returns {boolean} true wenn Wert akzeptiert (kein Artefakt)
     */
    addRR(rr, beatTsMs) {
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
        this.rrWallTimestamps.push(Number.isFinite(beatTsMs) ? beatTsMs : performance.now());

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

    /** Anzahl Schläge im gegebenen performance.now()-Zeitfenster */
    beatCountInWindow(startMs, endMs) {
        let n = 0;
        for (let i = 0; i < this.rrWallTimestamps.length; i++) {
            const t = this.rrWallTimestamps[i];
            if (t >= startMs && t <= endMs && this.rrBuffer[i] > 0) n++;
        }
        return n;
    }

    /**
     * Steigung der Herzfrequenz im Zeitfenster (bpm pro Sekunde), per
     * Kleinste-Quadrate-Regression über alle Schläge im Fenster.
     *
     * Das ist das Reaktivitäts-Maß der vagalen Bremse: die Zyklus-Amplitude sagt,
     * wie TIEF die Bremse greift, die Steigung sagt, wie SCHNELL sie greift und
     * löst. Zwei Zyklen mit gleicher Amplitude können sich hier deutlich
     * unterscheiden — ein träger Sinus gegen einen schnellen, klaren Wechsel.
     *
     * Regression statt Schlag-zu-Schlag-Differenz, weil pro Segment nur wenige
     * Schläge vorliegen und Einzeldifferenzen zu stark rauschen.
     *
     * @returns {number|null} bpm/s (positiv = HF steigt), oder null bei zu wenig Daten
     */
    hrSlopeInWindow(startMs, endMs) {
        const xs = [], ys = [];
        for (let i = 0; i < this.rrWallTimestamps.length; i++) {
            const t = this.rrWallTimestamps[i];
            if (t < startMs || t > endMs) continue;
            const rr = this.rrBuffer[i];
            if (rr <= 0) continue;
            xs.push((t - startMs) / 1000); // Sekunden
            ys.push(60000 / rr);
        }
        if (xs.length < MIN_BEATS_FOR_SLOPE) return null;

        const n = xs.length;
        const mx = xs.reduce((a, b) => a + b, 0) / n;
        const my = ys.reduce((a, b) => a + b, 0) / n;
        let num = 0, den = 0;
        for (let i = 0; i < n; i++) {
            const dx = xs[i] - mx;
            num += dx * (ys[i] - my);
            den += dx * dx;
        }
        if (den <= 0) return null; // alle Schläge auf demselben Zeitpunkt
        return num / den;
    }

    /**
     * Zeitpunkt des HF-Maximums bzw. -Minimums im Fenster, per Parabel durch den
     * Extremschlag und seine beiden Nachbarn interpoliert.
     *
     * Ohne Interpolation wäre die Auflösung ein ganzes RR-Intervall (bei 60 bpm also
     * eine Sekunde) — viel zu grob, um daraus eine Phasenkorrektur abzuleiten. Die
     * Parabel nutzt die Krümmung der Nachbarschaft und trifft den Scheitel deutlich
     * genauer als der höchste Einzelschlag.
     *
     * Liegt der Extremwert am Fensterrand, kann nicht interpoliert werden — dann
     * wird der Randzeitpunkt zurückgegeben. Das UNTERschätzt die wahre Abweichung
     * (der Scheitel liegt dann außerhalb des Fensters) und ist damit die
     * konservative Richtung.
     *
     * @param {'max'|'min'} kind
     * @returns {number|null} Zeitpunkt auf der performance.now()-Achse, oder null
     */
    hrExtremumTime(startMs, endMs, kind = 'max') {
        const ts = [], hrs = [];
        for (let i = 0; i < this.rrWallTimestamps.length; i++) {
            const t = this.rrWallTimestamps[i];
            if (t < startMs || t > endMs) continue;
            const rr = this.rrBuffer[i];
            if (rr <= 0) continue;
            ts.push(t);
            hrs.push(60000 / rr);
        }
        if (ts.length < MIN_BEATS_FOR_SLOPE) return null; // zu wenig Kurve für eine Aussage

        let best = 0;
        for (let i = 1; i < hrs.length; i++) {
            if (kind === 'max' ? hrs[i] > hrs[best] : hrs[i] < hrs[best]) best = i;
        }
        if (best === 0 || best === ts.length - 1) return ts[best]; // Rand → nicht interpolierbar

        const [x0, x1, x2] = [ts[best - 1], ts[best], ts[best + 1]];
        const [y0, y1, y2] = [hrs[best - 1], hrs[best], hrs[best + 1]];
        const s01 = (y1 - y0) / (x1 - x0);
        const s12 = (y2 - y1) / (x2 - x1);
        const a = (s12 - s01) / (x2 - x0);
        if (!Number.isFinite(a) || a === 0) return x1;
        const b = s01 - a * (x0 + x1);
        const vertex = -b / (2 * a);
        if (!Number.isFinite(vertex)) return x1;
        return clampNumber(vertex, x0, x2); // entarteter Fit darf nicht davonfliegen
    }

    /**
     * Richtung der HF unmittelbar vor einem Zeitpunkt (z.B. Segment-Ende): vergleicht
     * die mittlere HF in zwei benachbarten Teilfenstern direkt davor. Das Fenster wird
     * an `minMs` geklammert (z.B. Segment-Anfang), damit es bei kurzen Phasen nicht ins
     * VORIGE Segment hineinliest — sonst würde die eigene Anpassungslogik (die Phasen
     * verkürzen kann) das Problem mit der Zeit verschärfen statt es zu vermeiden.
     * @param {number} atMs - Zeitpunkt (z.B. Segment-Ende), performance.now()-Achse
     * @param {number} windowMs - Gewünschte Gesamtbreite des Analysefensters (wird hälftig geteilt)
     * @param {number} [minMs] - untere Schranke fürs Fenster (z.B. Segment-Anfang)
     * @returns {'rising'|'falling'|'flat'|null}
     */
    hrDirectionBefore(atMs, windowMs = 3000, minMs = -Infinity) {
        const windowStart = Math.max(atMs - windowMs, minMs);
        const available = atMs - windowStart;
        if (available < MIN_DIRECTION_WINDOW_MS) return null; // zu wenig verlässliche Daten im Segment

        const half = windowStart + available / 2;

        // Einmalige Zuordnung jedes Schlags zu genau EINER Hälfte ([start, half) und
        // [half, at]). Über meanHRInWindow gerechnet würde ein Schlag exakt auf der
        // Trennlinie in beide Mittelwerte eingehen und den Unterschied künstlich
        // verkleinern — bei nur wenigen Schlägen je Hälfte fällt das ins Gewicht.
        let earlySum = 0, earlyN = 0, lateSum = 0, lateN = 0;
        for (let i = 0; i < this.rrWallTimestamps.length; i++) {
            const t = this.rrWallTimestamps[i];
            if (t < windowStart || t > atMs) continue;
            const rr = this.rrBuffer[i];
            if (rr <= 0) continue;
            const hr = 60000 / rr;
            if (t < half) { earlySum += hr; earlyN++; }
            else          { lateSum  += hr; lateN++;  }
        }

        // Fensterbreite allein garantiert keine Datenmenge: bei ~60 bpm liegen in
        // 1,5 s nur ein bis zwei Schläge. Ein Vergleich "ein Schlag gegen einen
        // Schlag" gegen eine 0,3-bpm-Schwelle wäre reines Rauschen und würde die
        // Regelschleife zufällig hin- und herschieben. Lieber keine Richtung melden.
        if (earlyN < MIN_BEATS_PER_HALF || lateN < MIN_BEATS_PER_HALF) return null;

        const diff = (lateSum / lateN) - (earlySum / earlyN);
        if (Math.abs(diff) < 0.3) return 'flat'; // < 0,3 bpm Unterschied gilt als Wendepunkt erreicht
        return diff > 0 ? 'rising' : 'falling';
    }

    /**
     * Zyklus-ausgerichtete RSA-Amplitude: HRmax während der Einatemphase minus
     * HRmin über den GESAMTEN Rest des Zyklus (Moonbird-Metrik), statt eines
     * beliebigen rollierenden Zeitfensters. Grenzen kommen von BreathPacer.onPhaseChange.
     * @param {number} inhaleStart - performance.now() bei Beginn Einatmen
     * @param {number} inhaleEnd   - performance.now() bei Ende Einatmen (= Beginn Halt-Ein/Ausatmen)
     * @param {number} cycleEnd    - performance.now() beim Ende des GESAMTEN Zyklus (= Beginn des
     *   nächsten Einatmens; deckt Halt-Ein + Ausatmen + Halt-Aus ab — bei fehlenden Halte-Phasen
     *   fällt das mit dem Ausatem-Ende zusammen). Wichtig: NICHT das reine Ausatem-Ende übergeben,
     *   sonst wird ein evtl. Minimum während Halt-Aus verpasst.
     * @returns {number|null} Amplitude in bpm, oder null wenn Daten fehlen
     */
    cycleAmplitude(inhaleStart, inhaleEnd, cycleEnd) {
        const hrMax = this.maxHRInWindow(inhaleStart, inhaleEnd);
        const hrMin = this.minHRInWindow(inhaleEnd, cycleEnd);
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
