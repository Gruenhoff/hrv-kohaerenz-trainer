/**
 * Adaptives Training — Ausrichtung von Atmung und Herzfrequenz-Verlauf
 *
 * Aufgabe der Schleife ist eine DIAGNOSE, kein Ausprobieren: Passt die Dauer des
 * Einatmens zur steigenden, die des Ausatmens zur fallenden Herzfrequenz?
 *
 * Pro Zyklus wird gemessen, um wie viele Millisekunden der HF-Gipfel neben dem
 * Ende des Anstiegs-Segments liegt und das HF-Tal neben dem Ende des Abstiegs-
 * Segments (Scheitelpunkt per Parabel interpoliert, siehe hrv.hrExtremumTime).
 * Korrigiert wird gegen den gleitenden Median der letzten Messungen, gedämpft
 * und mit Totzone — liegt der Versatz innerhalb der Messauflösung, steht der
 * Rhythmus still.
 *
 * Beide Segmente werden UNABHÄNGIG korrigiert. Die Zyklusdauer ergibt sich als
 * Summe und darf mitwandern — genau darüber findet die Schleife die tagesaktuelle
 * Resonanz: Deckungsgleichheit von Wendepunkt und Phasengrenze ist die
 * 0°-Phasenbedingung, und die kennzeichnet die Resonanz.
 *
 * Zwei Wächter:
 *  · Datenqualität — bei flacher RSA-Welle ist der Scheitelzeitpunkt nicht
 *    bestimmbar, dann wird nicht gesteuert.
 *  · Frequenzband — ±1,0 Atemzüge/min um den Protokoll-1/2-Wert. Nur auf der
 *    Gesamtfrequenz; Verhältnis und Binnenaufteilung bleiben darin frei.
 *
 * Der Startpunkt kommt immer aus Protokoll 1/2 und wird nie zurückgeschrieben:
 * jede Session ist eine unabhängige Messung der Tagesresonanz.
 *
 * Amplitude, RMSSD und Flankensteilheit sind reine ERGEBNISgrößen im Bericht,
 * keine Stellziele. Alles läuft unsichtbar und unangesagt; einzige Rückmeldung
 * an den Nutzer sind die EDR-Atemtiefe-Hinweise — das einzige, wogegen er aktiv
 * etwas tun kann.
 */
import { HRVAnalyzer } from './hrv.js';
import { EcgRPeakDetector, EdrBuffer } from './ecgAnalysis.js';

export class CancelledError extends Error {}

// ─── Einschwingen ────────────────────────────────────────────────────────────
// Kurz statt der früheren 3-Minuten-Kalibrierung: die HRV braucht nach dem
// Umschalten auf geführtes Atmen etwa eine Minute, bis sie sich eingependelt hat,
// und auf unruhigen Daten wird nicht gesteuert. Länger zu warten hieße dagegen,
// bei einem Rhythmus von gestern bewusst fehlausgerichtet zu trainieren.
const SETTLE_MS = 60 * 1000;
// Die Atemtiefe-Referenz darf länger reifen — sie hängt nicht an der Ausrichtung.
const EDR_BASELINE_MS = 120 * 1000;

// ─── Ausrichtungs-Korrektur ──────────────────────────────────────────────────
const LAG_MEDIAN_N       = 3;      // gleitender Median über so viele Versatz-Messungen
const CORRECTION_DAMPING = 1 / 3;  // Anteil des gemessenen Versatzes je Zyklus
const MAX_CORRECTION_MS  = 300;    // Deckel je Zyklus
// Totzone: unter einem halben RR-Intervall ist der gemessene Versatz nicht von der
// Messauflösung zu unterscheiden. Ohne sie würde die Schleife am Fixpunkt ewig
// weiterzappeln und Rauschen in den Rhythmus schreiben.
const DEADZONE_RR_FRACTION = 0.5;

// ─── Grenzen ─────────────────────────────────────────────────────────────────
// Nur auf der GESAMTFREQUENZ, nicht auf einzelnen Phasen: ±1,0 Atemzüge/min um den
// Protokoll-1-Wert. Das kodiert die Annahme, dass die Resonanz von Tag zu Tag nur
// leicht schwankt — wandert die Schleife in einer Session weiter, ist das mit hoher
// Wahrscheinlichkeit ein Messproblem. Verhältnis und Binnenaufteilung bleiben frei.
const FREQ_BAND_BPM = 1.0;
// Zusätzlich hart auf den Bereich geklemmt, den Protokoll 1 überhaupt absucht:
// bei einer gemessenen Resonanz von z.B. 4,75/min reichte das reine ±1-Band sonst
// bis 3,75/min hinunter — also in einen Bereich, der nie als Kandidat geprüft wurde.
const ABS_MIN_BPM = 4.5;
const ABS_MAX_BPM = 8.0;
const MIN_INHALE_MS = 1500;  // absolute Atembarkeits-Untergrenzen
const MIN_EXHALE_MS = 2000;

// ─── Datenqualität ───────────────────────────────────────────────────────────
// Bei flacher RSA-Welle ist der Scheitelzeitpunkt nicht bestimmbar — dann wird
// nicht gesteuert, statt auf Rauschen zu steuern.
const MIN_AMPLITUDE_FRACTION = 0.5;  // Anteil der laufenden Amplituden-Referenz
const AMPLITUDE_REF_N        = 10;   // Fensterbreite der gleitenden Referenz

const EDR_SHALLOW_FRACTION = 0.6;    // < 60% der Atemtiefe-Referenz gilt als "flach"
const EDR_SHALLOW_STREAK   = 3;      // so viele Zyklen in Folge, bevor Hinweis kommt
const SPEECH_COOLDOWN_MS   = 50000;  // 45–60s Zielkorridor, Mittelwert
const EDR_QUALITY_TOLERANCE = 0.25;  // erlaubte relative Abweichung implizite-HF vs. echte HF

const PHASES = ['inhale', 'holdIn', 'exhale', 'holdOut'];

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function median(values) {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function cycleMs(rhythm) {
    return rhythm.inhale + rhythm.holdIn + rhythm.exhale + rhythm.holdOut;
}

export class AdaptiveTraining {
    /**
     * @param {HRVAnalyzer} hrv
     * @param {import('./database.js').Database} db
     * @param {{inhale:number,holdIn:number,exhale:number,holdOut:number}} baseRhythm
     */
    constructor(hrv, db, baseRhythm) {
        this.hrv = hrv;
        this.db = db;
        this.baseRhythm = { ...baseRhythm };
        this.rhythm = { ...baseRhythm };
        this._settleMs = SETTLE_MS;           // Instanzfelder für Testbarkeit
        this._edrBaselineMs = EDR_BASELINE_MS;

        // Frequenzband um den Protokoll-1/2-Wert. Kürzerer Zyklus = höhere Frequenz,
        // deshalb liefert die obere bpm-Grenze die untere Zyklusgrenze.
        const baseBpm = 60000 / Math.max(1, cycleMs(baseRhythm));
        const fastBpm = Math.min(baseBpm + FREQ_BAND_BPM, ABS_MAX_BPM);
        const slowBpm = Math.max(baseBpm - FREQ_BAND_BPM, ABS_MIN_BPM);
        this._cycleBounds = [
            60000 / Math.max(fastBpm, baseBpm), // nie enger als der Startwert selbst
            60000 / Math.min(slowBpm, baseBpm),
        ];

        this._active = false;
        this._phaseWaiters = [];

        this.rPeakDetector = new EcgRPeakDetector();
        this.edrBuffer = new EdrBuffer(120000);
        this.rPeakDetector.onRPeak = (ts, amp) => this.edrBuffer.addRPeak(ts, amp);

        this._edrBaseline = null;
        this._edrShallowStreak = 0;
        this._lastSpeechTs = -Infinity;

        // Gleitende Amplituden-Referenz für das Datenqualitäts-Tor. Bewusst gleitend
        // und nicht in einer abgeschlossenen Phase eingefroren: sie soll die
        // Bedingungen abbilden, die gerade herrschen.
        this._amplitudeRef = [];

        // Gleitende Mediane der gemessenen Zeitversätze je Segment
        this._lags = { rising: [], falling: [] };
        this._prevCycle = null; // für den Tal-Versatz, der erst einen Zyklus später messbar ist

        // Session-weite Logs für den Abschlussbericht
        this._rmssdLog = [];
        this._amplitudeLog = [];
        this._reactivityLog = [];
        this._reactivityIndexLog = []; // Steilheit je Atemtiefe — Ergebnisgröße, kein Stellziel
        this._edrSamples = [];         // sammelt bis _edrBaselineMs, dann eingefroren

        this._summary = {
            segmentShift: { rising: 0, falling: 0 }, // Nettoverschiebung in ms
            corrections: 0,
            bandLimited: 0,   // wie oft die Frequenzschranke eine Korrektur gedeckelt hat
            speechCues: 0,
            cyclesObserved: 0,
        };

        // Callbacks (von app.js gesetzt)
        this.onRhythmChange    = null; // (rhythm) => void — Pacer (neu) starten
        this.onCalibrationTick = null; // (elapsedMs, totalMs) => void
        this.onCalibrationDone = null; // () => void
        this.onSpeechCue       = null; // (text) => void
        this.onCycleComplete   = null; // (info) => void — für optionale Live-Anzeige/Debug
        this.onComplete        = null; // (summary) => void — einziger Beendigungs-Callback (auch bei manuellem Stop)
    }

    get active() { return this._active; }

    async start() {
        this._active = true;
        this.onRhythmChange?.(this.rhythm);
        try {
            await this._settlePhase();
            await this._adaptiveLoop();
        } catch (err) {
            if (err instanceof CancelledError) return; // stop() erledigt Aufräumen + onComplete
            this._active = false;
            throw err; // echte Fehler an den Aufrufer durchreichen (siehe app.js .catch())
        }
    }

    /** Beendet die Session, speichert und liefert die Zusammenfassung via onComplete. */
    async stop() {
        if (!this._active) return; // bereits beendet — keine doppelte Beendigung/Speicherung
        this._active = false;

        const waiters = this._phaseWaiters;
        this._phaseWaiters = [];
        waiters.forEach(w => w.reject(new CancelledError()));
        if (this._waitReject) {
            const reject = this._waitReject;
            this._waitReject = null;
            reject(new CancelledError());
        }

        this._summary.avgRMSSD = this._rmssdLog.length
            ? Math.round(this._rmssdLog.reduce((a, b) => a + b, 0) / this._rmssdLog.length) : 0;
        this._summary.peakRMSSD = this._rmssdLog.length ? Math.round(Math.max(...this._rmssdLog)) : 0;
        this._summary.avgAmplitude = this._amplitudeLog.length
            ? Math.round(this._amplitudeLog.reduce((a, b) => a + b, 0) / this._amplitudeLog.length) : 0;
        this._summary.peakAmplitude = this._amplitudeLog.length ? Math.round(Math.max(...this._amplitudeLog)) : 0;

        // Reaktivität auf eine Nachkommastelle — die Werte liegen typisch im einstelligen bpm/s-Bereich
        const round1 = v => Math.round(v * 10) / 10;
        this._summary.avgReactivity = this._reactivityLog.length
            ? round1(this._reactivityLog.reduce((a, b) => a + b, 0) / this._reactivityLog.length) : 0;
        this._summary.peakReactivity = this._reactivityLog.length ? round1(Math.max(...this._reactivityLog)) : 0;

        // Atemtiefen-normiert: der über Sessions hinweg vergleichbare Wert, weil er
        // nicht mitsteigt, wenn nur kräftiger geatmet wurde. 0 = kein brauchbares EKG.
        this._summary.avgReactivityIndex = this._reactivityIndexLog.length
            ? round1(median(this._reactivityIndexLog)) : 0;
        const bpm = r => Math.round(60000 / cycleMs(r) * 10) / 10;
        this._summary.startBreathsPerMin = bpm(this.baseRhythm);
        this._summary.finalBreathsPerMin = bpm(this.rhythm);

        const result = { rhythm: this.rhythm, startRhythm: this.baseRhythm, ...this._summary };
        await this.db.saveAdaptiveTrainingSession(result).catch(() => {});
        this.onComplete?.(result);
    }

    /** Von app.js bei jedem BreathPacer.onPhaseChange aufzurufen */
    notifyPhaseChange(phase) {
        if (!this._phaseWaiters.length) return;
        const evt = { phase, ts: performance.now() };
        const waiters = this._phaseWaiters;
        this._phaseWaiters = [];
        waiters.forEach(w => w.resolve(evt));
    }

    /** Von app.js bei jedem rohen EKG-Sample aufzurufen (PMD-Stream) */
    addEcgSample(uv, tsMs) {
        this.rPeakDetector.addSample(uv, tsMs);
    }

    /** Von app.js bei jedem akzeptierten RR-Intervall aufzurufen (für den Abschluss-Score) */
    logRmssd(rmssd) {
        if (this._active) this._rmssdLog.push(rmssd);
    }

    _nextPhaseEvent() {
        if (!this._active) return Promise.reject(new CancelledError());
        return new Promise((resolve, reject) => this._phaseWaiters.push({ resolve, reject }));
    }

    _wait(ms) {
        if (!this._active) return Promise.reject(new CancelledError());
        return new Promise((resolve, reject) => {
            this._waitReject = reject;
            this._waitTimer = setTimeout(() => { this._waitReject = null; resolve(); }, ms);
        });
    }

    // ─── Ein vollständiger Zyklus: Grenzen einsammeln + auswerten ──────────

    /**
     * Wartet auf einen vollständigen Zyklus (Einatmen[-Halt]-Ausatmen[-Halt])
     * und liefert Wendepunkt-Richtungen (pro Segment) + Zyklus-Amplitude + EDR-Spannweite.
     *
     * @param {{phase:string,ts:number}|null} knownInhaleStart - das schließende
     *   Ereignis des VORIGEN Zyklus (= öffnendes 'inhale' dieses Zyklus), falls
     *   bekannt. Ohne diese Wiederverwendung würde bei fortlaufendem Aufruf
     *   jeder zweite reale Zyklus übersprungen, weil sonst erneut auf ein
     *   FRISCHES 'inhale' gewartet würde, während der Pacer bereits mitten im
     *   nächsten Zyklus läuft.
     * @returns {object} Zyklusdaten, inkl. `nextInhaleEvt` als Cursor für den
     *   nächsten Aufruf.
     */
    async _observeOneCycle(knownInhaleStart = null) {
        const inhaleStartEvt = knownInhaleStart ?? await this._waitUntilPhase('inhale');
        const inhaleStart = inhaleStartEvt.ts;

        const afterInhale = await this._nextPhaseEvent(); // weg von 'inhale'
        const inhaleEndTs = afterInhale.ts;

        // Ende des Anstiegs-Segments (Einatmen + ggf. Halt-Ein)
        let risingEnd = inhaleEndTs;
        if (afterInhale.phase === 'holdIn') {
            const afterHoldIn = await this._nextPhaseEvent(); // weg von 'holdIn'
            risingEnd = afterHoldIn.ts;
        }

        const afterExhale = await this._nextPhaseEvent(); // weg von 'exhale'
        const exhaleEndTs = afterExhale.ts;

        // Ende des Abstiegs-Segments (Ausatmen + ggf. Halt-Aus) = Ende des ganzen Zyklus
        let fallingEnd = exhaleEndTs;
        let nextInhaleEvt = afterExhale;
        if (afterExhale.phase === 'holdOut') {
            nextInhaleEvt = await this._nextPhaseEvent(); // weg von 'holdOut'
            fallingEnd = nextInhaleEvt.ts;
        }

        // HF-Maximum über das GANZE Anstiegs-Segment suchen (bis risingEnd), nicht nur
        // bis zum Einatem-Ende: bei vorhandenem Halt-Ein schiebt die Regelschleife den
        // Gipfel gezielt ans Ende des Halts — er läge sonst außerhalb des Suchfensters,
        // und die Amplitude würde umso stärker unterschätzt, je besser geregelt wird.
        const amplitude = this.hrv.cycleAmplitude(inhaleStart, risingEnd, fallingEnd);
        if (amplitude !== null && amplitude > 0) this._amplitudeLog.push(amplitude);

        // Reaktivität der vagalen Bremse: wie schnell sie löst (Anstieg) und greift (Abstieg).
        // Ergänzt die Amplitude (= wie tief) um die Geschwindigkeit (= wie reaktiv).
        const reactivity = this._cycleReactivity(inhaleStart, risingEnd, fallingEnd);
        if (reactivity !== null) this._reactivityLog.push(reactivity);

        let edrRange = this.edrBuffer.amplitudeRangeInWindow(inhaleStart, fallingEnd);
        if (!this._edrLooksReliable(inhaleStart, fallingEnd)) edrRange = null;

        // Atemtiefen-normierte Reaktivität mitschreiben, sobald eine Baseline steht —
        // unabhängig davon, welche Basis die Suche gerade benutzt.
        if (reactivity !== null && edrRange !== null && this._edrBaseline) {
            const depth = edrRange / this._edrBaseline;
            if (depth > 0.2) this._reactivityIndexLog.push(reactivity / depth);
        }

        this._summary.cyclesObserved++;
        return { inhaleStart, inhaleEndTs, risingEnd, fallingEnd, amplitude, reactivity, edrRange, nextInhaleEvt };
    }

    /**
     * Zeitversatz zwischen HF-Gipfel und dem Ende des Anstiegs-Segments.
     *
     * Das Suchfenster muss die Segmentgrenze ÜBERSPANNEN — von der Mitte des
     * Anstiegs bis in die Mitte des Abstiegs. Läge es nur im Anstiegs-Segment,
     * könnte ein Gipfel NACH der Grenze (Segment zu kurz) gar nicht gefunden
     * werden, und die Schleife wäre auf einem Auge blind.
     *
     * @returns {number|null} ms; positiv = Gipfel lag NACH der Grenze (Segment zu kurz)
     */
    _risingLag(cycle) {
        const from = (cycle.inhaleStart + cycle.risingEnd) / 2;
        const to   = (cycle.risingEnd + cycle.fallingEnd) / 2;
        const t = this.hrv.hrExtremumTime(from, to, 'max');
        return t === null ? null : t - cycle.risingEnd;
    }

    /**
     * Zeitversatz zwischen HF-Tal und dem Ende des Abstiegs-Segments.
     *
     * Messbar erst einen Zyklus später: zum Zeitpunkt des Zyklusendes liegen die
     * Schläge DANACH noch nicht vor, das Fenster wäre einseitig. Deshalb wird das
     * Tal des vorigen Zyklus ausgewertet, sobald der aktuelle seinen Anstieg
     * hinter sich hat — dann reicht das Fenster wieder über die Grenze hinaus.
     *
     * @returns {number|null} ms; positiv = Tal lag NACH der Grenze (Segment zu kurz)
     */
    _fallingLag(prev, cycle) {
        const from = (prev.risingEnd + prev.fallingEnd) / 2;
        const to   = (cycle.inhaleStart + cycle.risingEnd) / 2;
        const t = this.hrv.hrExtremumTime(from, to, 'min');
        return t === null ? null : t - prev.fallingEnd;
    }

    /**
     * Mittlere Flankensteilheit eines Zyklus in bpm/s: Betrag der HF-Steigung im
     * Anstiegs-Segment und im Abstiegs-Segment, gemittelt. Hoher Wert = die Bremse
     * wird schnell gelöst und schnell wieder gesetzt (das Trainingsziel), niedriger
     * Wert = träge Modulation, auch wenn die Amplitude gleich groß ist.
     *
     * Bewusst nur Messgröße, kein Regelziel: die Steilheit ist die ANPASSUNG, die
     * das Training über Wochen bewirken soll — sie innerhalb der Session zu
     * optimieren hieße, den Reiz gegen seine eigene Erfolgskennzahl einzutauschen.
     */
    _cycleReactivity(inhaleStart, risingEnd, fallingEnd) {
        const up   = this.hrv.hrSlopeInWindow(inhaleStart, risingEnd);
        const down = this.hrv.hrSlopeInWindow(risingEnd, fallingEnd);
        if (up === null || down === null) return null;
        return (Math.abs(up) + Math.abs(down)) / 2;
    }

    /**
     * Grober Plausibilitätscheck fürs EKG-Signal: die aus erkannten R-Zacken
     * implizite Herzfrequenz muss einigermaßen zur ECHTEN, vom Standard-HF-
     * Dienst gemessenen Herzfrequenz passen. Weicht sie zu stark ab (Rauschen/
     * Bewegungsartefakte erzeugen Fehl-Erkennungen), gilt das EDR-Signal für
     * dieses Fenster als unzuverlässig — betrifft NUR die EDR-Sprach-Hinweise,
     * nicht die Timing-Anpassung (die hängt allein am Standard-HF-Signal).
     */
    _edrLooksReliable(startMs, endMs) {
        const durationMin = (endMs - startMs) / 60000;
        if (durationMin <= 0) return false;
        const peakCount = this.edrBuffer.countInWindow(startMs, endMs);
        if (peakCount < 2) return false;
        const impliedHR = peakCount / durationMin;
        const trueHR = this.hrv.meanHRInWindow(startMs, endMs);
        if (trueHR === null || trueHR <= 0) return false;
        return Math.abs(impliedHR - trueHR) / trueHR <= EDR_QUALITY_TOLERANCE;
    }

    async _waitUntilPhase(target) {
        for (;;) {
            const evt = await this._nextPhaseEvent();
            if (evt.phase === target) return evt;
        }
    }

    // ─── Einschwingphase: nur beobachten, keine Eingriffe ──────────────────

    async _settlePhase() {
        const startTs = performance.now();
        let cursor = null;

        while (performance.now() - startTs < this._settleMs) {
            const cycle = await this._observeOneCycle(cursor);
            cursor = cycle.nextInhaleEvt;
            this._recordReferences(cycle, startTs);
            this._prevCycle = cycle;
            this.onCalibrationTick?.(performance.now() - startTs, this._settleMs);
        }

        this._settleStartTs = startTs;
        this._cursor = cursor; // an die Regelschleife übergeben, damit kein Zyklus übersprungen wird
        this.onCalibrationDone?.();
    }

    /**
     * Laufende Referenzwerte fortschreiben.
     *
     * Amplitude gleitend: sie dient dem Datenqualitäts-Tor und soll die Bedingungen
     * abbilden, die gerade herrschen — eine in Minute 1 eingefrorene Zahl täte das
     * nicht, etwa wenn die Entspannung im Lauf der Session tiefer wird.
     *
     * Atemtiefe dagegen wird nach _edrBaselineMs EINGEFROREN. Sie beantwortet die
     * Frage "atmest du flacher als sonst" und braucht dafür einen festen Anker —
     * gleitend würde die Referenz bei dauerhaft flacher Atmung mitsinken und der
     * Hinweis genau dann verstummen, wenn er gebraucht wird.
     */
    _recordReferences(cycle, sessionStartTs) {
        if (cycle.amplitude !== null && cycle.amplitude > 0) {
            this._amplitudeRef.push(cycle.amplitude);
            if (this._amplitudeRef.length > AMPLITUDE_REF_N) this._amplitudeRef.shift();
        }
        if (this._edrBaseline === null && cycle.edrRange !== null) {
            this._edrSamples.push(cycle.edrRange);
            if (performance.now() - sessionStartTs >= this._edrBaselineMs) {
                this._edrBaseline = median(this._edrSamples);
            }
        }
    }

    // ─── Regelschleife: Ausrichtung von Atmung und HF-Verlauf ───────────────

    async _adaptiveLoop() {
        let cursor = this._cursor ?? null; // nahtlos an die Einschwingphase anschließen
        const startTs = this._settleStartTs ?? performance.now();

        while (this._active) {
            const cycle = await this._observeOneCycle(cursor);
            cursor = cycle.nextInhaleEvt;

            this._recordReferences(cycle, startTs);

            // Der Tal-Versatz gehört zum VORIGEN Zyklus — erst jetzt liegen die
            // Schläge nach dessen Ende vor (siehe _fallingLag).
            const risingLag  = this._risingLag(cycle);
            const fallingLag = this._prevCycle ? this._fallingLag(this._prevCycle, cycle) : null;
            this._prevCycle = cycle;

            let rhythmChanged = false;
            if (this._dataUsable(cycle)) {
                rhythmChanged = this._correctSegment('rising',  risingLag,  cycle)  || rhythmChanged;
                rhythmChanged = this._correctSegment('falling', fallingLag, cycle) || rhythmChanged;
            }
            if (rhythmChanged) this.onRhythmChange?.(this.rhythm); // gebündelt: max. 1× pro Zyklus

            this._checkEdrFeedback(cycle.edrRange);
            this.onCycleComplete?.(cycle);
        }
    }

    /**
     * Datenqualitäts-Tor: Bei flacher RSA-Welle ist der Scheitelzeitpunkt nicht
     * bestimmbar — eine eingebrochene Amplitude sagt also weniger über ein schlechtes
     * Ergebnis als darüber, dass die MESSUNG gerade nichts taugt. Dann wird nicht
     * gesteuert. Die Amplitude bricht auch bei Ablenkung oder Bewegung ein; die
     * Schleife hält dann einfach still, bis wieder saubere Zyklen kommen.
     */
    _dataUsable(cycle) {
        if (cycle.amplitude === null || !(cycle.amplitude > 0)) return false;
        const ref = median(this._amplitudeRef);
        if (ref === null || ref <= 0) return true; // noch keine Referenz → nicht blockieren
        return cycle.amplitude >= ref * MIN_AMPLITUDE_FRACTION;
    }

    /**
     * Korrigiert ein Segment gegen den gleitenden Median der letzten Versatz-
     * Messungen. Gedämpft, gedeckelt, mit Totzone — und proportional auf aktives
     * Atmen und Halte-Phase verteilt, sodass das Protokoll-2-Mischungsverhältnis
     * maßstäblich erhalten bleibt.
     *
     * @param {'rising'|'falling'} segment
     * @param {number|null} lagMs positiv = Extremwert lag nach der Grenze = Segment zu kurz
     * @returns {boolean} true, wenn der Rhythmus geändert wurde
     */
    _correctSegment(segment, lagMs, cycle) {
        if (lagMs === null || !Number.isFinite(lagMs)) return false;

        const lags = this._lags[segment];
        lags.push(lagMs);
        if (lags.length > LAG_MEDIAN_N) lags.shift();
        const lag = median(lags);
        if (lag === null) return false;

        // Totzone: unterhalb eines halben RR-Intervalls ist der Versatz nicht von der
        // Messauflösung zu unterscheiden. Hier steht der Rhythmus still — das ist der
        // Zustand "Ausrichtung stimmt".
        const meanHR = this.hrv.meanHRInWindow(cycle.inhaleStart, cycle.fallingEnd);
        const meanRR = meanHR && meanHR > 0 ? 60000 / meanHR : 1000;
        if (Math.abs(lag) < meanRR * DEADZONE_RR_FRACTION) return false;

        const phases = segment === 'rising' ? ['inhale', 'holdIn'] : ['exhale', 'holdOut'];
        const current = phases.reduce((sum, p) => sum + this.rhythm[p], 0);
        if (current <= 0) return false;

        const wanted = clamp(lag * CORRECTION_DAMPING, -MAX_CORRECTION_MS, MAX_CORRECTION_MS);
        const next = this._applySegmentLength(phases, current, Math.round(current + wanted));
        if (next === 0) return false;

        this._summary.segmentShift[segment] += next;
        this._summary.corrections++;
        return true;
    }

    /**
     * Setzt die Segmentlänge auf `target`, soweit Frequenzband und Mindestdauern es
     * zulassen, und verteilt die Änderung proportional auf die Phasen des Segments.
     * @returns {number} tatsächlich angewandte Änderung in ms (0 = nichts geändert)
     */
    _applySegmentLength(phases, current, target) {
        const [minCycle, maxCycle] = this._cycleBounds;
        const rest = cycleMs(this.rhythm) - current;
        const limited = clamp(target, minCycle - rest, maxCycle - rest);
        if (limited !== target) this._summary.bandLimited++;
        if (limited === current || limited <= 0) return 0;

        const factor = limited / current;
        const draft = {};
        for (const p of phases) draft[p] = Math.round(this.rhythm[p] * factor);

        // Rundung kann die Segmentsumme um ein paar ms verfehlen — Rest auf die
        // aktive Phase legen, damit die Zyklusdauer exakt der Vorgabe entspricht.
        const sum = phases.reduce((s, p) => s + draft[p], 0);
        draft[phases[0]] += limited - sum;

        const floor = phases[0] === 'inhale' ? MIN_INHALE_MS : MIN_EXHALE_MS;
        if (draft[phases[0]] < floor) return 0; // nicht mehr atembar → verwerfen

        for (const p of phases) this.rhythm[p] = draft[p];
        return limited - current;
    }

    _checkEdrFeedback(edrRange) {
        if (this._edrBaseline === null || edrRange === null) return; // Signal zu unsicher/fehlt → keine EDR-Hinweise
        const isShallow = edrRange < this._edrBaseline * EDR_SHALLOW_FRACTION;
        this._edrShallowStreak = isShallow ? this._edrShallowStreak + 1 : 0;

        if (this._edrShallowStreak < EDR_SHALLOW_STREAK) return;
        const now = performance.now();
        if (now - this._lastSpeechTs < SPEECH_COOLDOWN_MS) return;

        this._lastSpeechTs = now;
        this._edrShallowStreak = 0;
        this._summary.speechCues++;
        this.onSpeechCue?.('Versuch etwas tiefer zu atmen.');
    }
}
