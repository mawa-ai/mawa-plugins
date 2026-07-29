import { assertEquals } from '@std/assert'
import { createTestBot, createTestContext, withFetchMock } from 'mawa/testing'
import ChatwootPlugin from '../plugins/chatwoot/mod.ts'

const newPlugin = (baseUrl?: string) => new ChatwootPlugin(7, 'cw-key', 3, baseUrl)

const author = {
    id: 'whatsapp:5511999' as const,
    name: 'Gabriel',
    email: 'g@example.com',
    phoneNumber: '5511999',
    photoUri: 'https://example.com/a.png',
    metadata: { plan: 'pro' },
}

const buildContext = (kv: Map<string, unknown>) => createTestContext({ author, kv })

Deno.test('creates a Chatwoot contact on the first user message', async () => {
    createTestBot()
    const kv = new Map<string, unknown>()
    const context = buildContext(kv)

    const requests = await withFetchMock(
        new Response(JSON.stringify({ id: 501 }), { status: 200 }),
        () => newPlugin().userMessageHook(context),
    )

    assertEquals(requests.length, 1)
    assertEquals(requests[0].url, 'https://app.chatwoot.com/api/v1/accounts/7/contacts')
    assertEquals(requests[0].headers.get('api_access_token'), 'cw-key')
    assertEquals(requests[0].json(), {
        inbox_id: 3,
        name: 'Gabriel',
        email: 'g@example.com',
        phone_number: '+5511999',
        identifier: 'whatsapp:5511999',
        avatar_url: 'https://example.com/a.png',
        additional_attributes: { plan: 'pro' },
    })
    assertEquals(kv.get('#chatwoot-contact'), 501)
})

Deno.test('does not recreate a contact that already exists', async () => {
    createTestBot()
    const kv = new Map<string, unknown>([['#chatwoot-contact', 501]])
    const context = buildContext(kv)

    const requests = await withFetchMock(
        new Response('{}', { status: 200 }),
        () => newPlugin().userMessageHook(context),
    )

    assertEquals(requests.length, 0)
})

Deno.test('opens a conversation and mirrors a received message', async () => {
    createTestBot()
    const kv = new Map<string, unknown>([['#chatwoot-contact', 501]])
    const context = buildContext(kv)

    const requests = await withFetchMock(
        new Response(JSON.stringify({ id: 902 }), { status: 200 }),
        () => newPlugin().messageHook(context, 'received', { type: 'text', content: 'oi' }),
    )

    assertEquals(requests.length, 2)

    assertEquals(requests[0].url, 'https://app.chatwoot.com/api/v1/accounts/7/conversations')
    assertEquals(requests[0].json(), {
        source_id: 'whatsapp',
        inbox_id: 3,
        contact_id: 501,
        additional_attributes: { plan: 'pro' },
        status: 'pending',
    })

    assertEquals(requests[1].url, 'https://app.chatwoot.com/api/v1/accounts/7/conversations/902/messages')
    assertEquals(requests[1].json(), {
        message_type: 'incoming',
        private: false,
        content: 'oi',
    })
})

Deno.test('marks bot replies as outgoing', async () => {
    createTestBot()
    const kv = new Map<string, unknown>([['#chatwoot-contact', 501], ['#chatwoot-conversation', 902]])
    const context = buildContext(kv)

    const requests = await withFetchMock(
        new Response('{}', { status: 200 }),
        () => newPlugin().messageHook(context, 'sent', { type: 'text', content: 'olá!' }),
    )

    assertEquals(requests.length, 1)
    assertEquals(requests[0].json(), {
        message_type: 'outgoing',
        private: false,
        content: 'olá!',
    })
})

Deno.test('mirrors a menu using its text body', async () => {
    createTestBot()
    const kv = new Map<string, unknown>([['#chatwoot-contact', 501], ['#chatwoot-conversation', 902]])
    const context = buildContext(kv)

    const requests = await withFetchMock(
        new Response('{}', { status: 200 }),
        () =>
            newPlugin().messageHook(context, 'sent', {
                type: 'menu',
                content: { text: 'Escolha', button: 'Ver', sections: [{ options: ['a'] }] },
            }),
    )

    assertEquals(requests[0].json().content, 'Escolha')
})

Deno.test('does nothing when there is no contact to attach the conversation to', async () => {
    createTestBot()
    const context = buildContext(new Map())

    const requests = await withFetchMock(
        new Response('{}', { status: 200 }),
        () => newPlugin().messageHook(context, 'received', { type: 'text', content: 'oi' }),
    )

    assertEquals(requests.length, 0)
})

Deno.test('honours a self-hosted base url', async () => {
    createTestBot()
    const kv = new Map<string, unknown>()
    const context = buildContext(kv)

    const requests = await withFetchMock(
        new Response(JSON.stringify({ id: 501 }), { status: 200 }),
        () => newPlugin('https://chat.acme.com').userMessageHook(context),
    )

    assertEquals(requests[0].url, 'https://chat.acme.com/api/v1/accounts/7/contacts')
})

Deno.test('exposes the handover state under the plugin id', () => {
    const plugin = newPlugin()

    assertEquals(plugin.id, 'chatwoot')
    assertEquals(typeof plugin.states.send, 'function')
    assertEquals(typeof plugin.hooks.message, 'function')
    assertEquals(typeof plugin.hooks.usermessage, 'function')
})
