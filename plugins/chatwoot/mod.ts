import { mawa } from '../../deps.ts'

export default class ChatwootPlugin implements mawa.Plugin {
    public id = 'chatwoot'

    constructor(
        private readonly accountId: number,
        private readonly apiKey: string,
        private readonly inboxId: number,
        private readonly baseUrl: string = 'https://app.chatwoot.com',
    ) {}

    public messageHook: mawa.MessageHook = async (context, direction, message) => {
        let chatwootConversation = await context.getKv('#chatwoot-conversation')
        if (!chatwootConversation) {
            const chatwootContact = await context.getKv('#chatwoot-contact')
            if (!chatwootContact) {
                mawa.logger.error('No chatwoot contact found')
                return
            }

            const conversation = {
                source_id: context.author.getSourceId(),
                inbox_id: this.inboxId,
                contact_id: chatwootContact,
                additional_attributes: {
                    ...context.author.metadata,
                },
                status: 'pending',
            }
            const response = await fetch(`${this.baseUrl}/api/v1/accounts/${this.accountId}/conversations`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'api_access_token': `${this.apiKey}`,
                },
                body: JSON.stringify(conversation),
            })

            if (response.status === 200) {
                const data = await response.json()
                chatwootConversation = data.id
                await context.setKv('#chatwoot-conversation', chatwootConversation)
            } else {
                mawa.logger.error(`Error creating conversation on chatwoot: ${response.status}`, {
                    status: response.status,
                    body: await response.text(),
                })
                return
            }
        }

        // deno-lint-ignore no-explicit-any
        const chatwootMessage: any = {
            message_type: direction === 'sent' ? 'outgoing' : 'incoming',
            private: false,
        }

        if (mawa.isMessageOfType(message, 'text')) {
            chatwootMessage.content = message.content
        } else if (mawa.isMessageOfType(message, 'menu') || mawa.isMessageOfType(message, 'quick-reply')) {
            chatwootMessage.content = message.content.text
        }

        const response = await fetch(
            `${this.baseUrl}/api/v1/accounts/${this.accountId}/conversations/${chatwootConversation}/messages`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'api_access_token': `${this.apiKey}`,
                },
                body: JSON.stringify(chatwootMessage),
            },
        )

        if (response.status !== 200) {
            mawa.logger.error(`Error creating message on chatwoot: ${response.status}`, {
                status: response.status,
                body: await response.text(),
            })
        }
    }

    public userMessageHook: mawa.UserMessageHook = async (context) => {
        const chatwootContact = await context.getKv('#chatwoot-contact')
        if (!chatwootContact) {
            const contact = {
                inbox_id: this.inboxId,
                name: context.author.name,
                email: context.author.email,
                phone_number: '+' + context.author.phoneNumber,
                identifier: context.author.id,
                avatar_url: context.author.photoUri,
                additional_attributes: {
                    ...context.author.metadata,
                },
            }

            const response = await fetch(`${this.baseUrl}/api/v1/accounts/${this.accountId}/contacts`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'api_access_token': `${this.apiKey}`,
                },
                body: JSON.stringify(contact),
            })

            if (response.status === 200) {
                const data = await response.json()
                await context.setKv('#chatwoot-contact', data.id)
            } else {
                mawa.logger.error(`Error creating contact on chatwoot: ${response.status}`, {
                    status: response.status,
                    body: await response.text(),
                })
            }
        }
    }

    public sendToChatWoot: mawa.State = async (context) => {
        // set chatwoot state
        return { input: false }
    }

    states = {
        send: this.sendToChatWoot,
    }

    hooks: Partial<mawa.Hooks> = {
        message: this.messageHook,
        usermessage: this.userMessageHook,
    }
}
