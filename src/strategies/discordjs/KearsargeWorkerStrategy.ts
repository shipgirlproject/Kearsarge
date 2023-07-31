import { join } from 'node:path';
import { WebSocketManager, WorkerShardingStrategy, WorkerShardingStrategyOptions } from '@discordjs/ws';

export class KearsargeWorkerStrategy extends WorkerShardingStrategy {
    constructor(manager: WebSocketManager, options: WorkerShardingStrategyOptions) {
        super(manager, { ...options, ...{ workerPath: join(__dirname, 'src/strategies/discordjs', 'KearsargeWorker.js') }});
    }
}
