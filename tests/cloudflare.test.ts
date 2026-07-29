import { assertEquals } from '@std/assert'
import { createTestBot, FakeChannel, jsonRequest } from 'mawa/testing'
import { mawa } from '../deps.ts'
import { createFetchListener, type ExecutionContext } from '../hosting/cloudflare/mod.ts'

/**
 * A channel that answers with the flow's replies, the way the web chat does.
 *
 * These must never be deferred, or the response would be empty.
 */
class JsonChannel implements mawa.Channel {
    public readonly sourceId = 'web'
    public readonly sent: mawa.UnknownMessage[] = []

    public receive(): Promise<void> {
        // Returning nothing hands the request to handle() below.
        return Promise.resolve()
    }

    public async handle(request: Request, onMessage: mawa.MessageHandler): Promise<Response> {
        const { from, message } = await request.json()
        await onMessage(from, message, this)
        return Response.json(this.sent)
    }

    public send(_sourceUserId: string, message: mawa.UnknownMessage): Promise<void> {
        this.sent.push(message)
        return Promise.resolve()
    }
}

const slowState = (delayMs: number): mawa.State => async (context) => {
    if (delayMs) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    await context.send('pong')
    return { input: true }
}

/** Installs a bot the way the generated bundle does, with no files involved. */
const installBot = (options: { delayMs?: number } = {}) => {
    // Resets the SDK's "already loaded" memo, so this bot replaces the previous test's.
    createTestBot()

    const webhook = new FakeChannel('webhook')
    const web = new JsonChannel()

    mawa.setRegistry({
        configuration: {
            logLevel: 'CRITICAL',
            channels: [webhook, web],
            storage: new mawa.MemoryStorage(),
        },
        states: { start: { default: slowState(options.delayMs ?? 0) } },
    })

    return { webhook, web }
}

const post = (body: unknown, path = '/webhook') => jsonRequest(`https://worker.example.com${path}`, body)

const message = { from: 'user1', message: { type: 'text', content: 'oi' } }

/** Records what was handed to waitUntil, the way the Workers runtime keeps it alive. */
const fakeContext = () => {
    const pending: Promise<unknown>[] = []
    const ctx: ExecutionContext = { waitUntil: (promise) => void pending.push(promise) }
    return { ctx, pending }
}

Deno.test('serves a registered bot without reading the filesystem', async () => {
    const { webhook } = installBot()
    const fetchHandler = createFetchListener()

    const response = await fetchHandler(post(message))

    assertEquals(response.status, 200)
    await response.body?.cancel()
    assertEquals(webhook.texts, ['pong'])

    mawa.clearRegistry()
})

Deno.test('accepts the Workers handler signature', async () => {
    const { webhook } = installBot()
    const fetchHandler = createFetchListener()
    const { ctx, pending } = fakeContext()

    const response = await fetchHandler(post(message), { SOME_BINDING: 'value' }, ctx)
    await response.body?.cancel()

    assertEquals(response.status, 200)

    // Deferred, because a webhook's reply does not travel in this response.
    await Promise.all(pending)
    assertEquals(webhook.texts, ['pong'])

    mawa.clearRegistry()
})

Deno.test('acknowledges a webhook before running its flow', async () => {
    const { webhook } = installBot({ delayMs: 20 })
    const fetchHandler = createFetchListener()
    const { ctx, pending } = fakeContext()

    const response = await fetchHandler(post(message), {}, ctx)
    await response.body?.cancel()

    // Answered first, so a provider that retries on a slow response does not.
    assertEquals(webhook.texts, [])
    assertEquals(pending.length, 1)

    await Promise.all(pending)
    assertEquals(webhook.texts, ['pong'])

    mawa.clearRegistry()
})

Deno.test('still awaits a channel that answers with the flow replies', async () => {
    const { web } = installBot({ delayMs: 20 })
    const fetchHandler = createFetchListener()
    const { ctx, pending } = fakeContext()

    // This is what a boolean per adapter could not express: both channels, one Worker.
    const response = await fetchHandler(post(message, '/web'), {}, ctx)

    assertEquals(await response.json(), [{ type: 'text', content: 'pong' }])
    assertEquals(pending.length, 0)
    assertEquals(web.sent.length, 1)

    mawa.clearRegistry()
})

Deno.test('runs inline when the runtime offers no context', async () => {
    const { webhook } = installBot()
    const fetchHandler = createFetchListener()

    const response = await fetchHandler(post(message))
    await response.body?.cancel()

    assertEquals(webhook.texts, ['pong'])

    mawa.clearRegistry()
})

Deno.test('propagates the status a channel chose', async () => {
    installBot()
    const fetchHandler = createFetchListener()

    const response = await fetchHandler(post({ message: { type: 'text', content: 'oi' } }))

    assertEquals(response.status, 400)
    assertEquals(await response.text(), 'Missing from')

    mawa.clearRegistry()
})
