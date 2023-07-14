import { mawa } from '../../deps.ts'

type ChatwootMessage = {
    account: {
        id: number
    }
    content_type: string
    content: unknown
    conversation: {
        id: number
        can_reply: boolean
        inbox_id: number
        status: string
    }
    message_type: 'incoming' | 'outgoing'
    sender: {
        additional_attributes: Record<string, unknown>
        custom_attributes: Record<string, unknown>
        avatar: string
        email: string
        id: number
        name: string
        phone_number: string
        thumbnail: string
    }
    source_id: string
    event: string
}

export default class ChatwootChannel implements mawa.Channel {
    public readonly sourceId = 'chatwoot'

    constructor(
        private readonly config: {
            userApiKey: string
            baseUrl?: string
        },
    ) {
        if (!config.baseUrl) {
            config.baseUrl = 'https://app.chatwoot.com'
        }
    }

    public async receive(request: Request): Promise<void | Response | mawa.SourceMessage> {
        if (request.method !== 'POST') {
            return new Response('Invalid method', { status: 405 })
        }

        const body: ChatwootMessage = await request.json()

        mawa.logger.debug('Received request from chatwoot', body)

        if (body.event !== 'message_created') {
            mawa.logger.debug('Received message that is not message_created')
            return new Response()
        }

        if (body.message_type !== 'incoming') {
            mawa.logger.debug('Received message that is not incoming')
            return new Response()
        }

        if (body.content_type !== 'text') {
            mawa.logger.debug('Received message that is not text')
            return new Response()
        }

        const message: mawa.Message<'text'> = {
            type: 'text',
            content: body.content as string,
        }

        const userId = mawa.User.getIdFromSourceId(body.sender.id.toString(), this.sourceId)
        await mawa.config().storage.mergeUser(userId, {
            name: body.sender.name,
            email: body.sender.email,
            phoneNumber: body.sender.phone_number,
            photoUri: body.sender.avatar || body.sender.thumbnail,
            metadata: this.convertObjectToStringObject({
                ...body.sender.additional_attributes,
                ...body.sender.custom_attributes,
            }),
        })

        await mawa.config().storage.setKv(userId, '#chatwoot-conversation', body.conversation.id.toString())

        return {
            sourceAuthorId: body.sender.id.toString(),
            message,
        }
    }

    public async send(sourceUserId: string, message: mawa.UnknownMessage): Promise<void> {
        const userId = mawa.User.getIdFromSourceId(sourceUserId, this.sourceId)
        const conversation = await mawa.config().storage.getKv(userId, '#chatwoot-conversation')

        if (!conversation) {
            throw new Error(`No conversation found for user ${userId}`)
        }

        if (!mawa.isMessageOfType(message, 'text')) {
            throw new Error(`Message type ${message.type} not supported`)
        }

        const result = await fetch(`${this.config.baseUrl}/api/v1/conversations/${conversation}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api_access_token': this.config.userApiKey,
            },
            body: JSON.stringify({
                message_type: 'outgoing',
                private: false,
                content_type: 'text',
                content: message.content,
            }),
        })

        if (!result.ok) {
            throw new Error(`Failed to send message: ${await result.text()}`)
        }

        mawa.logger.debug('Sent message to chatwoot', message)
    }

    private convertObjectToStringObject(obj: Record<string, unknown>): Record<string, string> {
        const result: Record<string, string> = {}
        for (const [key, value] of Object.entries(obj)) {
            if (value) {
                result[key] = value.toString()
            }
        }
        return result
    }
}
