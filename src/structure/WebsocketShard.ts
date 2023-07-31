// A port of @discordjs/ws websocket shard code to make it work with Websocket.ts
// Original code at https://github.com/discordjs/discord.js/blob/main/packages/ws/src/ws/WebSocketShard.ts

import { once } from 'node:events';
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import { URLSearchParams } from 'node:url';
import { IContextFetchingStrategy, getInitialSendRateLimitState, ImportantGatewayOpcodes, SessionInfo } from '@discordjs/ws';
import { Collection } from '@discordjs/collection';
import { AsyncQueue } from '@sapphire/async-queue';
import { AsyncEventEmitter } from '@vladfrangu/async_event_emitter';
import {
    GatewayCloseCodes,
    GatewayDispatchEvents,
    GatewayOpcodes,
    type GatewayDispatchPayload,
    type GatewayIdentifyData,
    type GatewayReadyDispatchData,
    type GatewayReceivePayload,
    type GatewaySendPayload,
} from 'discord-api-types/v10';
import { Websocket } from './Websocket';
import { WebsocketEncoding } from '../Constants';

export enum WebSocketShardEvents {
    Closed = 'closed',
    Debug = 'debug',
    Dispatch = 'dispatch',
    Error = 'error',
    HeartbeatComplete = 'heartbeat',
    Hello = 'hello',
    Ready = 'ready',
    Resumed = 'resumed',
}

export enum WebSocketShardStatus {
    Idle,
    Connecting,
    Resuming,
    Ready,
}

export enum WebSocketShardDestroyRecovery {
    Reconnect,
    Resume,
}

export type WebSocketShardEventsMap = {
    [WebSocketShardEvents.Closed]: [{ code: number }];
    [WebSocketShardEvents.Debug]: [payload: { message: string }];
    [WebSocketShardEvents.Dispatch]: [payload: { data: GatewayDispatchPayload }];
    [WebSocketShardEvents.Error]: [payload: { error: Error }];
    [WebSocketShardEvents.Hello]: [];
    [WebSocketShardEvents.Ready]: [payload: { data: GatewayReadyDispatchData }];
    [WebSocketShardEvents.Resumed]: [];
    [WebSocketShardEvents.HeartbeatComplete]: [payload: { ackAt: number; heartbeatAt: number; latency: number }];
};

export interface WebSocketShardDestroyOptions {
    code?: number;
    reason?: string;
    recover?: WebSocketShardDestroyRecovery;
}

export enum CloseCodes {
    Normal = 1_000,
    Resuming = 4_200,
}

export interface SendRateLimitState {
    remaining: number;
    resetAt: number;
}

const recoverableErrorsRegex = /(?:EAI_AGAIN)|(?:ECONNRESET)/;

export class WebsocketShard extends AsyncEventEmitter<WebSocketShardEventsMap> {
    public readonly id: number;
    public readonly strategy: IContextFetchingStrategy;
    private readonly connection: Websocket;
    private replayedEvents = 0;
    private isAck = true;
    private sendRateLimitState: SendRateLimitState = getInitialSendRateLimitState();
    private initialHeartbeatTimeoutController: AbortController | null = null;
    private heartbeatInterval: NodeJS.Timer | null = null;
    private lastHeartbeatAt = -1;
    private readonly sendQueue = new AsyncQueue();
    private readonly timeoutAbortControllers = new Collection<WebSocketShardEvents, AbortController>();
    private _status: WebSocketShardStatus = WebSocketShardStatus.Idle;

    public get status(): WebSocketShardStatus {
        return this._status;
    }

    public constructor(id: number, strategy: IContextFetchingStrategy) {
        super();
        this.id = id;
        this.strategy = strategy;
        this.connection = new Websocket()
            .on('ws_close', number => this.onClose(number))
            .on('ws_receive', payload => this.onMessage(payload))
            .on('ws_error', error => this.onError(error))
            .on('debug', message => this.debug([ 'Internal Websocket Class Message', message ]));
    }

    public async connect(): Promise<void> {
        if (this._status !== WebSocketShardStatus.Idle)
            throw new Error('Tried to connect a shard that wasn\'t idle');
        const { version, encoding, compression } = this.strategy.options;
        const params = new URLSearchParams({ v: version, encoding });
        if (compression) params.append('compress', compression);
        this.connection.encoding = encoding === 'json' ? WebsocketEncoding.JSON : WebsocketEncoding.ETF;
        this.connection.compress = !!compression;
        const session = await this.strategy.retrieveSessionInfo(this.id);
        if (!session) {
            this.debug([ 'Can\'t fetch sessions, retrying in 5s' ]);
            await sleep(5000);
            return await this.connect();
        }
        this._status = WebSocketShardStatus.Connecting;
        try {
            await this.connection.connect(`${session?.resumeURL ?? this.strategy.options.gatewayInformation.url}?${params.toString()}`);
        } catch (error: any) {
            this._status = WebSocketShardStatus.Idle;
            if (!recoverableErrorsRegex.test(error.toString())) throw error;
            this.debug([ 'Can\'t initially connect to websocket due to network error, retrying in 5s' ]);
            await sleep(5000);
            return await this.connect();
        }
        if (session!.shardCount === this.strategy.options.shardCount)
            await this.resume(session!);
        else
            await this.identify();
    }

    public async destroy(options: WebSocketShardDestroyOptions = {}): Promise<void> {
        if (this._status === WebSocketShardStatus.Idle) {
            this.debug([ 'Tried to destroy a shard that was idle' ]);
            return;
        }
        if (!options.code) {
            options.code = options.recover === WebSocketShardDestroyRecovery.Resume ? CloseCodes.Resuming : CloseCodes.Normal;
        }
        this.debug([
            'Destroying shard',
            `Reason: ${options.reason ?? 'none'}`,
            `Code: ${options.code}`,
            `Recover: ${options.recover === undefined ? 'none' : WebSocketShardDestroyRecovery[options.recover]!}`,
        ]);
        // Reset state
        this.isAck = true;
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        if (this.initialHeartbeatTimeoutController) {
            this.initialHeartbeatTimeoutController.abort();
            this.initialHeartbeatTimeoutController = null;
        }
        this.lastHeartbeatAt = -1;
        for (const controller of this.timeoutAbortControllers.values()) {
            controller.abort();
        }
        this.timeoutAbortControllers.clear();
        // Clear session state if applicable
        if (options.recover !== WebSocketShardDestroyRecovery.Resume) {
            await this.strategy.updateSessionInfo(this.id, null);
        }
        await this.connection.close(options.code, options.reason || 'none');
        this._status = WebSocketShardStatus.Idle;
        if (options.recover !== undefined) {
            // There's cases (like no internet connection) where we immediately fail to connect,
            // causing a very fast and draining reconnection loop.
            await sleep(500);
            return this.connect();
        }
    }

    private async waitForEvent(event: WebSocketShardEvents, timeoutDuration?: number | null): Promise<{ ok: boolean }> {
        this.debug([ `Waiting for event ${event} ${timeoutDuration ? `for ${timeoutDuration}ms` : 'indefinitely'}` ]);
        const timeoutController = new AbortController();
        const timeout = timeoutDuration ? setTimeout(() => timeoutController.abort(), timeoutDuration).unref() : null;
        this.timeoutAbortControllers.set(event, timeoutController);
        const closeController = new AbortController();
        try {
            // If the first promise resolves, all is well. If the 2nd promise resolves,
            // the shard has meanwhile closed. In that case, a destroy is already ongoing, so we just need to
            // return false. Meanwhile, if something rejects (error event) or the first controller is aborted,
            // we enter the catch block and trigger a destroy there.
            const closed = await Promise.race<boolean>([
                once(this, event, { signal: timeoutController.signal }).then(() => false),
                once(this, WebSocketShardEvents.Closed, { signal: closeController.signal }).then(() => true),
            ]);
            return { ok: !closed };
        } catch {
            // If we're here because of other reasons, we need to destroy the shard
            void this.destroy({
                code: CloseCodes.Normal,
                reason: 'Something timed out or went wrong while waiting for an event',
                recover: WebSocketShardDestroyRecovery.Reconnect,
            });
            return { ok: false };
        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
            this.timeoutAbortControllers.delete(event);
            // Clean up the close listener to not leak memory
            if (!closeController.signal.aborted) {
                closeController.abort();
            }
        }
    }

    public async send(payload: GatewaySendPayload): Promise<void> {
        if (!this.connection)
            throw new Error('WebSocketShard wasn\'t connected');
        if (this._status !== WebSocketShardStatus.Ready && !ImportantGatewayOpcodes.has(payload.op)) {
            this.debug([ 'Tried to send a non-crucial payload before the shard was ready, waiting' ]);
            // This will throw if the shard throws an error event in the meantime, just requeue the payload
            try {
                await once(this, WebSocketShardEvents.Ready);
            } catch {
                return this.send(payload);
            }
        }
        await this.sendQueue.wait();
        if (--this.sendRateLimitState.remaining <= 0) {
            const now = Date.now();
            if (this.sendRateLimitState.resetAt > now) {
                const sleepFor = this.sendRateLimitState.resetAt - now;

                this.debug([ `Was about to hit the send rate limit, sleeping for ${sleepFor}ms` ]);
                const controller = new AbortController();
                // Sleep for the remaining time, but if the connection closes in the meantime, we shouldn't wait the remainder to avoid blocking the new conn
                const interrupted = await Promise.race([
                    sleep(sleepFor).then(() => false),
                    once(this, WebSocketShardEvents.Closed, { signal: controller.signal }).then(() => true),
                ]);
                if (interrupted) {
                    this.debug([ 'Connection closed while waiting for the send rate limit to reset, re-queueing payload' ]);
                    this.sendQueue.shift();
                    return this.send(payload);
                }
                // This is so the listener from the `once` call is removed
                controller.abort();
            }
            this.sendRateLimitState = getInitialSendRateLimitState();
        }
        this.sendQueue.shift();
        this.connection.send(payload);
    }

    private async identify(): Promise<void> {
        this.debug([ 'Waiting for identify throttle' ]);
        const controller = new AbortController();
        const closeHandler = () => {
            controller.abort();
        };
        this.on(WebSocketShardEvents.Closed, closeHandler);
        try {
            await this.strategy.waitForIdentify(this.id, controller.signal);
        } catch {
            if (controller.signal.aborted) {
                this.debug([ 'Was waiting for an identify, but the shard closed in the meantime' ]);
                return;
            }
            this.debug([
                'IContextFetchingStrategy#waitForIdentify threw an unknown error.',
                'If you\'re using a custom strategy, this is probably nothing to worry about.',
                'If you\'re not, please open an issue on GitHub.',
            ]);
            await this.destroy({
                reason: 'Identify throttling logic failed',
                recover: WebSocketShardDestroyRecovery.Resume,
            });
        } finally {
            this.off(WebSocketShardEvents.Closed, closeHandler);
        }
        this.debug([
            'Identifying',
            `shard id: ${this.id.toString()}`,
            `shard count: ${this.strategy.options.shardCount}`,
            `intents: ${this.strategy.options.intents}`,
            `compression: ${this.strategy.options.compression}`,
        ]);
        const d: GatewayIdentifyData = {
            token: this.strategy.options.token,
            properties: this.strategy.options.identifyProperties,
            intents: this.strategy.options.intents,
            compress: false,
            shard: [ this.id, this.strategy.options.shardCount ],
        };
        if (this.strategy.options.largeThreshold) {
            d.large_threshold = this.strategy.options.largeThreshold;
        }
        if (this.strategy.options.initialPresence) {
            d.presence = this.strategy.options.initialPresence;
        }
        await this.send({
            op: GatewayOpcodes.Identify,
            d,
        });
        await this.waitForEvent(WebSocketShardEvents.Ready, this.strategy.options.readyTimeout);
    }

    private async resume(session: SessionInfo): Promise<void> {
        this.debug([
            'Resuming session',
            `resume url: ${session.resumeURL}`,
            `sequence: ${session.sequence}`,
            `shard id: ${this.id.toString()}`,
        ]);
        this._status = WebSocketShardStatus.Resuming;
        this.replayedEvents = 0;
        await this.send({
            op: GatewayOpcodes.Resume,
            d: {
                token: this.strategy.options.token,
                seq: session.sequence,
                session_id: session.sessionId,
            },
        });
    }

    private async heartbeat(requested = false) {
        if (!this.isAck && !requested) {
            return this.destroy({ reason: 'Zombie connection', recover: WebSocketShardDestroyRecovery.Resume });
        }
        const session = await this.strategy.retrieveSessionInfo(this.id);
        await this.send({
            op: GatewayOpcodes.Heartbeat,
            d: session?.sequence ?? null,
        });
        this.lastHeartbeatAt = Date.now();
        this.isAck = false;
    }

    private async onMessage(payload: GatewayReceivePayload) {
        switch (payload.op) {
            case GatewayOpcodes.Dispatch: {
                if (this._status === WebSocketShardStatus.Resuming) {
                    this.replayedEvents++;
                }
                switch (payload.t) {
                    case GatewayDispatchEvents.Ready: {
                        this._status = WebSocketShardStatus.Ready;
                        const session = {
                            sequence: payload.s,
                            sessionId: payload.d.session_id,
                            shardId: this.id,
                            shardCount: this.strategy.options.shardCount,
                            resumeURL: payload.d.resume_gateway_url,
                        };
                        await this.strategy.updateSessionInfo(this.id, session);
                        this.emit(WebSocketShardEvents.Ready, { data: payload.d });
                        break;
                    }
                    case GatewayDispatchEvents.Resumed: {
                        this._status = WebSocketShardStatus.Ready;
                        this.debug([ `Resumed and replayed ${this.replayedEvents} events` ]);
                        this.emit(WebSocketShardEvents.Resumed);
                        break;
                    }
                    default: {
                        break;
                    }
                }
                const session = await this.strategy.retrieveSessionInfo(this.id);
                if (session) {
                    if (payload.s > session.sequence) {
                        await this.strategy.updateSessionInfo(this.id, { ...session, sequence: payload.s });
                    }
                } else {
                    this.debug([
                        `Received a ${payload.t} event but no session is available. Session information cannot be re-constructed in this state without a full reconnect`,
                    ]);
                }
                this.emit(WebSocketShardEvents.Dispatch, { data: payload });
                break;
            }
            case GatewayOpcodes.Heartbeat: {
                await this.heartbeat(true);
                break;
            }
            case GatewayOpcodes.Reconnect: {
                await this.destroy({
                    reason: 'Told to reconnect by Discord',
                    recover: WebSocketShardDestroyRecovery.Resume,
                });
                break;
            }
            case GatewayOpcodes.InvalidSession: {
                this.debug([ `Invalid session; will attempt to resume: ${payload.d.toString()}` ]);
                const session = await this.strategy.retrieveSessionInfo(this.id);
                if (payload.d && session) {
                    await this.resume(session);
                } else {
                    await this.destroy({
                        reason: 'Invalid session',
                        recover: WebSocketShardDestroyRecovery.Reconnect,
                    });
                }
                break;
            }
            case GatewayOpcodes.Hello: {
                this.emit(WebSocketShardEvents.Hello);
                const jitter = Math.random();
                const firstWait = Math.floor(payload.d.heartbeat_interval * jitter);
                this.debug([ `Preparing first heartbeat of the connection with a jitter of ${jitter}; waiting ${firstWait}ms` ]);

                try {
                    const controller = new AbortController();
                    this.initialHeartbeatTimeoutController = controller;
                    await sleep(firstWait, undefined, { signal: controller.signal });
                } catch {
                    this.debug([ 'Cancelled initial heartbeat due to #destroy being called' ]);
                    return;
                } finally {
                    this.initialHeartbeatTimeoutController = null;
                }
                await this.heartbeat();
                this.debug([ `First heartbeat sent, starting to beat every ${payload.d.heartbeat_interval}ms` ]);
                this.heartbeatInterval = setInterval(() => void this.heartbeat(), payload.d.heartbeat_interval);
                break;
            }
            case GatewayOpcodes.HeartbeatAck: {
                this.isAck = true;
                const ackAt = Date.now();
                this.emit(WebSocketShardEvents.HeartbeatComplete, {
                    ackAt,
                    heartbeatAt: this.lastHeartbeatAt,
                    latency: ackAt - this.lastHeartbeatAt,
                });
                break;
            }
        }
    }

    private onError(error: Error): void {
        this.emit(WebSocketShardEvents.Error, { error });
    }

    private async onClose(code: number): Promise<void> {
        this.emit(WebSocketShardEvents.Closed, { code });
        switch (code) {
            case CloseCodes.Normal: {
                await this.destroy({
                    code,
                    reason: 'Got disconnected by Discord',
                    recover: WebSocketShardDestroyRecovery.Reconnect,
                });
                break;
            }
            case CloseCodes.Resuming: {
                break;
            }
            case GatewayCloseCodes.UnknownError: {
                this.debug([ `An unknown error occurred: ${code}` ]);
                await this.destroy({ code, recover: WebSocketShardDestroyRecovery.Resume });
                break;
            }
            case GatewayCloseCodes.UnknownOpcode: {
                this.debug([ 'An invalid opcode was sent to Discord.' ]);
                await this.destroy({ code, recover: WebSocketShardDestroyRecovery.Resume });
                break;
            }
            case GatewayCloseCodes.DecodeError: {
                this.debug([ 'An invalid payload was sent to Discord.' ]);
                await this.destroy({ code, recover: WebSocketShardDestroyRecovery.Resume });
                break;
            }
            case GatewayCloseCodes.NotAuthenticated: {
                this.debug([ 'A request was somehow sent before the identify/resume payload.' ]);
                await this.destroy({ code, recover: WebSocketShardDestroyRecovery.Reconnect });
                break;
            }
            case GatewayCloseCodes.AuthenticationFailed: {
                this.emit(WebSocketShardEvents.Error, {
                    error: new Error('Authentication failed'),
                });
                await this.destroy({ code });
                break;
            }
            case GatewayCloseCodes.AlreadyAuthenticated: {
                this.debug([ 'More than one auth payload was sent.' ]);
                await this.destroy({ code, recover: WebSocketShardDestroyRecovery.Reconnect });
                break;
            }
            case GatewayCloseCodes.InvalidSeq: {
                this.debug([ 'An invalid sequence was sent.' ]);
                await this.destroy({ code, recover: WebSocketShardDestroyRecovery.Reconnect });
                break;
            }
            case GatewayCloseCodes.RateLimited: {
                this.debug([ 'The WebSocket rate limit has been hit, this should never happen' ]);
                await this.destroy({ code, recover: WebSocketShardDestroyRecovery.Reconnect });
                break;
            }
            case GatewayCloseCodes.SessionTimedOut: {
                this.debug([ 'Session timed out.' ]);
                await this.destroy({ code, recover: WebSocketShardDestroyRecovery.Resume });
                break;
            }
            case GatewayCloseCodes.InvalidShard: {
                this.emit(WebSocketShardEvents.Error, {
                    error: new Error('Invalid shard'),
                });
                await this.destroy({ code });
                break;
            }
            case GatewayCloseCodes.ShardingRequired: {
                this.emit(WebSocketShardEvents.Error, {
                    error: new Error('Sharding is required'),
                });
                await this.destroy({ code });
                break;
            }
            case GatewayCloseCodes.InvalidAPIVersion: {
                this.emit(WebSocketShardEvents.Error, {
                    error: new Error('Used an invalid API version'),
                });
                await this.destroy({ code });
                break;
            }
            case GatewayCloseCodes.InvalidIntents: {
                this.emit(WebSocketShardEvents.Error, {
                    error: new Error('Used invalid intents'),
                });
                await this.destroy({ code });
                break;
            }
            case GatewayCloseCodes.DisallowedIntents: {
                this.emit(WebSocketShardEvents.Error, {
                    error: new Error('Used disallowed intents'),
                });
                await this.destroy({ code });
                break;
            }
            default: {
                this.debug([
                    `The gateway closed with an unexpected code ${code}, attempting to reconnect.`,
                ]);
                await this.destroy({
                    code,
                    recover: WebSocketShardDestroyRecovery.Reconnect,
                });
            }
        }
    }

    private debug(messages: [string, ...string[]]) {
        const message = `${messages[0]}${
            messages.length > 1
                ? `\n${messages
                    .slice(1)
                    .map((m) => `	${m}`)
                    .join('\n')}`
                : ''
        }`;
        this.emit(WebSocketShardEvents.Debug, { message });
    }
}
