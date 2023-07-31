import { WorkerShardingStrategy } from '@discordjs/ws';
import { join, isAbsolute, resolve } from 'node:path';

// @ts-expect-error: replaces the resolve worker path due to custom worker
export class KearsargeWorkerStrategy extends WorkerShardingStrategy {
    private resolveWorkerPath(): string {
        // @ts-expect-error: access passed options
        const path = this.options.workerPath;
        if (!path) {
            return join(__dirname, 'src/strategies/discordjs', 'KearsargeWorker.js');
        }
        if (isAbsolute(path)) {
            return path;
        }
        if (/^\.\.?[/\\]/.test(path)) {
            return resolve(path);
        }
        try {
            return require.resolve(path);
        } catch {
            return resolve(path);
        }
    }
}
