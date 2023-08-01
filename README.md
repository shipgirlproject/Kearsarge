## Kearsarge

> An alternative set of strategies for [@discordjs/ws](https://github.com/discordjs/discord.js/tree/main/packages/ws) using [CloudStorm](https://github.com/DasWolke/CloudStorm/tree/master)
<p align="center">
    <img src="https://safe.kashima.moe/315ktpr2490f.png"> 
</p>

> The ShipGirl Project, feat Kearsarge; ⓒ Azur Lane

### Notes

* Uses mixed code between [@discordjs/ws](https://github.com/discordjs/discord.js/tree/main/packages/ws) and [CloudStorm](https://github.com/DasWolke/CloudStorm/tree/master)

* Does not break anything in [@discordjs/ws](https://github.com/discordjs/discord.js/tree/main/packages/ws)

* Implements both simple and worker sharding strategies of [@discordjs/ws](https://github.com/discordjs/discord.js/tree/main/packages/ws)

* Has support for etf encoding and zlib compression (If you need those!)

* Probably fast as well?

### Installation

* Stable Branch
> `npm i kearsarge --save`

* Dev Branch
> `npm install https://github.com/Deivu/Kearsarge.git --save`

### Example usages

> Using with Discord.JS with (Discord.JS default strategy)
```js 
import { KearsargeSimpleStrategy } from 'kearsarge';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { Client } from 'discord.js';

const options = {
    allowedMentions: { parse: [ 'users', 'roles' ] },
    intents: [ Guilds ],
    makeCache: Options.cacheWithLimits(Options.DefaultMakeCacheSettings),
    ws: {
        buildStrategy: (manager) => new KearsargeSimpleStrategy(manager)
    }
}

const client = new Client(options);

await client.login();
```

> Using with Indomitable with enabled concurrency handling

* Note: Don't use this if you don't use `handleConcurrency`. in those cases, use the discordjs strategies

```js
import { IndomitableStrategy } from 'kearsarge';
import { Indomitable } from 'indomitable';
import { Client } from 'discord.js';

const options = {
    clusterCount: 2,
    shardCount: 8,
    clientOptions: {
        intents: [1 << 0],
        ws: {
            buildStrategy: manager => new IndomitableStrategy(manager)
        }
    },
    autoRestart: true,
    handleConcurrency: true,
    client: Client,
    token: process.env.DISCORD_TOKEN
}

const manager = new Indomitable(options)
    .on('error', console.error);

manager.spawn();
```

> Using simple strategy (Discord.JS default strategy)
```js
import { KearsargeSimpleStrategy } from 'kearsarge';
import { WebSocketManager, WebSocketShardEvents } from '@discordjs/ws';
import { REST } from '@discordjs/rest';

const rest = new REST().setToken(process.env.DISCORD_TOKEN);
const manager = new WebSocketManager({
    token: process.env.DISCORD_TOKEN,
    intents: 0,
    buildStrategy: (manager) => new KearsargeSimpleStrategy(manager),
    rest
});

manager.on(WebSocketShardEvents.Dispatch, (event) => console.log(event));

await manager.connect();
```

> Using worker strategy
```js
import { KearsargeWorkerStrategy } from 'kearsarge';
import { WebSocketManager, WebSocketShardEvents } from '@discordjs/ws';
import { REST } from '@discordjs/rest';

const rest = new REST().setToken(process.env.DISCORD_TOKEN);
const manager = new WebSocketManager({
    token: process.env.DISCORD_TOKEN,
    intents: 0,
    buildStrategy: (manager) => new KearsargeWorkerStrategy(manager, { shardsPerWorker: 2 }),
    rest
});

manager.on(WebSocketShardEvents.Dispatch, (event) => console.log(event));

await manager.connect();
```

> Use of different encoding with compression
```js
import { KearsargeWorkerStrategy, WebsocketEncoding } from 'kearsarge';
import { CompressionMethod, WebSocketManager, WebSocketShardEvents } from '@discordjs/ws';
import { REST } from '@discordjs/rest';

const rest = new REST().setToken(process.env.DISCORD_TOKEN);
const manager = new WebSocketManager({
    token: process.env.DISCORD_TOKEN,
    // @ts-expect-error: overrides the type of discord.js encodings
    encoding: WebsocketEncoding.ETF,
    compression: CompressionMethod.ZlibStream,
    intents: 0,
    buildStrategy: (manager) => new KearsargeWorkerStrategy(manager, { shardsPerWorker: 2 }),
    rest
});
```

### Reminder

* If you have custom strategies or bootstrappers, changing the WebsocketShard class to Kearsarge's websocket class will work. You don\'t need to use any of my strategies if you have your own
