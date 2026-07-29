import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert'
import { createTestBot, withFetchMock } from 'mawa/testing'
import { DEFAULT_GRAPH_API_VERSION, WhatsappChannel } from '../channel/whatsapp/mod.ts'

const channelConfig = {
    numberId: '111222',
    token: 'wa-token',
    verifyToken: 'verify-me',
}

const newChannel = (overrides: Partial<typeof channelConfig> & { graphApiVersion?: string } = {}) =>
    new WhatsappChannel({ ...channelConfig, ...overrides })

const ok = new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 })

const inbound = (message: unknown) =>
    new Request('http://localhost/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            entry: [{
                changes: [{
                    value: {
                        metadata: { phone_number_id: '111222' },
                        contacts: [{ wa_id: '5511999', profile: { name: 'Gabriel' } }],
                        messages: [message],
                    },
                }],
            }],
        }),
    })

Deno.test('completes the webhook verification handshake', async () => {
    const channel = newChannel()

    const response = await channel.receive(
        new Request('http://localhost/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123'),
    )

    assertEquals((response as Response).status, 200)
    assertEquals(await (response as Response).text(), 'abc123')
})

Deno.test('rejects webhook verification with the wrong token', async () => {
    const channel = newChannel()

    const response = await channel.receive(
        new Request('http://localhost/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123'),
    )

    assertEquals((response as Response).status, 403)
})

Deno.test('rejects methods other than GET and POST', async () => {
    const channel = newChannel()

    const response = await channel.receive(new Request('http://localhost/whatsapp', { method: 'DELETE' }))

    assertEquals((response as Response).status, 405)
})

Deno.test('converts an inbound text message', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(inbound({ type: 'text', text: { body: 'olá' } }))

    assertEquals(result, {
        sourceAuthorId: '5511999',
        message: { type: 'text', content: 'olá' },
    })
})

Deno.test('stores the contact name and phone number on receive', async () => {
    const bot = createTestBot()
    const channel = newChannel()

    await channel.receive(inbound({ type: 'text', text: { body: 'olá' } }))

    const user = await bot.storage.getUser('whatsapp:5511999')
    assertEquals(user?.name, 'Gabriel')
    assertEquals(user?.phoneNumber, '5511999')
})

Deno.test('converts a button reply into the button title', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(inbound({
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: '0', title: 'Sim' } },
    }))

    assertEquals((result as { message: unknown }).message, { type: 'text', content: 'Sim' })
})

Deno.test('converts a list reply into the row title', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(inbound({
        type: 'interactive',
        interactive: { type: 'list_reply', list_reply: { id: '0.1', title: 'Segunda via' } },
    }))

    assertEquals((result as { message: unknown }).message, { type: 'text', content: 'Segunda via' })
})

Deno.test('ignores status callbacks that carry no message', async () => {
    createTestBot()
    const channel = newChannel()

    const response = await channel.receive(
        new Request('http://localhost/whatsapp', {
            method: 'POST',
            body: JSON.stringify({
                entry: [{
                    changes: [{
                        value: { metadata: { phone_number_id: '111222' }, statuses: [{ status: 'delivered' }] },
                    }],
                }],
            }),
        }),
    )

    assertEquals((response as Response).status, 200)
})

Deno.test('refuses messages addressed to another number', async () => {
    createTestBot()
    const channel = newChannel()

    const response = await channel.receive(
        new Request('http://localhost/whatsapp', {
            method: 'POST',
            body: JSON.stringify({
                entry: [{ changes: [{ value: { metadata: { phone_number_id: 'someone-else' } } }] }],
            }),
        }),
    )

    assertEquals((response as Response).status, 400)
})

Deno.test('sends a text message with the documented payload', async () => {
    const channel = newChannel()

    const requests = await withFetchMock(ok, () => channel.send('5511999', { type: 'text', content: 'olá' }))

    assertEquals(requests.length, 1)
    assertEquals(requests[0].method, 'POST')
    assertEquals(requests[0].headers.get('Authorization'), 'Bearer wa-token')
    assertEquals(requests[0].json(), {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '5511999',
        type: 'text',
        text: { body: 'olá' },
    })
})

Deno.test('targets the current Graph API version by default', async () => {
    const channel = newChannel()

    const requests = await withFetchMock(ok, () => channel.send('5511999', { type: 'text', content: 'olá' }))

    assertEquals(
        requests[0].url,
        `https://graph.facebook.com/${DEFAULT_GRAPH_API_VERSION}/111222/messages`,
    )
    assertStringIncludes(DEFAULT_GRAPH_API_VERSION, 'v')
})

Deno.test('honours a pinned Graph API version', async () => {
    const channel = newChannel({ graphApiVersion: 'v23.0' })

    const requests = await withFetchMock(ok, () => channel.send('5511999', { type: 'text', content: 'olá' }))

    assertEquals(requests[0].url, 'https://graph.facebook.com/v23.0/111222/messages')
})

Deno.test('sends a quick reply as an interactive button message', async () => {
    const channel = newChannel()

    const requests = await withFetchMock(
        ok,
        () =>
            channel.send('5511999', {
                type: 'quick-reply',
                content: { text: 'Confirma?', options: ['Sim', 'Não'] },
            }),
    )

    assertEquals(requests[0].json(), {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '5511999',
        type: 'interactive',
        interactive: {
            type: 'button',
            body: { text: 'Confirma?' },
            action: {
                buttons: [
                    { type: 'reply', reply: { id: '0', title: 'Sim' } },
                    { type: 'reply', reply: { id: '1', title: 'Não' } },
                ],
            },
        },
    })
})

Deno.test('sends a menu as an interactive list message', async () => {
    const channel = newChannel()

    const requests = await withFetchMock(
        ok,
        () =>
            channel.send('5511999', {
                type: 'menu',
                content: {
                    text: 'Escolha',
                    button: 'Ver opções',
                    sections: [{
                        title: 'Serviços',
                        options: ['Boleto', { title: 'Atendente', description: 'Falar com humano' }],
                    }],
                },
            }),
    )

    assertEquals(requests[0].json().interactive, {
        type: 'list',
        body: { text: 'Escolha' },
        action: {
            button: 'Ver opções',
            sections: [{
                title: 'Serviços',
                rows: [
                    { id: '0.0', title: 'Boleto' },
                    { id: '0.1', title: 'Atendente', description: 'Falar com humano' },
                ],
            }],
        },
    })
})

Deno.test('throws when the Graph API rejects the message', async () => {
    const channel = newChannel()

    await withFetchMock(
        new Response(JSON.stringify({ error: { message: 'invalid token' } }), { status: 401 }),
        () =>
            assertRejects(
                () => channel.send('5511999', { type: 'text', content: 'olá' }),
                Error,
                'Failed to send message to whatsapp: 401',
            ),
    )
})

Deno.test('refuses to send a message type it cannot convert', async () => {
    const channel = newChannel()

    await assertRejects(
        () => channel.send('5511999', { type: 'event', content: { event: 'x', data: null } }),
        Error,
        'No converter found',
    )
})
