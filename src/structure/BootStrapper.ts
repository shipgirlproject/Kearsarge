import {
    BootstrapOptions,
    WebSocketShardEvents,
    WorkerBootstrapper,
    WorkerContextFetchingStrategy,
    WorkerReceivePayload,
    WorkerReceivePayloadOp
} from '@discordjs/ws';
import { WebsocketShard } from './WebsocketShard';
import { parentPort } from 'worker_threads';

export class BootStrapper extends WorkerBootstrapper {
    public async bootstrap(options: Readonly<BootstrapOptions> = {}): Promise<void> {
        // Start by initializing the shards
        for (const shardId of this.data.shardIds) {
            const shard = new WebsocketShard(shardId, new WorkerContextFetchingStrategy(this.data));
            for (const event of options.forwardEvents ?? Object.values(WebSocketShardEvents)) {
                // @ts-expect-error: Event types incompatible
                shard.on(event, (data) => {
                    const payload: WorkerReceivePayload = {
                        op: WorkerReceivePayloadOp.Event,
                        event,
                        data,
                        shardId,
                    };
                    parentPort!.postMessage(payload);
                });
            }

            // Any additional setup the user might want to do
            // @ts-expect-error: custom shard class that has the same properties
            await options.shardCallback?.(shard);
            // @ts-expect-error: custom shard class that has the same properties
            this.shards.set(shardId, shard);
        }
        // Lastly, start listening to messages from the parent thread
        this.setupThreadEvents();
        const message: WorkerReceivePayload = {
            op: WorkerReceivePayloadOp.WorkerReady,
        };
        parentPort!.postMessage(message);
    }
}
