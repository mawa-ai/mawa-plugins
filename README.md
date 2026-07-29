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
            // Required: every delivery's X-Hub-Signature-256 is verified against it.
            appSecret: Deno.env.get('WA_APP_SECRET')!,
            // Defaults to the current Graph API version; pin it to control when you move.
            graphApiVersion: 'v25.0',
        }),
    ],
    storage: new MongoDbStorage(Deno.env.get('MONGODB_URL')!),
} satisfies Configuration
```

## WhatsApp

### `appSecret` is required

Every delivery's `X-Hub-Signature-256` is verified, and there is no way to turn that off. A webhook that cannot verify a
delivery has no idea who sent it: the author of an inbound message comes from the payload, so anyone who knows the URL
could drive any user's conversation. The secret is under App settings → Basic in the Meta dashboard.

### What travels each way

| Message       | Out                                                      | In                                              |
| ------------- | -------------------------------------------------------- | ----------------------------------------------- |
| `text`        | yes, with link previews; split when over 4096 characters | yes                                             |
| `quick-reply` | up to 3 reply buttons, with optional header and footer   | replies come back as `text`                     |
| `menu`        | a list, up to 10 rows over 10 sections                   | replies come back as `text`                     |
| `media`       | by public `url` or by `id` from `uploadMedia`            | as an `id`; read the bytes with `downloadMedia` |
| `location`    | yes                                                      | yes                                             |
| `template`    | yes                                                      | —                                               |
| `raw`         | passed through, for anything below                       | —                                               |

A reply is matched on the option id the channel sent, not on the title WhatsApp echoes, so a flow sees the option text
it wrote rather than the version cut to 20 characters for display.

Interactive features with no message type of their own — CTA URL buttons, Flows, product messages, address messages —
are reachable through `raw`, addressed to `'whatsapp'`:

```ts
await context.send({
    type: 'raw',
    content: { sourceId: 'whatsapp', payload: { type: 'interactive', interactive: {/* ... */} } },
})
```

### Reaching a user first

WhatsApp refuses free-form messages more than 24 hours after the user's last one. Past that only an approved template
gets through, and a send that hits the limit says so:

```ts
await context.send({
    type: 'template',
    content: {
        name: 'order_update',
        language: 'pt_BR',
        parameters: [orderId, days],
        // Sent by channels that have no approved templates, so the same flow works on all of them.
        fallback: `Seu pedido ${orderId} chega em ${days} dias.`,
    },
})
```

### Who the user is

**The phone number is not the identity.** WhatsApp usernames let a user hide their number from a business, and when they
do, `wa_id` and `from` are simply absent from the webhook — the fields most integrations were built to require. What is
always sent is `user_id` / `from_user_id`, Meta's business-scoped user ID (BSUID), which is stable and scoped to your
business portfolio.

So a conversation is keyed on the BSUID where there is one, and on the phone number otherwise. Three things follow:

- `author.id` may be `whatsapp:BR.13491208655302741918` rather than `whatsapp:5511999999999`. Do not parse a phone
  number out of it.
- `author.phoneNumber` is **optional**. It is set only when the user actually shared a number. A flow that needs one has
  to ask, or request it, rather than assume.
- `author.metadata.whatsappUsername` holds the `@handle` when the user has one, which is often all an agent has to go
  on.

**Nothing to migrate.** A user whose conversation started under their phone number keeps it: the first time their BSUID
appears, the channel finds the existing phone-keyed user and links the two, so the flow carries on mid-conversation. New
users are keyed on the BSUID from the start. Outbound sends address a BSUID as `recipient` and a phone number as `to`,
which is read off the id's shape, so nothing has to be remembered per user.

Sources:
[Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/).

### Who owns the user's name

A WhatsApp profile name is whatever the user last typed into their own settings, and it arrives with every message.
Writing it to `User.name` each time would undo the most ordinary thing a flow does — ask what to call someone and store
the answer — one message later.

So the channel claims `name` when the user is first seen, and keeps it in step with the profile only while nothing else
has touched it. Once a flow, a hook or an agent sets `name`, it stays theirs. The profile name is always available in
`author.metadata.whatsappProfileName`. Chatwoot behaves the same way, under `chatwootContactName`.

### What is not a message

Reactions, orders, contact cards, Flow completions and anything Meta adds next arrive as `event` messages rather than
being dropped, so the `event` hook can answer instead of the bot going quiet. Event names are in `WHATSAPP_EVENTS`.
Delivery statuses are logged, and reported as events too when `statusEvents` is set.

Inbound messages are marked read with a typing indicator before the flow runs, in one request. `acknowledge: 'read'`
drops the indicator, `'none'` skips the request entirely.

### Redeliveries

Meta retries a delivery that is slow or answered with anything but a 200. The channel reports each message's `wamid` as
the `SourceMessage.id`, and the SDK skips one it has already handled — under the same per-user lock that serializes
handling, so two retries arriving together cannot both slip through.

Prefer a storage that implements `lock` when running more than one instance: `MongoDbStorage` does, and without it two
instances handling the same user at once can lose a state transition.

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

`tests/mongodb.test.ts` needs a real server and is skipped unless `MONGODB_TEST_URL` is set. The per-user lock is only
covered there, so run these after touching it:

```sh
docker run --rm -d -p 27017:27017 --name mawa-mongo mongo:8
MONGODB_TEST_URL=mongodb://localhost:27017 deno task test
docker rm -f mawa-mongo
```
