import { assertEquals, assertNotEquals, assertRejects, assertStringIncludes } from '@std/assert'
import { handleMessage, resolveChannel } from 'mawa/hosting'
import { createTestBot, type RecordedRequest, withFetchMock } from 'mawa/testing'
import { mawa } from '../deps.ts'
import {
    DEFAULT_GRAPH_API_VERSION,
    isBusinessScopedId,
    WHATSAPP_EVENTS,
    WhatsappChannel,
    type WhatsappChannelConfig,
} from '../channel/whatsapp/mod.ts'

const APP_SECRET = 'app-secret'

const channelConfig = {
    numberId: '111222',
    token: 'wa-token',
    verifyToken: 'verify-me',
    appSecret: APP_SECRET,
    // Off in most tests so that receiving does not reach for the network. Acknowledgement is
    // covered by its own tests below.
    acknowledge: 'none',
} satisfies WhatsappChannelConfig

const newChannel = (overrides: Partial<WhatsappChannelConfig> = {}) =>
    new WhatsappChannel({ ...channelConfig, ...overrides })

const ok = new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 })

const sign = async (body: string, secret: string) => {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    )
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
    return 'sha256=' +
        Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * A signed POST to the webhook, which is the only kind the channel accepts.
 *
 * Every delivery in these tests goes through the real signature, so the verification path is
 * exercised by all of them rather than only by the handful of tests about it.
 */
const post = async (body: string) =>
    new Request('http://localhost/whatsapp', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Hub-Signature-256': await sign(body, APP_SECRET),
        },
        body,
    })

/** A webhook delivery wrapping whatever `value` describes. */
const delivery = (value: unknown) =>
    post(JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'messages', value }] }],
    }))

let deliveredCount = 0

/**
 * A delivery carrying `messages`, from a contact that knows who it is.
 *
 * Every message gets a distinct id unless it brings its own, because the channel recognizes
 * a redelivery by id and would otherwise handle only the first of two identical ones. Tests
 * about redelivery pass the id themselves.
 */
const inbound = (...messages: Record<string, unknown>[]) =>
    delivery({
        metadata: { phone_number_id: '111222' },
        contacts: [{ wa_id: '5511999', profile: { name: 'Gabriel' } }],
        messages: messages.map((message) => ({ id: `wamid.${++deliveredCount}`, ...message })),
    })

const messages = (result: Awaited<ReturnType<WhatsappChannel['receive']>>): mawa.SourceMessage[] => {
    if (result instanceof Response) {
        throw new Error(`Expected messages, got a ${result.status} response`)
    }
    return result
}

const contents = (result: Awaited<ReturnType<WhatsappChannel['receive']>>) =>
    messages(result).map(({ message }) => ({ type: message.type, content: message.content }))

const status = (result: Awaited<ReturnType<WhatsappChannel['receive']>>): number => {
    if (!(result instanceof Response)) {
        throw new Error(`Expected a response, got ${result.length} messages`)
    }
    return result.status
}

// --- webhook verification ----------------------------------------------------------------

Deno.test('completes the webhook verification handshake', async () => {
    const channel = newChannel()

    const response = await channel.receive(
        new Request('http://localhost/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123'),
    )

    assertEquals(status(response), 200)
    assertEquals(await (response as Response).text(), 'abc123')
})

Deno.test('rejects webhook verification with the wrong token', async () => {
    const channel = newChannel()

    const response = await channel.receive(
        new Request('http://localhost/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123'),
    )

    assertEquals(status(response), 403)
})

Deno.test('rejects webhook verification without a challenge to echo', async () => {
    const channel = newChannel()

    const response = await channel.receive(
        new Request('http://localhost/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me'),
    )

    // Answering 200 with an empty body would fail the handshake without saying why.
    assertEquals(status(response), 400)
})

Deno.test('rejects methods other than GET and POST', async () => {
    const channel = newChannel()

    const response = await channel.receive(new Request('http://localhost/whatsapp', { method: 'DELETE' }))

    assertEquals(status(response), 405)
})

// --- signature verification --------------------------------------------------------------

const signedBody = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
        changes: [{
            field: 'messages',
            value: {
                metadata: { phone_number_id: '111222' },
                contacts: [{ wa_id: '5511999', profile: { name: 'Gabriel' } }],
                messages: [{ id: 'wamid.signed', from: '5511999', type: 'text', text: { body: 'ol\u00e1' } }],
            },
        }],
    }],
})

Deno.test('accepts a delivery signed with the app secret', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(await post(signedBody))

    assertEquals(contents(result), [{ type: 'text', content: 'ol\u00e1' }])
})

Deno.test('refuses a delivery signed with the wrong secret', async () => {
    createTestBot()
    const channel = newChannel()

    const response = await channel.receive(
        new Request('http://localhost/whatsapp', {
            method: 'POST',
            headers: { 'X-Hub-Signature-256': await sign(signedBody, 'not-the-secret') },
            body: signedBody,
        }),
    )

    assertEquals(status(response), 401)
})

Deno.test('refuses an unsigned delivery', async () => {
    createTestBot()
    const channel = newChannel()

    const response = await channel.receive(
        new Request('http://localhost/whatsapp', { method: 'POST', body: signedBody }),
    )

    // There is no way to turn verification off, so a delivery with no signature is nobody.
    assertEquals(status(response), 401)
})

Deno.test('refuses a delivery whose body was altered after signing', async () => {
    createTestBot()
    const channel = newChannel()

    const response = await channel.receive(
        new Request('http://localhost/whatsapp', {
            method: 'POST',
            headers: { 'X-Hub-Signature-256': await sign(signedBody, APP_SECRET) },
            // Someone forging the author of a message, which is the attack the signature stops.
            body: signedBody.replace('5511999', '5511000'),
        }),
    )

    assertEquals(status(response), 401)
})

// --- reading inbound messages ------------------------------------------------------------

Deno.test('converts an inbound text message', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(await inbound({ from: '5511999', type: 'text', text: { body: 'olá' } }))

    assertEquals(messages(result).length, 1)
    assertEquals(messages(result)[0].sourceAuthorId, '5511999')
    assertEquals(messages(result)[0].message.type, 'text')
    assertEquals(messages(result)[0].message.content, 'olá')
})

Deno.test('carries the message id and type as metadata', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(
        await inbound({
            id: 'wamid.abc',
            from: '5511999',
            type: 'text',
            timestamp: '1700000000',
            text: { body: 'olá' },
        }),
    )

    assertEquals(messages(result)[0].message.metadata, {
        wamid: 'wamid.abc',
        whatsappType: 'text',
        timestamp: '1700000000',
    })
})

Deno.test('records the id of the message being replied to', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(
        await inbound({ from: '5511999', type: 'text', text: { body: 'esse' }, context: { id: 'wamid.original' } }),
    )

    assertEquals(messages(result)[0].message.metadata?.replyTo, 'wamid.original')
})

Deno.test('keeps every message of a batched delivery', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(
        await inbound(
            { from: '5511999', type: 'text', text: { body: 'one' } },
            { from: '5511999', type: 'text', text: { body: 'two' } },
            { from: '5511999', type: 'text', text: { body: 'three' } },
        ),
    )

    assertEquals(contents(result), [
        { type: 'text', content: 'one' },
        { type: 'text', content: 'two' },
        { type: 'text', content: 'three' },
    ])
})

Deno.test('keeps messages spread across entries and changes', async () => {
    createTestBot()
    const channel = newChannel()

    const value = (body: string) => ({
        metadata: { phone_number_id: '111222' },
        contacts: [{ wa_id: '5511999' }],
        messages: [{ id: `wamid.${body}`, from: '5511999', type: 'text', text: { body } }],
    })

    const result = await channel.receive(
        await post(JSON.stringify({
            entry: [
                {
                    changes: [{ field: 'messages', value: value('one') }, {
                        field: 'messages',
                        value: value('two'),
                    }],
                },
                { changes: [{ field: 'messages', value: value('three') }] },
            ],
        })),
    )

    assertEquals(contents(result).map(({ content }) => content), ['one', 'two', 'three'])
})

Deno.test('takes the author from the message rather than the first contact', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(
        await delivery({
            metadata: { phone_number_id: '111222' },
            contacts: [{ wa_id: '5511000', profile: { name: 'Someone else' } }, {
                wa_id: '5511999',
                profile: { name: 'Gabriel' },
            }],
            messages: [{ id: 'wamid.1', from: '5511999', type: 'text', text: { body: 'olá' } }],
        }),
    )

    assertEquals(messages(result)[0].sourceAuthorId, '5511999')
})

Deno.test('does not file a message under the wrong contact', async () => {
    const bot = createTestBot()
    const channel = newChannel()

    await channel.receive(
        await delivery({
            metadata: { phone_number_id: '111222' },
            contacts: [{ wa_id: '5511000', profile: { name: 'Someone else' } }, {
                wa_id: '5511777',
                profile: { name: 'Another' },
            }],
            messages: [{ id: 'wamid.1', from: '5511999', type: 'text', text: { body: 'olá' } }],
        }),
    )

    // Neither contact is the sender, so no name is guessed at.
    assertEquals((await bot.storage.getUser('whatsapp:5511999'))?.name, undefined)
})

Deno.test('trusts a lone contact whose wa_id disagrees with the sender', async () => {
    const bot = createTestBot()
    const channel = newChannel()

    await channel.receive(
        await delivery({
            metadata: { phone_number_id: '111222' },
            contacts: [{ wa_id: '5511000', profile: { name: 'Gabriel' } }],
            messages: [{ id: 'wamid.1', from: '5511999', type: 'text', text: { body: 'olá' } }],
        }),
    )

    assertEquals((await bot.storage.getUser('whatsapp:5511999'))?.name, 'Gabriel')
})

Deno.test('reads a message from a delivery with no contacts at all', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(
        await delivery({
            metadata: { phone_number_id: '111222' },
            messages: [{ id: 'wamid.1', from: '5511999', type: 'text', text: { body: 'olá' } }],
        }),
    )

    assertEquals(messages(result)[0].sourceAuthorId, '5511999')
})

Deno.test('stores the contact name and phone number on receive', async () => {
    const bot = createTestBot()
    const channel = newChannel()

    await channel.receive(await inbound({ from: '5511999', type: 'text', text: { body: 'olá' } }))

    const user = await bot.storage.getUser('whatsapp:5511999')
    assertEquals(user?.name, 'Gabriel')
    assertEquals(user?.phoneNumber, '5511999')
})

Deno.test('keeps the name a flow stored, and remembers the profile name beside it', async () => {
    const bot = createTestBot()
    const channel = newChannel()

    // As if a state had asked what to call the user and stored the answer.
    await bot.storage.mergeUser('whatsapp:5511999', { name: 'Gabi' })

    await channel.receive(await inbound({ from: '5511999', type: 'text', text: { body: 'olá' } }))

    const user = await bot.storage.getUser('whatsapp:5511999')
    // The profile name would otherwise undo the answer one message after it was given.
    assertEquals(user?.name, 'Gabi')
    assertEquals(user?.metadata?.whatsappProfileName, 'Gabriel')
})

Deno.test('follows the profile name while nothing else has claimed it', async () => {
    const bot = createTestBot()
    const channel = newChannel()

    await channel.receive(await inbound({ from: '5511999', type: 'text', text: { body: 'olá' } }))
    assertEquals((await bot.storage.getUser('whatsapp:5511999'))?.name, 'Gabriel')

    await channel.receive(
        await delivery({
            metadata: { phone_number_id: '111222' },
            contacts: [{ wa_id: '5511999', profile: { name: 'Gabriel Ferreira' } }],
            messages: [{ id: 'wamid.renamed', from: '5511999', type: 'text', text: { body: 'mudei' } }],
        }),
    )

    // Nobody had overridden it, so the rename comes through.
    assertEquals((await bot.storage.getUser('whatsapp:5511999'))?.name, 'Gabriel Ferreira')
})

Deno.test('keeps a stored name when a delivery carries no profile', async () => {
    const bot = createTestBot()
    const channel = newChannel()

    await bot.storage.mergeUser('whatsapp:5511999', { name: 'Gabriel' })
    await channel.receive(
        await delivery({
            metadata: { phone_number_id: '111222' },
            messages: [{ id: 'wamid.1', from: '5511999', type: 'text', text: { body: 'olá' } }],
        }),
    )

    assertEquals((await bot.storage.getUser('whatsapp:5511999'))?.name, 'Gabriel')
})

Deno.test('prefers the number the user typed over the resolved wa_id', async () => {
    const bot = createTestBot()
    const channel = newChannel()

    await channel.receive(
        await delivery({
            metadata: { phone_number_id: '111222' },
            contacts: [{ wa_id: '551199999', input: '5511999999999', profile: { name: 'Gabriel' } }],
            messages: [{ id: 'wamid.1', from: '551199999', type: 'text', text: { body: 'olá' } }],
        }),
    )

    assertEquals((await bot.storage.getUser('whatsapp:551199999'))?.phoneNumber, '5511999999999')
})

// --- identity: business-scoped user ids --------------------------------------------------

const BSUID = 'BR.13491208655302741918'

Deno.test('keys a conversation on the business-scoped id, not the phone number', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(
        await delivery({
            metadata: { phone_number_id: '111222' },
            contacts: [{ wa_id: '5511999', user_id: BSUID, profile: { name: 'Gabriel' } }],
            messages: [{ id: 'wamid.1', from: '5511999', from_user_id: BSUID, type: 'text', text: { body: 'olá' } }],
        }),
    )

    // The number can be hidden or changed later; the business-scoped id cannot.
    assertEquals(messages(result)[0].sourceAuthorId, BSUID)
})

Deno.test('reads a message from a user who withheld their phone number', async () => {
    const bot = createTestBot()
    const channel = newChannel()

    // A user with a WhatsApp username and no recent history with this business: no `from`, no
    // `wa_id` anywhere in the payload.
    const result = await channel.receive(
        await delivery({
            metadata: { phone_number_id: '111222' },
            contacts: [{ user_id: BSUID, profile: { name: 'Gabriel' } }],
            messages: [{ id: 'wamid.1', from_user_id: BSUID, type: 'text', text: { body: 'olá' } }],
        }),
    )

    assertEquals(contents(result), [{ type: 'text', content: 'olá' }])
    assertEquals(messages(result)[0].sourceAuthorId, BSUID)

    // Nothing that is not a phone number ends up in the phone number field.
    const user = await bot.storage.getUser(`whatsapp:${encodeURIComponent(BSUID)}`)
    assertEquals(user?.phoneNumber, undefined)
    assertEquals(user?.name, 'Gabriel')
})

Deno.test('keeps one conversation when the phone number stops arriving', async () => {
    createTestBot()
    const channel = newChannel()

    const withNumber = await channel.receive(
        await delivery({
            metadata: { phone_number_id: '111222' },
            contacts: [{ wa_id: '5511999', user_id: BSUID }],
            messages: [{ id: 'wamid.1', from: '5511999', from_user_id: BSUID, type: 'text', text: { body: 'um' } }],
        }),
    )

    const withoutNumber = await channel.receive(
        await delivery({
            metadata: { phone_number_id: '111222' },
            contacts: [{ user_id: BSUID }],
            messages: [{ id: 'wamid.2', from_user_id: BSUID, type: 'text', text: { body: 'dois' } }],
        }),
    )

    // Same person, so the flow has to see the same user rather than starting over.
    assertEquals(messages(withoutNumber)[0].sourceAuthorId, messages(withNumber)[0].sourceAuthorId)
})

Deno.test('continues a conversation started before business-scoped ids arrived', async () => {
    const bot = createTestBot()
    const channel = newChannel()

    // A user keyed by phone number, halfway through a flow.
    await bot.storage.mergeUser('whatsapp:5511999', { phoneNumber: '5511999' })
    await bot.storage.setKv('whatsapp:5511999', '#state', 'ask-name')

    const result = await channel.receive(
        await delivery({
            metadata: { phone_number_id: '111222' },
            contacts: [{ wa_id: '5511999', user_id: BSUID }],
            messages: [{ id: 'wamid.1', from: '5511999', from_user_id: BSUID, type: 'text', text: { body: 'olá' } }],
        }),
    )

    // Answered as the user who was already mid-flow, not as a new one under the new id.
    assertEquals(messages(result)[0].sourceAuthorId, '5511999')
})

Deno.test('still keys on the phone number when no business-scoped id is sent', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(await inbound({ from: '5511999', type: 'text', text: { body: 'olá' } }))

    assertEquals(messages(result)[0].sourceAuthorId, '5511999')
})

Deno.test('records the phone number of a user who does share it', async () => {
    const bot = createTestBot()
    const channel = newChannel()

    await channel.receive(
        await delivery({
            metadata: { phone_number_id: '111222' },
            contacts: [{ wa_id: '5511999', user_id: BSUID, input: '+55 11 99999-9999' }],
            messages: [{ id: 'wamid.1', from: '5511999', from_user_id: BSUID, type: 'text', text: { body: 'olá' } }],
        }),
    )

    const user = await bot.storage.getUser(`whatsapp:${encodeURIComponent(BSUID)}`)
    assertEquals(user?.phoneNumber, '+55 11 99999-9999')
})

Deno.test('records the username of a user who has one', async () => {
    const bot = createTestBot()
    const channel = newChannel()

    await channel.receive(
        await delivery({
            metadata: { phone_number_id: '111222' },
            contacts: [{ user_id: BSUID, profile: { name: 'Gabriel', username: 'gabriel' } }],
            messages: [{ id: 'wamid.1', from_user_id: BSUID, type: 'text', text: { body: 'olá' } }],
        }),
    )

    const user = await bot.storage.getUser(`whatsapp:${BSUID}`)
    // Often the only thing an agent picking up the conversation has to go on.
    assertEquals(user?.metadata?.whatsappUsername, 'gabriel')
})

Deno.test('reports the status of a message sent to a user with no phone number', async () => {
    createTestBot()
    const channel = newChannel({ statusEvents: true })

    const result = await channel.receive(
        await delivery({
            metadata: { phone_number_id: '111222' },
            statuses: [{ id: 'wamid.1', status: 'delivered', recipient_user_id: BSUID }],
        }),
    )

    // `recipient_id` is absent here, and reading only that would lose the status entirely.
    assertEquals(messages(result)[0].sourceAuthorId, BSUID)
})

Deno.test('addresses a business-scoped id as a recipient rather than a phone number', async () => {
    createTestBot()
    const channel = newChannel()

    const requests = await withFetchMock(ok, () => channel.send(BSUID, { type: 'text', content: 'olá' }))

    // Graph refuses a business-scoped id given as `to`.
    assertEquals(requests[0].json().recipient, BSUID)
    assertEquals(requests[0].json().to, undefined)
})

Deno.test('addresses a phone number as before', async () => {
    createTestBot()
    const channel = newChannel()

    const requests = await withFetchMock(ok, () => channel.send('5511999', { type: 'text', content: 'olá' }))

    assertEquals(requests[0].json().to, '5511999')
    assertEquals(requests[0].json().recipient, undefined)
})

Deno.test('tells a business-scoped id apart from a phone number', () => {
    assertEquals(isBusinessScopedId('BR.13491208655302741918'), true)
    assertEquals(isBusinessScopedId('us.1A2b3C'), true)
    assertEquals(isBusinessScopedId('5511999999999'), false)
    assertEquals(isBusinessScopedId('+5511999999999'), false)
    assertEquals(isBusinessScopedId(''), false)
})

// --- interactive replies -----------------------------------------------------------------

Deno.test('converts a button reply into the button title', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(
        await inbound({
            from: '5511999',
            type: 'interactive',
            interactive: { type: 'button_reply', button_reply: { id: '0', title: 'Sim' } },
        }),
    )

    assertEquals(contents(result), [{ type: 'text', content: 'Sim' }])
})

Deno.test('converts a list reply into the row title', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(
        await inbound({
            from: '5511999',
            type: 'interactive',
            interactive: { type: 'list_reply', list_reply: { id: '0.1', title: 'Segunda via' } },
        }),
    )

    assertEquals(contents(result), [{ type: 'text', content: 'Segunda via' }])
})

/** The reply button ids of a quick reply the channel just sent. */
const sentButtonIds = (requests: RecordedRequest[]): string[] =>
    requests[0].json().interactive.action.buttons.map((button: { reply: { id: string } }) => button.reply.id)

/** The row ids of a menu the channel just sent, across all sections. */
const sentRowIds = (requests: RecordedRequest[]): string[] =>
    requests[0].json().interactive.action.sections.flatMap((section: { rows: { id: string }[] }) =>
        section.rows.map((row) => row.id)
    )

Deno.test('resolves a reply to the untruncated option the flow wrote', async () => {
    createTestBot()
    const channel = newChannel()
    const long = 'Falar com um atendente humano agora'

    const requests = await withFetchMock(ok, () =>
        channel.send('5511999', {
            type: 'quick-reply',
            content: { text: 'Escolha', options: ['Sim', long] },
        }))

    // WhatsApp echoes the title it displayed, cut to 20 characters, and the id it was given.
    const result = await channel.receive(
        await inbound({
            from: '5511999',
            type: 'interactive',
            interactive: {
                type: 'button_reply',
                button_reply: { id: sentButtonIds(requests)[1], title: 'Falar com um atende…' },
            },
        }),
    )

    assertEquals(contents(result), [{ type: 'text', content: long }])
})

Deno.test('tells apart two options that only differ past the title limit', async () => {
    createTestBot()
    const channel = newChannel()
    const first = 'Segunda via da conta de setembro'
    const second = 'Segunda via da conta de outubro'

    const requests = await withFetchMock(ok, () =>
        channel.send('5511999', {
            type: 'menu',
            content: { text: 'Escolha', button: 'Ver', sections: [{ options: [first, second] }] },
        }))

    const result = await channel.receive(
        await inbound({
            from: '5511999',
            type: 'interactive',
            interactive: {
                type: 'list_reply',
                list_reply: { id: sentRowIds(requests)[1], title: 'Segunda via da c…' },
            },
        }),
    )

    assertEquals(contents(result), [{ type: 'text', content: second }])
})

Deno.test('gives two messages different option ids', async () => {
    createTestBot()
    const channel = newChannel()

    const first = await withFetchMock(
        ok,
        () => channel.send('5511999', { type: 'quick-reply', content: { text: 'Um', options: ['Sim'] } }),
    )
    const second = await withFetchMock(
        ok,
        () => channel.send('5511999', { type: 'quick-reply', content: { text: 'Dois', options: ['Sim'] } }),
    )

    // Otherwise a tap on the first message's button would read as an answer to the second.
    assertNotEquals(sentButtonIds(first)[0], sentButtonIds(second)[0])
})

Deno.test('still resolves a reply to a menu from earlier in the conversation', async () => {
    createTestBot()
    const channel = newChannel()

    const requests = await withFetchMock(ok, () =>
        channel.send('5511999', {
            type: 'quick-reply',
            content: { text: 'Confirma o pedido?', options: ['Sim', 'Não'] },
        }))

    // Three more messages with options of their own before the user scrolls up and answers.
    for (const text of ['Outra?', 'E outra?', 'Mais uma?']) {
        await withFetchMock(
            ok,
            () => channel.send('5511999', { type: 'quick-reply', content: { text, options: ['a'] } }),
        )
    }

    const result = await channel.receive(
        await inbound({
            from: '5511999',
            type: 'interactive',
            interactive: { type: 'button_reply', button_reply: { id: sentButtonIds(requests)[1], title: 'Não' } },
        }),
    )

    assertEquals(contents(result), [{ type: 'text', content: 'Não' }])
})

Deno.test('falls back to the echoed title when the options are no longer known', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(
        await inbound({
            from: '5511999',
            type: 'interactive',
            interactive: { type: 'button_reply', button_reply: { id: '7', title: 'Sim' } },
        }),
    )

    assertEquals(contents(result), [{ type: 'text', content: 'Sim' }])
})

Deno.test('converts a template quick reply into its text', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(
        await inbound({
            from: '5511999',
            type: 'button',
            button: { text: 'Confirmar', payload: 'confirm' },
        }),
    )

    assertEquals(contents(result), [{ type: 'text', content: 'Confirmar' }])
})

Deno.test('reports a flow completion as an event instead of empty text', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(
        await inbound({
            from: '5511999',
            type: 'interactive',
            interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', response_json: '{"cpf":"123"}' } },
        }),
    )

    assertEquals(contents(result), [{
        type: 'event',
        content: { event: WHATSAPP_EVENTS.flowReply, data: { name: 'flow', response: { cpf: '123' } } },
    }])
})

// --- media and location ------------------------------------------------------------------

Deno.test('converts inbound media into a media message', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(
        await inbound({
            from: '5511999',
            type: 'image',
            image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'olha' },
        }),
    )

    assertEquals(contents(result), [{
        type: 'media',
        content: { kind: 'image', id: 'media-1', mimeType: 'image/jpeg', caption: 'olha', filename: undefined },
    }])
})

Deno.test('converts an inbound voice note into audio media', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(
        await inbound({
            from: '5511999',
            type: 'audio',
            audio: { id: 'media-2', mime_type: 'audio/ogg' },
        }),
    )

    assertEquals(messages(result)[0].message.type, 'media')
    assertEquals((messages(result)[0].message.content as mawa.Media).kind, 'audio')
})

Deno.test('converts an inbound location', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(
        await inbound({
            from: '5511999',
            type: 'location',
            location: { latitude: -23.5, longitude: -46.6, name: 'Sé' },
        }),
    )

    assertEquals(contents(result), [{
        type: 'location',
        content: { latitude: -23.5, longitude: -46.6, name: 'Sé', address: undefined },
    }])
})

// --- what cannot become a message --------------------------------------------------------

Deno.test('reports a reaction as an event', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(
        await inbound({
            from: '5511999',
            type: 'reaction',
            reaction: { emoji: '👍', message_id: 'wamid.original' },
        }),
    )

    assertEquals(contents(result), [{
        type: 'event',
        content: { event: WHATSAPP_EVENTS.reaction, data: { emoji: '👍', messageId: 'wamid.original' } },
    }])
})

Deno.test('reports an unreadable message type as an event rather than dropping it', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(await inbound({ from: '5511999', type: 'order', order: { catalog_id: '1' } }))

    const [{ message }] = messages(result)
    assertEquals(message.type, 'event')
    assertEquals((message.content as mawa.Event).event, WHATSAPP_EVENTS.unsupported)
})

Deno.test('ignores status callbacks that carry no message', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(
        await delivery({
            metadata: { phone_number_id: '111222' },
            statuses: [{ id: 'wamid.1', status: 'delivered', recipient_id: '5511999' }],
        }),
    )

    assertEquals(messages(result), [])
})

Deno.test('reports delivery statuses as events when asked to', async () => {
    createTestBot()
    const channel = newChannel({ statusEvents: true })

    const result = await channel.receive(
        await delivery({
            metadata: { phone_number_id: '111222' },
            statuses: [{ id: 'wamid.1', status: 'failed', recipient_id: '5511999', errors: [{ code: 131047 }] }],
        }),
    )

    const [{ sourceAuthorId, message }] = messages(result)
    assertEquals(sourceAuthorId, '5511999')
    assertEquals((message.content as mawa.Event).event, WHATSAPP_EVENTS.status)
})

Deno.test('ignores a change that is not about messages', async () => {
    createTestBot()
    const channel = newChannel()

    // A template approval on the same subscription. Reading it as a message used to throw,
    // which Meta answers by retrying and eventually disabling the webhook.
    const result = await channel.receive(
        await post(JSON.stringify({
            entry: [{
                changes: [{
                    field: 'message_template_status_update',
                    value: { event: 'APPROVED', message_template_id: 1 },
                }],
            }],
        })),
    )

    assertEquals(messages(result), [])
})

Deno.test('survives a delivery with nothing recognizable in it', async () => {
    createTestBot()
    const channel = newChannel()

    for (const body of ['{}', '{"entry":[]}', '{"entry":[{}]}', '{"entry":[{"changes":[{}]}]}']) {
        const result = await channel.receive(await post(body))

        assertEquals(messages(result), [])
    }
})

Deno.test('answers 400 to a body that is not JSON', async () => {
    createTestBot()
    const channel = newChannel()

    const response = await channel.receive(await post('not json'))

    assertEquals(status(response), 400)
})

Deno.test('refuses messages addressed to another number', async () => {
    createTestBot()
    const channel = newChannel()

    const response = await channel.receive(
        await post(JSON.stringify({
            entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'someone-else' } } }] }],
        })),
    )

    assertEquals(status(response), 400)
})

// --- redelivery and number changes -------------------------------------------------------

Deno.test('reports the id WhatsApp gave each message, so a redelivery can be recognized', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(
        await delivery({
            metadata: { phone_number_id: '111222' },
            contacts: [{ wa_id: '5511999' }],
            messages: [
                { id: 'wamid.one', from: '5511999', type: 'text', text: { body: 'um' } },
                { id: 'wamid.two', from: '5511999', type: 'text', text: { body: 'dois' } },
            ],
        }),
    )

    // Acting on it belongs to the SDK, which does it under the per-user lock.
    assertEquals(messages(result).map(({ id }) => id), ['wamid.one', 'wamid.two'])
})

Deno.test('answers a redelivered message only once, end to end', async () => {
    const channel = newChannel()
    const bot = createTestBot({ directory: 'tests/fixtures/counting', channels: [channel] })

    const deliver = async () =>
        await resolveChannel(
            await delivery({
                metadata: { phone_number_id: '111222' },
                contacts: [{ wa_id: '5511999' }],
                messages: [{ id: 'wamid.same', from: '5511999', type: 'text', text: { body: 'olá' } }],
            }),
            handleMessage,
        )

    await withFetchMock(ok, async () => {
        await deliver()
        await deliver()
    })

    // Meta redelivers what it thinks went unacknowledged; the conversation must not advance
    // twice for one message the user sent once.
    assertEquals(await bot.storage.getKv('whatsapp:5511999', 'count'), 1)
})

Deno.test('keeps the conversation when a user changes number', async () => {
    const bot = createTestBot()
    const channel = newChannel()

    await bot.storage.setKv('whatsapp:5511999', '#state', 'ask-name')

    await channel.receive(
        await inbound({
            from: '5511999',
            type: 'system',
            system: { type: 'user_changed_number', new_wa_id: '5511888' },
        }),
    )

    const result = await channel.receive(await inbound({ from: '5511888', type: 'text', text: { body: 'sou eu' } }))

    // Answered as the user who was already halfway through the flow, not as a new one.
    assertEquals(messages(result)[0].sourceAuthorId, '5511999')
})

Deno.test('points a second number change at the original conversation', async () => {
    createTestBot()
    const channel = newChannel()

    await channel.receive(
        await inbound({
            from: '5511999',
            type: 'system',
            system: { type: 'user_changed_number', new_wa_id: '5511888' },
        }),
    )
    await channel.receive(
        await inbound({
            from: '5511888',
            type: 'system',
            system: { type: 'user_changed_number', new_wa_id: '5511777' },
        }),
    )

    const result = await channel.receive(await inbound({ from: '5511777', type: 'text', text: { body: 'ainda eu' } }))

    assertEquals(messages(result)[0].sourceAuthorId, '5511999')
})

Deno.test('produces no message for a system notice', async () => {
    createTestBot()
    const channel = newChannel()

    const result = await channel.receive(
        await inbound({
            from: '5511999',
            type: 'system',
            system: { type: 'user_changed_number', new_wa_id: '5511888' },
        }),
    )

    assertEquals(messages(result), [])
})

// --- read receipts and typing ------------------------------------------------------------

Deno.test('marks the last inbound message as read and shows typing', async () => {
    createTestBot()
    const channel = newChannel({ acknowledge: 'typing' })

    const requests = await withFetchMock(ok, async () => {
        await channel.receive(
            await inbound(
                { id: 'wamid.first', from: '5511999', type: 'text', text: { body: 'one' } },
                { id: 'wamid.last', from: '5511999', type: 'text', text: { body: 'two' } },
            ),
        )
    })

    assertEquals(requests.length, 1)
    assertEquals(requests[0].json(), {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: 'wamid.last',
        typing_indicator: { type: 'text' },
    })
})

Deno.test('still delivers the messages when marking as read fails', async () => {
    createTestBot()
    const channel = newChannel({ acknowledge: 'typing', retry: { attempts: 1 } })

    let result: Awaited<ReturnType<WhatsappChannel['receive']>> = []
    await withFetchMock(new Response('nope', { status: 500 }), async () => {
        result = await channel.receive(await inbound({ from: '5511999', type: 'text', text: { body: 'olá' } }))
    })

    assertEquals(contents(result), [{ type: 'text', content: 'olá' }])
})

// --- sending -----------------------------------------------------------------------------

Deno.test('sends a text message with the documented payload', async () => {
    createTestBot()
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
        text: { body: 'olá', preview_url: true },
    })
})

Deno.test('targets the current Graph API version by default', async () => {
    createTestBot()
    const channel = newChannel()

    const requests = await withFetchMock(ok, () => channel.send('5511999', { type: 'text', content: 'olá' }))

    assertEquals(
        requests[0].url,
        `https://graph.facebook.com/${DEFAULT_GRAPH_API_VERSION}/111222/messages`,
    )
    assertStringIncludes(DEFAULT_GRAPH_API_VERSION, 'v')
})

Deno.test('honours a pinned Graph API version', async () => {
    createTestBot()
    const channel = newChannel({ graphApiVersion: 'v23.0' })

    const requests = await withFetchMock(ok, () => channel.send('5511999', { type: 'text', content: 'olá' }))

    assertEquals(requests[0].url, 'https://graph.facebook.com/v23.0/111222/messages')
})

Deno.test('splits text too long for one message', async () => {
    createTestBot()
    const channel = newChannel()
    const paragraph = 'a'.repeat(3000)

    const requests = await withFetchMock(
        ok,
        () => channel.send('5511999', { type: 'text', content: `${paragraph}\n\n${paragraph}` }),
    )

    assertEquals(requests.length, 2)
    assertEquals(requests[0].json().text.body, paragraph)
    assertEquals(requests[1].json().text.body, paragraph)
})

Deno.test('sends a quick reply as an interactive button message', async () => {
    createTestBot()
    const channel = newChannel()

    const requests = await withFetchMock(
        ok,
        () =>
            channel.send('5511999', {
                type: 'quick-reply',
                content: { text: 'Confirma?', options: ['Sim', 'Não'] },
            }),
    )

    const [yes, no] = sentButtonIds(requests)
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
                    { type: 'reply', reply: { id: yes, title: 'Sim' } },
                    { type: 'reply', reply: { id: no, title: 'Não' } },
                ],
            },
        },
    })

    // The ids identify the message as well as the position within it.
    assertStringIncludes(yes, '.0')
    assertStringIncludes(no, '.1')
})

Deno.test('sends a quick reply header and footer when given one', async () => {
    createTestBot()
    const channel = newChannel()

    const requests = await withFetchMock(
        ok,
        () =>
            channel.send('5511999', {
                type: 'quick-reply',
                content: { text: 'Confirma?', options: ['Sim'], header: 'Pedido 42', footer: 'Loja' },
            }),
    )

    assertEquals(requests[0].json().interactive.header, { type: 'text', text: 'Pedido 42' })
    assertEquals(requests[0].json().interactive.footer, { text: 'Loja' })
})

Deno.test('refuses a quick reply with more options than WhatsApp shows', async () => {
    createTestBot()
    const channel = newChannel()

    // Dropping the fourth silently would leave the bot waiting on an unreachable answer.
    await assertRejects(
        () =>
            channel.send('5511999', {
                type: 'quick-reply',
                content: { text: 'Escolha', options: ['a', 'b', 'c', 'd'] },
            }),
        Error,
        'at most 3 reply buttons',
    )
})

Deno.test('shortens a reply button title instead of failing', async () => {
    createTestBot()
    const channel = newChannel()

    const requests = await withFetchMock(
        ok,
        () =>
            channel.send('5511999', {
                type: 'quick-reply',
                content: { text: 'Escolha', options: ['Falar com um atendente humano'] },
            }),
    )

    const title = requests[0].json().interactive.action.buttons[0].reply.title
    assertEquals(title.length, 20)
    assertStringIncludes(title, 'Falar com um')
})

Deno.test('sends a menu as an interactive list message', async () => {
    createTestBot()
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

    const [boleto, atendente] = sentRowIds(requests)
    assertEquals(requests[0].json().interactive, {
        type: 'list',
        body: { text: 'Escolha' },
        action: {
            button: 'Ver opções',
            sections: [{
                title: 'Serviços',
                rows: [
                    { id: boleto, title: 'Boleto' },
                    { id: atendente, title: 'Atendente', description: 'Falar com humano' },
                ],
            }],
        },
    })

    // Section and row position, behind the token that identifies the message.
    assertStringIncludes(boleto, '.0.0')
    assertStringIncludes(atendente, '.0.1')
})

Deno.test('refuses a menu with more rows than one list can hold', async () => {
    createTestBot()
    const channel = newChannel()

    await assertRejects(
        () =>
            channel.send('5511999', {
                type: 'menu',
                content: {
                    text: 'Escolha',
                    button: 'Ver',
                    sections: [{ options: Array.from({ length: 11 }, (_, index) => `Opção ${index}`) }],
                },
            }),
        Error,
        'at most 10 rows',
    )
})

Deno.test('refuses a menu with no options', async () => {
    createTestBot()
    const channel = newChannel()

    await assertRejects(
        () => channel.send('5511999', { type: 'menu', content: { text: 'Escolha', button: 'Ver', sections: [] } }),
        Error,
        'no options',
    )
})

Deno.test('sends media by link, with its caption', async () => {
    createTestBot()
    const channel = newChannel()

    const requests = await withFetchMock(
        ok,
        () =>
            channel.send('5511999', {
                type: 'media',
                content: { kind: 'image', url: 'https://example.com/a.jpg', caption: 'olha' },
            }),
    )

    assertEquals(requests[0].json().type, 'image')
    assertEquals(requests[0].json().image, { link: 'https://example.com/a.jpg', caption: 'olha' })
})

Deno.test('sends media by id, naming a document', async () => {
    createTestBot()
    const channel = newChannel()

    const requests = await withFetchMock(
        ok,
        () =>
            channel.send('5511999', {
                type: 'media',
                content: { kind: 'document', id: 'media-1', filename: 'boleto.pdf' },
            }),
    )

    assertEquals(requests[0].json().document, { id: 'media-1', filename: 'boleto.pdf' })
})

Deno.test('leaves a caption off a kind that cannot show one', async () => {
    createTestBot()
    const channel = newChannel()

    const requests = await withFetchMock(
        ok,
        () =>
            channel.send('5511999', {
                type: 'media',
                content: { kind: 'audio', id: 'media-1', caption: 'ignored' },
            }),
    )

    assertEquals(requests[0].json().audio, { id: 'media-1' })
})

Deno.test('refuses media with neither a url nor an id', async () => {
    createTestBot()
    const channel = newChannel()

    await assertRejects(
        () => channel.send('5511999', { type: 'media', content: { kind: 'image' } }),
        Error,
        'either a url or an id',
    )
})

Deno.test('sends a location', async () => {
    createTestBot()
    const channel = newChannel()

    const requests = await withFetchMock(
        ok,
        () =>
            channel.send('5511999', {
                type: 'location',
                content: { latitude: -23.5, longitude: -46.6, name: 'Loja' },
            }),
    )

    assertEquals(requests[0].json().location, { latitude: -23.5, longitude: -46.6, name: 'Loja' })
})

Deno.test('sends a template with positional parameters', async () => {
    createTestBot()
    const channel = newChannel()

    const requests = await withFetchMock(
        ok,
        () =>
            channel.send('5511999', {
                type: 'template',
                content: { name: 'order_update', language: 'pt_BR', parameters: ['42', 3] },
            }),
    )

    assertEquals(requests[0].json().template, {
        name: 'order_update',
        language: { code: 'pt_BR' },
        components: [{
            type: 'body',
            parameters: [{ type: 'text', text: '42' }, { type: 'text', text: '3' }],
        }],
    })
})

Deno.test('sends a template with hand-written components', async () => {
    createTestBot()
    const channel = newChannel()
    const components = [{ type: 'header', parameters: [{ type: 'image', image: { link: 'https://e.com/a.jpg' } }] }]

    const requests = await withFetchMock(
        ok,
        () => channel.send('5511999', { type: 'template', content: { name: 't', language: 'en', components } }),
    )

    assertEquals(requests[0].json().template.components, components)
})

Deno.test('refuses a template given both parameters and components', async () => {
    createTestBot()
    const channel = newChannel()

    await assertRejects(
        () =>
            channel.send('5511999', {
                type: 'template',
                content: { name: 't', language: 'en', parameters: ['a'], components: [] },
            }),
        Error,
        'either parameters or components',
    )
})

Deno.test('sends a raw payload addressed to this channel as it was written', async () => {
    createTestBot()
    const channel = newChannel()
    const payload = { type: 'interactive', interactive: { type: 'cta_url', action: { name: 'cta_url' } } }

    const requests = await withFetchMock(
        ok,
        () => channel.send('5511999', { type: 'raw', content: { sourceId: 'whatsapp', payload } }),
    )

    assertEquals(requests[0].json(), {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '5511999',
        ...payload,
    })
})

Deno.test('skips a raw payload meant for another channel', async () => {
    createTestBot()
    const channel = newChannel()

    const requests = await withFetchMock(
        ok,
        () => channel.send('5511999', { type: 'raw', content: { sourceId: 'chatwoot', payload: {} } }),
    )

    assertEquals(requests.length, 0)
})

Deno.test('threads a reply to an earlier message', async () => {
    createTestBot()
    const channel = newChannel()

    const requests = await withFetchMock(
        ok,
        () => channel.send('5511999', { type: 'text', content: 'sobre isso', metadata: { replyTo: 'wamid.original' } }),
    )

    assertEquals(requests[0].json().context, { message_id: 'wamid.original' })
})

Deno.test('refuses to send a message type it cannot convert', async () => {
    createTestBot()
    const channel = newChannel()

    await assertRejects(
        () => channel.send('5511999', { type: 'event', content: { event: 'x', data: null } }),
        Error,
        'No converter found',
    )
})

// --- failures and retries ----------------------------------------------------------------

Deno.test('throws when the Graph API rejects the message', async () => {
    createTestBot()
    const channel = newChannel()

    await withFetchMock(
        new Response(JSON.stringify({ error: { message: 'invalid token', code: 190 } }), { status: 401 }),
        () =>
            assertRejects(
                () => channel.send('5511999', { type: 'text', content: 'olá' }),
                Error,
                'Failed to send message to whatsapp: 401 (invalid token)',
            ),
    )
})

Deno.test('explains a send refused outside the 24-hour window', async () => {
    createTestBot()
    const channel = newChannel()

    await withFetchMock(
        new Response(JSON.stringify({ error: { message: 'Re-engagement message', code: 131047 } }), { status: 400 }),
        () =>
            assertRejects(
                () => channel.send('5511999', { type: 'text', content: 'olá' }),
                Error,
                'only an approved template can be sent',
            ),
    )
})

Deno.test('retries a rate limited send and succeeds', async () => {
    createTestBot()
    const channel = newChannel({ retry: { attempts: 3, baseDelayMs: 0 } })

    let calls = 0
    const requests = await withFetchMock(
        () => {
            calls++
            return calls === 1 ? new Response('{}', { status: 429 }) : ok.clone()
        },
        () => channel.send('5511999', { type: 'text', content: 'olá' }),
    )

    assertEquals(requests.length, 2)
})

Deno.test('retries a graph error code that means later, not never', async () => {
    createTestBot()
    const channel = newChannel({ retry: { attempts: 2, baseDelayMs: 0 } })

    let calls = 0
    const requests = await withFetchMock(
        () => {
            calls++
            return calls === 1 ? new Response(JSON.stringify({ error: { code: 130429 } }), { status: 400 }) : ok.clone()
        },
        () => channel.send('5511999', { type: 'text', content: 'olá' }),
    )

    assertEquals(requests.length, 2)
})

Deno.test('gives up after the configured number of attempts', async () => {
    createTestBot()
    const channel = newChannel({ retry: { attempts: 2, baseDelayMs: 0 } })

    const requests = await withFetchMock(
        new Response('{}', { status: 503 }),
        () => assertRejects(() => channel.send('5511999', { type: 'text', content: 'olá' })),
    )

    assertEquals(requests.length, 2)
})

Deno.test('does not retry a request the server understood and refused', async () => {
    createTestBot()
    const channel = newChannel({ retry: { attempts: 3, baseDelayMs: 0 } })

    const requests = await withFetchMock(
        new Response(JSON.stringify({ error: { code: 131026, message: 'Receiver incapable' } }), { status: 400 }),
        () => assertRejects(() => channel.send('5511999', { type: 'text', content: 'olá' })),
    )

    assertEquals(requests.length, 1)
})

// --- media transfer ----------------------------------------------------------------------

Deno.test('downloads inbound media', async () => {
    createTestBot()
    const channel = newChannel()

    const requests = await withFetchMock(
        (request) =>
            request.url.includes('lookaside')
                ? new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/ogg' } })
                : Response.json({ url: 'https://lookaside.fbsbx.com/whatsapp/1' }),
        async () => {
            const { data, mimeType } = await channel.downloadMedia('media-1')
            assertEquals(new Uint8Array(data), new Uint8Array([1, 2, 3]))
            assertEquals(mimeType, 'audio/ogg')
        },
    )

    assertEquals(requests.length, 2)
    assertStringIncludes(requests[0].url, '/media-1')
    assertEquals(requests[1].headers.get('Authorization'), 'Bearer wa-token')
})

Deno.test('reports a media id that cannot be resolved', async () => {
    createTestBot()
    const channel = newChannel()

    await withFetchMock(
        Response.json({ error: { message: 'Unsupported get request' } }, { status: 400 }),
        () => assertRejects(() => channel.getMediaUrl('media-1'), Error, 'Unsupported get request'),
    )
})

Deno.test('uploads media and returns its id', async () => {
    createTestBot()
    const channel = newChannel()

    const requests = await withFetchMock(
        Response.json({ id: 'media-9' }),
        async () => {
            const id = await channel.uploadMedia(new Blob(['x'], { type: 'image/png' }), 'a.png')
            assertEquals(id, 'media-9')
        },
    )

    assertStringIncludes(requests[0].url, '/111222/media')
    assertEquals(requests[0].headers.get('Authorization'), 'Bearer wa-token')
})

// --- the whole path through a bot --------------------------------------------------------

Deno.test('answers every message of a batched delivery, in order', async () => {
    const channel = newChannel()
    // The bot answers on whichever channel the message arrived on, so the flow's replies go
    // out through the Graph API like they would in production.
    const bot = createTestBot({ directory: 'tests/fixtures/bot', channels: [channel] })

    const requests = await withFetchMock(ok, async () => {
        const response = await resolveChannel(
            await inbound(
                { from: '5511999', type: 'text', text: { body: 'one' } },
                { from: '5511999', type: 'text', text: { body: 'two' } },
            ),
            handleMessage,
        )

        assertEquals(response.status, 200)
    })

    assertEquals(requests.map((request) => request.json().text.body), ['echo: one', 'echo: two'])
    assertEquals(await bot.storage.getUser('whatsapp:5511999').then((user) => user?.name), 'Gabriel')
})

Deno.test('handles two concurrent deliveries from one user without losing a transition', async () => {
    const channel = newChannel()
    const bot = createTestBot({ directory: 'tests/fixtures/counting', channels: [channel] })

    const deliver = async (body: string) =>
        await resolveChannel(
            await inbound({ from: '5511999', type: 'text', text: { body } }),
            handleMessage,
        )

    await withFetchMock(ok, async () => {
        // First on its own, so that loading the state module and creating the user are done
        // before the pair that matters. Otherwise the two runs take different code paths and
        // happen not to overlap, which would make this pass whether or not they are serialized.
        await deliver('warm up')
        await Promise.all([deliver('one'), deliver('two')])
    })

    // The counting state reads the count, awaits a send, then writes it back. Handled at the
    // same time, both runs would read the same value and one of the two writes would be lost.
    assertEquals(await bot.storage.getKv('whatsapp:5511999', 'count'), 3)
})
