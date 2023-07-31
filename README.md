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

* Dev Branch
> `npm install https://github.com/Deivu/Kearsarge.git`

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
