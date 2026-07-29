import { assertEquals, assertNotEquals } from '@std/assert'
import { createTestBot } from 'mawa/testing'
import { MawaChatChannel } from '../channel/mawa-chat/mod.ts'

const authRequest = (headers?: HeadersInit) => new Request('http://localhost/web?action=auth', { headers })

const messageRequest = (credentials: string, body: unknown, origin?: string) =>
    new Request('http://localhost/web', {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${btoa(credentials)}`,
            ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify(body),
    })

/** Runs the auth handshake and returns the credentials the client would then use. */
const authenticate = async (channel: MawaChatChannel, headers?: HeadersInit) => {
    const response = await channel.receive(authRequest(headers)) as Response
    const { user, password } = await response.json()
    return { user, password, credentials: `${user}:${password}` }
}

Deno.test('issues a user id and password on the auth action', async () => {
    createTestBot()
    const channel = new MawaChatChannel()

    const { user, password } = await authenticate(channel)

    assertEquals(typeof user, 'string')
    assertEquals(typeof password, 'string')
    assertNotEquals(user, password)
})

Deno.test('issues distinct credentials per session', async () => {
    createTestBot()
    const channel = new MawaChatChannel()

    const first = await authenticate(channel)
    const second = await authenticate(channel)

    assertNotEquals(first.user, second.user)
})

Deno.test('requires the configured token to authenticate', async () => {
    createTestBot()
    const channel = new MawaChatChannel({ authorizationToken: 'let-me-in' })

    const denied = await channel.receive(authRequest()) as Response
    assertEquals(denied.status, 401)

    const allowed = await channel.receive(authRequest({ Authorization: 'let-me-in' })) as Response
    assertEquals(allowed.status, 200)
    await allowed.body?.cancel()
})

Deno.test('answers preflight requests with the allowed methods', async () => {
    createTestBot()
    const channel = new MawaChatChannel()

    const response = await channel.receive(
        new Request('http://localhost/web', { method: 'OPTIONS' }),
    ) as Response

    assertEquals(response.headers.get('Access-Control-Allow-Methods'), 'POST, GET, OPTIONS')
    assertEquals(response.headers.get('Access-Control-Allow-Headers'), 'Content-Type, Authorization')
})

Deno.test('allows any origin when none are configured', async () => {
    createTestBot()
    const channel = new MawaChatChannel()

    const response = await channel.receive(
        new Request('http://localhost/web', { method: 'OPTIONS', headers: { Origin: 'https://anywhere.com' } }),
    ) as Response

    assertEquals(response.headers.get('Access-Control-Allow-Origin'), '*')
})

Deno.test('reflects only allowed origins, matching strings and regexes', async () => {
    createTestBot()
    const channel = new MawaChatChannel({
        allowedOrigins: ['https://acme.com', /^https:\/\/.*\.acme\.dev$/],
    })

    const exact = await channel.receive(
        new Request('http://localhost/web', { method: 'OPTIONS', headers: { Origin: 'https://acme.com' } }),
    ) as Response
    assertEquals(exact.headers.get('Access-Control-Allow-Origin'), 'https://acme.com')

    const byPattern = await channel.receive(
        new Request('http://localhost/web', { method: 'OPTIONS', headers: { Origin: 'https://app.acme.dev' } }),
    ) as Response
    assertEquals(byPattern.headers.get('Access-Control-Allow-Origin'), 'https://app.acme.dev')

    const rejected = await channel.receive(
        new Request('http://localhost/web', { method: 'OPTIONS', headers: { Origin: 'https://evil.com' } }),
    ) as Response
    assertEquals(rejected.headers.get('Access-Control-Allow-Origin'), null)
})

Deno.test('rejects a message without credentials', async () => {
    createTestBot()
    const channel = new MawaChatChannel()

    const response = await channel.handle(
        new Request('http://localhost/web', { method: 'POST', body: '{}' }),
        () => Promise.resolve(),
    )

    assertEquals(response.status, 401)
})

Deno.test('rejects a non-Basic authorization scheme', async () => {
    createTestBot()
    const channel = new MawaChatChannel()

    const response = await channel.handle(
        new Request('http://localhost/web', {
            method: 'POST',
            headers: { Authorization: 'Bearer something' },
            body: '{}',
        }),
        () => Promise.resolve(),
    )

    assertEquals(response.status, 401)
})

Deno.test('rejects a wrong password', async () => {
    createTestBot()
    const channel = new MawaChatChannel()
    const { user } = await authenticate(channel)

    const response = await channel.handle(
        messageRequest(`${user}:wrong-password`, { type: 'text', content: 'oi' }),
        () => Promise.resolve(),
    )

    assertEquals(response.status, 401)
})

Deno.test('rejects a malformed message', async () => {
    createTestBot()
    const channel = new MawaChatChannel()
    const { credentials } = await authenticate(channel)

    const response = await channel.handle(
        messageRequest(credentials, { content: 'no type' }),
        () => Promise.resolve(),
    )

    assertEquals(response.status, 400)
})

Deno.test('returns the replies produced while handling the message', async () => {
    createTestBot()
    const channel = new MawaChatChannel()
    const { user, credentials } = await authenticate(channel)

    const response = await channel.handle(
        messageRequest(credentials, { type: 'text', content: 'oi' }),
        async ({ sourceAuthorId }, ch) => {
            assertEquals(sourceAuthorId, user)
            await ch.send(sourceAuthorId, { type: 'text', content: 'primeira' })
            await ch.send(sourceAuthorId, { type: 'text', content: 'segunda' })
        },
    )

    assertEquals(response.status, 200)
    assertEquals(await response.json(), [
        { type: 'text', content: 'primeira' },
        { type: 'text', content: 'segunda' },
    ])
})

Deno.test('drops messages sent outside of an active request', async () => {
    createTestBot()
    const channel = new MawaChatChannel()
    const { user } = await authenticate(channel)

    // No request in flight, so there is nowhere to buffer this. It must not throw.
    await channel.send(user, { type: 'text', content: 'ninguém ouve' })
})
