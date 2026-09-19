/**
 * Moonbird-Diagnose
 *
 * Ziel: messen, wie exakt das Moonbird den Rhythmus atmet, den der Pacer visuell zeigt —
 * und alle Hemmnisse aufdecken (BLE-Latenz, Geräteuhr, Phasenlage und Drift der Langsession,
 * Pause beim Rhythmuswechsel, EKG-Stream, Hauptthread, Hintergrund).
 *
 * Aufbau:
 *  1. analyzeTrace()      — wertet das Zeitprotokoll (moonbird.trace) aus, pure Funktion
 *  2. MoonbirdDiagnostics — aktive Messungen (Latenz, Uhr, Genauigkeit, Synchron-Test, Wechsel-Test)
 *  3. buildFindings()     — regelbasierte Befunde + Empfehlungen
 *  4. renderText/renderHTML — Bericht
 */
import { MoonbirdController } from './moonbird.js';

const { MIN_SESSION_MS } = MoonbirdController.constants;

const END_MARGIN_MS = 200;      // Ein-Atemzug-Sessions (Genauigkeits-Test): Dauer endet so weit vor dem Ausatem-Ende
const GATE_LEAD_MS = 600;       // Benachrichtigungen so lange vor dem erwarteten Ende wieder an

// Toleranzen: Startlage ±150 ms, zusätzliche Pause beim Wechsel bis 150 ms (unterhalb der Wahrnehmung eines Atemrhythmus)
const START_TOL_MS = 150;
const PAUSE_TOL_MS = 150;

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
 * Wertet das Zeitprotokoll einer Langsession-Sitzung aus: Sessions, Rhythmuswechsel (Pause, Funkzeit,
 * Ende-Ereignis) und ob der Pacer auf dem Raster des Moonbird läuft. Reine Funktion.
 * @param {object[]} traceIn  moonbird.trace (oder ein Ausschnitt davon)
 */
export function analyzeTrace(traceIn) {
    const trace = [...traceIn].sort((a, b) => a.t - b.t);
    const sessions = trace.filter(e => e.type === 'session');
    const switchEvents = trace.filter(e => e.type === 'switch');
    const inhales = trace.filter(e => e.type === 'pacer' && e.phase === 'inhale');
    const decisions = trace.filter(e => e.type === 'decision');
    const cmds = trace.filter(e => e.type === 'cmd');

    // Pacer gegen das Raster des Moonbird: Einatem-Ereignis vs. Sollzeit (Session-Anfang + k · Zyklus).
    // Erwartet 0–16 ms (ein Bildwechsel); mehr heißt, dass der Pacer nicht im Takt des Geräts läuft.
    const pacerOffsets = [];
    sessions.forEach((sess, i) => {
        const nextAnchor = sessions[i + 1]?.anchor ?? Infinity;
        const cyc = cycleOf(sess.rhythm);
        inhales.filter(e => e.t >= sess.anchor - 200 && e.t < nextAnchor - 200).forEach(e => {
            const k = Math.round((e.t - sess.anchor) / cyc);
            pacerOffsets.push(e.t - (sess.anchor + k * cyc));
        });
    });

    const switches = switchEvents.map((x) => ({
        t: x.tRequest ?? x.t,
        ok: !!x.ok,
        renew: !!x.renew,
        reason: x.reason || null,
        stage: x.stage || null,
        from: x.from, to: x.to,
        replans: x.replans || 0,
        holdOldMs: x.from?.holdOut || 0,                                                   // Pause des alten Rhythmus nach der Ausatmung
        extraPauseMs: x.extraPauseMs ?? null,                                              // zusätzliche Pause über die normale hinaus
        silentMs: x.S != null && x.E != null ? x.S - x.E : null,                           // Moonbird ruht von Ausatem-Ende bis Start
        endLatencyMs: x.tEnd != null && x.E != null && !x.endLost ? x.tEnd - x.E : null,   // Ende-Ereignis nach dem erwarteten Ausatem-Ende
        endLost: !!x.endLost,
        stopLeadMs: x.tStop != null && x.E != null ? x.E - x.tStop : null,                 // so früh vor dem Ausatem-Ende war der Stopp bestätigt
        waitMs: x.S != null ? x.S - (x.tRequest ?? x.t) : null,                            // Anforderung → neuer Rhythmus beginnt
    }));
    const okSw = switches.filter(x => x.ok);

    const decisionCounts = {};
    decisions.forEach(d => { decisionCounts[d.what] = (decisionCounts[d.what] || 0) + 1; });

    const summary = {
        pacerCycles: Math.max(0, inhales.length - 1),
        sessions: sessions.length,
        switches: switches.length,
        switchesOk: okSw.length,
        switchesFailed: switches.length - okSw.length,
        renewals: switches.filter(x => x.renew).length,
        replans: switches.reduce((sum, x) => sum + x.replans, 0),
        extraPause: stats(okSw.map(x => x.extraPauseMs)),
        silent: stats(okSw.map(x => x.silentMs)),
        endLatency: stats(okSw.map(x => x.endLatencyMs)),
        stopLead: stats(switches.map(x => x.stopLeadMs)),
        wait: stats(okSw.map(x => x.waitMs)),
        endLost: switches.filter(x => x.endLost).length,
        noPauseCount: okSw.filter(x => (x.extraPauseMs ?? 0) <= 30).length,
        endBias: stats(decisions.filter(d => d.what === 'end-bias').map(d => d.bias)),   // Ende-Ereignis − erwartetes Ausatem-Ende (auch beim Stopp am Trainingsende)
        pacerOffset: stats(pacerOffsets),
        ack: stats(cmds.filter(c => c.tWritten != null && c.tSend != null).map(c => c.tWritten - c.tSend)),
        decisionCounts,
    };
    return { switches, summary };
}

/** Wertet das zuletzt aufgezeichnete echte Training (nicht die Diagnose-Läufe) aus. */
export function analyzeLastTraining(trace) {
    let from = -1;
    for (let i = trace.length - 1; i >= 0; i--) if (trace[i].type === 'follow' && trace[i].source === 'training') { from = i; break; }
    const slice = from < 0 ? [] : trace.slice(from);
    if (!slice.some(e => e.type === 'session')) return { error: 'Kein Training mit Moonbird aufgezeichnet.' };
    return { analysis: analyzeTrace(slice) };
}

// ─── 3. Befunde ────────────────────────────────────────────────────────────

const F = (severity, title, detail, suggestion = null) => ({ severity, title, detail, suggestion });

/** Befunde aus einer Trace-Auswertung (Wechsel-Test oder Live-Training). */
export function traceFindings(a, label) {
    const s = a.summary;
    const out = [];
    const L = label ? `[${label}] ` : '';
    if (!s.sessions) return [F('info', `${L}Kein Moonbird-Lauf aufgezeichnet`, 'Für eine Auswertung muss eine Session gestartet worden sein.')];

    if (s.switches === 0) {
        out.push(F('ok', `${L}Keine Rhythmuswechsel: das Moonbird atmete durchgehend im exakten Takt`,
            'In der Langsession läuft das Moonbird auf seiner eigenen Uhr — ohne Funkverkehr und ohne Kürzung einzelner Atemzüge.'));
    } else {
        if (s.switchesFailed) {
            const reasons = [...new Set(a.switches.filter(x => !x.ok).map(x => x.reason || 'unbekannt'))].join('; ');
            out.push(F('bad', `${L}${s.switchesFailed} von ${s.switches} Rhythmuswechseln fehlgeschlagen`,
                `Grund: ${reasons}. Der Pacer blieb dabei beim alten Rhythmus (bzw. lief ohne Moonbird weiter).`,
                'Fehlerdetails im Rohprotokoll (JSON-Export) ansehen; Verbindung und Abstand prüfen.'));
        }
        if (s.switchesOk && s.extraPause) {
            const ep = s.extraPause;
            const sev = ep.max <= PAUSE_TOL_MS ? 'ok' : ep.max <= 400 ? 'info' : 'warn';
            const holds = [...new Set(a.switches.filter(x => x.ok).map(x => Math.round(x.holdOldMs)))].join('/');
            out.push(F(sev, `${L}${s.switchesOk} Rhythmuswechsel: zusätzliche Pause Ø ${r0(ep.mean)} ms (max ${r0(ep.max)} ms), ${s.noPauseCount} davon ohne spürbare Pause`,
                `Zwischen Ausatem-Ende und neuem Start liegen Ø ${r0(s.silent?.mean)} ms (Ende melden, Programm setzen, Start dauern mindestens so lange; die reguläre Pause des Rhythmus beträgt ${holds} ms). Nur der Überschuss verlängert die Pause einmalig. Der Pacer bleibt in dieser Pause stehen und beginnt genau mit dem Moonbird.`,
                sev === 'warn' ? `Ein Halt nach Ausatmen von ≥ ${r0(s.silent?.mean)} ms macht den Wechsel unmerklich; alternativ Wechsel seltener zulassen.` : null));
        }
        if (s.endLost) {
            out.push(F('info', `${L}Ende-Ereignis ${s.endLost}× nicht angekommen — Status-Rückfall hat übernommen`,
                'Das Session-Ende wurde dann per Statusabfrage erkannt; der Wechsel wird dadurch nicht später, solange die Pause die Wartezeit abdeckt.'));
        }
        if (s.replans) {
            out.push(F('warn', `${L}${s.replans}× kam der Stopp zu spät für das geplante Zyklusende`,
                'Der Wechsel musste auf das nächste Zyklusende ausweichen; der Pacer stand dadurch länger in der Pause.',
                'Funkverbindung prüfen (Latenztest); der Stopp muss ca. 0,6 s vor dem Ausatem-Ende am Moonbird sein.'));
        }
        if (s.endLatency) {
            out.push(F('info', `${L}Ende-Ereignis kommt Ø ${sgn(s.endLatency.mean)} ms nach dem erwarteten Ausatem-Ende (σ ${r0(s.endLatency.sd)} ms)`,
                'Enthält Funklaufzeit und die Abweichung zwischen Geräteuhr-Raster und Pacer-Raster; bestimmt, wann Programm und Start gesendet werden können.'));
        }
    }

    if (s.endBias && s.endBias.n >= 1 && Math.abs(s.endBias.mean) > 450) {
        out.push(F('bad', `${L}Session-Ende liegt Ø ${sgn(s.endBias.mean)} ms neben dem erwarteten Ausatem-Ende`,
            'Das Modell der Geräte-Abfolge (Einatmen → Halten → Ausatmen → Pause) stimmt dann nicht mit dem Moonbird überein — Wechsel warten unnötig, und der Rhythmus liegt ggf. um die Pause versetzt.',
            'Genau diese Zahl aus dem Bericht mitteilen (Halt nach Ausatmen des Test-Rhythmus vergleichen).'));
    }

    if (s.pacerOffset && s.pacerOffset.n >= 2) {
        const po = s.pacerOffset;
        const bad = Math.abs(po.mean) > 60 || po.p95 > 120;
        out.push(F(bad ? 'warn' : 'ok', `${L}Pacer-Takt ${bad ? 'weicht vom Moonbird-Raster ab' : 'deckungsgleich mit dem Moonbird-Raster'}: Einatem-Signal Ø ${sgn(po.mean)} ms (p95 ${r0(po.p95)} ms)`,
            'Abweichung des Einatem-Ereignisses im Pacer von der Sollzeit (Session-Start + Zyklen). Bis ca. 16 ms ist ein Bildwechsel.',
            bad ? 'Bildrate/Hauptthread prüfen (Umgebungs-Test), App im Vordergrund lassen.' : null));
    }

    const d = s.decisionCounts;
    ['fail', 'disconnect'].forEach(k => {
        if (d[k]) out.push(F('bad', `${L}Ereignis „${k}" ${d[k]}×`, 'Steuerung bzw. Verbindung wurde abgebrochen.', 'Fehlerdetails im Rohprotokoll (JSON-Export) ansehen.'));
    });
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
        const bad = st.timeouts > 0 || st.f1Lost || run > Math.max(300, 3 * idle);
        out.push(F(bad ? 'bad' : 'ok',
            `Sensor-Datenstrom: ${st.streamRate != null ? r0(st.streamRate) + ' Notifications/s' : 'kein Datenstrom erkannt'}; Antwortzeit während der Session Median ${r0(run)} ms (Leerlauf ${r0(idle)} ms), p95 ${r0(st.running.p95)} ms`,
            `${st.timeouts} von ${st.polls} Abfragen ohne Antwort. ${st.f1Lost ? 'Das Ende-Ereignis der Session ging verloren (kam nicht an) — bei dauerhaft aktiven Benachrichtigungen erfährt die App das Session-Ende dann gar nicht.' : `Ende-Ereignis kam ${sgn(st.f1DelayMs)} ms gegenüber der Erwartung.`}`,
            bad ? 'Der Datenstrom verstopft die Funkstrecke. Gegenmaßnahme (Benachrichtigungen während der Session aus, nur kurz vor einem Wechsel an) ist im Training aktiv.' : null));
    } else if (st?.error) {
        out.push(F('warn', 'Datenstrom-Test fehlgeschlagen', st.error));
    }

    const ck = results.clock;
    if (ck && !ck.error && ck.reliable === false) {
        out.push(F('warn', `Uhren-Messung nicht belastbar (${ck.samples} Messpunkte, Streuung σ ${r0(ck.residualSd)} ms)`,
            `Die Statusantworten waren zu ungleichmäßig, um die Geräteuhr und den Startverzug sauber zu bestimmen; die Startzeit-Schätzung bleibt ungenau (nur aus der Schreib-Bestätigung geschätzt).`,
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
            `Bestätigung kommt ${sgn(ck.startBiasReply)} ms relativ zum Gerätestart. Ende-Ereignis erreicht die App ${r0(ck.endLatency)} ms nach dem Geräte-Ende${ck.endLatency < 0 ? ' (negativ ist physikalisch unmöglich: das Gerät beendet die Session etwas früher als rechnerisch angenommen — die absolute Lage des Endes bleibt daher unsicher; für die Steuerung zählt nur der Start)' : ''}.`,
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

    ['sync', 'switch'].forEach(k => {
        const r = results[k];
        if (!r) return;
        if (r.error) { out.push(F('bad', `${r.label || k} fehlgeschlagen`, r.error)); return; }
        const f = r.fit;
        if (f) {
            const e = f.startErrorMs;
            const sev = Math.abs(e) <= START_TOL_MS / 2 ? 'ok' : Math.abs(e) <= START_TOL_MS ? 'info' : 'warn';
            out.push(F(f.reliable ? sev : 'warn',
                `${r.label}: Moonbird beginnt ${sgn(e)} ms gegenüber dem Pacer-Raster (${f.n} Messpunkte, σ ${r0(f.resSd)} ms)`,
                (f.reliable ? '' : 'Messung nicht belastbar (zu wenige/zu unruhige Statusantworten). ')
                + `Die Geräteuhr (Zähler der Statusantwort) legt den tatsächlichen Start fest; verglichen wird mit der Startzeit, zu der der Pacer beginnt. ${e > 0 ? 'Positiv = Moonbird atmet später ein als der Pacer.' : 'Negativ = Moonbird atmet früher ein als der Pacer.'}`,
                sev === 'ok' || !f.reliable ? null : `Vorhalt (Startbefehl früher senden) um ca. ${r0(-e)} ms ändern — Kalibrierung im Uhren-Test durchführen.`));
            if (r.key === 'sync' || k === 'sync') {
                const drift10 = f.ppm * 0.6;   // ms Drift in 10 Minuten
                const sig = Math.abs(f.ppm) > 2 * f.ppmSe;
                out.push(F(sig && Math.abs(drift10) > 150 ? 'warn' : 'ok',
                    `Drift Moonbird gegenüber Pacer: ${sgn(f.ppm)} ± ${r0(f.ppmSe)} ppm → ${sgn(drift10)} ms in 10 Minuten`,
                    sig ? 'Das Moonbird atmet in der Langsession geringfügig schneller/langsamer als die Handy-Uhr; jeder Rhythmuswechsel gleicht das wieder aus (Pacer beginnt mit dem Moonbird).'
                        : 'Abweichung nicht signifikant — die Uhren laufen für diesen Zweck gleich schnell.',
                    sig && Math.abs(drift10) > 150 ? 'Bei langen Trainings ohne Wechsel läuft das Bild sichtbar auseinander; ggf. Wechsel/Erneuerung häufiger erzwingen.' : null));
            }
        }
        if (r.analysis) out.push(...traceFindings(r.analysis, r.label));
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

    /**
     * Ein-Atemzug-Session gated abwarten: Benachrichtigungen aus, kurz vor dem erwarteten Ende wieder an,
     * auf das Ende-Ereignis warten. Liefert { ended, tEnd, predEnd }.
     */
    async _waitEndGated(startMid, breathMs, timeoutMs = 20000) {
        const mb = this.mb;
        const predEnd = startMid + breathMs;
        await mb.setNotifications(false);
        const wait = predEnd - GATE_LEAD_MS - performance.now();
        if (wait > 0) await sleep(wait);
        const ended = mb.waitSessionEnd(timeoutMs);
        await mb.setNotifications(true);
        const ok = await ended;
        return { ended: ok, tEnd: this._lastEndTime(), predEnd };
    }

    /** Statusabfragen im Puls (Benachrichtigungen nur kurz an, sonst verstopft der Sensor-Datenstrom die Strecke). */
    async _collectCounter(until, label, pauseMs = 1700) {
        const samples = [], rtts = [];
        let pulses = 0, failed = 0;
        while (performance.now() < until) {
            this._check();
            this._progress(`${label}: ${samples.length} Messpunkte`, samples.length, 16);
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
            await this._sleep(pauseMs);
        }
        return { samples, rtts, pulses, failed };
    }

    /** Zähler = a · t + c  →  Gerätestart (Handy-Zeit) = −c / a; a − 1 ist der Uhrenfehler. */
    static _fit(samples) {
        const n = samples.length;
        const mx = samples.reduce((sum, x) => sum + x.tMid, 0) / n;
        const my = samples.reduce((sum, x) => sum + x.counter, 0) / n;
        let num = 0, den = 0;
        samples.forEach(x => { num += (x.tMid - mx) * (x.counter - my); den += (x.tMid - mx) ** 2; });
        const a = num / den;
        const c0 = my - a * mx;
        const resSd = stats(samples.map(x => x.counter - (a * x.tMid + c0))).sd;
        const span = samples[n - 1].tMid - samples[0].tMid;
        return {
            n, a, c0, resSd, spanMs: span,
            devStart: -c0 / a,
            ppm: (a - 1) * 1e6,
            ppmSe: resSd / (span * Math.sqrt(n / 12)) * 1e6,   // Standardfehler der Steigung
            reliable: n >= 8 && resSd < 60,
        };
    }

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

            const { samples, rtts, pulses, failed } = await this._collectCounter(predEnd - 3500, `Uhren-Test (ca. ${Math.round(plannedEnd / 1000)} s)`);
            const endRes = await this._waitEndGated(startMid, plannedEnd, 20000);
            if (!endRes.ended) throw new Error('Session-Ende nicht gemeldet');
            const tEnd = endRes.tEnd;
            if (samples.length < 8) throw new Error(`zu wenige brauchbare Messpunkte (${samples.length} von ${pulses}, ${failed} ohne Antwort)`);

            const fit = MoonbirdDiagnostics._fit(samples);
            const { n, a, devStart, resSd } = fit;
            const res = {
                samples: n, pulses, failed,
                spanMs: fit.spanMs,
                ratio: a,
                ppm: fit.ppm,
                ppmSe: fit.ppmSe,
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
            const endPromise = mb.waitSessionEnd(breath + 9000);      // vor den Abfragen registrieren, sonst wird das Ende verpasst

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
                f1Lost: !ended,
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
                const g = await this._waitEndGated((tSend + rep.tRecv) / 2, planned, planned * 2 + 8000);
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

    // ── Langsession: Pacer-Anbindung, wie sie im Training verwendet wird ──
    _hooksFor(box) {
        return {
            hold: (T) => box.pacer?.holdAt(T),
            commit: (rhythm, S) => box.pacer?.switchTo(rhythm, S),
            cancel: () => box.pacer?.cancelHold(),
            renewed: () => {},
        };
    }

    async _startLong(label, key, rhythm) {
        const mb = this.mb;
        this._progress(`${label}: Moonbird starten …`);
        const box = { pacer: null };
        const started = await mb.begin(rhythm, this._hooksFor(box), 'diag');
        if (!started) { this.results[key] = { label, key, error: 'Moonbird nicht bereit (Start der Langsession fehlgeschlagen)' }; return null; }
        box.pacer = this.createPacer(rhythm, (phase) => mb.onPacerPhase(phase));
        box.pacer.start(started.startTs);
        return { box, S: started.startTs };
    }

    async _endLong(box) {
        try { box.pacer?.stop(); box.pacer?.destroy?.(); } catch { /* egal */ }
        await this.mb.release({ wait: true }).catch(() => {});
    }

    /** Uhrvergleich einer laufenden Session: wo begann sie wirklich, wie schnell läuft die Geräteuhr? */
    async _measureSession(anchor, durationMs, label) {
        const { samples, pulses, failed } = await this._collectCounter(anchor + durationMs, label);
        if (samples.length < 4) throw new Error(`zu wenige brauchbare Messpunkte (${samples.length} von ${pulses}, ${failed} ohne Antwort)`);
        const fit = MoonbirdDiagnostics._fit(samples);
        return { ...fit, startErrorMs: fit.devStart - anchor, pulses, failed };
    }

    // ── Synchron-Test: Langsession neben dem Pacer, Phasenlage und Drift ──
    async runSync(durationMs = 40000) {
        const label = 'Synchron-Test (Langsession)';
        const t0 = performance.now();
        const run = await this._startLong(label, 'sync', this.baseRhythm);
        if (!run) return this.results.sync;
        try {
            const fit = await this._measureSession(run.S, durationMs, label);
            await this._endLong(run.box);
            const analysis = analyzeTrace(this.mb.trace.filter(e => e.t >= t0));
            return (this.results.sync = { label, key: 'sync', fit, analysis });
        } catch (err) {
            await this._endLong(run.box);
            if (err.message === 'Abgebrochen') throw err;
            return (this.results.sync = { label, key: 'sync', error: err.message });
        }
    }

    // ── Wechsel-Test: mehrere Rhythmuswechsel wie im Adaptiven Training ──
    async runSwitch(switches = 3) {
        const label = 'Wechsel-Test (Rhythmuswechsel)';
        const mb = this.mb;
        const t0 = performance.now();
        const b = this.baseRhythm;
        const step = (d) => ({ ...b, inhale: b.inhale + d, exhale: b.exhale + d });
        const seq = [step(300), step(600), b, step(-300)].slice(0, switches);
        const run = await this._startLong(label, 'switch', b);
        if (!run) return this.results.switch;
        const outcomes = [];
        try {
            await this._sleep(Math.max(0, run.S + 2 * cycleOf(b) - performance.now()));
            for (let i = 0; i < seq.length; i++) {
                this._progress(`${label}: Wechsel ${i + 1}/${seq.length}`, i, seq.length);
                const res = await mb.switchRhythm(seq[i]);
                outcomes.push({ ok: res.ok, extraPauseMs: res.extraPauseMs ?? null, reason: res.reason || null });
                if (!res.ok) break;
                await this._sleep(Math.max(0, res.effectiveTs + 1.2 * cycleOf(seq[i]) - performance.now()));
            }
            // Wie genau begann die zuletzt gestartete Session? (Ausrichtung nach einem Wechsel)
            const anchor = mb.session?.anchor ?? run.S;
            const fit = await this._measureSession(anchor, 32000, `${label}: Ausrichtung messen`);
            await this._endLong(run.box);
            const analysis = analyzeTrace(mb.trace.filter(e => e.t >= t0));
            return (this.results.switch = { label, key: 'switch', outcomes, fit, analysis });
        } catch (err) {
            await this._endLong(run.box);
            if (err.message === 'Abgebrochen') throw err;
            return (this.results.switch = { label, key: 'switch', outcomes, error: err.message });
        }
    }

    /** Auswertung des letzten realen Trainings (aus dem laufenden Zeitprotokoll). */
    analyzeLive() {
        return (this.results.live = analyzeLastTraining(this.mb.trace));
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
            sync: () => this.runSync(),
            switch: () => this.runSwitch(),
            live: async () => this.analyzeLive(),
        };
        try { return await map[name](); }
        finally { this._finalizeEnv(); }
    }

    async runAll() {
        this._aborted = false;
        const steps = ['env', 'latency', 'latencyEcg', 'stream', 'clock', 'accuracy', 'sync', 'switch'];
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
    ['sync', 'switch', 'live'].forEach(k => {
        const x = r[k];
        if (!x) return;
        const name = x.label || 'Letztes Training';
        if (x.fit) L.push(`${name}: Start ${sgn(x.fit.startErrorMs)} ms gegenüber Pacer, Drift ${sgn(x.fit.ppm)} ± ${r0(x.fit.ppmSe)} ppm, ${x.fit.n} Messpunkte, σ ${r0(x.fit.resSd)} ms`);
        const a = x.analysis;
        if (!a) return;
        const s = a.summary;
        L.push(`${name}: ${s.sessions} Session(s), ${s.switchesOk}/${s.switches} Wechsel erfolgreich (${s.renewals} Erneuerungen), zusätzliche Pause ${fmtStats(s.extraPause)}, Ruhe Ausatem-Ende→Start ${fmtStats(s.silent)}, Ende-Ereignis ${fmtStats(s.endLatency)}, Pacer-Versatz ${fmtStats(s.pacerOffset)}`);
        a.switches.forEach((w, i) => L.push(`   #${i + 1} ${w.ok ? 'ok' : 'FEHLER ' + (w.reason || '')}${w.renew ? ' (Erneuerung)' : ''} · Pause+ ${sgn(w.extraPauseMs)} · Ruhe ${r0(w.silentMs)} · Ende ${sgn(w.endLatencyMs)}${w.endLost ? ' (F1 verloren)' : ''}${w.replans ? ' · ' + w.replans + '× umgeplant' : ''}`));
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
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Zusätzliche Pause je Wechsel">${band}<line x1="0" x2="${W}" y1="${zero}" y2="${zero}" stroke="#2a4468"/>${bars}</svg>`;
}

function switchTable(a) {
    const rows = a.switches.map((w, i) => {
        if (!w.ok) return `<tr class="dz-miss"><td>${i + 1}</td><td colspan="6">${esc(w.reason || 'fehlgeschlagen')}</td></tr>`;
        return `<tr><td>${i + 1}${w.renew ? ' (erneuert)' : ''}</td><td>${sgn(w.extraPauseMs)}</td><td>${r0(w.holdOldMs)}</td><td>${r0(w.silentMs)}</td><td>${sgn(w.endLatencyMs)}${w.endLost ? ' ✗' : ''}</td><td>${r0(w.waitMs)}</td><td>${w.replans || ''}</td></tr>`;
    }).join('');
    return `<table class="dz-table"><tr><th>#</th><th>Pause+ ms</th><th>Halt ms</th><th>Ruhe ms</th><th>F1 ms</th><th>Dauer ms</th><th>Umplan.</th></tr>${rows}</table>`;
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
    ['sync', 'switch', 'live'].forEach(k => {
        const a = r[k]?.analysis;
        if (!a || !a.switches.length) return;
        parts.push(`<h3 class="dz-h">${esc(r[k].label || 'Letztes Training')} — zusätzliche Pause je Wechsel</h3>`);
        parts.push(svgBars(a.switches.filter(w => w.ok).map(w => w.extraPauseMs), PAUSE_TOL_MS));
        parts.push(switchTable(a));
    });
    parts.push('<h3 class="dz-h">Kennwerte</h3>');
    const kv = [];
    if (r.latency) kv.push(['Schreib-Bestätigung', fmtStats(r.latency.ack)], ['Antwort-Notification', fmtStats(r.latency.reply)]);
    if (r.latencyEcg?.without) kv.push(['Latenz ohne EKG (Median)', `${r0(r.latencyEcg.without.ack?.p50)} ms`], ['Latenz mit EKG (Median)', `${r0(r.latencyEcg.with?.ack?.p50)} ms`]);
    ['sync', 'switch'].forEach(k => { if (r[k]?.fit) kv.push([`${r[k].label}: Start gegenüber Pacer`, `${sgn(r[k].fit.startErrorMs)} ms (Drift ${sgn(r[k].fit.ppm)} ± ${r0(r[k].fit.ppmSe)} ppm)`]); });
    if (r.clock && !r.clock.error) kv.push(['Geräteuhr', `${sgn(r.clock.ppm)} ± ${r0(r.clock.ppmSe)} ppm`], ['Gerätestart nach Senden', `${sgn(r.clock.startBias)} ms`], ['Ende-Ereignis-Latenz', `${r0(r.clock.endLatency)} ms`]);
    if (r.env) kv.push(['Frames', fmtStats(r.env.frames)], ['Timer-Jitter', fmtStats(r.env.timerJitter)], ['Hauptthread-Blockaden', `${r.env.longTasks?.count ?? 0} (max ${r0(r.env.longTasks?.maxMs)} ms)`], ['Plattform', esc(r.env.userAgent)]);
    parts.push('<table class="dz-table">' + kv.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('') + '</table>');
    return parts.join('');
}
