import { mawa } from '../../../deps.ts'

/**
 * Channel that answers with whatever the flow replied, so an end-to-end test can assert
 * on it over HTTP. Buffering on the instance is fine for a fixture handling one request
 * at a time; a real channel would key this per request.
 */
class JsonChannel implements mawa.Channel {
    public readonly sourceId = 'webhook'
    private replies: mawa.UnknownMessage[] = []

    public receive(): Promise<void> {
        // Returning nothing hands the request to handle() below.
        return Promise.resolve()
    }

    public async handle(request: Request, onMessage: mawa.MessageHandler): Promise<Response> {
        this.replies = []
        const { from, message } = await request.json()
        await onMessage(from, message, this)
        return Response.json(this.replies)
    }

    public send(_sourceUserId: string, message: mawa.UnknownMessage): Promise<void> {
        this.replies.push(message)
        return Promise.resolve()
    }
}

const config: mawa.Configuration = {
    logLevel: 'CRITICAL',
    channels: [new JsonChannel()],
    storage: new mawa.MemoryStorage(),
    // Read at module scope, which is what the Deno.env shim has to cover.
    config: { greeting: Deno.env.get('GREETING') ?? 'no-greeting' },
}

export default config
