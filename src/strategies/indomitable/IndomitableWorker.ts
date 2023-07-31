import { WebSocketShardEvents } from '@discordjs/ws';
import { workerData } from 'worker_threads';
import { WorkerData, IndomitableFetchingStrategy, ThreadStrategyWorker , Utils } from 'indomitable';
import { WebsocketShard } from '../../structure/WebsocketShard';

const options = workerData as WorkerData;

const ipc = new ThreadStrategyWorker();
const strategy = new IndomitableFetchingStrategy(ipc, options);
const shard = new WebsocketShard(options.shardId, strategy);

// @ts-expect-error: same class as discord.js
ipc.build(shard);

for (const event of Object.values(WebSocketShardEvents)) {
    // @ts-expect-error: unknown fix
    shard.on(event, data => {
        const content: Utils.ThreadStrategyData = {
            op: Utils.ThreadStrategyOps.SHARD_EVENT,
            event,
            data,
            shardId: shard.id,
            internal: true
        };
        ipc.send({ content })
            .catch(() => null);
    });
}
