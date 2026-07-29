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
    // additional_attributes and custom_attributes are flattened into metadata as strings,
    // alongside the contact name the channel keeps track of for itself.
    assertEquals(user?.metadata, { city: 'SP', plan: 'pro', chatwootContactName: 'Gabriel' })
    assertEquals(await bot.storage.getKv('chatwoot:555', '#chatwoot-conversation'), '42')
})

Deno.test('keeps the name a flow stored, and remembers the contact name beside it', async () => {
    const bot = createTestBot()
    await bot.storage.mergeUser('chatwoot:555', { name: 'Gabi' })

    await newChannel().receive(inbound())

    const user = await bot.storage.getUser('chatwoot:555')
    assertEquals(user?.name, 'Gabi')
    assertEquals(user?.metadata?.chatwootContactName, 'Gabriel')
})

Deno.test('follows the contact name while nothing else has claimed it', async () => {
    const bot = createTestBot()

    await newChannel().receive(inbound())
    assertEquals((await bot.storage.getUser('chatwoot:555'))?.name, 'Gabriel')

    await newChannel().receive(inbound({
        sender: {
            id: 555,
            name: 'Gabriel Ferreira',
            additional_attributes: {},
            custom_attributes: {},
        },
    }))

    assertEquals((await bot.storage.getUser('chatwoot:555'))?.name, 'Gabriel Ferreira')
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

Deno.test('sends a menu as an input_select', async () => {
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

Deno.test('offers the options of every section of a menu', async () => {
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
                    // Chatwoot shows one flat list, but a second section is not a reason to
                    // hide half of what the flow offered.
                    sections: [{ title: 'Contas', options: ['Boleto'] }, {
                        title: 'Ajuda',
                        options: ['Atendente'],
                    }],
                },
            }),
    )

    assertEquals(requests[0].json().content_attributes.items, [
        { title: 'Boleto', value: 'Boleto' },
        { title: 'Atendente', value: 'Atendente' },
    ])
})

Deno.test('names a described menu option by its title', async () => {
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
                    sections: [{ options: [{ title: 'Atendente', description: 'Falar com humano' }] }],
                },
            }),
    )

    // Not '[object Object]', which is what the user would have been asked to pick.
    assertEquals(requests[0].json().content_attributes.items, [{ title: 'Atendente', value: 'Atendente' }])
})

Deno.test('folds a header and footer into the text Chatwoot shows', async () => {
    const bot = createTestBot()
    await bot.storage.setKv('chatwoot:555', '#chatwoot-conversation', '42')

    const requests = await withFetchMock(
        ok,
        () =>
            newChannel().send('555', {
                type: 'quick-reply',
                content: { text: 'Confirma?', options: ['Sim'], header: 'Pedido 42', footer: 'Loja' },
            }),
    )

    // Chatwoot has neither, and dropping them would lose which order this is about.
    assertEquals(requests[0].json().content, 'Pedido 42\n\nConfirma?\n\nLoja')
})

Deno.test('sends the fallback text of a template', async () => {
    const bot = createTestBot()
    await bot.storage.setKv('chatwoot:555', '#chatwoot-conversation', '42')

    const requests = await withFetchMock(
        ok,
        () =>
            newChannel().send('555', {
                type: 'template',
                content: { name: 'order_update', language: 'pt_BR', fallback: 'Seu pedido saiu para entrega.' },
            }),
    )

    // The same message a flow sends on WhatsApp as an approved template.
    assertEquals(requests[0].json().content, 'Seu pedido saiu para entrega.')
})

Deno.test('says what is missing when a template has no fallback', async () => {
    const bot = createTestBot()
    await bot.storage.setKv('chatwoot:555', '#chatwoot-conversation', '42')

    await assertRejects(
        () => newChannel().send('555', { type: 'template', content: { name: 'order_update', language: 'pt_BR' } }),
        Error,
        'has no fallback text',
    )
})

Deno.test('sends media as a link an agent can open', async () => {
    const bot = createTestBot()
    await bot.storage.setKv('chatwoot:555', '#chatwoot-conversation', '42')

    const requests = await withFetchMock(
        ok,
        () =>
            newChannel().send('555', {
                type: 'media',
                content: { kind: 'image', url: 'https://example.com/a.jpg', caption: 'olha' },
            }),
    )

    assertEquals(requests[0].json().content, 'olha\n\nhttps://example.com/a.jpg')
})

Deno.test('sends a location as its name and coordinates', async () => {
    const bot = createTestBot()
    await bot.storage.setKv('chatwoot:555', '#chatwoot-conversation', '42')

    const requests = await withFetchMock(
        ok,
        () =>
            newChannel().send('555', { type: 'location', content: { latitude: -23.5, longitude: -46.6, name: 'Sé' } }),
    )

    assertEquals(requests[0].json().content, 'Sé\n\n-23.5, -46.6')
})

Deno.test('skips a raw payload meant for another channel', async () => {
    const bot = createTestBot()
    await bot.storage.setKv('chatwoot:555', '#chatwoot-conversation', '42')

    const requests = await withFetchMock(
        ok,
        () => newChannel().send('555', { type: 'raw', content: { sourceId: 'whatsapp', payload: {} } }),
    )

    assertEquals(requests.length, 0)
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
