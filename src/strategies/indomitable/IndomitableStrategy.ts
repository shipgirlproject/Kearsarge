import { join } from 'node:path';
import { WebSocketManager } from '@discordjs/ws';
import { BaseWorker, IndomitableStrategy as IndomitableOriginalStrategy } from 'indomitable';

export const WorkerOptions = {
    path: join(__dirname, 'src/strategies/indomitable/', 'IndomitableWorker.js'),
    resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 32
    }
};

export class IndomitableStrategy extends IndomitableOriginalStrategy {
    constructor(manager: WebSocketManager) {
        super(manager, new BaseWorker(), WorkerOptions);
    }
}
