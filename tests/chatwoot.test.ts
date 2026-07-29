import { assertEquals, assertRejects } from '@std/assert'
import { createTestBot, withFetchMock } from 'mawa/testing'
import { ChatwootChannel } from '../channel/chatwoot/mod.ts'

const newChannel = (baseUrl?: string) => new ChatwootChannel({ agentBotApiKey: 'cw-key', accountId: 7, baseUrl })

const ok = new Response(JSON.stringify({ id: 99 }), { status: 200 })

const inbound = (overrides: Record<string, unknown> = {}) =>
    new Request('http://localhost/chatwoot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            event: 'message_created',
            message_type: 'incoming',
            content_type: 'text',
            content: 'olá',
            account: { id: 7 },
            conversation: { id: 42, can_reply: true, inbox_id: 1, status: 'open' },
            sender: {
                id: 555,
                name: 'Gabriel',
                email: 'g@example.com',
                phone_number: '+5511999',
                avatar: 'https://example.com/a.png',
                thumbnail: '',
                additional_attributes: { city: 'SP' },
                custom_attributes: { plan: 'pro' },
            },
            ...overrides,
        }),
    })

Deno.test('rejects methods other than POST', async () => {
    const response = await newChannel().receive(new Request('http://localhost/chatwoot'))

    assertEquals((response as Response).status, 405)
})

Deno.test('converts an incoming text message', async () => {
    createTestBot()

    const result = await newChannel().receive(inbound())

    assertEquals(result, {
        sourceAuthorId: '555',
        message: { type: 'text', content: 'olá' },
    })
})

Deno.test('stores the sender profile and the conversation id', async () => {
    const bot = createTestBot()

    await newChannel().receive(inbound())

    const user = await bot.storage.getUser('chatwoot:555')
    assertEquals(user?.name, 'Gabriel')
    assertEquals(user?.email, 'g@example.com')
    assertEquals(user?.phoneNumber, '+5511999')
    assertEquals(user?.photoUri, 'https://example.com/a.png')
    // additional_attributes and custom_attributes are flattened into metadata as strings.
    assertEquals(user?.metadata, { city: 'SP', plan: 'pro' })
    assertEquals(await bot.storage.getKv('chatwoot:555', '#chatwoot-conversation'), '42')
})

Deno.test('ignores events other than message_created', async () => {
    createTestBot()

    const response = await newChannel().receive(inbound({ event: 'conversation_updated' }))

    assertEquals((response as Response).status, 200)
})

Deno.test('ignores outgoing messages, to avoid echoing its own replies', async () => {
    createTestBot()

    const response = await newChannel().receive(inbound({ message_type: 'outgoing' }))

    assertEquals((response as Response).status, 200)
})

Deno.test('ignores non-text content types', async () => {
    createTestBot()

    const response = await newChannel().receive(inbound({ content_type: 'input_select' }))

    assertEquals((response as Response).status, 200)
})

Deno.test('sends a text reply to the stored conversation', async () => {
    const bot = createTestBot()
    await bot.storage.setKv('chatwoot:555', '#chatwoot-conversation', '42')

    const requests = await withFetchMock(
        ok,
        () => newChannel().send('555', { type: 'text', content: 'oi' }),
    )

    assertEquals(requests.length, 1)
    assertEquals(requests[0].url, 'https://app.chatwoot.com/api/v1/accounts/7/conversations/42/messages')
    assertEquals(requests[0].headers.get('api_access_token'), 'cw-key')
    assertEquals(requests[0].json(), {
        message_type: 'outgoing',
        private: false,
        content_type: 'text',
        content: 'oi',
    })
})

Deno.test('honours a self-hosted base url', async () => {
    const bot = createTestBot()
    await bot.storage.setKv('chatwoot:555', '#chatwoot-conversation', '42')

    const requests = await withFetchMock(
        ok,
        () => newChannel('https://chat.acme.com').send('555', { type: 'text', content: 'oi' }),
    )

    assertEquals(requests[0].url, 'https://chat.acme.com/api/v1/accounts/7/conversations/42/messages')
})

Deno.test('sends a quick reply as an input_select', async () => {
    const bot = createTestBot()
    await bot.storage.setKv('chatwoot:555', '#chatwoot-conversation', '42')

    const requests = await withFetchMock(
        ok,
        () =>
            newChannel().send('555', {
                type: 'quick-reply',
                content: { text: 'Confirma?', options: ['Sim', 'Não'] },
            }),
    )

    assertEquals(requests[0].json(), {
        message_type: 'outgoing',
        private: false,
        content: 'Confirma?',
        content_type: 'input_select',
        content_attributes: {
            items: [
                { title: 'Sim', value: 'Sim' },
                { title: 'Não', value: 'Não' },
            ],
        },
    })
})

Deno.test('sends a menu as an input_select built from the first section', async () => {
    const bot = createTestBot()
    await bot.storage.setKv('chatwoot:555', '#chatwoot-conversation', '42')

    const requests = await withFetchMock(
        ok,
        () =>
            newChannel().send('555', {
                type: 'menu',
                content: {
                    text: 'Escolha',
                    button: 'Ver',
                    sections: [{ options: ['Boleto', 'Atendente'] }],
                },
            }),
    )

    assertEquals(requests[0].json().content_attributes, {
        items: [
            { title: 'Boleto', value: 'Boleto' },
            { title: 'Atendente', value: 'Atendente' },
        ],
    })
})

Deno.test('throws when there is no conversation for the user', async () => {
    createTestBot()

    await assertRejects(
        () => newChannel().send('nobody', { type: 'text', content: 'oi' }),
        Error,
        'No conversation found',
    )
})

Deno.test('throws when Chatwoot rejects the message', async () => {
    const bot = createTestBot()
    await bot.storage.setKv('chatwoot:555', '#chatwoot-conversation', '42')

    await withFetchMock(
        new Response('forbidden', { status: 403 }),
        () =>
            assertRejects(
                () => newChannel().send('555', { type: 'text', content: 'oi' }),
                Error,
                'Failed to send message',
            ),
    )
})
