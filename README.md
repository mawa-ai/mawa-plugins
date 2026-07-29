# @mawa/plugins

Channels, storage backends and hosting adapters for [`@mawa/sdk`](https://github.com/mawa-ai/mawa-sdk).

Requires [Deno](https://deno.com) 2.x.

## What is here

| Import                             | What it is                               |
| ---------------------------------- | ---------------------------------------- |
| `@mawa/plugins/channel/whatsapp`   | WhatsApp Cloud API channel (Graph API)   |
| `@mawa/plugins/channel/chatwoot`   | Chatwoot channel, driven by an agent bot |
| `@mawa/plugins/channel/mawa-chat`  | HTTP channel for a web chat widget       |
| `@mawa/plugins/plugin/chatwoot`    | Mirrors conversations into Chatwoot      |
| `@mawa/plugins/storage/mongodb`    | Storage backed by MongoDB                |
| `@mawa/plugins/hosting/aws`        | AWS Lambda handler (HTTP API payload v2) |
| `@mawa/plugins/hosting/cloudflare` | Cloudflare Workers `fetch` listener      |

```ts
import { WhatsappChannel } from '@mawa/plugins/channel/whatsapp'
import { MongoDbStorage } from '@mawa/plugins/storage/mongodb'
import type { Configuration } from '@mawa/sdk'

export default {
    channels: [
        new WhatsappChannel({
            numberId: Deno.env.get('WA_NUMBER_ID')!,
            token: Deno.env.get('WA_TOKEN')!,
            verifyToken: Deno.env.get('WA_VERIFY_TOKEN')!,
            // Defaults to the current Graph API version; pin it to control when you move.
            graphApiVersion: 'v25.0',
        }),
    ],
    storage: new MongoDbStorage(Deno.env.get('MONGODB_URL')!),
} satisfies Configuration
```

## Cloudflare Workers

Workers has no filesystem, so the bot has to be bundled ahead of time. Write the entrypoint once:

```ts
// bot/worker.ts
import { createFetchListener } from '@mawa/plugins/hosting/cloudflare'

export default { fetch: createFetchListener() }
```

Then bundle and deploy. States are discovered and imported for you; there is no per-state import to maintain.

```sh
deno run -A jsr:@mawa/sdk/bundle --bot ./bot --entry ./bot/worker.ts -o dist/worker.js
npx wrangler deploy
```

```jsonc
// wrangler.jsonc
{
    "name": "my-bot",
    "main": "dist/worker.js",
    "compatibility_date": "2026-07-01"
}
```

Secrets set with `wrangler secret put` reach `mawa.config.ts` through `Deno.env.get(...)`, which the generated bundle
shims over the Worker's bindings. Two things do not carry over: `@std/dotenv`'s `load()` needs a filesystem, and
`MongoDbStorage` needs raw TCP that the MongoDB driver cannot get on Workers — use a storage reachable over HTTP
instead.

Webhook channels such as WhatsApp and Chatwoot are acknowledged as soon as the message is accepted, with the flow
finishing in `ctx.waitUntil`, so providers that retry on a slow response get their prompt 200. Channels that build their
reply into the response, such as the web chat, are still awaited. Nothing to configure: whether a channel's reply
travels in the response is already known from how the channel is written.

`deno task e2e:cloudflare` bundles the fixture bot, serves it with `wrangler dev` and drives a real conversation through
workerd. It needs Node, so it is not part of `deno task test`.

## Development

This repo depends on `@mawa/sdk`, and `deno.json` links that dependency to a local checkout so both can be changed
together:

```json
{
    "imports": { "mawa": "jsr:@mawa/sdk@^0.1.0" },
    "links": ["../mawa-sdk"]
}
```

**Clone both repos side by side**, or every command fails with `Could not find link member`:

```
your-workspace/
  mawa-sdk/
  mawa-plugins/
```

```sh
git clone https://github.com/mawa-ai/mawa-sdk.git
git clone https://github.com/mawa-ai/mawa-plugins.git
cd mawa-plugins && deno task test
```

The `links` entry only affects this repo's own commands. A project that installs `@mawa/plugins` resolves `@mawa/sdk`
from JSR through the `imports` entry above, so consumers are unaffected by it.

```sh
deno task test    # run the test suite
deno task check   # type check
deno task ci      # fmt --check + lint + check + test
```

`tests/mongodb.test.ts` needs a real server and is skipped unless `MONGODB_TEST_URL` is set:

```sh
docker run --rm -d -p 27017:27017 --name mawa-mongo mongo:8
MONGODB_TEST_URL=mongodb://localhost:27017 deno task test
docker rm -f mawa-mongo
```
