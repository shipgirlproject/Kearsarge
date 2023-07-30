import {
    managerToFetchingStrategyOptions,
    SimpleContextFetchingStrategy,
    SimpleShardingStrategy,
    WebSocketShardEvents
} from '@discordjs/ws';
import { WebsocketShard } from './structure/WebsocketShard';

export class KearsargeSimpleStrategy extends SimpleShardingStrategy {
    public async spawn(shardIds: number[]): Promise<void> {
        // @ts-expect-error: needs to pass the manager
        const strategyOptions = await managerToFetchingStrategyOptions(this.manager);
        for (const shardId of shardIds) {
            // @ts-expect-error: needs to pass the manager
            const strategy = new SimpleContextFetchingStrategy(this.manager, strategyOptions);
            const shard = new WebsocketShard(shardId, strategy);
            for (const event of Object.values(WebSocketShardEvents)) {
                // @ts-expect-error: Intentional
                shard.on(event, (payload) => this.manager.emit(event, { ...payload, shardId }));
            }
            // @ts-expect-error: needs to set the shards to the map
            this.shards.set(shardId, shard);
        }
    }
}
