export enum WebsocketStatus {
    OPEN,
    CONNECTING,
    CLOSING,
    CLOSED
}

export enum WebsocketEncoding {
    JSON = 'json',
    ETF = 'etf'
}

export enum WebsocketEvents {
    OPEN = 'open',
    CLOSE = 'close',
    MESSAGE = 'message',
    ERROR = 'error',
    DEBUG = 'debug'
}
