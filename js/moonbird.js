/**
 * Moonbird-Steuerung (Haptik-Atemgerät) via Web Bluetooth
 *
 * Das Moonbird kennt nur "Sessions": Programm setzen (Opcode 05), Session
 * starten (07), stoppen (08). Solange eine Session läuft, lehnt es neue Programme
 * ab. Eine Session endet immer erst am Ende der Ausatmung (Ende-Ereignis: 0xF1) —
 * bei 08 am Ende der Ausatmung des laufenden Zyklus, sonst nach Ablauf der Dauer.
 *
 * Betriebsart "Langsession": Das Moonbird bekommt EINE lange Session mit dem exakten
 * Rhythmus des Pacers und atmet danach allein, auf seiner eigenen Uhr — ohne Funkverkehr,
 * ohne Kürzung einzelner Atemzüge. Der Rhythmus stimmt so bei jedem Atemzug mit dem Pacer
 * überein (nur die Uhren beider Geräte laufen minimal auseinander).
 *
 * Ändert das Adaptive Training den Rhythmus, geht das nur über Stopp und Neustart:
 *   08 (Ende am Ausatem-Ende des laufenden Zyklus) → F1 → 05 (neues Programm) → 07 (Start).
 * Damit Pacer und Moonbird dabei nicht auseinanderlaufen, wird der Wechsel an eine Zyklusgrenze
 * gelegt: Der Pacer läuft den laufenden Zyklus mit dem alten Rhythmus zu Ende, bleibt in der Pause
 * stehen und beginnt den neuen Zyklus genau dann, wenn das Moonbird startet. Die Pause nach dem
 * Ausatmen des letzten alten Zyklus deckt die Funkzeit ab (Ende melden, 05, 07 ≈ 0,4–0,5 s):
 * ist die Pause des Rhythmus mindestens so lang, merkt man den Wechsel gar nicht; sonst verlängert
 * sich diese eine Pause um den Rest.
 *
 * Während einer laufenden Session sendet das Moonbird ~20 Sensor-Notifications
 * pro Sekunde (91 Byte). Auf dem Handy verstopft das die Funkstrecke: Antworten
 * und das Ende-Ereignis kommen um Sekunden verspätet. Deshalb werden die
 * Benachrichtigungen (CCCD) direkt nach dem Start abgeschaltet und erst kurz vor
 * dem erwarteten Ende wieder eingeschaltet (F1 geht sonst verloren). Zwischen den
 * Wechseln gibt es dadurch überhaupt keinen Funkverkehr.
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
const STOP_CMD  = new Uint8Array([OP_STOP]);
const STATUS_CMD = new Uint8Array([OP_STATUS]);

const SESSION_MS         = 600000;    // Dauer der Langsession (wie die Voreinstellung des Geräts); danach Erneuerung wie ein Wechsel
const MIN_SESSION_MS     = 8000;      // kürzere Dauern lehnt das Moonbird ab
const REQUEST_TIMEOUT_MS = 3000;
const IDLE_WAIT_MS       = 15000;     // so lange auf das Ende einer laufenden Session warten
const GATE_LEAD_MS       = 600;       // Benachrichtigungen so lange vor dem erwarteten Ende wieder an
const END_WAIT_MS        = 900;       // so lange nach dem erwarteten Ende auf F1 warten, bevor der Status abgefragt wird
const END_BIAS_MAX_MS    = 400;
const STOP_MIN_LEAD_MS   = 600;       // Stopp muss so lange vor dem Ausatem-Ende (plus Funklaufzeit) beim Moonbird sein
const STOP_EARLY_MARGIN_MS = 100;
const DEVICE_START_MS    = 120;       // Moonbird beginnt so lange nach Eintreffen des Startbefehls (am PC und Handy ~110–130 ms)
const DEFAULT_LEAD_MS    = 200;       // Vorhalt, solange noch keine Schreib-Bestätigung gemessen wurde
const LEAD_MAX_MS        = 450;
const START_REPLY_TIMEOUT_MS = 1200;
const MAX_REPLANS        = 2;         // so oft darf ein Wechsel auf das nächste Zyklusende ausweichen
const MAX_FAILURES       = 2;         // so viele Wechsel in Folge dürfen scheitern, danach wird das Moonbird abgekoppelt

function cycleMs(r) { return r.inhale + (r.holdIn || 0) + r.exhale + (r.holdOut || 0); }

function hex(bytes, n = 8) {
    return Array.from(bytes.slice(0, n), b => b.toString(16).padStart(2, '0')).join('');
}

function sleepUntil(t) {
    const ms = t - performance.now();
    return ms <= 0 ? Promise.resolve() : new Promise(r => setTimeout(r, ms));
}

export class MoonbirdController {
    constructor() {
        this.device = null;
        this._writeChar = null;
        this._notifyChar = null;
        this.isConnected = false;

        this.active = false;      // Langsession läuft und ist an den Pacer gekoppelt
        this.session = null;      // { rhythm, anchor, duration } — anchor: Startzeit des aktuellen Zyklus-Rasters (performance.now())
        this._hooks = null;       // { hold(T), commit(rhythm, S), cancel() } — Pacer-Anbindung (app.js)
        this._switching = false;
        this._token = 0;          // wird bei release/Trennung erhöht und bricht laufende Wechsel ab
        this._failures = 0;
        this._renewTimer = null;

        this._waiters = new Map();      // Antwort-Opcode → { resolve, reject, timer }
        this._endListeners = [];
        this._chain = Promise.resolve(); // serialisiert GATT-Operationen

        // Zeitprotokoll für die Diagnose (moonbirdDiagnostics.js): Pacer-Phasen, Befehle
        // mit Sende-/Schreib-/Antwortzeit, Ende-Ereignisse, Wechsel. Zeiten: performance.now().
        this.trace = [];

        // Stream-Trick: Benachrichtigungen während der Session aus (siehe Kopfkommentar).
        // Abschaltbar, um vorher/nachher zu vergleichen (Diagnose).
        this.gateStream = true;
        this._notifyOn = false;
        this._predEnd = 0;
        this._lastEndT = 0;
        this._endBias = 0;              // gemessene Abweichung Ende-Ereignis − Vorhersage (Median der letzten 5)
        this._recentBias = [];
        // Vorhalt: Startbefehl so viel VOR dem gewünschten Start senden, wie das Moonbird zum Losgehen braucht.
        this.leadOverrideMs = null;     // z. B. aus der Kalibrierung (Diagnose: Gerätestart nach Senden)
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

    /** Alter Name aus der Kettenbetrieb-Zeit: true, solange das Moonbird an den Pacer gekoppelt ist. */
    get following() { return this.active; }

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
        this.active = false;
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
        this.active = false;
        this.session = null;
        this._token++;
        clearTimeout(this._renewTimer);
        for (const w of this._waiters.values()) {
            clearTimeout(w.timer);
            w.reject(new Error('Moonbird getrennt'));
        }
        this._waiters.clear();
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

    /** Wartet auf die Antwort-Notification mit dem Opcode; lehnt nach timeoutMs ab. */
    _waitReply(replyOp, timeoutMs) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this._waiters.get(replyOp)?.timer === timer) this._waiters.delete(replyOp);
                reject(new Error('Moonbird antwortet nicht'));
            }, timeoutMs);
            this._waiters.set(replyOp, { resolve, reject, timer });
        });
    }

    _newRec(bytes) {
        return { op: bytes[0], tQueued: performance.now(), tSend: null, tWritten: null, tReply: null, reply: null, error: null };
    }

    _finishRec(rec) { this.trace.push({ type: 'cmd', t: rec.tQueued, ...rec }); }

    /** Befehl senden und auf die Antwort-Notification warten (GATT-Zugriffe laufen nacheinander). */
    _request(bytes, timeoutMs = REQUEST_TIMEOUT_MS) {
        const replyOp = bytes[0] | REPLY_FLAG;
        const rec = this._newRec(bytes);
        const run = async () => {
            if (!this.isConnected) throw new Error('Moonbird nicht verbunden');
            // Ohne Benachrichtigungen käme keine Antwort — sicherheitshalber einschalten
            if (!this._notifyOn) await this._applyNotify(true);
            const reply = this._waitReply(replyOp, timeoutMs);
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
        const p = this._enqueue(run);
        p.then((reply) => {
            rec.tReply = reply.tRecv ?? performance.now();
            rec.reply = hex(reply);
            this._finishRec(rec);
        }, (err) => { rec.error = err.message; this._finishRec(rec); });
        return p;
    }

    /**
     * Wie _request, gibt die GATT-Verbindung aber schon nach der Schreib-Bestätigung frei, damit der nächste Befehl
     * nicht auf die Antwort-Notification warten muss. Liefert { rec, wrote, reply }: wrote löst nach der Bestätigung
     * auf, reply mit der Antwort (Bytes mit .tRecv).
     */
    _requestEarly(bytes, timeoutMs = REQUEST_TIMEOUT_MS) {
        const replyOp = bytes[0] | REPLY_FLAG;
        const rec = this._newRec(bytes);
        let replyP = null;
        const wrote = this._enqueue(async () => {
            if (!this.isConnected) throw new Error('Moonbird nicht verbunden');
            if (!this._notifyOn) await this._applyNotify(true);
            replyP = this._waitReply(replyOp, timeoutMs);
            replyP.catch(() => {});
            rec.tSend = performance.now();
            try {
                await this._write(bytes);
                rec.tWritten = performance.now();
            } catch (err) {
                const w = this._waiters.get(replyOp);
                if (w) { clearTimeout(w.timer); this._waiters.delete(replyOp); }
                throw err;
            }
        });
        const reply = wrote.then(() => replyP);
        reply.then((r) => {
            rec.tReply = r.tRecv ?? performance.now();
            rec.reply = hex(r);
            this._finishRec(rec);
        }, (err) => { rec.error = err.message; this._finishRec(rec); });
        wrote.catch(() => {});
        reply.catch(() => {});
        return { rec, wrote, reply };
    }

    /** Befehl senden, ohne auf eine Antwort zu warten (Stopp: die Antwort brauchen wir nicht, das Ende meldet F1). */
    _sendOnly(bytes) {
        const rec = this._newRec(bytes);
        const p = this._enqueue(async () => {
            if (!this.isConnected) throw new Error('Moonbird nicht verbunden');
            rec.tSend = performance.now();
            await this._write(bytes);
            rec.tWritten = performance.now();
        });
        p.then(() => this._finishRec(rec), (err) => { rec.error = err.message; this._finishRec(rec); });
        return p.then(() => rec);
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
        return { SESSION_MS, MIN_SESSION_MS };
    }

    /** Median der letzten Schreib-Bestätigungen (Funkweg-Rundlauf) oder null, wenn weniger als minCount vorliegen. */
    _medianAck(minCount = 1) {
        const acks = [];
        for (let i = this.trace.length - 1; i >= 0 && acks.length < 8; i--) {
            const e = this.trace[i];
            if (e.type === 'cmd' && e.tWritten != null && e.tSend != null) acks.push(e.tWritten - e.tSend);
        }
        if (acks.length < minCount) return null;
        acks.sort((a, b) => a - b);
        return acks[Math.floor(acks.length / 2)];
    }

    /** Vorhalt in ms: Zeit vom Senden des Startbefehls bis das Moonbird losgeht (Schreib-Bestätigung/2 + Startverzögerung). */
    get startLeadMs() {
        if (this.leadOverrideMs != null) return Math.max(0, Math.min(LEAD_MAX_MS, this.leadOverrideMs));
        const ack = this._medianAck(2);
        return ack == null ? DEFAULT_LEAD_MS : Math.max(0, Math.min(LEAD_MAX_MS, ack / 2 + DEVICE_START_MS));
    }

    /** Geschätzte Zeit vom Senden bis zum Gerätestart für genau diesen Startbefehl (mit seiner eigenen Bestätigungszeit). */
    _startDelay(tSend, tWritten) {
        if (this.leadOverrideMs != null) return Math.max(0, Math.min(LEAD_MAX_MS, this.leadOverrideMs));
        return Math.max(0, Math.min(2000, (tWritten - tSend) / 2 + DEVICE_START_MS));   // Schätzung, nicht Planung: auch langsame Strecken abbilden
    }

    async _queryRunning() {
        const r = await this._request(STATUS_CMD);
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
        await this._request(STOP_CMD);
        await ended;
        if (await this._queryRunning()) throw new Error('Moonbird beendet die laufende Session nicht');
    }

    _onSessionEnd(tRecv = performance.now()) {
        this._lastEndT = tRecv;
        if (this._predEnd) {
            // Vorhersage nachführen: wie spät kam das Ende-Ereignis gegenüber der Erwartung?
            const bias = tRecv - this._predEnd;
            this._recentBias.push(Math.max(-END_BIAS_MAX_MS, Math.min(END_BIAS_MAX_MS, bias)));
            if (this._recentBias.length > 5) this._recentBias.shift();
            const sorted = [...this._recentBias].sort((a, b) => a - b);
            this._endBias = sorted[Math.floor(sorted.length / 2)];
            this._trace('decision', { what: 'end-bias', bias });
            this._predEnd = 0;
        }
        this._endListeners.splice(0).forEach(fn => fn(true));
    }

    // ─── Langsession ─────────────────────────────────────────────────────────

    /**
     * Startet die Langsession mit dem Rhythmus und liefert den (geschätzten) Startzeitpunkt des Geräts
     * (performance.now()-Zeit). Der Pacer beginnt seinen ersten Zyklus zu genau dieser Zeit.
     *
     * @param {{inhale:number,holdIn:number,exhale:number,holdOut:number}} rhythm
     * @param {{hold?:(T:number)=>void, commit?:(rhythm:object, S:number)=>void, cancel?:()=>void, renewed?:(res:object)=>void}} [hooks]
     *        Pacer-Anbindung für spätere Rhythmuswechsel: hold(T) = am Zyklusende T anhalten,
     *        commit(rhythm, S) = neuen Rhythmus ab S beginnen, cancel() = mit dem alten Rhythmus weiter,
     *        renewed(res) = die Session wurde ohne Rhythmusänderung erneuert (res.effectiveTs).
     * @param {string} [source] 'training' oder 'diag' (Zuordnung im Zeitprotokoll)
     * @returns {Promise<{startTs:number}|null>} null bei Fehlern (Moonbird nicht bereit)
     */
    async begin(rhythm, hooks = {}, source = 'training') {
        if (!this.isConnected) return null;
        const token = ++this._token;
        this._hooks = hooks;
        this.active = false;
        this._failures = 0;
        clearTimeout(this._renewTimer);
        const rec = { begin: true, rhythm: { ...rhythm } };
        this._trace('follow', { rhythm: { ...rhythm }, source });
        try {
            await this.setNotifications(true);
            await this._ensureIdle();
            if (token !== this._token) return null;
            let S = null;
            await this._startSession(rhythm, 0, token, rec, (s) => { S = s; });
            if (token !== this._token) {   // während des Starts beendet/getrennt: die gerade gestartete Session wieder stoppen
                if (this.isConnected) this._sendOnly(STOP_CMD).catch(() => {});
                return null;
            }
            this.session = { rhythm: { ...rhythm }, anchor: S, duration: SESSION_MS };
            this.active = true;
            this._trace('session', { begin: true, anchor: S, rhythm: { ...rhythm }, tSend: rec.tSend, tWritten: rec.tWritten });
            this._scheduleRenewal();
            return { startTs: S };
        } catch (err) {
            this._fail(err);
            return null;
        }
    }

    /**
     * Programm setzen und Session starten. `notBefore` (performance.now()-Zeit, 0 = sofort): das Gerät soll dann
     * beginnen — der Startbefehl geht um den Vorhalt früher raus. `onStarted(S)` wird sofort nach der Schreib-
     * Bestätigung des Startbefehls gerufen (S = geschätzter Gerätestart), noch bevor die Antwort da ist.
     */
    async _startSession(rhythm, notBefore, token, rec, onStarted) {
        const prog = MoonbirdController.programBytes(rhythm.holdOut || 0, rhythm.inhale, rhythm.holdIn || 0, rhythm.exhale, SESSION_MS);
        for (let attempt = 0; ; attempt++) {
            const p = this._requestEarly(prog);
            await p.wrote;
            const reply = await p.reply;
            if (MoonbirdController._ok(reply)) break;
            if (attempt >= 2) throw new Error(`Programm abgelehnt (${hex(reply, 3)})`);
            await new Promise(r => setTimeout(r, 150));   // z. B. Ende-Ereignis kam vor dem Idle-Zustand
        }
        rec.t05 = performance.now();
        if (token !== this._token) throw new Error('abgebrochen');

        if (notBefore) await sleepUntil(notBefore - this.startLeadMs);
        if (token !== this._token) throw new Error('abgebrochen');

        for (let attempt = 0; ; attempt++) {
            const s = this._requestEarly(START_CMD, START_REPLY_TIMEOUT_MS);
            await s.wrote;
            rec.tSend = s.rec.tSend;
            rec.tWritten = s.rec.tWritten;
            const S = s.rec.tSend + this._startDelay(s.rec.tSend, s.rec.tWritten);
            rec.S = S;
            onStarted(S);
            let reply = null;
            try { reply = await s.reply; } catch { rec.startUnconfirmed = true; }   // Antwort kann ausbleiben, gestartet hat es trotzdem meist
            if (!reply || MoonbirdController._ok(reply)) break;
            if (attempt >= 1) throw new Error(`Start abgelehnt (${hex(reply, 3)})`);
            await new Promise(r => setTimeout(r, 200));
        }
        if (this.gateStream) this.setNotifications(false).catch((err) => this._fail(err));
    }

    /** Vorausplanen: kurz vor Ablauf der Session-Dauer wie einen Wechsel behandeln (gleicher Rhythmus, neue Session). */
    _scheduleRenewal() {
        clearTimeout(this._renewTimer);
        if (!this.session || !this._hooks) return;
        const s = this.session;
        const at = s.anchor + s.duration - 2 * cycleMs(s.rhythm) - 4000;
        this._renewTimer = setTimeout(() => {
            if (this.active && !this._switching) this.switchRhythm(this.session.rhythm, { renew: true });
            else if (this.active) this._renewTimer = setTimeout(() => this._scheduleRenewal(), 3000);
        }, Math.max(0, at - performance.now()));
    }

    /**
     * Rhythmuswechsel an der nächsten Zyklusgrenze (siehe Kopfkommentar).
     * @returns {Promise<{ok:boolean, effectiveTs?:number, extraPauseMs?:number, decoupled?:boolean, reason?:string}>}
     *   effectiveTs = Beginn des ersten Zyklus mit dem neuen Rhythmus (Pacer und Moonbird).
     */
    async switchRhythm(newRhythm, opts = {}) {
        if (!this.active || !this.session) return { ok: false, reason: 'inaktiv' };
        if (this._switching) return { ok: false, reason: 'busy' };
        this._switching = true;
        const token = this._token;
        const rec = { tRequest: performance.now(), renew: !!opts.renew, from: { ...this.session.rhythm }, to: { ...newRhythm }, replans: 0 };
        let res;
        try {
            res = await this._doSwitch(newRhythm, rec, token);
        } catch (err) {
            res = { ok: false, reason: err.message, stage: rec.stage };
        }
        this._switching = false;
        rec.ok = res.ok;
        if (res.reason) rec.reason = res.reason;
        if (token !== this._token) {                       // beendet/getrennt: Pacer ist nicht mehr unser Problem
            this._trace('switch', rec);
            return { ok: false, decoupled: true, reason: res.reason || 'beendet' };
        }
        const hooks = this._hooks || {};
        if (!res.ok) {
            if (rec.stage === 'restart') {
                // Moonbird steht still (Stopp hat gewirkt, Neustart nicht): der Pacer soll mit dem neuen Rhythmus weiterlaufen
                this._safe(() => hooks.commit?.(newRhythm, performance.now()));
                res = { ok: true, effectiveTs: performance.now(), decoupled: true, reason: res.reason };
                this._decouple(`Moonbird konnte nicht neu gestartet werden (${rec.reason || 'unbekannt'}) – Training läuft ohne Moonbird weiter.`);
            } else {
                this._safe(() => hooks.cancel?.());
                this._failures++;
                if (this._failures >= MAX_FAILURES) {
                    res.decoupled = true;
                    this._decouple('Moonbird reagiert nicht auf Rhythmuswechsel – Training läuft ohne Moonbird weiter.');
                }
            }
        } else {
            this._failures = 0;
            if (opts.renew) this._safe(() => hooks.renewed?.(res));   // gleicher Rhythmus, aber neue Zeitachse (Pause um extraPauseMs länger)
        }
        this._trace('switch', rec);
        return res;
    }

    _safe(fn) { try { fn(); } catch (err) { console.error('Moonbird-Hook:', err); } }

    /** Kopplung beenden (Fehlerfall): Moonbird stoppen lassen, Meldung an den Nutzer. */
    _decouple(message) {
        const wasActive = this.active;
        this.active = false;
        this._token++;
        clearTimeout(this._renewTimer);
        if (this.isConnected) this._sendOnly(STOP_CMD).catch(() => {});
        if (wasActive) this.onNotice?.(message);
    }

    async _doSwitch(newRhythm, rec, token) {
        const hooks = this._hooks || {};
        const s = this.session;
        const old = s.rhythm;
        const cyc = cycleMs(old);
        const hoOld = old.holdOut || 0;
        const ack = this._medianAck(1) ?? 150;
        const minStopLead = Math.max(STOP_MIN_LEAD_MS, ack + 450);

        // Zyklusende wählen, dessen Ausatem-Ende weit genug entfernt liegt, damit der Stopp-Befehl noch davor ankommt
        let n = Math.max(1, Math.ceil((performance.now() + minStopLead + hoOld - s.anchor) / cyc));
        let T = s.anchor + n * cyc;      // Zyklusende (Pacer beginnt hier normalerweise den nächsten Zyklus)
        let E = T - hoOld;               // Ende der Ausatmung = Ende der Session nach dem Stopp
        rec.n = n; rec.T = T; rec.E = E; rec.stage = 'stop';
        this._safe(() => hooks.hold?.(T));

        // 1) Stopp: die Session endet am Ausatem-Ende des Zyklus, in dem der Befehl ankommt
        let stopRec = null;
        for (let attempt = 0; !stopRec; attempt++) {
            try { stopRec = await this._sendOnly(STOP_CMD); }
            catch (err) { if (attempt >= 1) return { ok: false, reason: `Stopp fehlgeschlagen: ${err.message}` }; }
        }
        if (token !== this._token) return { ok: false, reason: 'beendet' };
        rec.tStop = stopRec.tWritten;
        const stopAck = stopRec.tWritten - stopRec.tSend;
        // Kam der Befehl zu spät (nach dem Ausatem-Ende), endet die Session erst am nächsten
        while (stopRec.tWritten - stopAck / 2 > E - STOP_EARLY_MARGIN_MS && rec.replans < MAX_REPLANS) {
            rec.replans++; n++; T += cyc; E += cyc;
            this._safe(() => hooks.hold?.(T));
        }

        // 2) Ende der Session abwarten (F1; Status als Rückfall)
        const end = await this._awaitEnd(E, cyc, token, (E2) => {
            rec.replans++;
            E = E2; T = E2 + hoOld;
            this._safe(() => hooks.hold?.(T));
        }, rec.replans);
        if (token !== this._token) return { ok: false, reason: 'beendet' };
        rec.E = E; rec.T = T;
        rec.tEnd = end.tEnd; rec.endLost = !!end.lost; rec.tEndCheck = end.tCheck;
        if (!end.ended) return { ok: false, reason: 'Session endet nicht' };

        // 3) Programm setzen und zum Zyklusende T starten; der Pacer beginnt zur geschätzten Startzeit S
        rec.stage = 'restart';
        rec.lead = this.startLeadMs;
        let S = null;
        await this._startSession(newRhythm, T, token, rec, (s2) => {
            S = s2;
            this._safe(() => hooks.commit?.(newRhythm, Math.max(s2, T)));
        });
        if (token !== this._token) return { ok: false, reason: 'beendet' };

        const anchor = Math.max(S, T);
        this.session = { rhythm: { ...newRhythm }, anchor, duration: SESSION_MS };
        rec.S = anchor;
        rec.extraPauseMs = anchor - T;
        this._trace('session', { begin: false, anchor, rhythm: { ...newRhythm }, tSend: rec.tSend, tWritten: rec.tWritten });
        this._scheduleRenewal();
        return { ok: true, effectiveTs: anchor, extraPauseMs: anchor - T };
    }

    /**
     * Wartet auf das Ende der Session am erwarteten Ausatem-Ende E: Benachrichtigungen kurz vorher an, auf F1 warten,
     * danach (ohne F1) Status abfragen. Läuft die Session dann noch, kam der Stopp zu spät: auf das nächste Ausatem-
     * Ende ausweichen (onReplan).
     */
    async _awaitEnd(E, cyc, token, onReplan, replansUsed = 0) {
        let replans = replansUsed;
        for (;;) {
            const bias = this._endBias;
            this._predEnd = E;
            await sleepUntil(E + bias - GATE_LEAD_MS);
            if (token !== this._token) return { ended: false };
            const endP = this._waitSessionEnd(Math.max(800, E + bias + END_WAIT_MS - performance.now()));
            await this.setNotifications(true);
            if (await endP) return { ended: true, tEnd: this._lastEndT };

            // F1 nicht angekommen: Status ansehen (kann auch schon vor dem Einschalten der Benachrichtigungen geendet haben)
            const tCheck = performance.now();
            let running = null;
            try { running = MoonbirdController.parseStatus(await this._request(STATUS_CMD, 2500)).running; } catch { /* Timeout */ }
            if (token !== this._token) return { ended: false };
            if (running === false) { this._predEnd = 0; return { ended: true, lost: true, tEnd: performance.now(), tCheck }; }
            if (running === null) {
                // keine Antwort (Funkstau?): noch einmal auf F1 warten
                if (await this._waitSessionEnd(1500)) return { ended: true, tEnd: this._lastEndT, tCheck };
                return { ended: false, tCheck };
            }
            if (replans >= MAX_REPLANS) { this._predEnd = 0; return { ended: false, tCheck }; }
            // läuft noch → das Ende kommt erst am nächsten Zyklusende
            replans++;
            E += cyc;
            onReplan?.(E);
            if (this.gateStream) await this.setNotifications(false);
        }
    }

    /** Pacer-Phasenwechsel nur protokollieren (Diagnose): Zuordnung Pacer ↔ Moonbird. */
    onPacerPhase(phase) {
        this._trace('pacer', { phase, following: this.active });
    }

    /**
     * Beendet die Kopplung: Stopp-Befehl, das Moonbird hört am Ende der laufenden Ausatmung auf.
     * @param {{wait?:boolean}} [opts] wait: auf das tatsächliche Ende warten (Diagnose)
     */
    async release({ wait = false } = {}) {
        const wasActive = this.active || this._switching;
        const session = this.session;
        this.active = false;
        this._token++;              // laufenden Wechsel abbrechen
        this._switching = false;
        clearTimeout(this._renewTimer);
        this._hooks = null;
        if (!wasActive || !this.isConnected) return;
        let stopRec = null;
        try { stopRec = await this._sendOnly(STOP_CMD); } catch { return; }
        this._trace('decision', { what: 'release' });
        if (!wait || !session) return;
        // Ende abwarten: nächstes Ausatem-Ende nach Eintreffen des Stopps
        const cyc = cycleMs(session.rhythm), hoOld = session.rhythm.holdOut || 0;
        const arrive = stopRec.tWritten - (stopRec.tWritten - stopRec.tSend) / 2 + STOP_EARLY_MARGIN_MS;
        const n = Math.max(1, Math.ceil((arrive + hoOld - session.anchor) / cyc));
        const token = this._token;
        await this._awaitEnd(session.anchor + n * cyc - hoOld, cyc, token, null, MAX_REPLANS - 1);
    }

    // ─── Fehler ──────────────────────────────────────────────────────────────

    _fail(err) {
        console.error('Moonbird:', err);
        this._trace('decision', { what: 'fail', error: err.message });
        const was = this.active;
        this.active = false;
        clearTimeout(this._renewTimer);
        if (was) this._error(`Moonbird-Steuerung beendet: ${err.message}`);
        else this._error(`Moonbird nicht bereit: ${err.message}`);
    }

    _error(msg) {
        this.onError?.(msg);
    }
}
