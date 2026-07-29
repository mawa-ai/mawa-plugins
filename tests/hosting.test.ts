import { assertEquals } from '@std/assert'
import { fromFileUrl } from '@std/path'
import { initializeConfiguration } from 'mawa/hosting'
import { mawa } from '../deps.ts'
import { getHandler } from '../hosting/aws/mod.ts'
import { createFetchListener } from '../hosting/cloudflare/mod.ts'
import { channel } from './fixtures/bot/recorder.ts'

const botDirectory = fromFileUrl(import.meta.resolve('./fixtures/bot'))

/**
 * Loads the fixture bot explicitly rather than relying on the adapter's lazy load, so the
 * active configuration is the same no matter which test file ran first.
 */
const loadFixtureBot = async () => {
    await initializeConfiguration(botDirectory, false)
    channel.clear()
}

const lambdaEvent = (path: string, body: unknown, method = 'POST') =>
    ({
        version: '2.0',
        routeKey: `${method} ${path}`,
        rawPath: path,
        rawQueryString: '',
        headers: { 'content-type': 'application/json' },
        requestContext: {
            domainName: 'api.example.com',
            http: { method, path, protocol: 'HTTP/1.1', sourceIp: '1.2.3.4', userAgent: 'test' },
        },
        body: JSON.stringify(body),
        isBase64Encoded: false,
        // deno-lint-ignore no-explicit-any
    }) as any

Deno.test('the adapters and the SDK share one configuration instance', async () => {
    await loadFixtureBot()

    // Proves the split-module problem is gone: the adapter reads the very configuration
    // the SDK loaded, so its channel list is the fixture's.
    assertEquals(mawa.config().channels.map((channel) => channel.sourceId), ['webhook'])
})

Deno.test('cloudflare listener routes a request through to the flow', async () => {
    await loadFixtureBot()
    const listener = createFetchListener({ directory: botDirectory })

    const response = await listener(
        new Request('https://worker.example.com/webhook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: 'user1', message: { type: 'text', content: 'oi' } }),
        }),
    )

    assertEquals(response.status, 200)
    await response.body?.cancel()
    assertEquals(channel.texts, ['echo: oi'])
})

Deno.test('cloudflare listener answers 500 for an unknown channel', async () => {
    await loadFixtureBot()
    const listener = createFetchListener({ directory: botDirectory })

    const response = await listener(
        new Request('https://worker.example.com/nope', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: 'user1', message: { type: 'text', content: 'oi' } }),
        }),
    )

    assertEquals(response.status, 500)
    const body = await response.json()
    assertEquals(typeof body.error, 'string')
})

Deno.test('cloudflare listener propagates the status a channel chose', async () => {
    await loadFixtureBot()
    const listener = createFetchListener({ directory: botDirectory })

    const response = await listener(
        new Request('https://worker.example.com/webhook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: { type: 'text', content: 'oi' } }),
        }),
    )

    assertEquals(response.status, 400)
    assertEquals(await response.text(), 'Missing from')
})

Deno.test('lambda handler routes an API Gateway v2 event through to the flow', async () => {
    await loadFixtureBot()
    const handler = getHandler(botDirectory)

    const result = await handler(
        lambdaEvent('/webhook', { from: 'user1', message: { type: 'text', content: 'oi' } }),
    )

    assertEquals(typeof result, 'object')
    assertEquals((result as { statusCode: number }).statusCode, 200)
    assertEquals(channel.texts, ['echo: oi'])
})

Deno.test('lambda handler reports channel errors as a 500 payload', async () => {
    await loadFixtureBot()
    const handler = getHandler(botDirectory)

    const result = await handler(
        lambdaEvent('/nope', { from: 'user1', message: { type: 'text', content: 'oi' } }),
    ) as { statusCode: number; body: string }

    assertEquals(result.statusCode, 500)
    assertEquals(typeof JSON.parse(result.body).error, 'string')
})

Deno.test('lambda handler applies the request transformer before routing', async () => {
    await loadFixtureBot()

    // Strips a stage prefix, which is what the transformer exists for.
    const handler = getHandler(botDirectory, (request) => {
        const url = new URL(request.url)
        url.pathname = url.pathname.replace(/^\/prod/, '')
        return new Request(url, request)
    })

    const result = await handler(
        lambdaEvent('/prod/webhook', { from: 'user1', message: { type: 'text', content: 'oi' } }),
    ) as { statusCode: number }

    assertEquals(result.statusCode, 200)
    assertEquals(channel.texts, ['echo: oi'])
})
