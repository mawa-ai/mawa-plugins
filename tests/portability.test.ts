/**
 * One flow, every channel.
 *
 * The SDK's message types are only worth having if a bot written once runs wherever it is
 * plugged in. This drives the same fixture flow — which never mentions a channel — through
 * each of them and checks that every message it sends arrives as something, rather than
 * throwing or being quietly dropped.
 *
 * A channel that cannot render a type is expected to render it differently, not to refuse it.
 * `raw` is the deliberate exception: it is addressed to one channel and skipped by the others.
 */

import { assertEquals, assertGreater } from '@std/assert'
import { handleMessage } from 'mawa/hosting'
import { createTestBot, withFetchMock } from 'mawa/testing'
import { ChatwootChannel } from '../channel/chatwoot/mod.ts'
import { MawaChatChannel } from '../channel/mawa-chat/mod.ts'
import { WhatsappChannel } from '../channel/whatsapp/mod.ts'
import { mawa } from '../deps.ts'

const FIXTURE = 'tests/fixtures/portable'

/** How many messages the fixture flow sends. */
const SENT = 6

const ok = Response.json({ messages: [{ id: 'wamid.1' }] })

Deno.test('a whatsapp channel renders every portable message type', async () => {
    const channel = new WhatsappChannel({
        numberId: '111222',
        token: 't',
        verifyToken: 'v',
        appSecret: 's',
        acknowledge: 'none',
    })
    const bot = createTestBot({ directory: FIXTURE, channels: [channel] })

    const requests = await withFetchMock(
        ok,
        () => handleMessage({ sourceAuthorId: '5511999', message: { type: 'text', content: 'oi' } }, channel),
    )

    assertEquals(requests.length, SENT)
    assertEquals(requests.map((request) => request.json().type), [
        'text',
        'interactive',
        'interactive',
        'image',
        'location',
        'template',
    ])
    assertEquals(await bot.currentState(), undefined)
})

Deno.test('a chatwoot channel renders every portable message type', async () => {
    const channel = new ChatwootChannel({ agentBotApiKey: 'k', accountId: 7 })
    const bot = createTestBot({ directory: FIXTURE, channels: [channel] })
    await bot.storage.setKv('chatwoot:555', '#chatwoot-conversation', '42')

    const requests = await withFetchMock(
        ok,
        () => handleMessage({ sourceAuthorId: '555', message: { type: 'text', content: 'oi' } }, channel),
    )

    assertEquals(requests.length, SENT)

    // Nothing arrived empty: a converter that dropped its content would show up here.
    for (const request of requests) {
        assertGreater(String(request.json().content).length, 0)
    }

    // The two that Chatwoot has no shape for still say what they mean.
    assertEquals(requests[3].json().content, 'Seu boleto\n\nhttps://example.com/boleto.png')
    assertEquals(requests[5].json().content, 'Seu pedido 42 saiu para entrega.')
})

Deno.test('a web chat channel carries every portable message type to the client', async () => {
    const channel = new MawaChatChannel()
    createTestBot({ directory: FIXTURE, channels: [channel] })

    const auth = await channel.receive(new Request('http://localhost/web?action=auth')) as Response
    const { user, password } = await auth.json()

    const response = await channel.handle(
        new Request('http://localhost/web', {
            method: 'POST',
            headers: { Authorization: `Basic ${btoa(`${user}:${password}`)}` },
            body: JSON.stringify({ type: 'text', content: 'oi' }),
        }),
        handleMessage,
    )

    const messages: mawa.UnknownMessage[] = await response.json()

    // The widget gets the messages as they were written, and decides how to draw them.
    assertEquals(messages.map((message) => message.type), [
        'text',
        'quick-reply',
        'menu',
        'media',
        'location',
        'template',
    ])
})

Deno.test('a raw message reaches only the channel it names', async () => {
    createTestBot()
    const whatsapp = new WhatsappChannel({ numberId: '111222', token: 't', verifyToken: 'v', appSecret: 's' })
    const chatwoot = new ChatwootChannel({ agentBotApiKey: 'k', accountId: 7 })
    const message: mawa.UnknownMessage = {
        type: 'raw',
        content: { sourceId: 'whatsapp', payload: { type: 'interactive', interactive: { type: 'cta_url' } } },
    }

    const toWhatsapp = await withFetchMock(ok, () => whatsapp.send('5511999', message))
    const toChatwoot = await withFetchMock(ok, () => chatwoot.send('555', message))

    assertEquals(toWhatsapp.length, 1)
    // Not even the conversation was looked up, so an unrelated channel cannot fail on it.
    assertEquals(toChatwoot.length, 0)
})
