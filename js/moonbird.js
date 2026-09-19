/**
 * Moonbird-Steuerung (Haptik-Atemgerät) via Web Bluetooth
 *
 * Das Moonbird kennt nur "Sessions": Programm setzen (Opcode 05), Session
 * starten (07). Solange eine Session läuft, lehnt es neue Programme ab, und
 * eine Session endet immer erst am Ende der ersten Ausatmung NACH Ablauf der
 * gesetzten Dauer (Ende-Ereignis: Notification 0xF1).
 *
 * Daraus folgt der Trick für die Live-Steuerung: Jeder Atemzug ist eine eigene
 * Ein-Atemzug-Session. Die Dauer wird knapp VOR das Ende der Ausatmung gelegt,
 * das Programm für den nächsten Atemzug wird nach dem Ende-Ereignis gesetzt und
 * mit dem nächsten Einatem-Signal des Pacers gestartet. So folgt das Moonbird
 * jeder Rhythmus-Änderung (Adaptives Training) schon im nächsten Atemzug.
 * Den "Halt nach Ausatmen" liefert die Wartezeit zwischen zwei Sessions.
 *
 * Während einer laufenden Session sendet das Moonbird ~20 Sensor-Notifications
 * pro Sekunde (91 Byte). Auf dem Handy verstopft das die Funkstrecke: Antworten
 * und das Ende-Ereignis kommen um Sekunden verspätet. Deshalb werden die
 * Benachrichtigungen (CCCD) direkt nach dem Start abgeschaltet und erst kurz vor
 * dem vorhergesagten Ende wieder eingeschaltet (Ende-Ereignis F1 geht sonst verloren).
 *
 * Protokoll reverse-engineert (Sniffer + Test vom PC aus), siehe Notizen.
 */

const SERVICE_UUID = 'd2580000-d354-ad94-9b40-bc67a1c968ca';
const NOTIFY_UUID  = 'd2580001-d354-ad94-9b40-bc67a1c968ca';
const WRITE_UUID   = 'd2580002-d354-ad94-9b40-bc67a1c968ca';

const OP_STATUS  = 0x04;
const OP_PROGRAM = 0x05;
const OP_START   = 0x07;
const OP_STOP    = 0x08;
const REPLY_FLAG = 0x80;              // Antwort-Opcode = Befehl | 0x80
const EVT_SESSION_END = 0xf1;
const STATE_RUNNING   = 0x03;         // Statusbyte: 02 = bereit, 03 = läuft
const START_CMD = new Uint8Array([OP_START, 0x01, 0x00, 0x2a, 0xcc, 0x13]);

const MIN_SESSION_MS   = 8000;        // kürzere Dauern lehnt das Moonbird ab
const END_MARGIN_MS    = 200;         // Dauer endet so weit vor dem Ausatem-Ende
const CMD_OVERHEAD_MS  = 300;         // Ende-Ereignis → Start: 2 Schreibvorgänge (05+07)
const REQUEST_TIMEOUT_MS = 3000;
const IDLE_WAIT_MS       = 15000;     // so lange auf das Ende einer laufenden Session warten
const STALE_RUN_GRACE_MS = 3000;      // Toleranz, bevor ein verpasstes Ende-Ereignis abgefragt wird
const GATE_LEAD_MS       = 600;       // Benachrichtigungen so lange vor dem vorhergesagten Ende wieder an
const END_FALLBACK_MS    = 1200;      // so lange nach dem vorhergesagten Ende ohne F1 → Status abfragen
const END_BIAS_MAX_MS    = 400;
const OVERHEAD_MIN_MS    = 100;       // Lücke Ende-Ereignis → Start: selbstregelnd zwischen diesen Grenzen
const OVERHEAD_MAX_MS    = 1500;
const DEVICE_START_MS    = 120;       // Moonbird beginnt so lange nach Eintreffen des Startbefehls (am PC und Handy ~110–130 ms)
const LEAD_MAX_MS        = 450;
const SLACK_MARGIN_MS    = 80;        // so viel Reserve zwischen "Programm bereit" und Einatem-Signal ist gewollt

function rhythmKey(r) {
    return `${r.inhale}|${r.holdIn || 0}|${r.exhale}|${r.holdOut || 0}`;
}

export class MoonbirdController {
    constructor() {
        this.device = null;
        this._writeChar = null;
        this._notifyChar = null;
        this.isConnected = false;

        this.following = false;   // koppelt gerade Atemzug für Atemzug an den Pacer
        this.running = false;     // eine Moonbird-Session läuft
        this.rhythm = null;       // aktueller Soll-Rhythmus { inhale, holdIn, exhale, holdOut } (ms)
        this.prepared = null;     // Schlüssel des zuletzt erfolgreich gesetzten Programms

        this._preparing = false;
        this._starting = false;
        this._wantStart = false;  // Einatem-Signal kam, bevor das Programm bereit war
        this._tooFast = false;
        this._runStartedAt = 0;
        this._runExpectedMs = 0;

        this._waiters = new Map();      // Antwort-Opcode → { resolve, timer }
        this._endListeners = [];
        this._chain = Promise.resolve(); // serialisiert GATT-Operationen

        // Zeitprotokoll für die Diagnose (moonbirdDiagnostics.js): Pacer-Phasen, Befehle
        // mit Sende-/Schreib-/Antwortzeit, Ende-Ereignisse, Entscheidungen. Zeiten: performance.now().
        this.trace = [];
        this._lastProgram = null;

        // Stream-Trick: Benachrichtigungen während der Session aus (siehe Kopfkommentar).
        // Abschaltbar, um vorher/nachher zu vergleichen (Diagnose).
        this.gateStream = true;
        this._notifyOn = false;
        this._predEnd = 0;
        this._endBias = 0;              // gemessene Abweichung Ende-Ereignis − Vorhersage (Median der letzten 5)
        this._recentBias = [];
        this._endTimer = null;
        this._fallbackTimer = null;
        this._overheadMs = CMD_OVERHEAD_MS;   // Zeit von Geräte-Ende bis Start des nächsten Atemzugs (wird nachgeführt)
        this._lastDeficit = 0;
        this._lastBudget = 0;
        this._prevA = null;
        this._prevBudget = null;
        this._gapEma = null;
        this._lastInhaleT = 0;
        this._preparedAt = 0;
        this._reprepared = false;
        this._breathCount = 0;
        // Vorhalt: Startbefehl so viel VOR dem Einatem-Signal senden, wie das Moonbird zum Losgehen braucht,
        // damit es mit dem Pacer einatmet statt ~0,2 s danach.
        this.leadEnabled = true;
        this.leadOverrideMs = null;     // z. B. aus der Kalibrierung (Diagnose: Gerätestart nach Senden)
        this._leadTimer = null;
        this._targetInhaleT = 0;        // vorhergesagtes nächstes Einatem-Signal
        this._eventSeq = 0;             // Zähler der Einatem-Signale des Pacers
        this._stopAfter = false;        // nach dem laufenden Atemzug nichts Neues mehr starten
        this._targetSeq = 0;            // Nummer des Einatem-Signals, für das der Start geplant ist
        this._lastStartSendT = 0;
        this._streamCount = 0;
        this._streamFirst = 0;
        this._streamLast = 0;

        this._onNotifyBound = (e) => {
            const v = e.target.value;
            this._onNotify(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        };

        // Callbacks (von app.js gesetzt)
        this.onConnectionChange = null; // (connected: boolean) => void
        this.onNotice = null;           // (message: string) => void — unkritischer Hinweis
        this.onError  = null;           // (message: string) => void
    }

    static isAvailable() {
        return typeof navigator !== 'undefined' && navigator.bluetooth !== undefined;
    }

    // ─── Verbindung ──────────────────────────────────────────────────────────

    async connect() {
        if (!MoonbirdController.isAvailable()) {
            this._error('Web Bluetooth wird von diesem Browser nicht unterstützt. Bitte Chrome verwenden.');
            return false;
        }
        try {
            this.device = await navigator.bluetooth.requestDevice({
                filters: [
                    { namePrefix: 'moonbird' },
                    { namePrefix: 'Moonbird' },
                    { namePrefix: 'MOONBIRD' },
                    { services: [SERVICE_UUID] },
                ],
                optionalServices: [SERVICE_UUID],
            });
            this.device.addEventListener('gattserverdisconnected', () => this._handleDisconnect());

            const server = await this.device.gatt.connect();
            const service = await server.getPrimaryService(SERVICE_UUID);
            this._notifyChar = await service.getCharacteristic(NOTIFY_UUID);
            this._writeChar  = await service.getCharacteristic(WRITE_UUID);
            this._notifyChar.addEventListener('characteristicvaluechanged', this._onNotifyBound);
            await this._notifyChar.startNotifications();

            this._notifyOn = true;
            this.isConnected = true;
            this.onConnectionChange?.(true);
            return true;
        } catch (err) {
            this._teardown();
            if (err.name === 'NotFoundError') {
                this._error('Kein Moonbird ausgewählt. Ist es wach und die Moonbird-App geschlossen?');
            } else {
                this._error(`Moonbird-Verbindungsfehler: ${err.message}`);
            }
            return false;
        }
    }

    disconnect() {
        this.following = false;
        if (this.device?.gatt?.connected) this.device.gatt.disconnect();
        else this._handleDisconnect();
    }

    _handleDisconnect() {
        const wasConnected = this.isConnected;
        if (wasConnected) this._trace('decision', { what: 'disconnect' });
        this._teardown();
        if (wasConnected) this.onConnectionChange?.(false);
    }

    _teardown() {
        this.isConnected = false;
        this.following = false;
        this.running = false;
        this.prepared = null;
        this._wantStart = false;
        this._preparing = false;
        this._starting = false;
        for (const w of this._waiters.values()) {
            clearTimeout(w.timer);
            w.reject(new Error('Moonbird getrennt'));
        }
        this._waiters.clear();
        this._clearGate();
        this._notifyOn = false;
        this._endListeners.splice(0).forEach(fn => fn(false));
        this._notifyChar?.removeEventListener('characteristicvaluechanged', this._onNotifyBound);
        this._notifyChar = null;
        this._writeChar = null;
    }

    // ─── Diagnose-Protokoll ──────────────────────────────────────────────────

    _trace(type, data = {}) {
        this.trace.push({ type, t: performance.now(), ...data });
        if (this.trace.length > 20000) this.trace.splice(0, 5000);
    }

    clearTrace() { this.trace = []; }

    // ─── Kommunikation ───────────────────────────────────────────────────────

    _onNotify(bytes) {
        if (!bytes.length) return;
        bytes.tRecv = performance.now();
        const op = bytes[0];
        if (op === 0xf0) {   // Sensor-Datenstrom: nur mitzählen
            if (!this._streamCount) this._streamFirst = bytes.tRecv;
            this._streamCount++;
            this._streamLast = bytes.tRecv;
            return;
        }
        if (op === EVT_SESSION_END) { this._trace('end'); this._onSessionEnd(bytes.tRecv); return; }
        const w = this._waiters.get(op);
        if (w) {
            this._waiters.delete(op);
            clearTimeout(w.timer);
            w.resolve(bytes);
        }
        // alles andere (sonstige Blöcke) wird ignoriert
    }

    async _write(bytes) {
        const c = this._writeChar;
        if (!c) throw new Error('Moonbird nicht verbunden');
        if (c.writeValueWithResponse) await c.writeValueWithResponse(bytes);
        else await c.writeValue(bytes);
    }

    /** Befehl senden und auf die Antwort-Notification warten (GATT-Zugriffe laufen nacheinander). */
    _request(bytes, timeoutMs = REQUEST_TIMEOUT_MS) {
        const replyOp = bytes[0] | REPLY_FLAG;
        const rec = { op: bytes[0], tQueued: performance.now(), tSend: null, tWritten: null, tReply: null, reply: null, error: null };
        const run = async () => {
            if (!this.isConnected) throw new Error('Moonbird nicht verbunden');
            // Ohne Benachrichtigungen käme keine Antwort — sicherheitshalber einschalten
            if (!this._notifyOn) await this._applyNotify(true);
            const reply = new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this._waiters.delete(replyOp);
                    reject(new Error('Moonbird antwortet nicht'));
                }, timeoutMs);
                this._waiters.set(replyOp, { resolve, reject, timer });
            });
            reply.catch(() => {});
            rec.tSend = performance.now();
            try {
                await this._write(bytes);
                rec.tWritten = performance.now();
            } catch (err) {
                const w = this._waiters.get(replyOp);
                if (w) { clearTimeout(w.timer); this._waiters.delete(replyOp); }
                throw err;
            }
            return reply;
        };
        const finish = () => this.trace.push({ type: 'cmd', t: rec.tQueued, ...rec });
        const p = this._enqueue(run);
        p.then((reply) => {
            rec.tReply = reply.tRecv ?? performance.now();
            rec.reply = Array.from(reply.slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
            finish();
        }, (err) => { rec.error = err.message; finish(); });
        return p;
    }

    /** GATT-Operationen nacheinander ausführen (Web Bluetooth erlaubt nur eine gleichzeitig). */
    _enqueue(fn) {
        const p = this._chain.then(fn, fn);
        this._chain = p.catch(() => {});
        return p;
    }

    /** Benachrichtigungen (CCCD) ein-/ausschalten; ausgeschaltet gibt es keinen Sensor-Datenstrom. */
    setNotifications(on) {
        return this._enqueue(() => this._applyNotify(on));
    }

    async _applyNotify(on) {
        if (!this.isConnected || this._notifyOn === on || !this._notifyChar) return;
        const t = performance.now();
        if (on) await this._notifyChar.startNotifications();
        else await this._notifyChar.stopNotifications();
        this._notifyOn = on;
        this._trace('notify', { on, ms: performance.now() - t });
    }

    get notificationsOn() { return this._notifyOn; }

    /** Zähler des Sensor-Datenstroms (Notifications mit Opcode F0) für die Diagnose. */
    resetStreamStats() { this._streamCount = 0; this._streamFirst = 0; this._streamLast = 0; }
    get streamStats() {
        const span = this._streamLast - this._streamFirst;
        return { count: this._streamCount, ratePerS: span > 500 ? (this._streamCount - 1) / (span / 1000) : null };
    }

    /**
     * Diagnose-Hilfe: nach einem erfolgreich gestarteten Atemzug Benachrichtigungen aus, kurz vor
     * dem Ende wieder an und das Ende-Ereignis abwarten. Liefert { ended, tEnd, predEnd }.
     */
    async waitEndGated(startMid, breathMs, timeoutMs = 20000) {
        const predEnd = startMid + breathMs;
        await this.setNotifications(false);
        const wait = predEnd - GATE_LEAD_MS - performance.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        const ended = this._waitSessionEnd(timeoutMs);
        await this.setNotifications(true);
        const ok = await ended;
        let tEnd = null;
        for (let i = this.trace.length - 1; i >= 0; i--) if (this.trace[i].type === 'end') { tEnd = this.trace[i].t; break; }
        return { ended: ok, tEnd, predEnd };
    }

    static _ok(reply) { return reply[1] === 0x01 && reply[2] === 0x00; }

    // ─── Öffentliche Hilfen (Diagnose) ───────────────────────────────────────

    /** Rohbefehl senden und Antwort abwarten (Bytes mit .tRecv = Empfangszeit). */
    request(bytes, timeoutMs) { return this._request(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), timeoutMs); }
    ensureIdle() { return this._ensureIdle(); }
    waitSessionEnd(timeoutMs = IDLE_WAIT_MS) { return this._waitSessionEnd(timeoutMs); }
    static get startCommand() { return START_CMD; }

    /** Antwort auf 04 zerlegen: Zustand, Sessionzähler (ms seit Start, nur wenn läuft). */
    static parseStatus(reply) {
        const running = reply[3] === STATE_RUNNING;
        let counterMs = null;
        if (running && reply.length >= 38) {
            counterMs = ((reply[34] << 24) | (reply[35] << 16) | (reply[36] << 8) | reply[37]) >>> 0;
        }
        return { running, counterMs };
    }

    /** Programm-Befehl (Opcode 05) aus Rohwerten in ms bauen. */
    static programBytes(holdOut, inhale, holdIn, exhale, duration) {
        const buf = new Uint8Array(22);
        const dv = new DataView(buf.buffer);
        buf[0] = OP_PROGRAM;
        buf[1] = 0x01;
        [holdOut, inhale, holdIn, exhale, duration].forEach((v, i) => dv.setUint32(2 + i * 4, Math.round(v), false));
        return buf;
    }

    static get constants() {
        return { MIN_SESSION_MS, END_MARGIN_MS, CMD_OVERHEAD_MS };
    }

    get overheadMs() { return this._overheadMs; }

    /** Gelernte Lücke (Geräte-Ende → nächster Start) inkl. Reserve, oder null, solange noch nichts gelernt wurde. */
    get learnedOverheadMs() { return this._gapEma == null ? null : Math.round(this._overheadMs); }

    /** Früher gelernten Wert übernehmen, damit schon der erste Atemzug passend verkürzt wird. */
    restoreOverhead(ms) {
        if (!Number.isFinite(ms)) return;
        this._overheadMs = Math.max(OVERHEAD_MIN_MS, Math.min(OVERHEAD_MAX_MS, ms));
        this._gapEma = Math.max(0, this._overheadMs - SLACK_MARGIN_MS);
    }

    /** Vorhalt in ms: Schreib-Bestätigung/2 (Weg zum Gerät) + Startverzögerung des Geräts; 0 solange nichts gemessen ist. */
    get startLeadMs() {
        if (!this.leadEnabled) return 0;
        if (this.leadOverrideMs != null) return Math.max(0, Math.min(LEAD_MAX_MS, this.leadOverrideMs));
        const acks = [];
        for (let i = this.trace.length - 1; i >= 0 && acks.length < 8; i--) {
            const e = this.trace[i];
            if (e.type === 'cmd' && e.tWritten != null && e.tSend != null) acks.push(e.tWritten - e.tSend);
        }
        if (acks.length < 2) return 0;
        acks.sort((a, b) => a - b);
        return Math.max(0, Math.min(LEAD_MAX_MS, acks[Math.floor(acks.length / 2)] / 2 + DEVICE_START_MS));
    }

    /**
     * Nach fertigem Programm: den Start so planen, dass das Moonbird zum vorhergesagten Einatem-Signal
     * losgeht (Sendezeitpunkt = Einatem-Signal − Vorhalt). Der Pacer läuft mit dem letzten Rhythmus weiter,
     * sein Zyklus ist bekannt.
     */
    _scheduleStart() {
        clearTimeout(this._leadTimer);
        this._leadTimer = null;
        if (!this.following || !this._lastInhaleT) return;      // erster Atemzug: startet mit dem ersten Einatem-Signal
        const lead = this.startLeadMs;
        if (lead <= 0) return;
        const r = this.rhythm;
        this._targetInhaleT = this._lastInhaleT + r.inhale + (r.holdIn || 0) + r.exhale + (r.holdOut || 0);
        this._targetSeq = this._eventSeq + 1;
        const delay = this._targetInhaleT - lead - performance.now();
        this._trace('decision', { what: 'schedule', lead, delay });
        if (delay <= 0) { this._startBreath(); return; }
        this._leadTimer = setTimeout(() => this._startBreath(), delay);
    }

    async _queryRunning() {
        const r = await this._request(new Uint8Array([OP_STATUS]));
        return r[3] === STATE_RUNNING;
    }

    _waitSessionEnd(timeoutMs) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const i = this._endListeners.indexOf(listener);
                if (i >= 0) this._endListeners.splice(i, 1);
                resolve(false);
            }, timeoutMs);
            const listener = (ended) => { clearTimeout(timer); resolve(ended); };
            this._endListeners.push(listener);
        });
    }

    /** Falls noch eine (fremde/vergessene) Session läuft: beenden und Ende abwarten. */
    async _ensureIdle() {
        if (!(await this._queryRunning())) return;
        const ended = this._waitSessionEnd(IDLE_WAIT_MS);
        await this._request(new Uint8Array([OP_STOP]));
        await ended;
        if (await this._queryRunning()) throw new Error('Moonbird beendet die laufende Session nicht');
    }

    // ─── Programm-Berechnung ─────────────────────────────────────────────────

    /**
     * Ein-Atemzug-Programm (Opcode 05) für einen Rhythmus, oder null, wenn der
     * Atemzug für die Mindest-Sessiondauer des Moonbird zu kurz ist.
     * Reihenfolge der Zahlen im Befehl: [Halt nach Ausatmen, Einatmen,
     * Halt nach Einatmen, Ausatmen, Gesamtdauer] (je 4 Byte Big Endian, ms).
     */
    _programFor(r) {
        const holdOut = r.holdOut || 0;
        // Ist der Halt nach Ausatmen kürzer als die Befehlslaufzeit, verkürzt sich
        // die Ausatmung entsprechend, damit der Rhythmus über viele Zyklen nicht driftet.
        this._lastDeficit = Math.max(0, this._overheadMs - holdOut);
        this._lastBudget = holdOut + this._lastDeficit;
        const exhale = r.exhale - this._lastDeficit;
        const breath = r.inhale + (r.holdIn || 0) + exhale;
        const duration = breath - END_MARGIN_MS;
        if (duration < MIN_SESSION_MS) return null;

        this._runExpectedMs = breath;
        this._lastProgram = { holdOut, inhale: r.inhale, holdIn: r.holdIn || 0, exhale, duration, breath };
        return MoonbirdController.programBytes(holdOut, r.inhale, r.holdIn || 0, exhale, duration);
    }

    // ─── Kopplung an den Pacer ───────────────────────────────────────────────

    /**
     * Beginnt die Atemzug-für-Atemzug-Kopplung. Bereitet den ersten Atemzug vor;
     * gestartet wird er mit dem nächsten Einatem-Signal des Pacers.
     * @returns {Promise<boolean>}
     */
    async follow(rhythm, source = 'training') {
        if (!this.isConnected) return false;
        this.rhythm = { ...rhythm };
        this._trace('follow', { rhythm: { ...rhythm }, source });
        try {
            await this.setNotifications(true);
            await this._ensureIdle();
            this.following = true;
            this.running = false;
            this.prepared = null;
            this._wantStart = false;
            this._stopAfter = false;
            this._lastInhaleT = 0;
            this._targetInhaleT = 0;
            this._targetSeq = 0;
            this._eventSeq = 0;
            this._lastStartSendT = 0;
            await this._prepare();
            return this.following;
        } catch (err) {
            this._fail(err);
            return false;
        }
    }

    /** Neuen Soll-Rhythmus vormerken (gilt ab dem nächsten Atemzug). */
    setRhythm(rhythm) {
        this.rhythm = { ...rhythm };
        this._trace('rhythm', { rhythm: { ...rhythm } });
        if (this.following && this._tooFast && !this.running && !this._preparing) this._prepare();
    }

    /** Von app.js bei jedem Phasenwechsel des Pacers aufzurufen. */
    onPacerPhase(phase) {
        this._trace('pacer', { phase, following: this.following });
        if (phase !== 'inhale') return;
        const now = performance.now();
        const prev = this._lastInhaleT;
        this._lastInhaleT = now;
        this._eventSeq++;
        if (!this.following) return;
        // Wurde der Atemzug schon mit Vorhalt vor diesem Signal gestartet (2. Hälfte des Zyklus), nichts tun
        if (prev > 0 && this._lastStartSendT > prev + 0.5 * (now - prev)) return;
        // Ohne Vorhalt (erster Atemzug, Programm zu spät bereit): Start mit dem Einatem-Signal. Bewusst erst nach
        // der aktuellen Verarbeitung, damit ein Rhythmuswechsel des Adaptiven Trainings noch einfließt.
        setTimeout(() => this._startBreath(), 0);
    }

    /** Den gerade laufenden (oder als Nächstes startenden) Atemzug noch zu Ende führen, danach nichts Neues mehr starten. */
    stopAfterCurrent() {
        this._stopAfter = true;
        clearTimeout(this._leadTimer);
    }

    /** Beendet die Kopplung; ein laufender Atemzug wird noch zu Ende geführt. */
    async release() {
        this.following = false;
        this._wantStart = false;
        clearTimeout(this._leadTimer);
        if (this.running) await this._waitSessionEnd(IDLE_WAIT_MS);
    }

    async _prepare() {
        if (!this.following || this.running || this._preparing) return;
        this._preparing = true;
        try {
            const program = this._programFor(this.rhythm);
            if (!program) {
                this.prepared = null;
                this._trace('decision', { what: 'too-fast' });
                if (!this._tooFast) this.onNotice?.('Rhythmus zu schnell für das Moonbird (Atemzug unter ca. 8 s) – Moonbird pausiert.');
                this._tooFast = true;
                return;
            }
            this._tooFast = false;
            const key = rhythmKey(this.rhythm);
            const reply = await this._request(program);
            if (!MoonbirdController._ok(reply)) {
                throw new Error(`Programm abgelehnt (${Array.from(reply.slice(0, 3), b => b.toString(16).padStart(2, '0')).join(' ')})`);
            }
            this.prepared = key;
            this._preparedAt = performance.now();
        } catch (err) {
            this._preparing = false;
            this._fail(err);
            return;
        }
        this._preparing = false;
        if (this._wantStart) this._startBreath();
        else this._scheduleStart();
    }

    async _startBreath() {
        if (!this.following || this._starting) return;

        // Ende-Ereignis verpasst? Dann läuft laut Status nichts mehr, obwohl wir es glauben.
        if (this.running && Date.now() - this._runStartedAt > this._runExpectedMs + STALE_RUN_GRACE_MS) {
            try { if (!(await this._queryRunning())) this.running = false; } catch (err) { this._fail(err); return; }
        }

        if (this.running || this._preparing) {
            this._trace('decision', { what: this.running ? 'wait-running' : 'wait-preparing' });
            this._wantStart = true;
            return;
        }
        if (this.prepared !== rhythmKey(this.rhythm)) {
            // nichts vorbereitet oder der Rhythmus hat sich zwischenzeitlich geändert
            this._trace('decision', { what: this.prepared === null ? 'prepare-missing' : 'reprepare' });
            this._reprepared = true;
            this._wantStart = true;
            this._prepare();
            return;
        }

        this._wantStart = false;
        this._starting = true;
        clearTimeout(this._leadTimer);
        const early = this._targetSeq > this._eventSeq;   // Start gehört zu einem noch bevorstehenden Einatem-Signal
        const lead = this.startLeadMs;
        this._adaptOverhead(early ? this._targetInhaleT : this._lastInhaleT, lead);
        this._lastStartSendT = performance.now();
        try {
            const prog = this._lastProgram ? { ...this._lastProgram } : null;
            const reply = await this._request(START_CMD);
            if (MoonbirdController._ok(reply)) {
                this.running = true;
                this.prepared = null;
                this._runStartedAt = Date.now();
                this._trace('session', { prog, tReply: reply.tRecv, early, lead: early ? lead : 0 });
                this._afterStart(this._lastCmdSend(0x07), reply.tRecv);
            } else {
                this._trace('decision', { what: 'start-rejected' });
                this._wantStart = true; // vermutlich lief noch eine Session — nach deren Ende erneut versuchen
            }
        } catch (err) {
            this._fail(err);
        } finally {
            this._starting = false;
        }
    }

    /**
     * Schätzt die reale Lücke zwischen Geräte-Ende und Start des nächsten Atemzugs (Funkweg des Handys)
     * und stellt danach die Kürzung der Ausatmung ein.
     *
     * A = Zeitpunkt "Programm bereit" relativ zum Einatem-Signal (>0: zu spät, <0: Reserve). Der Verzug
     * ist ein Integrator der Fehlbeträge; deshalb wird NICHT auf den Verzug selbst geregelt (das schwingt),
     * sondern die Lücke aus der Änderung von A geschätzt:
     *     A_k = max(A_k-1, 0) + Lücke − Budget_k-1   →   Lücke = A_k − max(A_k-1, 0) + Budget_k-1
     * Neues Budget = Lücke + kleine Reserve + der halbe aufgelaufene Rückstand (holt Verzug stetig auf).
     * Rhythmuswechsel-Atemzüge (Neuvorbereitung) und der erste Atemzug gehen nicht in die Schätzung ein.
     */
    _adaptOverhead(inhaleRef, lead = 0) {
        // Bereitschaft relativ zum Zeitpunkt, an dem der Startbefehl idealerweise gesendet würde
        const A = this._preparedAt - (inhaleRef - lead);
        const budget = this._lastBudget;
        const prevA = this._prevA, prevBudget = this._prevBudget;
        const contaminated = this._reprepared;            // Neuvorbereitung verfälscht A (nicht das Budget)
        const skip = contaminated || this._breathCount === 0 || !inhaleRef || prevA == null;
        this._reprepared = false;
        this._breathCount++;
        // Der erste Atemzug liefert einen gültigen Vorgängerwert (lange vorher bereit, A ≪ 0), ein verunreinigter nicht
        this._prevA = (contaminated || !inhaleRef) ? null : A;
        this._prevBudget = (contaminated || !inhaleRef) ? null : budget;
        if (skip) return;

        const gap = A - Math.max(prevA, 0) + prevBudget;
        if (!Number.isFinite(gap) || gap < 0 || gap > 3000) return;      // unplausibel (z. B. Timer-Aussetzer)
        this._gapEma = this._gapEma == null ? gap : 0.5 * this._gapEma + 0.5 * gap;
        const before = this._overheadMs;
        this._overheadMs = Math.max(OVERHEAD_MIN_MS, Math.min(OVERHEAD_MAX_MS, this._gapEma + SLACK_MARGIN_MS + 0.5 * Math.max(A, 0)));
        this._trace('decision', { what: 'overhead', from: before, to: this._overheadMs, A, gap });
    }

    _onSessionEnd(tRecv = performance.now()) {
        if (this._predEnd) {
            // Vorhersage nachführen: wie spät kam das Ende-Ereignis gegenüber der Erwartung?
            this._recentBias.push(Math.max(-END_BIAS_MAX_MS, Math.min(END_BIAS_MAX_MS, tRecv - this._predEnd)));
            if (this._recentBias.length > 5) this._recentBias.shift();
            const sorted = [...this._recentBias].sort((a, b) => a - b);
            this._endBias = sorted[Math.floor(sorted.length / 2)];
            this._trace('decision', { what: 'end-bias', bias: tRecv - this._predEnd });
        }
        this._clearGate();
        this.running = false;
        if (this._stopAfter) { this._stopAfter = false; this.following = false; }
        this._endListeners.splice(0).forEach(fn => fn(true));
        if (this.following) this._prepare();
    }

    // ─── Stream-Trick ────────────────────────────────────────────────────────

    _lastCmdSend(op) {
        for (let i = this.trace.length - 1; i >= 0; i--) {
            const e = this.trace[i];
            if (e.type === 'cmd' && e.op === op) return e.tSend;
        }
        return performance.now();
    }

    _clearGate() {
        clearTimeout(this._leadTimer);
        this._leadTimer = null;
        clearTimeout(this._endTimer);
        clearTimeout(this._fallbackTimer);
        this._endTimer = this._fallbackTimer = null;
        this._predEnd = 0;
    }

    /** Nach erfolgreichem Start: Datenstrom abschalten, Wiedereinschalten für das Ende vorplanen. */
    _afterStart(tSend, tReply) {
        this._clearGate();
        if (!this.gateStream) return;
        const startMid = (tSend + tReply) / 2;
        this._predEnd = startMid + this._runExpectedMs + this._endBias;
        this.setNotifications(false).catch((err) => this._fail(err));
        this._endTimer = setTimeout(() => this._armEnd(), Math.max(0, this._predEnd - GATE_LEAD_MS - performance.now()));
    }

    async _armEnd() {
        if (!this.running) return;
        try { await this.setNotifications(true); } catch (err) { this._fail(err); return; }
        // Ende-Ereignis nicht angekommen (z. B. zu spät eingeschaltet)? Dann per Status nachsehen.
        this._fallbackTimer = setTimeout(() => this._checkEnded(), Math.max(0, this._predEnd + END_FALLBACK_MS - performance.now()));
    }

    async _checkEnded() {
        if (!this.running) return;
        try {
            const r = await this._request(new Uint8Array([OP_STATUS]));
            if (r[3] !== STATE_RUNNING) {
                this._trace('decision', { what: 'end-missed' });
                this._predEnd = 0;   // keine Bias-Auswertung ohne echtes Ereignis
                this._onSessionEnd();
            } else {
                this._fallbackTimer = setTimeout(() => this._checkEnded(), 800);
            }
        } catch (err) { this._fail(err); }
    }

    // ─── Fehler ──────────────────────────────────────────────────────────────

    _fail(err) {
        console.error('Moonbird:', err);
        this._trace('decision', { what: 'fail', error: err.message });
        const wasFollowing = this.following;
        this.following = false;
        this._wantStart = false;
        if (wasFollowing) this._error(`Moonbird-Steuerung beendet: ${err.message}`);
    }

    _error(msg) {
        this.onError?.(msg);
    }
}
