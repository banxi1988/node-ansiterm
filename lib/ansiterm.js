"use strict";
const events_1 = require("events");
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */
/*
 * Copyright (c) 2014, Joshua M. Clulow
 * Copyright (c) 2017, Cody Mello
 */
/* vim: set ts=8 sts=8 sw=8 noet: */
const assert = require("assert-plus");
const mod_buffer = require("safer-buffer");
const mod_jsprim = require("jsprim");
const mod_util = require("util");
const mod_events = require("events");
const mod_grapheme = require("./grapheme");
const mod_linedraw = require("./linedraw");
const Buffer = mod_buffer.Buffer;
/*
 * Constants:
 */
const ESC = "\u001b";
const CSI = ESC + "[";
const META_VALUES = {
    "1": "home",
    "2": "insert",
    "3": "delete",
    "4": "end",
    "5": "prior",
    "6": "next",
    "11": "F1",
    "12": "F2",
    "13": "F3",
    "14": "F4",
    "15": "F5",
    "17": "F6",
    "18": "F7",
    "19": "F8",
    "20": "F9",
    "21": "F10",
    "23": "F11",
    "24": "F12",
    "25": "F13",
    "26": "F14",
    "28": "F15",
    "29": "F16",
    "31": "F17",
    "32": "F18",
    "33": "F19",
    "34": "F20"
};
const DEFAULT_OPTS = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr
};
const PARSETABLE = require("./parsetable");
function _ptt(parsetable, state, c) {
    const pte = parsetable[state];
    if (!pte) {
        throw new Error("unknown state: " + state);
    }
    let dptt = null;
    for (let i = 0; i < pte.length; i++) {
        const ptt = pte[i];
        if (ptt.hasOwnProperty("c")) {
            if (typeof ptt.c === "string")
                ptt.c = ptt.c.charCodeAt(0);
            if (ptt.c === c)
                return ptt;
        }
        else {
            dptt = ptt;
        }
    }
    if (dptt === null) {
        throw new Error("could not find transition from " + state + " for " + c);
    }
    return dptt;
}
/*
 * For some inputs, the CSI sequence is followed by a number indicating
 * the modifiers that were held during the keypress. These are:
 *
 *      Code     Modifiers
 *  ---------+---------------------------
 *     2     | Shift
 *     3     | Alt
 *     4     | Shift + Alt
 *     5     | Control
 *     6     | Shift + Control
 *     7     | Alt + Control
 *     8     | Shift + Alt + Control
 *     9     | Meta
 *     10    | Meta + Shift
 *     11    | Meta + Alt
 *     12    | Meta + Alt + Shift
 *     13    | Meta + Ctrl
 *     14    | Meta + Ctrl + Shift
 *     15    | Meta + Ctrl + Alt
 *     16    | Meta + Ctrl + Alt + Shift
 *  ---------+---------------------------
 *
 *  By substracting 1 from these values, we can treat them as a bitmask.
 */
function processModifiers(mods, val) {
    var n = mod_jsprim.parseInteger(val);
    if (n instanceof Error || n < 2 || n > 16) {
        return;
    }
    n -= 1;
    if ((n & 1) == 1) {
        mods.shift = true;
    }
    if ((n & 2) == 2) {
        mods.alt = true;
    }
    if ((n & 4) == 4) {
        mods.control = true;
    }
    if ((n & 8) == 8) {
        mods.meta = true;
    }
}
class ANSITerm extends events_1.EventEmitter {
    constructor(opts) {
        super();
        this.at_pos = 0;
        this.at_state = "REST";
        this.at_buf = Buffer.alloc(0);
        this.at_store = Buffer.alloc(64);
        this.at_storepos = 0;
        this.at_ldcount = 0;
        this.at_linedraw = mod_linedraw.vt100;
        this._timeout = null;
        this.color256 = this.colour256;
        if (opts !== undefined) {
            this.opts = Object.assign({}, DEFAULT_OPTS, opts);
        }
        else {
            this.opts = DEFAULT_OPTS;
        }
        //if (process.env.LANG && process.env.LANG.match(/[uU][tT][fF]-?8$/))
        //	this.linedraw = mod_linedraw.utf8;
        if (!this.at_in.isTTY || !this.at_out.isTTY)
            throw new Error("not a tty");
        if (!process.env.TERM || process.env.TERM === "dumb")
            throw new Error("not a useful terminal");
        this.at_in.on("data", data => {
            var x = this.at_buf;
            this.at_buf = Buffer.alloc(this.at_buf.length + data.length);
            x.copy(this.at_buf);
            data.copy(this.at_buf, x.length);
            setImmediate(() => {
                this._procbuf();
            });
        });
        this.at_in.setRawMode(true);
        this.at_in.resume();
        process.on("SIGWINCH", () => {
            this.emit("resize", this.size());
        });
        process.on("exit", err => {
            this.softReset();
        });
    }
    get at_in() {
        return this.opts.stdin;
    }
    get at_out() {
        return this.opts.stdout;
    }
    get at_err() {
        return this.opts.stderr;
    }
    _emit_after(toms, to_emit, ...args) {
        if (this._timeout)
            clearTimeout(this._timeout);
        this._timeout = setTimeout(() => {
            this.emit(to_emit, ...args);
            this.at_state = "REST";
        }, toms);
    }
    _push_store(b) {
        this.at_store.writeUInt8(b, this.at_storepos++);
    }
    _fetch_store() {
        const s = this.at_store.toString("utf8", 0, this.at_storepos);
        this.at_storepos = 0;
        return s;
    }
    _dump_invalid() {
        for (var i = 0; i < this.at_storepos; ++i) {
            var k = String.fromCharCode(this.at_store[i]);
            this.emit("keypress", k);
        }
        this.at_pos--;
        this.at_storepos = 0;
        this.at_state = "REST";
    }
    _procbuf() {
        if (this.at_pos >= this.at_buf.length)
            return;
        if (this._timeout)
            clearTimeout(this._timeout);
        this._timeout = null;
        var c = this.at_buf[this.at_pos];
        var ptt = _ptt(PARSETABLE, this.at_state, c);
        this.debug("CHAR: " + c);
        for (var i = 0; i < ptt.acts.length; i++) {
            var act = ptt.acts[i];
            switch (act.a) {
                case "KEYREAD":
                    if ((c & 248) === 240) {
                        // 0b11110xxx
                        this.at_state = "UTF8-REM3";
                    }
                    else if ((c & 240) === 224) {
                        // 0b1110xxxx
                        this.at_state = "UTF8-REM2";
                    }
                    else if ((c & 224) === 192) {
                        // 0b110xxxxx
                        this.at_state = "UTF8-REM1";
                    }
                    else {
                        this.emit("keypress", String.fromCharCode(c));
                        break;
                    }
                    this._push_store(c);
                    break;
                case "KEYSTEP":
                    if ((c & 192) !== 128) {
                        // Not 0b10xxxxxx
                        this._dump_invalid();
                        break;
                    }
                    this._push_store(c);
                    if (act.c) {
                        this.emit("keypress", this._fetch_store());
                    }
                    this.at_state = act.b;
                    break;
                case "STATE":
                    this.debug("STATE: " + this.at_state + " -> " + act.b);
                    this.at_state = act.b;
                    break;
                case "TIMEOUT":
                    this.debug("TIMEOUT: " + act.e);
                    this._emit_after(10, act.b, act.v);
                    break;
                case "EMIT":
                    this.debug("EMIT: " + act.b);
                    if (act.d && this.listeners(act.b).length < 1) {
                        this.clear();
                        this.moveto(1, 1);
                        this.write("terminated (" + act.b + ")\n");
                        process.exit(1);
                    }
                    if (act.c) {
                        this.emit(act.b, String.fromCharCode(c));
                    }
                    else if (act.v) {
                        this.emit(act.b, act.v, act.m);
                    }
                    else {
                        this.emit(act.b);
                    }
                    break;
                case "STORE":
                    this.debug("STORE: " + c);
                    this._push_store(c);
                    break;
                case "RESET":
                    this.debug("RESET");
                    this._fetch_store();
                    break;
                case "CALL":
                    this.debug("CALL: " + act.b);
                    this[act.b](act.v);
                    break;
                default:
                    throw new Error("unknown action " + act.a);
            }
        }
        this.at_pos++;
        setImmediate(() => {
            this._procbuf();
        });
    }
    write(str) {
        this.at_out.write(str);
    }
    _curpos() {
        const x = this._fetch_store().split(/;/);
        this.debug("CURSOR POSITION: " + x[0] + ", " + x[1]);
        this.emit("position", x[0], x[1]);
    }
    _devstat() {
        const status = this._fetch_store();
        this.debug("DEVICE STATUS: " + status);
    }
    _fnkeys(name) {
        const modchars = this._fetch_store().split(/;/);
        const mods = {
            alt: false,
            control: false,
            meta: false,
            shift: false
        };
        for (let i = 1; i < modchars.length; i++) {
            processModifiers(mods, modchars[i]);
        }
        this.emit("special", name, mods);
    }
    _inkeys() {
        var s = this._fetch_store();
        var x = s.split(/;/);
        var mods = {
            alt: false,
            control: false,
            meta: false,
            shift: false
        };
        for (let i = 1; i < x.length; i++) {
            processModifiers(mods, x[i]);
        }
        if (META_VALUES.hasOwnProperty(x[0])) {
            this.emit("special", META_VALUES[x[0]], mods);
        }
        else {
            throw new Error("unknown input key sequence " + s);
        }
    }
    debug(str) {
        return;
        this.at_err.write(str + "\n");
    }
    logerr(str) {
        this.at_err.write(str + "\n");
    }
    clear() {
        this.at_out.write(CSI + "2J");
    }
    moveto(x, y) {
        if (x < 0)
            x = this.at_out.columns + x + 1;
        if (y < 0)
            y = this.at_out.rows + y + 1;
        this.at_out.write(CSI + y + ";" + x + "f");
    }
    cursor(show) {
        this.at_out.write(CSI + "?25" + (show ? "h" : "l"));
    }
    bold() {
        this.at_out.write(CSI + "1m");
    }
    reverse() {
        this.at_out.write(CSI + "7m");
    }
    colour256(num, bg) {
        this.at_out.write(CSI + (bg ? "48" : "38") + ";5;" + num + "m");
    }
    reset() {
        this.at_out.write(CSI + "m");
    }
    eraseLine() {
        this.at_out.write(CSI + "2K");
    }
    eraseStartOfLine() {
        this.at_out.write(CSI + "1K");
    }
    eraseEndOfLine() {
        this.at_out.write(CSI + "K");
    }
    insertMode() {
        this.at_out.write(CSI + "4h");
    }
    replaceMode() {
        this.at_out.write(CSI + "4l");
    }
    drawHorizontalLine(y, xfrom = 1, xto) {
        if (typeof xto !== "number")
            xto = this.at_out.columns;
        this.moveto(xfrom, y);
        this.enableLinedraw();
        if (false) {
            /*
             * XXX Dubious auto-repeat control sequence...
             */
            this.write(this.at_linedraw.horiz + CSI + (xto - xfrom) + "b");
        }
        else {
            var s = "";
            for (let i = 0; i <= xto - xfrom; i++) {
                s += this.at_linedraw.horiz;
            }
            this.write(s);
        }
        this.disableLinedraw();
    }
    drawVerticalLine(x, yfrom, yto) {
        if (typeof yfrom !== "number")
            yfrom = 1;
        if (typeof yto !== "number")
            yto = this.at_out.rows;
        this.moveto(x, yfrom);
        this.enableLinedraw();
        for (let p = yfrom; p <= yto; p++) {
            /*
             * Draw vertical, move down:
             */
            this.write(this.at_linedraw.verti + CSI + "B" + CSI + x + "G");
        }
        this.disableLinedraw();
    }
    drawBox(x1 = 1, y1 = 1, x2, y2) {
        if (typeof x2 !== "number")
            x2 = this.at_out.columns;
        if (typeof y2 !== "number")
            y2 = this.at_out.rows;
        var horizl = "";
        for (let p = x1 + 1; p <= x2 - 1; p++)
            horizl += this.at_linedraw.horiz;
        this.enableLinedraw();
        this.moveto(x1, y1);
        this.write(this.at_linedraw.topleft + horizl + this.at_linedraw.topright);
        this.moveto(x1, y2);
        this.write(this.at_linedraw.bottomleft + horizl + this.at_linedraw.bottomright);
        this.drawVerticalLine(x1, y1 + 1, y2 - 1);
        this.drawVerticalLine(x2, y1 + 1, y2 - 1);
        this.disableLinedraw();
    }
    doubleHeight(x, y, str) {
        this.moveto(x, y);
        this.write(ESC + "#3" + str);
        this.moveto(x, y + 1);
        this.write(ESC + "#4" + str);
    }
    disableLinedraw() {
        if (this.at_ldcount === 0)
            return;
        this.at_ldcount--;
        if (this.at_ldcount === 0) {
            this.at_out.write(this.at_linedraw.off);
        }
    }
    enableLinedraw() {
        if (this.at_ldcount === 0) {
            this.at_out.write(this.at_linedraw.on);
        }
        this.at_ldcount++;
    }
    size() {
        return {
            h: this.at_out.rows,
            w: this.at_out.columns
        };
    }
    softReset() {
        this.cursor(true);
        this.replaceMode();
        this.reset();
    }
}
module.exports = {
    ANSITerm: ANSITerm,
    wcwidth: mod_grapheme.wcwidth,
    wcswidth: mod_grapheme.wcswidth,
    forEachGrapheme: mod_grapheme.forEachGrapheme
};
