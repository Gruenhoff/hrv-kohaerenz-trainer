/**
 * Moonbird-Diagnose
 *
 * Ziel: messen, wie exakt das Moonbird die Frequenz abbildet, die der Pacer
 * visuell zeigt — und alle Hemmnisse aufdecken (BLE-Latenz, Geräteuhr,
 * Atemzug-Genauigkeit, Rhythmus-Wechsel, EKG-Stream, Hauptthread, Hintergrund).
 *
 * Aufbau:
 *  1. analyzeTrace()      — wertet das Zeitprotokoll (moonbird.trace) aus, pure Funktion
 *  2. MoonbirdDiagnostics — aktive Messungen (Latenz, Uhr, Genauigkeit, Spiegeltest)
 *  3. buildFindings()     — regelbasierte Befunde + Empfehlungen
 *  4. renderText/renderHTML — Bericht
 */
import { MoonbirdController } from './moonbird.js';

const { MIN_SESSION_MS, END_MARGIN_MS, CMD_OVERHEAD_MS } = MoonbirdController.constants;

// Toleranzen für "synchron": Start ±150 ms, Ende ±250 ms (unterhalb der Wahrnehmung eines Atemrhythmus)
const START_TOL_MS = 150;
const END_TOL_MS = 250;

// ─── Statistik-Helfer ──────────────────────────────────────────────────────

export function stats(values) {
    const v = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return null;
    const n = v.length;
    const mean = v.reduce((s, x) => s + x, 0) / n;
    const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
    const q = (p) => v[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
    return { n, mean, sd, min: v[0], max: v[n - 1], p50: q(0.5), p95: q(0.95) };
}

function slope(xs, ys, minN = 4) {
    const n = ys.length;
    if (n < minN) return null;
    const mx = xs.reduce((s, x) => s + x, 0) / n;
    const my = ys.reduce((s, y) => s + y, 0) / n;
    let num = 0, den = 0;
    ys.forEach((y, i) => { num += (xs[i] - mx) * (y - my); den += (xs[i] - mx) ** 2; });
    return den ? num / den : null;
}

const r0 = (x) => (x == null || !Number.isFinite(x)) ? '–' : Math.round(x);
const sgn = (x) => (x == null || !Number.isFinite(x)) ? '–' : (x > 0 ? '+' : '') + Math.round(x);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const breathOf = (r) => r ? r.inhale + (r.holdIn || 0) + r.exhale : null;
const cycleOf = (r) => r ? r.inhale + (r.holdIn || 0) + r.exhale + (r.holdOut || 0) : null;

// ─── 1. Auswertung des Zeitprotokolls ──────────────────────────────────────

/**
 * Ordnet jedem Einatem-Signal des Pacers den Moonbird-Atemzug zu und misst Verzug,
 * Atemzug-Länge, Ende-Versatz und Zyklus-Frequenz.
 * @param {object[]} traceIn  moonbird.trace (oder ein Ausschnitt davon)
 * @param {{calibration?: {startBias?: number, endLatency?: number}}} [opts]
 */
export function analyzeTrace(traceIn, opts = {}) {
    const trace = [...traceIn].sort((a, b) => a.t - b.t);
    const cal = opts.calibration || {};

    const cmds = trace.filter(e => e.type === 'cmd');
    const ack = cmds.filter(c => c.tWritten != null && c.tSend != null).map(c => c.tWritten - c.tSend);
    const oneWay = ack.length ? stats(ack).p50 / 2 : 50;
    const startBias = cal.startBias ?? oneWay;       // Befehl gesendet → Gerät beginnt
    const endLatency = cal.endLatency ?? oneWay;     // Gerät beendet → Ereignis in der App

    const phaseEvents = trace.filter(e => e.type === 'pacer');
    const inhales = phaseEvents.filter(e => e.phase === 'inhale');
    const rhythms = trace.filter(e => e.type === 'rhythm' || e.type === 'follow');
    const starts = cmds.filter(c => c.op === 0x07 && c.reply?.startsWith('870100'));
    const ends = trace.filter(e => e.type === 'end');
    const sessions = trace.filter(e => e.type === 'session');
    const decisions = trace.filter(e => e.type === 'decision');

    // Start → Einatem-Signal zuordnen. Mit Vorhalt wird der Startbefehl VOR dem Signal gesendet (session.early):
    // dann gehört er zum nächsten Signal, sonst zum vorangegangenen.
    const startInfos = starts.map(st => {
        const sess = sessions.find(x => x.tReply != null && Math.abs(x.tReply - st.tReply) < 5) ?? null;
        return { st, sess, early: !!sess?.early };
    });
    const byCycle = new Map();
    for (const si of startInfos) {
        let idx = -1;
        if (si.early) idx = inhales.findIndex(e => e.t >= si.st.tSend - 50);
        else for (let i = inhales.length - 1; i >= 0; i--) if (inhales[i].t <= si.st.tSend + 50) { idx = i; break; }
        if (idx >= 0 && !byCycle.has(idx)) byCycle.set(idx, si);
    }
    const leadWin = Math.max(0, ...sessions.map(x => x.lead || 0)) + 120;   // Entscheidungen zum Start liegen vor dem Signal

    const cycles = [];
    for (let i = 0; i < inhales.length; i++) {
        const tP = inhales[i].t;
        const tNext = inhales[i + 1]?.t ?? null;
        const rhythm = [...rhythms].reverse().find(r => r.t <= tP + 60)?.rhythm ?? null;
        const inCycle = (e) => e.t >= tP - leadWin && (tNext === null || e.t < tNext - leadWin);
        const tHoldOut = phaseEvents.find(e => e.phase === 'holdOut' && e.t > tP && (tNext === null || e.t < tNext))?.t ?? null;

        const c = {
            i, tP, tNext, rhythm,
            pacerPeriod: tNext ? tNext - tP : null,
            pacerBreath: breathOf(rhythm),
            matched: false,
            flags: {},
        };
        decisions.filter(inCycle).forEach(d => { if (d.what !== 'schedule' && d.what !== 'end-bias') c.flags[d.what] = (c.flags[d.what] || 0) + 1; });

        const si = byCycle.get(i);
        if (si) {
            const { st: start, sess } = si;
            const endEvt = ends.find(e => e.t > start.tSend);
            c.matched = true;
            c.early = si.early;
            c.lead = sess?.lead || 0;
            c.tSend = start.tSend;
            c.cmdLag = start.tSend - tP;                       // negativ: mit Vorhalt vor dem Einatem-Signal gesendet
            c.ack = start.tWritten != null ? start.tWritten - start.tSend : null;
            c.devStart = start.tSend + startBias;              // geschätzter Beginn am Gerät
            c.startLag = c.devStart - tP;                      // Versatz zum Pacer-Einatmen
            c.progBreath = sess?.prog?.breath ?? null;         // Atemzug-Länge, die dem Gerät befohlen wurde
            if (endEvt) {
                c.devEnd = endEvt.t - endLatency;
                c.breathMeasured = c.devEnd - c.devStart;
                const pacerEnd = tHoldOut ?? tNext;            // Ende der Ausatmung im Pacer
                if (pacerEnd != null) c.endOffset = c.devEnd - pacerEnd;
            }
        }
        cycles.push(c);
    }

    // Zyklusdauer Gerät vs. Pacer (nur benachbarte, zugeordnete Zyklen)
    for (let i = 0; i < cycles.length - 1; i++) {
        const a = cycles[i], b = cycles[i + 1];
        if (a.matched && b.matched && a.pacerPeriod != null) {
            a.devPeriod = b.devStart - a.devStart;
            a.periodErr = a.devPeriod - a.pacerPeriod;
        }
    }

    const full = cycles.filter(c => c.tNext != null);   // vollständige Pacer-Zyklen
    const m = cycles.filter(c => c.matched);
    // Rhythmuswechsel (reprepare) verschiebt den Start sprunghaft — für Frequenz/Drift ausklammern
    const clean = m.filter(c => !c.flags.reprepare);
    // Die ersten Atemzüge sind die Lernphase des Ausgleichs (Lücke wird gemessen) — für Drift/Streuung getrennt betrachten
    const steadyFrom = full.length >= 6 ? 2 : 0;
    const steady = clean.filter(c => c.i >= steadyFrom);
    const nextOf = (c) => cycles[c.i + 1];
    const periodPairs = cycles.filter(c => c.devPeriod != null && !c.flags.reprepare && !nextOf(c)?.flags.reprepare);
    const sumDev = periodPairs.reduce((s, c) => s + c.devPeriod, 0);
    const sumPacer = periodPairs.reduce((s, c) => s + c.pacerPeriod, 0);

    const decisionCounts = {};
    decisions.forEach(d => { decisionCounts[d.what] = (decisionCounts[d.what] || 0) + 1; });

    const good = full.filter(c => c.matched && Math.abs(c.startLag) <= START_TOL_MS
        && (c.endOffset == null || Math.abs(c.endOffset) <= END_TOL_MS));

    const rhythmChanges = cycles.filter((c, i) => i > 0 && c.rhythm && cycles[i - 1].rhythm && cycleOf(c.rhythm) !== cycleOf(cycles[i - 1].rhythm)).length;
    const overheadEvents = decisions.filter(d => d.what === 'overhead');
    const lastOverhead = overheadEvents[overheadEvents.length - 1] || null;

    const summary = {
        rhythmChanges,
        gapEstMs: lastOverhead ? lastOverhead.gap : null,
        overheadMs: lastOverhead ? lastOverhead.to : null,
        pacerCycles: full.length,
        matchedCycles: full.filter(c => c.matched).length,
        oneWayMs: oneWay,
        startBias, endLatency,
        calibrated: cal.startBias != null,
        startLag: stats(m.map(c => c.startLag)),
        cmdLag: stats(m.map(c => c.cmdLag)),
        ack: stats(m.map(c => c.ack)),
        breathError: stats(m.filter(c => c.breathMeasured != null && c.progBreath != null).map(c => c.breathMeasured - c.progBreath)),
        breathDeficit: stats(m.filter(c => c.pacerBreath != null && c.progBreath != null).map(c => c.pacerBreath - c.progBreath)),
        endOffset: stats(m.map(c => c.endOffset)),
        periodErr: stats(periodPairs.map(c => c.periodErr)),
        freqErrorPct: sumPacer ? (sumDev / sumPacer - 1) * 100 : null,
        startLagClean: stats(clean.map(c => c.startLag)),
        startLagSteady: steadyFrom ? stats(steady.map(c => c.startLag)) : null,
        startLagMax: m.length ? Math.max(...m.map(c => c.startLag)) : null,
        leadMs: m.length ? stats(m.map(c => c.lead || 0)).mean : 0,
        lagSlope: slope(steady.map(c => c.i), steady.map(c => c.startLag), 3),
        decisionCounts,
        startOkPct: m.length ? 100 * m.filter(c => Math.abs(c.startLag) <= START_TOL_MS).length / m.length : null,
        mirrorQualityPct: full.length ? 100 * good.length / full.length : null,
        reprepareCost: null,
    };

    // Kosten der Neuvorbereitung bei Rhythmuswechsel: Mehrverzug der Zyklen mit 'reprepare'
    const withRe = m.filter(c => c.flags.reprepare).map(c => c.startLag);
    const withoutRe = m.filter(c => !c.flags.reprepare).map(c => c.startLag);
    if (withRe.length && withoutRe.length) {
        summary.reprepareCost = stats(withRe).mean - stats(withoutRe).mean;
        summary.reprepareCount = withRe.length;
    }
    return { cycles, summary };
}

/** Wertet das zuletzt aufgezeichnete echte Training (nicht die Diagnose-Läufe) aus. */
export function analyzeLastTraining(trace, calibration = null) {
    let from = -1;
    for (let i = trace.length - 1; i >= 0; i--) if (trace[i].type === 'follow' && trace[i].source !== 'diag') { from = i; break; }
    const slice = from < 0 ? [] : trace.slice(from);
    if (!slice.some(e => e.type === 'pacer')) return { error: 'Kein Training mit Moonbird aufgezeichnet.' };
    return { analysis: analyzeTrace(slice, { calibration }) };
}

// ─── 3. Befunde ────────────────────────────────────────────────────────────

const F = (severity, title, detail, suggestion = null) => ({ severity, title, detail, suggestion });

/** Befunde aus einer Trace-Auswertung (Spiegeltest oder Live-Training). */
export function traceFindings(a, label) {
    const s = a.summary;
    const out = [];
    const L = label ? `[${label}] ` : '';
    if (!s.pacerCycles) return [F('info', `${L}Keine vollständigen Pacer-Zyklen aufgezeichnet`, 'Für eine Auswertung sind mindestens zwei Einatem-Signale nötig.')];

    const missed = s.pacerCycles - s.matchedCycles;
    if (missed > 0) {
        out.push(F(missed > s.pacerCycles / 4 ? 'bad' : 'warn', `${L}${missed} von ${s.pacerCycles} Atemzügen ohne Moonbird`,
            'Zu diesen Einatem-Signalen wurde kein Start bestätigt.',
            'Ursachen prüfen: Moonbird beim Einatem-Signal noch im vorigen Atemzug (Halt nach Ausatmen zu kurz), abgelehnte Befehle, Verbindungsabbruch.'));
    }

    if (s.startLag) {
        const base = s.startLagSteady || s.startLagClean || s.startLag;   // Lernphase und Rhythmuswechsel zählen separat
        const m = base.mean, sd = base.sd;
        const sev = Math.abs(m) > 250 ? 'bad' : Math.abs(m) > START_TOL_MS ? 'warn' : 'ok';
        out.push(F(sev, `${L}Start: Moonbird beginnt Ø ${sgn(m)} ms nach dem Pacer-Einatmen (σ ${r0(sd)} ms)`,
            (s.leadMs > 0
                ? `Startbefehl wird ${r0(s.leadMs)} ms VOR dem Einatem-Signal gesendet (Vorhalt), Gerätestart ${r0(s.startBias)} ms nach dem Senden.`
                : `Davon ${r0(s.cmdLag?.mean)} ms Wartezeit in der App bis zum Senden, ${r0(s.ack?.mean)} ms Schreib-Bestätigung, Rest Gerätestart.`)
            + `${s.calibrated ? ' (kalibriert über Geräteuhr)' : ' (geschätzt, ohne Kalibrierung)'} Schätzunsicherheit ca. ±${r0(s.oneWayMs)} ms.`,
            sev === 'ok' ? null : (Math.abs(m) <= 400
                ? `Vorhalt: den Start-Befehl ca. ${r0(m)} ms VOR dem Einatem-Signal senden (Zeitpunkt aus dem Pacer-Zyklus vorausberechnen).`
                : 'Zuerst die Ursache des großen Verzugs beheben (Datenstrom-Befund, „Moonbird noch im vorigen Atemzug"); ein Vorhalt hilft erst bei kleinem, stabilem Versatz.')));
        if (s.startLagMax > 350 && s.startLagSteady) {
            out.push(F('info', `${L}Einschwingphase: Startverzug bis +${r0(s.startLagMax)} ms in den ersten Atemzügen, danach Ø ${sgn(s.startLagSteady.mean)} ms`,
                'Der Ausgleich lernt in den ersten 2–3 Atemzügen die reale Lücke zwischen zwei Atemzügen; der gelernte Wert wird gespeichert und beim nächsten Training gleich verwendet.'));
        }
        if (sd > 80) {
            out.push(F('warn', `${L}Startzeitpunkt schwankt (σ ${r0(sd)} ms, max ${sgn(base.max)} ms)`,
                'Ein fester Vorhalt kann die Streuung nicht beseitigen — sie stammt aus BLE-Übertragung/Verbindungsintervall.',
                'Latenztest (mit/ohne EKG-Stream) auswerten; ggf. EKG-Stream im Moonbird-Betrieb entlasten, Handy-Energiesparen aus.'));
        }
    }

    if (s.lagSlope != null && Math.abs(s.lagSlope) > 15) {
        out.push(F('bad', `${L}Versatz wächst: ${sgn(s.lagSlope)} ms pro Atemzug`,
            'Das Moonbird läuft dem Pacer zunehmend hinterher bzw. voraus — der Rhythmus stimmt nicht.',
            'Meist ist der Halt nach Ausatmen kürzer als die Befehlslaufzeit oder das Ende-Ereignis kommt spät (siehe Entscheidungs-Zähler).'));
    }

    if (s.freqErrorPct != null) {
        const ae = Math.abs(s.freqErrorPct);
        const sev = ae > 1 ? 'bad' : ae > 0.3 ? 'warn' : 'ok';
        out.push(F(sev, `${L}Zyklus-Frequenz: Moonbird ${s.freqErrorPct > 0 ? '+' : ''}${s.freqErrorPct.toFixed(2)} % gegenüber Pacer`,
            `Zyklus-Abweichung Ø ${sgn(s.periodErr?.mean)} ms (σ ${r0(s.periodErr?.sd)} ms).`,
            sev === 'ok' ? null : 'Gerätedauer je Atemzug und Wartezeit zwischen den Atemzügen prüfen (Atemzug-Test, Halt-Ausgleich).'));
    }

    if (s.breathError && Math.abs(s.breathError.mean) > 80) {
        out.push(F('warn', `${L}Atemzug am Gerät ${sgn(s.breathError.mean)} ms gegenüber Befehl`,
            `σ ${r0(s.breathError.sd)} ms. Das Gerät hält die befohlene Länge nicht exakt ein (oder Ende-Latenz falsch geschätzt).`,
            'Kalibrierung (Uhren-Test) durchführen; wirkt der Fehler konstant, kann er in der Dauer-Berechnung ausgeglichen werden.'));
    }
    if (s.breathDeficit && s.breathDeficit.mean > 20) {
        out.push(F('info', `${L}Ausatmung am Moonbird um Ø ${r0(s.breathDeficit.mean)} ms gekürzt`,
            `Zwischen zwei Atemzügen vergehen ${s.gapEstMs != null ? r0(s.gapEstMs) + ' ms (gemessen)' : 'ca. ' + CMD_OVERHEAD_MS + ' ms (Annahme)'} für Ende-Ereignis, Programm setzen und Start. Ohne Halt nach Ausatmen wird die Ausatmung am Moonbird um diese Zeit gekürzt, damit der Rhythmus nicht driftet.`,
            'Bei Rhythmen ohne Halt lässt sich das nur durch früheres Vorbereiten (Programm während der letzten Ausatmung setzen) vermeiden — vom Gerät aktuell nicht erlaubt (Programm nur im Leerlauf).'));
    }
    if (s.endOffset && Math.abs(s.endOffset.mean) > END_TOL_MS) {
        // Erwartet: Das Moonbird endet um die bewusste Kürzung (Totzeit) früher als der Pacer
        const expected = s.breathDeficit && s.breathDeficit.mean > 100 ? -s.breathDeficit.mean : 0;
        const unexplained = s.endOffset.mean - expected;
        if (Math.abs(unexplained) <= END_TOL_MS) {
            out.push(F('info', `${L}Ausatmung endet am Moonbird ${r0(Math.abs(s.endOffset.mean))} ms vor dem Pacer-Ende (gewollt)`,
                `Entspricht der Kürzung um die Totzeit zwischen zwei Atemzügen (${r0(s.breathDeficit.mean)} ms); danach folgt am Moonbird eine kurze Pause bis zum nächsten Einatmen.`));
        } else {
            out.push(F('warn', `${L}Ende der Ausatmung ${sgn(s.endOffset.mean)} ms gegenüber Pacer`,
                `σ ${r0(s.endOffset.sd)} ms${expected ? `; davon ${r0(-expected)} ms durch die gewollte Kürzung erklärt` : ''}.`, 'Startverzug und Atemzug-Länge zusammen prüfen; Ende-Latenz kalibrieren.'));
        }
    }

    const d = s.decisionCounts;
    if (d['wait-running']) {
        out.push(F('warn', `${L}Moonbird war ${d['wait-running']}× beim Einatem-Signal noch im vorigen Atemzug`,
            'Der neue Start musste auf das Ende-Ereignis warten (Verzug pro Fall = Restlaufzeit + Befehlslaufzeit).',
            'Halt nach Ausatmen ≥ ca. 300–400 ms lassen oder den Atemzug am Gerät etwas kürzen.'));
    }
    if (d['wait-preparing'] || d['prepare-missing']) {
        out.push(F('warn', `${L}Programm war beim Einatem-Signal noch nicht gesetzt (${(d['wait-preparing'] || 0) + (d['prepare-missing'] || 0)}×)`,
            'Nach dem Ende-Ereignis dauert das Setzen des Programms; bei Halt ≈ 0 ist es nicht rechtzeitig fertig.', 'Wie oben: Halt nach Ausatmen vergrößern oder Ausatmung am Gerät kürzen.'));
    }
    if (s.rhythmChanges > 0 && s.leadMs > 0) {
        out.push(F('info', `${L}${s.rhythmChanges} Rhythmuswechsel: das Moonbird übernimmt sie einen Atemzug später`,
            'Mit Vorhalt wird der nächste Atemzug schon vor dem Einatem-Signal gestartet, also noch mit dem alten Rhythmus. Dafür startet er exakt im Takt; nach einer Verkürzung des Rhythmus entsteht einmalig ein Rückstand von etwa der Differenz.',
            'Bei den seltenen, kleinen Schritten des Adaptiven Trainings (±0,3 s) ist das unkritisch.'));
    }
    if (s.reprepareCost != null) {
        out.push(F(s.reprepareCost > 100 ? 'warn' : 'info', `${L}Rhythmuswechsel kostet Ø ${sgn(s.reprepareCost)} ms Startverzug (${s.reprepareCount}×)`,
            'Bei Wechsel direkt nach dem Einatem-Signal muss das Programm neu gesendet werden, bevor der Atemzug startet.',
            'Alternative: Wechsel erst zum übernächsten Atemzug wirksam machen (Moonbird bleibt dann exakt im Takt, Pacer wechselt eine Runde früher).'));
    }
    ['start-rejected', 'fail', 'disconnect'].forEach(k => {
        if (d[k]) out.push(F('bad', `${L}Ereignis „${k}" ${d[k]}×`, 'Befehl abgelehnt bzw. Verbindung/Steuerung abgebrochen.', 'Fehlerdetails im Rohprotokoll (JSON-Export) ansehen.'));
    });
    if (!out.some(f => f.severity !== 'ok' && f.severity !== 'info')) {
        out.push(F('ok', `${L}Spiegelung im Toleranzbereich`, `${r0(s.mirrorQualityPct)} % der Atemzüge starten ±${START_TOL_MS} ms und enden ±${END_TOL_MS} ms zum Pacer.`));
    }
    return out;
}

/** Befunde aus allen aktiven Messungen. */
export function buildFindings(results) {
    const out = [];
    const env = results.env;
    if (env) {
        if (env.rafStalled) out.push(F('bad', `Keine Animations-Frames geliefert (${env.framesDelivered} in 3 s)`,
            'Der Pacer wird über requestAnimationFrame getaktet — steht die Bildausgabe still (App verdeckt, Bildschirm aus, Hintergrund), läuft weder die Animation noch das Einatem-Signal für das Moonbird.',
            'App im Vordergrund lassen, Bildschirm nicht sperren (Wake-Lock), keine Overlays/Split-Screen.'));
        if (env.frames && env.frames.p95 > 34) out.push(F('warn', `Pacer-Bildrate unruhig (p95 Frame ${r0(env.frames.p95)} ms, max ${r0(env.frames.max)} ms)`,
            'Der Pacer-Takt wird bildgebunden erkannt; Ruckler verschieben das Einatem-Signal.', 'Andere Apps/Tabs schließen, Energiesparmodus aus, Bildschirm nicht dimmen.'));
        if (env.timerJitter && env.timerJitter.p95 > 40) out.push(F('warn', `Timer-Jitter hoch (p95 ${r0(env.timerJitter.p95)} ms)`,
            'setTimeout kommt deutlich verspätet — Start-Befehle verzögern sich entsprechend.', 'Hintergrund-Drosselung des Browsers vermeiden (Tab im Vordergrund, Display an).'));
        if (env.longTasks && env.longTasks.count) out.push(F(env.longTasks.maxMs > 200 ? 'warn' : 'info', `${env.longTasks.count} Hauptthread-Blockaden (max ${r0(env.longTasks.maxMs)} ms)`,
            'Während einer Blockade werden Bluetooth-Ereignisse und Pacer-Signale verspätet verarbeitet.', 'Rechenlast im Training senken (Diagramme/HRV-Berechnung) oder auf stärkerem Gerät testen.'));
        if (env.hiddenEvents) out.push(F('bad', `App war ${env.hiddenEvents}× im Hintergrund`, 'Im Hintergrund werden Timer und Bluetooth-Ereignisse gedrosselt.', 'Während des Trainings in der App bleiben, Bildschirmsperre vermeiden.'));
        if (env.ecgStreaming) out.push(F('info', 'EKG-Stream (H10) war während der Diagnose aktiv', 'Das entspricht dem Trainingsbetrieb; Latenz-Vergleich mit/ohne EKG zeigt den Einfluss.'));
    }

    const lat = results.latency;
    if (lat && lat.ack) {
        const med = lat.ack.p50;
        out.push(F(med > 150 ? 'warn' : med > 90 ? 'info' : 'ok', `Schreib-Bestätigung Moonbird: Median ${r0(med)} ms, p95 ${r0(lat.ack.p95)} ms, max ${r0(lat.ack.max)} ms`,
            `Antwort-Notification: Median ${r0(lat.reply?.p50)} ms. ${lat.timeouts ? lat.timeouts + ' Timeouts.' : ''} Das ist die Untergrenze des Startverzugs.`,
            med > 150 ? 'Hohe BLE-Latenz: Abstand zum Moonbird verringern, andere Bluetooth-Geräte trennen, Verbindungsintervall des Handys ist nicht einstellbar.' : null));
        if (lat.ack.p95 - lat.ack.p50 > 120) out.push(F('warn', `Latenz schwankt stark (p95 − Median = ${r0(lat.ack.p95 - lat.ack.p50)} ms)`, 'Hoher Jitter erzeugt unregelmäßige Starts.', 'Störquellen (WLAN 2,4 GHz, weitere BLE-Geräte) reduzieren.'));
        if (lat.timeouts) out.push(F('bad', `${lat.timeouts} Befehle ohne Antwort`, 'Antwort-Notifications gehen verloren.', 'Verbindung prüfen, Abstand verringern.'));
    }

    const le = results.latencyEcg;
    if (le && le.without?.ack && le.with?.ack) {
        const d50 = le.with.ack.p50 - le.without.ack.p50;
        const d95 = le.with.ack.p95 - le.without.ack.p95;
        out.push(F(d50 > 40 || d95 > 100 ? 'warn' : 'ok', `EKG-Stream: Latenz ${sgn(d50)} ms (Median), ${sgn(d95)} ms (p95)`,
            `Ohne EKG Median ${r0(le.without.ack.p50)} ms, mit EKG ${r0(le.with.ack.p50)} ms — der 130-Hz-EKG-Stream teilt sich das Funkfenster mit dem Moonbird.`,
            d50 > 40 || d95 > 100 ? 'EKG-Stream nur nutzen, wenn Atemtiefe-Hinweise gewünscht sind; sonst für Moonbird-Training deaktivieren.' : null));
    } else if (le?.skipped) {
        out.push(F('info', 'EKG-Einfluss nicht gemessen', le.skipped));
    }

    const st = results.stream;
    if (st && !st.error && st.idle && st.running) {
        const idle = st.idle.p50, run = st.running.p50;
        const bad = st.timeouts > 0 || run > Math.max(300, 3 * idle);
        out.push(F(bad ? 'bad' : 'ok',
            `Sensor-Datenstrom: ${st.streamRate != null ? r0(st.streamRate) + ' Notifications/s' : 'kein Datenstrom erkannt'}; Antwortzeit während der Session Median ${r0(run)} ms (Leerlauf ${r0(idle)} ms), p95 ${r0(st.running.p95)} ms`,
            `${st.timeouts} von ${st.polls} Abfragen ohne Antwort. Ende-Ereignis kam ${sgn(st.f1DelayMs)} ms gegenüber der Erwartung.`,
            bad ? 'Der Datenstrom verstopft die Funkstrecke. Gegenmaßnahme (Benachrichtigungen während der Session aus) ist im Training aktiv — Spiegeltest vs. „ohne Stream-Trick" zeigt die Wirkung.' : null));
    } else if (st?.error) {
        out.push(F('warn', 'Datenstrom-Test fehlgeschlagen', st.error));
    }

    const ck = results.clock;
    if (ck && !ck.error && ck.reliable === false) {
        out.push(F('warn', `Uhren-Messung nicht belastbar (${ck.samples} Messpunkte, Streuung σ ${r0(ck.residualSd)} ms)`,
            `Die Statusantworten waren zu ungleichmäßig, um die Geräteuhr und den Startverzug sauber zu bestimmen; die Schätzungen der Spiegeltests bleiben ungenau (Startverzug/Ende nur nach Schreib-Bestätigung geschätzt).`,
            'Diagnose wiederholen; der Datenstrom-Befund erklärt meist die Ursache.'));
    } else if (ck && !ck.error) {
        const ae = Math.abs(ck.ppm);
        const significant = ae > 2 * ck.ppmSe;
        const sev = !significant ? 'ok' : ae > 1000 ? 'bad' : ae > 300 ? 'warn' : 'ok';
        out.push(F(sev, `Geräteuhr: ${sgn(ck.ppm)} ppm ± ${r0(ck.ppmSe)} gegenüber Handy-Uhr (${ck.samples} Messpunkte über ${r0(ck.spanMs / 1000)} s)`,
            significant
                ? `Bei 10 s Zyklus entspricht das ${(ck.ppm * 1e-6 * 10000).toFixed(1)} ms Fehler pro Atemzug. Streuung der Messpunkte σ ${r0(ck.residualSd)} ms.`
                : `Abweichung nicht signifikant (kleiner als die doppelte Messunsicherheit) — die Geräteuhr ist für diesen Zweck genau genug. Streuung σ ${r0(ck.residualSd)} ms.`,
            sev !== 'ok' ? 'Uhrenfehler pro Atemzug in der Dauer-Berechnung ausgleichen.' : null));
        out.push(F('info', `Gerätestart: ${sgn(ck.startBias)} ms nach Sende-Zeitpunkt des Start-Befehls`,
            `Bestätigung kommt ${sgn(ck.startBiasReply)} ms relativ zum Gerätestart. Ende-Ereignis erreicht die App ${r0(ck.endLatency)} ms nach dem Geräte-Ende.`,
            `Empfohlener Vorhalt für den Start: ca. ${r0(ck.startBias)} ms.`));
    } else if (ck?.error) {
        out.push(F('warn', 'Uhren-Test fehlgeschlagen', ck.error));
    }

    const ac = results.accuracy;
    if (ac && ac.items?.length && ac.error?.mean != null) {
        const bias = ac.error.mean, sd = ac.error.sd;
        out.push(F(Math.abs(bias) > 100 ? 'warn' : 'ok', `Atemzug-Genauigkeit: Ø ${sgn(bias)} ms gegenüber Programm (σ ${r0(sd)} ms, ${ac.items.length} Atemzüge)`,
            ac.items.map(i => `${r0(i.planned)} ms → ${sgn(i.error)} ms`).join(' · '),
            Math.abs(bias) > 100 ? 'Konstanten Fehler in der Dauer-Berechnung (END_MARGIN) ausgleichen.' : null));
        const doubles = ac.items.filter(i => i.measured > i.planned * 1.6);
        if (doubles.length) out.push(F('bad', `${doubles.length} Atemzüge dauerten fast doppelt so lang wie befohlen`,
            'Die Session-Dauer lag nicht vor dem Ende der ersten Ausatmung — das Gerät hängt einen zweiten Atemzug an.', 'END_MARGIN vergrößern bzw. Dauer früher legen.'));
    }

    const gA = results.mirrorFixed?.analysis?.summary, gB = results.mirrorAlwaysOn?.analysis?.summary;
    if (gA && gB) {
        const f = (x) => x == null ? '–' : `${x > 0 ? '+' : ''}${x.toFixed(2)} %`;
        const better = (gA.matchedCycles >= gB.matchedCycles) && Math.abs(gA.freqErrorPct ?? 99) <= Math.abs(gB.freqErrorPct ?? 0) + 0.2;
        out.push(F(better ? 'ok' : 'info',
            `Stream-Trick im Vergleich: Frequenz ${f(gA.freqErrorPct)} statt ${f(gB.freqErrorPct)}, Startverzug Ø ${r0((gA.startLagClean || gA.startLag)?.mean)} statt ${r0((gB.startLagClean || gB.startLag)?.mean)} ms, ${gA.matchedCycles}/${gA.pacerCycles} statt ${gB.matchedCycles}/${gB.pacerCycles} Atemzüge zugeordnet`,
            'Mit Stream-Trick (Standard) sind die Benachrichtigungen während der Session aus, ohne bleiben sie dauernd an.'));
    }
    ['mirrorFixed', 'mirrorChange', 'mirrorAlwaysOn'].forEach(k => {
        const r = results[k];
        if (r && r.analysis) out.push(...traceFindings(r.analysis, r.label));
        else if (r?.error) out.push(F('bad', `${r.label || k} fehlgeschlagen`, r.error));
    });
    if (results.live?.analysis) out.push(...traceFindings(results.live.analysis, 'Letztes Training'));

    const order = { bad: 0, warn: 1, info: 2, ok: 3 };
    return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ─── 2. Aktive Messungen ───────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class MoonbirdDiagnostics {
    /**
     * @param {object} deps
     * @param {MoonbirdController} deps.moonbird
     * @param {object} [deps.ble]           PolarBluetooth (für EKG-Vergleich)
     * @param {(rhythm:object, onPhase:(phase:string)=>void)=>object} deps.createPacer  liefert Pacer mit start/stop/destroy, .rhythm, .startTime
     * @param {object} [deps.rhythm]        Test-Rhythmus (z. B. Resonanz-Rhythmus des Nutzers)
     * @param {(p:{text:string, step:number, total:number})=>void} [deps.onProgress]
     */
    constructor({ moonbird, ble = null, createPacer, rhythm = null, onProgress = null }) {
        this.mb = moonbird;
        this.ble = ble;
        this.createPacer = createPacer;
        this.onProgress = onProgress;
        this.baseRhythm = MoonbirdDiagnostics.usableRhythm(rhythm);
        this.results = {};
        this.calibration = null;
        this._aborted = false;
        this.longTasks = [];
        this.hiddenEvents = 0;
        this._observers = [];
        this._startObservers();
    }

    static usableRhythm(r) {
        const fallback = { inhale: 3000, holdIn: 1000, exhale: 5000, holdOut: 1000 };
        if (!r || !(r.inhale > 0) || !(r.exhale > 0)) return fallback;
        const rh = { inhale: r.inhale, holdIn: r.holdIn || 0, exhale: r.exhale, holdOut: r.holdOut || 0 };
        return breathOf(rh) - END_MARGIN_MS >= MIN_SESSION_MS ? rh : fallback;
    }

    _startObservers() {
        try {
            if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
                const po = new PerformanceObserver((list) => {
                    list.getEntries().forEach(e => this.longTasks.push({ t: e.startTime, dur: e.duration }));
                });
                po.observe({ entryTypes: ['longtask'] });
                this._observers.push(po);
            }
        } catch { /* nicht verfügbar */ }
        if (typeof document !== 'undefined') {
            this._vis = () => { if (document.visibilityState === 'hidden') this.hiddenEvents++; };
            document.addEventListener('visibilitychange', this._vis);
        }
    }

    dispose() {
        this._observers.forEach(o => o.disconnect());
        if (typeof document !== 'undefined' && this._vis) document.removeEventListener('visibilitychange', this._vis);
    }

    abort() { this._aborted = true; this._abortReject?.(new Error('Abgebrochen')); }
    _check() { if (this._aborted) throw new Error('Abgebrochen'); }
    async _sleep(ms) { await sleep(ms); this._check(); }
    _progress(text, step = 0, total = 0) { this.onProgress?.({ text, step, total }); }

    _lastCmd(op) { for (let i = this.mb.trace.length - 1; i >= 0; i--) { const e = this.mb.trace[i]; if (e.type === 'cmd' && e.op === op) return e; } return null; }

    // ── Umgebung ──
    async runEnvironment() {
        this._progress('Umgebung prüfen …');
        const env = {
            time: new Date().toISOString(),
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'node',
            platform: typeof navigator !== 'undefined' ? navigator.platform : null,
            cores: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : null,
            memoryGb: typeof navigator !== 'undefined' ? navigator.deviceMemory : null,
            visibility: typeof document !== 'undefined' ? document.visibilityState : null,
            moonbirdConnected: this.mb.isConnected,
            polarConnected: !!this.ble?.isConnected,
            ecgStreaming: !!this.ble?.ecgStreaming,
            wakeLockApi: typeof navigator !== 'undefined' && 'wakeLock' in navigator,
        };
        try {
            if (typeof navigator !== 'undefined' && navigator.getBattery) {
                const b = await navigator.getBattery();
                env.battery = { level: Math.round(b.level * 100), charging: b.charging };
            }
        } catch { /* ignorieren */ }

        const jitter = [];
        for (let i = 0; i < 25; i++) {
            const t = performance.now();
            await sleep(20);
            jitter.push(performance.now() - t - 20);
        }
        env.timerJitter = stats(jitter);

        if (typeof requestAnimationFrame !== 'undefined') {
            const frames = [];
            await new Promise((resolve) => {
                let last = performance.now(); const t0 = last; let done = false;
                const finish = () => { if (!done) { done = true; resolve(); } };
                const tick = (now) => { frames.push(now - last); last = now; if (now - t0 < 3000) requestAnimationFrame(tick); else finish(); };
                requestAnimationFrame(tick);
                setTimeout(finish, 4500);   // rAF steht still, wenn das Fenster verdeckt/im Hintergrund ist
            });
            env.framesDelivered = frames.length;
            env.rafStalled = frames.length < 10;   // bei 60 Hz wären es ~180 Frames in 3 s
            env.frames = frames.length > 2 ? stats(frames.slice(1)) : null;
        }
        this._check();
        this.results.env = env;
        return env;
    }

    _finalizeEnv() {
        const env = this.results.env;
        if (!env) return;
        env.hiddenEvents = this.hiddenEvents;
        env.longTasks = this.longTasks.length
            ? { count: this.longTasks.length, maxMs: Math.max(...this.longTasks.map(l => l.dur)), totalMs: this.longTasks.reduce((s, l) => s + l.dur, 0) }
            : { count: 0, maxMs: 0, totalMs: 0 };
    }

    // ── Latenz ──
    async runLatency(n = 30, key = 'latency', label = 'Latenz') {
        const t0 = performance.now();
        const results = { label, n };
        for (let i = 0; i < n; i++) {
            this._progress(`${label}: Messung ${i + 1}/${n}`, i, n);
            try { await this.mb.request([0x04], 2500); } catch { results.timeouts = (results.timeouts || 0) + 1; }
            await this._sleep(120);
        }
        const cmds = this.mb.trace.filter(e => e.type === 'cmd' && e.op === 0x04 && e.t >= t0);
        results.ack = stats(cmds.filter(c => c.tWritten != null).map(c => c.tWritten - c.tSend));
        results.reply = stats(cmds.filter(c => c.tReply != null).map(c => c.tReply - c.tSend));
        results.timeouts = results.timeouts || 0;
        if (key) this.results[key] = results;
        return results;
    }

    async runLatencyEcg(n = 20) {
        if (!this.ble?.isConnected) {
            return (this.results.latencyEcg = { skipped: 'H10 ist nicht verbunden — Vergleich mit/ohne EKG-Stream nicht möglich.' });
        }
        const was = !!this.ble.ecgStreaming;
        try {
            if (was) await this.ble.disableEcgStream();
            await this._sleep(800);
            const without = await this.runLatency(n, null, 'Latenz ohne EKG');
            const ok = await this.ble.enableEcgStream();
            if (!ok) return (this.results.latencyEcg = { skipped: 'EKG-Stream ließ sich nicht aktivieren.', without });
            await this._sleep(1500);
            const withEcg = await this.runLatency(n, null, 'Latenz mit EKG');
            return (this.results.latencyEcg = { without, with: withEcg });
        } finally {
            try {
                if (was && !this.ble.ecgStreaming) await this.ble.enableEcgStream();
                if (!was && this.ble.ecgStreaming) await this.ble.disableEcgStream();
            } catch { /* Zustand best effort wiederherstellen */ }
        }
    }

    // ── Geräteuhr + Startverzug ──
    // Gepulste Messung: Benachrichtigungen sind während der Session aus (sonst verstopft der Sensor-
    // Datenstrom die Strecke und verfälscht die Zeiten). Nur für jeweils ~300 ms einschalten, Status
    // abfragen, wieder ausschalten. ~40 s Messdauer, damit der Uhrenfehler auflösbar ist.
    async runClock(durationMs = 38000) {
        const rh = { holdOut: 1000, inhale: 3000, holdIn: 1000, exhale: 5000 };
        const e1 = rh.inhale + rh.holdIn + rh.exhale;
        const cycle = e1 + rh.holdOut;
        let plannedEnd = e1;                       // Ende der ersten Ausatmung nach Ablauf der Dauer
        while (plannedEnd < durationMs) plannedEnd += cycle;
        try {
            this._progress('Uhren-Test: Gerät vorbereiten …');
            await this.mb.ensureIdle();
            const prog = await this.mb.request(MoonbirdController.programBytes(rh.holdOut, rh.inhale, rh.holdIn, rh.exhale, durationMs));
            if (!(prog[1] === 1 && prog[2] === 0)) throw new Error('Programm abgelehnt');
            const rep = await this.mb.request(MoonbirdController.startCommand);
            if (!(rep[1] === 1 && rep[2] === 0)) throw new Error('Start abgelehnt');
            const tSend = this._lastCmd(0x07).tSend, tReply = rep.tRecv;
            const startMid = (tSend + tReply) / 2;
            const predEnd = startMid + plannedEnd;
            await this.mb.setNotifications(false);

            const samples = [];
            const rtts = [];
            let pulses = 0, failed = 0;
            while (performance.now() < predEnd - 3500) {
                this._check();
                this._progress(`Uhren-Test: ${samples.length} Messpunkte (ca. ${Math.round(plannedEnd / 1000)} s)`, samples.length, 16);
                pulses++;
                try {
                    await this.mb.setNotifications(true);
                    const r = await this.mb.request([0x04], 1500);
                    const c = this._lastCmd(0x04);
                    const st = MoonbirdController.parseStatus(r);
                    const rtt = r.tRecv - c.tSend;
                    rtts.push(rtt);
                    if (st.running && st.counterMs != null && rtt < 500) samples.push({ tMid: (c.tSend + r.tRecv) / 2, counter: st.counterMs });
                } catch { failed++; }
                try { await this.mb.setNotifications(false); } catch { /* egal */ }
                await this._sleep(1700);
            }
            const endRes = await this.mb.waitEndGated(startMid, plannedEnd, 20000);
            if (!endRes.ended) throw new Error('Session-Ende nicht gemeldet');
            const tEnd = endRes.tEnd;
            if (samples.length < 8) throw new Error(`zu wenige brauchbare Messpunkte (${samples.length} von ${pulses}, ${failed} ohne Antwort)`);

            // counter = a * tMid + c  → Gerätestart (Handy-Zeit) = −c / a
            const n = samples.length;
            const mx = samples.reduce((s, x) => s + x.tMid, 0) / n;
            const my = samples.reduce((s, x) => s + x.counter, 0) / n;
            let num = 0, den = 0;
            samples.forEach(x => { num += (x.tMid - mx) * (x.counter - my); den += (x.tMid - mx) ** 2; });
            const a = num / den;
            const c0 = my - a * mx;
            const devStart = -c0 / a;
            const resSd = stats(samples.map(x => x.counter - (a * x.tMid + c0))).sd;
            const span = samples[n - 1].tMid - samples[0].tMid;
            const res = {
                samples: n, pulses, failed,
                spanMs: span,
                ratio: a,
                ppm: (a - 1) * 1e6,
                ppmSe: resSd / (span * Math.sqrt(n / 12)) * 1e6,   // Standardfehler der Steigung
                residualSd: resSd,
                rtt: stats(rtts),
                devStart,
                startBias: devStart - tSend,          // Gerätestart relativ zum Sende-Zeitpunkt
                startBiasReply: devStart - tReply,    // relativ zur Antwort (negativ: Gerät startete vor der Antwort)
                endLatency: tEnd - (devStart + plannedEnd / a),   // Ende-Ereignis kommt so spät nach dem Geräte-Ende
            };
            res.reliable = n >= 8 && resSd < 60;
            this.calibration = res.reliable ? { startBias: res.startBias, endLatency: res.endLatency } : null;
            if (res.reliable && res.startBias > 40 && res.startBias < 450) this.mb.leadOverrideMs = res.startBias;
            return (this.results.clock = res);
        } catch (err) {
            return (this.results.clock = { error: err.message });
        }
    }

    // ── Datenstrom-Last: verlangsamt der Sensor-Datenstrom die Antworten während einer Session? ──
    async runStream() {
        const mb = this.mb;
        try {
            this._progress('Datenstrom-Test: Leerlauf messen …');
            await mb.ensureIdle();
            await mb.setNotifications(true);
            const idle = [];
            for (let i = 0; i < 6; i++) {
                try { await mb.request([0x04], 2500); const c = this._lastCmd(0x04); idle.push(c.tReply - c.tSend); } catch { /* zählt nicht */ }
                await this._sleep(150);
            }
            const breath = 9000;
            const prog = await mb.request(MoonbirdController.programBytes(1000, 3000, 1000, 5000, breath - END_MARGIN_MS));
            if (!(prog[1] === 1 && prog[2] === 0)) throw new Error('Programm abgelehnt');
            const rep = await mb.request(MoonbirdController.startCommand);
            if (!(rep[1] === 1 && rep[2] === 0)) throw new Error('Start abgelehnt');
            const startMid = (this._lastCmd(0x07).tSend + rep.tRecv) / 2;
            mb.resetStreamStats();
            const endPromise = mb.waitSessionEnd(25000);      // vor den Abfragen registrieren, sonst wird das Ende verpasst

            const runRtts = [];
            let timeouts = 0;
            while (performance.now() < startMid + breath - 1500) {
                this._check();
                this._progress(`Datenstrom-Test: Antwortzeit während der Session (${runRtts.length + timeouts} Abfragen)`);
                try { await mb.request([0x04], 2500); const c = this._lastCmd(0x04); runRtts.push(c.tReply - c.tSend); } catch { timeouts++; }
                await this._sleep(250);
            }
            const stream = mb.streamStats;
            const ended = await endPromise;
            const tEnd = this._lastEndTime();
            const res = {
                idle: stats(idle),
                running: stats(runRtts),
                timeouts, polls: runRtts.length + timeouts,
                streamRate: stream.ratePerS, streamCount: stream.count,
                f1DelayMs: ended && tEnd ? tEnd - (startMid + breath) : null,
            };
            return (this.results.stream = res);
        } catch (err) {
            return (this.results.stream = { error: err.message });
        }
    }

    _lastEndTime() { for (let i = this.mb.trace.length - 1; i >= 0; i--) if (this.mb.trace[i].type === 'end') return this.mb.trace[i].t; return null; }

    // ── Atemzug-Genauigkeit (Ein-Atemzug-Sessions ohne Pacer) ──
    async runAccuracy(rhythms = null) {
        const list = rhythms || [
            { holdOut: 1000, inhale: 2500, holdIn: 0, exhale: 6000 },      // e1 8500
            { holdOut: 1000, inhale: 3000, holdIn: 1000, exhale: 6000 },   // e1 10000
            { holdOut: 0, inhale: 4500, holdIn: 1500, exhale: 6000 },      // e1 12000
        ];
        const items = [];
        try {
            for (let i = 0; i < list.length; i++) {
                const r = list[i];
                const planned = r.inhale + r.holdIn + r.exhale;
                this._progress(`Atemzug-Genauigkeit: ${i + 1}/${list.length} (${(planned / 1000).toFixed(1)} s)`, i, list.length);
                await this.mb.ensureIdle();
                const prog = await this.mb.request(MoonbirdController.programBytes(r.holdOut, r.inhale, r.holdIn, r.exhale, planned - END_MARGIN_MS));
                if (!(prog[1] === 1 && prog[2] === 0)) throw new Error('Programm abgelehnt');
                const rep = await this.mb.request(MoonbirdController.startCommand);
                if (!(rep[1] === 1 && rep[2] === 0)) throw new Error('Start abgelehnt');
                const tSend = this._lastCmd(0x07).tSend;
                const g = await this.mb.waitEndGated((tSend + rep.tRecv) / 2, planned, planned * 2 + 8000);
                if (!g.ended) throw new Error('Session-Ende nicht gemeldet');
                const tEnd = g.tEnd;
                const oneWay = 50;
                const startBias = this.calibration?.startBias ?? oneWay;
                const endLat = this.calibration?.endLatency ?? oneWay;
                const measured = (tEnd - endLat) - (tSend + startBias);
                items.push({ planned, measured, error: measured - planned });
                await this._sleep(400);
            }
        } catch (err) {
            this.results.accuracy = { error: err.message, items };
            return this.results.accuracy;
        }
        return (this.results.accuracy = { items, error: stats(items.map(i => i.error)), calibrated: !!this.calibration });
    }

    // ── Spiegeltest: echter Pacer + Moonbird, wie im Training ──
    async runMirror({ key, label, rhythms, cycles = 6 }) {
        const mb = this.mb;
        const t0 = performance.now();
        this._progress(`${label}: Moonbird vorbereiten …`);
        const ready = await mb.follow(rhythms[0], 'diag');
        if (!ready) return (this.results[key] = { label, error: 'Moonbird nicht bereit (follow fehlgeschlagen)' });

        let idx = -1;
        let pacer = null;
        let stopped = false;
        let releasePromise = null;
        const finished = new Promise((resolve) => {
            pacer = this.createPacer(rhythms[0], (phase) => {
                if (stopped) return;
                if (phase === 'inhale') {
                    idx++;
                    if (idx >= cycles) {
                        stopped = true;
                        releasePromise = mb.release();          // letzten Atemzug noch beenden lassen
                        mb.onPacerPhase(phase);                  // nur protokollieren (Kopplung ist bereits beendet)
                        pacer.stop();
                        resolve();
                        return;
                    }
                    if (idx === cycles - 1) mb.stopAfterCurrent();   // dieser Atemzug ist der letzte — kein Vorhalt-Start für einen weiteren
                    const next = rhythms[idx % rhythms.length];
                    const cur = pacer.rhythm;
                    if (cur.inhale !== next.inhale || cur.holdIn !== next.holdIn || cur.exhale !== next.exhale || cur.holdOut !== next.holdOut) {
                        pacer.rhythm = { ...next };
                        pacer.startTime = performance.now();
                    }
                    mb.setRhythm(next);
                    this._progress(`${label}: Atemzug ${idx + 1}/${cycles}`, idx, cycles);
                }
                mb.onPacerPhase(phase);
            });
        });
        pacer.start();

        const maxMs = cycles * Math.max(...rhythms.map(cycleOf)) + 30000;
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Zeitüberschreitung')), maxMs));
        const aborted = new Promise((_, rej) => { this._abortReject = rej; });
        aborted.catch(() => {}); timeout.catch(() => {});
        try {
            await Promise.race([finished, timeout, aborted]);
            if (releasePromise) await releasePromise;
            await this._sleep(500);
        } catch (err) {
            stopped = true;
            await mb.release().catch(() => {});
            pacer.stop(); pacer.destroy?.();
            if (err.message === 'Abgebrochen') throw err;
            return (this.results[key] = { label, error: err.message });
        }
        pacer.destroy?.();
        const analysis = analyzeTrace(mb.trace.filter(e => e.t >= t0), { calibration: this.calibration });
        return (this.results[key] = { label, rhythms, cycles, analysis, calibrated: !!this.calibration });
    }

    mirrorFixed(cycles = 6) {
        return this.runMirror({ key: 'mirrorFixed', label: 'Spiegeltest fester Rhythmus', rhythms: [this.baseRhythm], cycles });
    }

    mirrorChange(cycles = 6) {
        const b = this.baseRhythm;
        const step = (d) => ({ ...b, inhale: b.inhale + d, exhale: b.exhale + d });
        return this.runMirror({ key: 'mirrorChange', label: 'Spiegeltest mit Rhythmuswechsel', rhythms: [b, step(300), step(600), step(300), b, step(-300)], cycles });
    }

    /** Vergleichslauf: Benachrichtigungen bleiben während der Session an (ohne Stream-Trick). */
    async mirrorAlwaysOn(cycles = 4) {
        const prev = this.mb.gateStream;
        this.mb.gateStream = false;
        try {
            return await this.runMirror({ key: 'mirrorAlwaysOn', label: 'Spiegeltest OHNE Stream-Trick (Vergleich)', rhythms: [this.baseRhythm], cycles });
        } finally {
            this.mb.gateStream = prev;
            await this.mb.setNotifications(true).catch(() => {});
        }
    }

    /** Auswertung des letzten realen Trainings (aus dem laufenden Zeitprotokoll). */
    analyzeLive() {
        return (this.results.live = analyzeLastTraining(this.mb.trace, this.calibration));
    }

    async runOne(name) {
        this._aborted = false;
        const map = {
            env: () => this.runEnvironment(),
            latency: () => this.runLatency(30),
            latencyEcg: () => this.runLatencyEcg(20),
            stream: () => this.runStream(),
            clock: () => this.runClock(),
            accuracy: () => this.runAccuracy(),
            mirrorFixed: () => this.mirrorFixed(),
            mirrorChange: () => this.mirrorChange(),
            mirrorAlwaysOn: () => this.mirrorAlwaysOn(),
            live: async () => this.analyzeLive(),
        };
        try { return await map[name](); }
        finally { this._finalizeEnv(); }
    }

    async runAll() {
        this._aborted = false;
        const steps = ['env', 'latency', 'latencyEcg', 'stream', 'clock', 'accuracy', 'mirrorFixed', 'mirrorChange', 'mirrorAlwaysOn'];
        for (const s of steps) {
            this._check();
            try { await this.runOne(s); }
            catch (err) {
                if (err.message === 'Abgebrochen') throw err;
                this.results[s] = { error: err.message };
            }
        }
        return this.buildReport();
    }

    // ── Bericht ──
    buildReport() {
        this._finalizeEnv();
        const findings = buildFindings(this.results);
        return { meta: { created: new Date().toISOString(), baseRhythm: this.baseRhythm, calibration: this.calibration }, results: this.results, findings };
    }
}

// ─── 4. Berichte ───────────────────────────────────────────────────────────

const fmtStats = (s, unit = 'ms') => s ? `Ø ${r0(s.mean)} · σ ${r0(s.sd)} · Median ${r0(s.p50)} · p95 ${r0(s.p95)} · min/max ${r0(s.min)}/${r0(s.max)} ${unit} (n=${s.n})` : 'keine Daten';
const ICON = { bad: '🔴', warn: '🟠', info: '🔵', ok: '🟢' };

export function renderText(report) {
    const L = [];
    L.push(`MOONBIRD-DIAGNOSE  ${report.meta.created}`);
    L.push(`Test-Rhythmus: ${report.meta.baseRhythm.inhale}/${report.meta.baseRhythm.holdIn}/${report.meta.baseRhythm.exhale}/${report.meta.baseRhythm.holdOut} ms`);
    L.push('');
    L.push('BEFUNDE');
    report.findings.forEach(f => {
        L.push(`${ICON[f.severity]} ${f.title}`);
        if (f.detail) L.push(`    ${f.detail}`);
        if (f.suggestion) L.push(`    → ${f.suggestion}`);
    });
    const r = report.results;
    L.push('');
    L.push('KENNWERTE');
    if (r.env) {
        L.push(`Umgebung: ${r.env.userAgent}`);
        L.push(`  Frames ${fmtStats(r.env.frames)} | Timer-Jitter ${fmtStats(r.env.timerJitter)} | Hauptthread-Blockaden ${r.env.longTasks?.count ?? 0} (max ${r0(r.env.longTasks?.maxMs)} ms) | Hintergrund ${r.env.hiddenEvents ?? 0}×`);
    }
    if (r.latency) L.push(`Latenz: Schreib-Bestätigung ${fmtStats(r.latency.ack)}; Antwort ${fmtStats(r.latency.reply)}`);
    if (r.stream && !r.stream.error) L.push(`Datenstrom: ${r0(r.stream.streamRate)}/s, Antwortzeit laufend ${fmtStats(r.stream.running)} (Leerlauf Median ${r0(r.stream.idle?.p50)} ms), Timeouts ${r.stream.timeouts}/${r.stream.polls}, Ende-Ereignis ${sgn(r.stream.f1DelayMs)} ms`);
    if (r.latencyEcg?.without) L.push(`Latenz ohne/mit EKG (Median): ${r0(r.latencyEcg.without.ack?.p50)} / ${r0(r.latencyEcg.with?.ack?.p50)} ms`);
    if (r.clock && !r.clock.error) L.push(`Uhr: ${sgn(r.clock.ppm)} ± ${r0(r.clock.ppmSe)} ppm, Start ${sgn(r.clock.startBias)} ms nach Senden, Ende-Latenz ${r0(r.clock.endLatency)} ms, σ ${r0(r.clock.residualSd)} ms`);
    if (r.accuracy?.items) L.push(`Atemzug-Genauigkeit: ${r.accuracy.items.map(i => `${r0(i.planned)}→${sgn(i.error)}`).join(', ')} ms`);
    ['mirrorFixed', 'mirrorChange', 'mirrorAlwaysOn', 'live'].forEach(k => {
        const a = r[k]?.analysis;
        if (!a) return;
        const s = a.summary;
        L.push(`${r[k].label || 'Letztes Training'}: ${s.matchedCycles}/${s.pacerCycles} Atemzüge, Spiegelgüte ${r0(s.mirrorQualityPct)} %, Startverzug ${fmtStats(s.startLag)}, Frequenz ${s.freqErrorPct == null ? '–' : s.freqErrorPct.toFixed(2)} %, Ende-Versatz ${fmtStats(s.endOffset)}`);
        a.cycles.filter(c => c.matched).forEach(c => L.push(`   #${c.i + 1} Verzug ${sgn(c.startLag)} (App ${r0(c.cmdLag)} + Gerät) · Atemzug ${r0(c.breathMeasured)}/${r0(c.progBreath)} ms · Ende ${sgn(c.endOffset)} · Periode ${sgn(c.periodErr)} ${Object.keys(c.flags).join(',')}`));
    });
    return L.join('\n');
}

function svgBars(values, tol) {
    const v = values.map(x => (Number.isFinite(x) ? x : 0));
    if (!v.length) return '';
    const W = 300, H = 90, pad = 6;
    const max = Math.max(tol * 1.5, ...v.map(Math.abs));
    const zero = H / 2;
    const scale = (H / 2 - pad) / max;
    const bw = Math.min(28, (W - 2 * pad) / v.length - 4);
    const bars = v.map((x, i) => {
        const h = Math.abs(x) * scale;
        const xPos = pad + i * ((W - 2 * pad) / v.length) + 2;
        const y = x >= 0 ? zero - h : zero;
        const col = Math.abs(x) <= tol ? '#00e5a0' : '#ff8800';
        return `<rect x="${xPos.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" fill="${col}" rx="2"/>`
            + `<text x="${(xPos + bw / 2).toFixed(1)}" y="${H - 1}" font-size="8" fill="#7a9bc0" text-anchor="middle">${i + 1}</text>`;
    }).join('');
    const band = `<rect x="0" y="${zero - tol * scale}" width="${W}" height="${2 * tol * scale}" fill="rgba(0,212,255,0.07)"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Startverzug pro Atemzug">${band}<line x1="0" x2="${W}" y1="${zero}" y2="${zero}" stroke="#2a4468"/>${bars}</svg>`;
}

function cycleTable(a) {
    // Das letzte Einatem-Signal beendet die Aufzeichnung nur — kein eigener Atemzug
    const rows = a.cycles.filter(c => c.tNext != null || c.matched).map(c => {
        if (!c.matched) return `<tr class="dz-miss"><td>${c.i + 1}</td><td colspan="6">kein Moonbird-Start${Object.keys(c.flags).length ? ' (' + esc(Object.keys(c.flags).join(', ')) + ')' : ''}</td></tr>`;
        return `<tr><td>${c.i + 1}</td><td>${sgn(c.startLag)}</td><td>${r0(c.cmdLag)}</td><td>${r0(c.breathMeasured)} / ${r0(c.progBreath)}</td><td>${sgn(c.endOffset)}</td><td>${sgn(c.periodErr)}</td><td>${esc(Object.keys(c.flags).join(', '))}</td></tr>`;
    }).join('');
    return `<table class="dz-table"><tr><th>#</th><th>Start ms</th><th>App ms</th><th>Atemzug ms (gem./Befehl)</th><th>Ende ms</th><th>Periode ms</th><th>Ereignisse</th></tr>${rows}</table>`;
}

export function renderHTML(report) {
    const r = report.results;
    const parts = [];
    const top = report.findings.filter(f => f.severity === 'bad' || f.severity === 'warn').length;
    parts.push(`<div class="dz-verdict">${top ? `${top} Befund${top === 1 ? '' : 'e'} mit Handlungsbedarf` : 'Keine kritischen Befunde'}</div>`);
    parts.push('<h3 class="dz-h">Befunde &amp; Empfehlungen</h3>');
    report.findings.forEach(f => {
        parts.push(`<div class="dz-finding dz-${f.severity}"><div class="dz-title">${ICON[f.severity]} ${esc(f.title)}</div>`
            + (f.detail ? `<div class="dz-detail">${esc(f.detail)}</div>` : '')
            + (f.suggestion ? `<div class="dz-sugg">→ ${esc(f.suggestion)}</div>` : '') + '</div>');
    });
    ['mirrorFixed', 'mirrorChange', 'mirrorAlwaysOn', 'live'].forEach(k => {
        const a = r[k]?.analysis;
        if (!a) return;
        parts.push(`<h3 class="dz-h">${esc(r[k].label || 'Letztes Training')} — Startverzug je Atemzug</h3>`);
        parts.push(svgBars(a.cycles.filter(c => c.matched).map(c => c.startLag), START_TOL_MS));
        parts.push(cycleTable(a));
    });
    parts.push('<h3 class="dz-h">Kennwerte</h3>');
    const kv = [];
    if (r.latency) kv.push(['Schreib-Bestätigung', fmtStats(r.latency.ack)], ['Antwort-Notification', fmtStats(r.latency.reply)]);
    if (r.latencyEcg?.without) kv.push(['Latenz ohne EKG (Median)', `${r0(r.latencyEcg.without.ack?.p50)} ms`], ['Latenz mit EKG (Median)', `${r0(r.latencyEcg.with?.ack?.p50)} ms`]);
    if (r.clock && !r.clock.error) kv.push(['Geräteuhr', `${sgn(r.clock.ppm)} ± ${r0(r.clock.ppmSe)} ppm`], ['Gerätestart nach Senden', `${sgn(r.clock.startBias)} ms`], ['Ende-Ereignis-Latenz', `${r0(r.clock.endLatency)} ms`]);
    if (r.env) kv.push(['Frames', fmtStats(r.env.frames)], ['Timer-Jitter', fmtStats(r.env.timerJitter)], ['Hauptthread-Blockaden', `${r.env.longTasks?.count ?? 0} (max ${r0(r.env.longTasks?.maxMs)} ms)`], ['Plattform', esc(r.env.userAgent)]);
    parts.push('<table class="dz-table">' + kv.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('') + '</table>');
    return parts.join('');
}
