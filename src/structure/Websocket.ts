// This ultra lightweight WS code is a slimmed down version originally found at https://github.com/timotejroiko/tiny-discord
// Modifications and use of this code was granted for this project by the author, Timotej Roiko.
// A major thank you to Tim for better performing software.
// The original TS code is taken from CloudStorm: https://github.com/DasWolke/CloudStorm/blob/master/src/structures/BetterWs.ts

import type { GatewayReceivePayload } from 'discord-api-types/v10';
import type Net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash, randomBytes } from 'node:crypto';
import { constants, createInflate, Inflate, inflateSync } from 'node:zlib';
import { AsyncEventEmitter } from '@vladfrangu/async_event_emitter';
import { WebsocketEncoding, WebsocketEvents, WebsocketStatus } from '../Constants';
import Https from 'https';
import Http from 'http';

export type WebsocketEventsMap = {
    [WebsocketEvents.OPEN]: [];
    [WebsocketEvents.CLOSE]: [number, string];
    [WebsocketEvents.MESSAGE]: [GatewayReceivePayload];
    [WebsocketEvents.ERROR]: [Error];
    [WebsocketEvents.DEBUG]: [string];
};

export interface ConnectOptions {
    address: string;
    encoding?: WebsocketEncoding;
    compress?: boolean;
}

/**
 * The class that establishes a connection and parses messages from websocket
 */
export class Websocket extends AsyncEventEmitter<WebsocketEventsMap> {
    private _encoding: WebsocketEncoding;
    private _compress: boolean;
    private _address: string|null;
    private _socket: Net.Socket | null;
    private _status: WebsocketStatus;
    private readonly _internal: { closePromise: Promise<void> | null; zlib: Inflate | null; };

    public get encoding(): WebsocketEncoding {
        return this._encoding;
    }

    public get compress(): boolean {
        return this._compress;
    }

    public get address(): string|null {
        return this._address;
    }

    public get status(): WebsocketStatus {
        return this._status;
    }

    public constructor() {
        super();
        this._encoding = WebsocketEncoding.JSON;
        this._compress = false;
        this._address = null;
        this._socket = null;
        this._status = WebsocketStatus.CLOSED;
        this._internal = {
            closePromise: null,
            zlib: null,
        };
    }

    public connect(options: ConnectOptions): Promise<void> {
        // if the status is open or connecting, do not do anything
        if (this._status === WebsocketStatus.CONNECTING || this._status === WebsocketStatus.OPEN)
            return Promise.resolve(void 0);
        // if the status is closing and connect was requested, we wait until the status is closed
        if (this._status === WebsocketStatus.CLOSING) {
            this.emit(WebsocketEvents.DEBUG, 'Websocket tried to connect, but the status is not closed. Retrying in 5s');
            return sleep(5000)
                .then(() => this.connect(options));
        }
        // status will be closed here, hence feel free to connect
        this._address = options.address;
        if (options.encoding) this._encoding = options.encoding;
        if (options.compress) this._compress = options.compress;
        const key = randomBytes(16).toString('base64');
        const url = new URL(this._address);
        const useHttps = (url.protocol === 'https:' || url.protocol === 'wss:') || url.port === '443';
        const port = url.port || (useHttps ? '443' : '80');
        const req = (useHttps ? Https : Http).request({
            hostname: url.hostname,
            path: `${url.pathname}${url.search}`,
            port: port,
            headers: {
                'Connection': 'Upgrade',
                'Upgrade': 'websocket',
                'Sec-WebSocket-Key': key,
                'Sec-WebSocket-Version': '13',
            }
        });
        this._status = WebsocketStatus.CONNECTING;
        this.emit(WebsocketEvents.DEBUG, `Connecting to: ${options.address}`);
        return new Promise((resolve, reject) => {
            req.on('upgrade', (res, socket) => {
                const hash = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
                const accept = res.headers['sec-websocket-accept'];
                if (hash !== accept) {
                    socket.end(() => {
                        this.emit(WebsocketEvents.DEBUG, 'Failed websocket-key validation');
                        this._status = WebsocketStatus.CLOSED;
                        reject(new Error(`Invalid Sec-Websocket-Accept | expected: ${hash} | received: ${accept}`));
                    });
                    return;
                }
                socket.on('error', this._onError.bind(this));
                socket.on('close', this._onClose.bind(this));
                socket.on('readable', this._onReadable.bind(this));
                this._socket = socket;
                this._status = WebsocketStatus.OPEN;
                this.emit(WebsocketEvents.DEBUG, `Connected to: ${options.address}`);
                if (this._compress) {
                    const z = createInflate();
                    // @ts-ignore
                    z._c = z.close; z._h = z._handle; z._hc = z._handle.close; z._v = () => void 0;
                    this._internal.zlib = z;
                }
                this.emit(WebsocketEvents.OPEN);
                resolve(void 0);
            });
            req.on('error', e => {
                this._status = WebsocketStatus.CLOSED;
                reject(e);
            });
            req.end();
        });
    }

    public close(code: number, reason?: string): Promise<void> {
        const internal = this._internal;
        if (internal.closePromise) return internal.closePromise;
        if (!this._socket) return Promise.resolve(void 0);
        let resolver: ((value: unknown) => void) | undefined;
        const promise = new Promise(resolve => {
            resolver = resolve;
            const from = Buffer.from([ code >> 8, code & 255 ]);
            this._write(reason ? Buffer.concat([ from, Buffer.from(reason) ]) : from, 8);
        }).then(() => {
            internal.closePromise = null;
        });
        // @ts-ignore
        promise.resolve = resolver;
        internal.closePromise = promise;
        this._status = WebsocketStatus.CLOSING;
        return promise;
    }

    public send(data: any): void {
        let encoded;
        if (this._encoding === WebsocketEncoding.JSON) {
            encoded = Buffer.from(JSON.stringify(data));
            this._write(encoded, 1);
        } else if (this._encoding === WebsocketEncoding.ETF) {
            encoded = writeETF(data);
            this._write(encoded, 2);
        }
    }

    private _write(packet: Buffer, opcode: number): void {
        const socket = this._socket;
        if (!socket?.writable) return;
        const length = packet.length;
        let frame: Buffer | undefined;
        if (length < 126) {
            frame = Buffer.allocUnsafe(6 + length);
            frame[1] = 128 + length;
        } else if (length < (1 << 16)) {
            frame = Buffer.allocUnsafe(8 + length);
            frame[1] = 254;
            frame[2] = length >> 8;
            frame[3] = length & 255;
        } else {
            frame = Buffer.allocUnsafe(14 + length);
            frame[1] = 255;
            frame.writeBigUInt64BE(BigInt(length), 2);
        }
        frame[0] = 128 + opcode;
        frame.writeUInt32BE(0, frame.length - length - 4);
        frame.set(packet, frame.length - length);
        socket.write(frame);
    }

    private _onError(error: Error): void {
        if (!this._socket) return;
        this.emit(WebsocketEvents.ERROR, error);
        this._write(Buffer.allocUnsafe(0), 8);
    }

    private _onClose(): void {
        const socket = this._socket;
        const internal = this._internal;
        if (!socket) return;
        socket.removeListener('data', this._onReadable);
        socket.removeListener('error', this._onError);
        socket.removeListener('close', this._onClose);
        this._socket = null;
        this._status = WebsocketStatus.CLOSED;
        if (internal.zlib) {
            internal.zlib.close();
            internal.zlib = null;
        }
        // @ts-ignore
        if (internal.closePromise) internal.closePromise.resolve(void 0);
    }

    private _onReadable(): void {
        const socket = this._socket;
        while((socket?.readableLength || 0) > 1) {
            let length = readRange(socket!, 1, 1) & 127;
            let bytes = 0;
            if (length > 125) {
                bytes = length === 126 ? 2 : 8;
                if (socket!.readableLength < 2 + bytes) return;
                length = readRange(socket!, 2, bytes);
            }
            const frame = socket!.read(2 + bytes + length) as Buffer;
            if (!frame) return;
            const fin = frame[0] >> 7;
            const opcode = frame[0] & 15;
            if (fin !== 1 || opcode === 0)
                this.emit(WebsocketEvents.DEBUG, 'Discord actually does send messages with fin=0. if you see this error let me know');
            const payload = frame.subarray(2 + bytes);
            this._processFrame(opcode, payload);
        }
    }

    private _processFrame(opcode: number, message: Buffer): void {
        const internal = this._internal;
        switch (opcode) {
            case 1: {
                const packet = JSON.parse(message.toString());
                this.emit(WebsocketEvents.MESSAGE, packet);
                break;
            }
            case 2: {
                let packet;
                if (this._compress) {
                    const z = internal.zlib;
                    let error = null;
                    let data = null;
                    // @ts-ignore
                    z.close = z._handle.close = z._v;
                    try {
                        // @ts-ignore
                        data = z._processChunk(message, constants.Z_SYNC_FLUSH);
                    } catch(e) {
                        error = e;
                    }
                    const l = message.length;
                    if (message[l - 4] !== 0 || message[l - 3] !== 0 || message[l - 2] !== 255 || message[l - 1] !== 255)
                        this.emit(WebsocketEvents.DEBUG, 'Discord actually does send fragmented zlib messages. If you see this error let me know');
                    // @ts-ignore
                    z.close = z._c;
                    // @ts-ignore
                    z._handle = z._h;
                    // @ts-ignore
                    z._handle.close = z._hc;
                    // @ts-ignore
                    z._events.error = void 0;
                    // @ts-ignore
                    z._eventCount--;
                    z!.removeAllListeners('error');
                    if (error) {
                        this.emit(WebsocketEvents.DEBUG, 'Zlib error processing chunk');
                        this._write(Buffer.allocUnsafe(0), 8);
                        return;
                    }
                    if (!data) {
                        this.emit(WebsocketEvents.DEBUG, 'Data from zlib processing was null. If you see this error let me know'); // This should never run, but TS is lame
                        return;
                    }
                    packet = this._encoding === WebsocketEncoding.JSON ? JSON.parse(String(data)) : readETF(data, 1);
                } else if (this._encoding === WebsocketEncoding.JSON) {
                    const data = inflateSync(message);
                    packet = JSON.parse(data.toString());
                } else packet = readETF(message, 1);
                this.emit(WebsocketEvents.MESSAGE, packet);
                break;
            }
            case 8: {
                const code = message.length > 1 ? (message[0] << 8) + message[1] : 0;
                const reason = message.length > 2 ? message.subarray(2).toString() : '';
                this.emit(WebsocketEvents.CLOSE, code, reason);
                this._write(Buffer.from([ code >> 8, code & 255 ]), 8);
                break;
            }
            case 9: {
                this._write(message, 10);
                break;
            }
        }
    }
}

export function readRange(socket: import('net').Socket, index: number, bytes: number): number {
    // @ts-ignore
    let head = socket._readableState.buffer.head;
    let cursor = 0;
    let read = 0;
    let num = 0;
    do {
        for (const element of head.data) {
            if (++cursor > index) {
                num *= 256;
                num += element;
                if (++read === bytes) return num;
            }
        }
    } while((head = head.next));
    throw new Error('readRange failed?');
}

export function readETF(data: Buffer, start: number): {} | null | undefined {
    let view: DataView | undefined;
    let x = start;
    const loop = () => {
        const type = data[x++];
        switch(type) {
            case 97: {
                return data[x++];
            }
            case 98: {
                const int = data.readInt32BE(x);
                x += 4;
                return int;
            }
            case 100: {
                const length = data.readUInt16BE(x);
                let atom = '';
                if (length > 30) {
                    // @ts-ignore
                    atom = data.latin1Slice(x += 2, x + length);
                } else {
                    for (let i = x += 2; i < x + length; i++) {
                        atom += String.fromCharCode(data[i]);
                    }
                }
                x += length;
                if (!atom) return undefined;
                if (atom === 'nil' || atom === 'null') return null;
                if (atom === 'true') return true;
                if (atom === 'false') return false;
                return atom;
            }
            case 108: case 106: {
                const array = [] as Array<any>;
                if (type === 108) {
                    const length = data.readUInt32BE(x);
                    x += 4;
                    for (let i = 0; i < length; i++) {
                        array.push(loop());
                    }
                    x++;
                }
                return array;
            }
            case 107: {
                const array = [] as Array<number>;
                const length = data.readUInt16BE(x);
                x += 2;
                for (let i = 0; i < length; i++) {
                    array.push(data[x++]);
                }
                return array;
            }
            case 109: {
                const length = data.readUInt32BE(x);
                let str = '';
                if (length > 30) {
                    // @ts-ignore
                    str = data.utf8Slice(x += 4, x + length);
                } else {
                    let i = x += 4;
                    const l = x + length;
                    while(i < l) {
                        const byte = data[i++];
                        if (byte < 128) str += String.fromCharCode(byte);
                        else if (byte < 224) str += String.fromCharCode(((byte & 31) << 6) + (data[i++] & 63));
                        else if (byte < 240) str += String.fromCharCode(((byte & 15) << 12) + ((data[i++] & 63) << 6) + (data[i++] & 63));
                        else str += String.fromCodePoint(((byte & 7) << 18) + ((data[i++] & 63) << 12) + ((data[i++] & 63) << 6) + (data[i++] & 63));
                    }
                }
                x += length;
                return str;
            }
            case 110: {
                // @ts-ignore
                if (!view) view = new DataView(data.buffer, data.offset, data.byteLength);
                const length = data[x++];
                const sign = data[x++];
                let left = length;
                let num = BigInt(0);
                while(left > 0) {
                    if (left >= 8) {
                        num <<= BigInt(64);
                        num += view.getBigUint64(x + (left -= 8), true);
                    } else if (left >= 4) {
                        num <<= BigInt(32);
                        // @ts-ignore
                        num += BigInt(view.getUint32(x + (left -= 4)), true);
                    } else if (left >= 2) {
                        num <<= BigInt(16);
                        // @ts-ignore
                        num += BigInt(view.getUint16(x + (left -= 2)), true);
                    } else {
                        num <<= BigInt(8);
                        num += BigInt(data[x]);
                        left--;
                    }
                }
                x += length;
                return (sign ? -num : num).toString();
            }
            case 116: {
                const obj = {};
                const length = data.readUInt32BE(x);
                x += 4;
                for(let i = 0; i < length; i++) {
                    const key = loop();
                    // @ts-ignore
                    obj[key] = loop();
                }
                return obj;
            }
        }
        throw new Error(`Missing etf type: ${type}`);
    };
    return loop();
}

export function writeETF(data: any): Buffer {
    const b = Buffer.allocUnsafe(1 << 12);
    b[0] = 131;
    let i = 1;
    const loop = (obj: any) => {
        const type = typeof obj;
        switch(type) {
            case 'boolean': {
                b[i++] = 100;
                if (obj) {
                    b.writeUInt16BE(4, i);
                    // @ts-ignore
                    b.latin1Write('true', i += 2);
                    i += 4;
                } else {
                    b.writeUInt16BE(5, i);
                    // @ts-ignore
                    b.latin1Write('false', i += 2);
                    i += 5;
                }
                break;
            }
            case 'string': {
                const length = Buffer.byteLength(obj);
                b[i++] = 109;
                b.writeUInt32BE(length, i);
                // @ts-ignore
                b.utf8Write(obj, i += 4);
                i += length;
                break;
            }
            case 'number': {
                if (Number.isInteger(obj)) {
                    const abs = Math.abs(obj);
                    if (abs < 2147483648) {
                        b[i++] = 98;
                        b.writeInt32BE(obj, i);
                        i += 4;
                    } else if (abs < Number.MAX_SAFE_INTEGER) {
                        b[i++] = 110;
                        b[i++] = 8;
                        b[i++] = Number(obj < 0);
                        b.writeBigUInt64LE(BigInt(abs), i);
                        i += 8;
                        break;
                    } else {
                        b[i++] = 70;
                        b.writeDoubleBE(obj, i);
                        i += 8;
                    }
                } else {
                    b[i++] = 70;
                    b.writeDoubleBE(obj, i);
                    i += 8;
                }
                break;
            }
            case 'bigint': {
                b[i++] = 110;
                b[i++] = 8;
                b[i++] = Number(obj < 0);
                b.writeBigUInt64LE(obj, i);
                i += 8;
                break;
            }
            case 'object': {
                if (obj === null) {
                    b[i++] = 100;
                    b.writeUInt16BE(3, i);
                    // @ts-ignore
                    b.latin1Write('nil', i += 2);
                    i += 3;
                } else if (Array.isArray(obj)) {
                    if (obj.length) {
                        b[i++] = 108;
                        b.writeUInt32BE(obj.length, i);
                        i += 4;
                        for (const item of obj) {
                            loop(item);
                        }
                    }
                    b[i++] = 106;
                } else {
                    const entries = Object.entries(obj).filter(x => typeof x[1] !== 'undefined');
                    b[i++] = 116;
                    b.writeUInt32BE(entries.length, i);
                    i += 4;
                    for(const [ key, value ] of entries) {
                        loop(key);
                        loop(value);
                    }
                }
                break;
            }
        }
    };
    loop(data);
    return Buffer.from(b.subarray(0, i));
}
