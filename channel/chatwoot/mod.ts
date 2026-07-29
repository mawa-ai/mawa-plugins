import { mawa } from '../../deps.ts'
import { mergeContact } from '../contact.ts'
import { Converter, convertToSourcePayloads } from '../converter.ts'
import { chatwootLocationConverter } from './converters/location.ts'
import { chatwootMediaConverter } from './converters/media.ts'
import { chatwootMenuConverter } from './converters/menu.ts'
import { chatwootQuickReplyConverter } from './converters/quick-reply.ts'
import { chatwootTemplateConverter } from './converters/template.ts'
import { chatwootTextConverter } from './converters/text.ts'

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

/**
 * User metadata key holding the Chatwoot contact name, as last seen.
 *
 * The contact record is edited by agents and by the upstream channel, so the channel keeps its
 * own copy here and only claims `User.name` while nothing else has. See {@linkcode mergeContact}.
 */
export const CHATWOOT_CONTACT_NAME_KEY = 'chatwootContactName'

const converters: Converter<keyof mawa.MessageTypes>[] = [
    chatwootTextConverter,
    chatwootMenuConverter,
    chatwootQuickReplyConverter,
    chatwootMediaConverter,
    chatwootLocationConverter,
    chatwootTemplateConverter,
]

export class ChatwootChannel implements mawa.Channel {
    public readonly sourceId = 'chatwoot'

    constructor(
        private readonly config: {
            agentBotApiKey: string
            accountId: number
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

        // Independent of each other, so they do not need to be two round trips in sequence.
        await Promise.all([
            mergeContact(
                userId,
                { name: body.sender.name, key: CHATWOOT_CONTACT_NAME_KEY },
                {
                    email: body.sender.email,
                    phoneNumber: body.sender.phone_number,
                    photoUri: body.sender.avatar || body.sender.thumbnail,
                    metadata: this.convertObjectToStringObject({
                        ...body.sender.additional_attributes,
                        ...body.sender.custom_attributes,
                    }),
                },
            ),
            mawa.config().storage.setKv(userId, '#chatwoot-conversation', body.conversation.id.toString()),
        ])

        return {
            sourceAuthorId: body.sender.id.toString(),
            message,
        }
    }

    public async send(sourceUserId: string, message: mawa.UnknownMessage): Promise<void> {
        const chatwootMessages = convertToSourcePayloads(converters, this.sourceId, message, undefined)
        if (chatwootMessages.length === 0) {
            return
        }

        const userId = mawa.User.getIdFromSourceId(sourceUserId, this.sourceId)
        const conversation = await mawa.config().storage.getKv(userId, '#chatwoot-conversation')

        if (!conversation) {
            throw new Error(`No conversation found for user ${userId}`)
        }

        for (const chatwootMessage of chatwootMessages) {
            const result = await fetch(
                `${this.config.baseUrl}/api/v1/accounts/${this.config.accountId}/conversations/${conversation}/messages`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'api_access_token': this.config.agentBotApiKey,
                    },
                    body: JSON.stringify({
                        message_type: 'outgoing',
                        private: false,
                        ...chatwootMessage as Record<string, unknown>,
                    }),
                },
            )

            if (!result.ok) {
                throw new Error(`Failed to send message: ${await result.text()}`)
            }
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
