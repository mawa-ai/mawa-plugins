/**
 * The parts of the WhatsApp Cloud API webhook this channel reads.
 *
 * Everything is optional on purpose. A webhook delivery is not only inbound messages: the
 * same subscription carries template approvals, account and quality updates, message echoes
 * and delivery statuses, and Meta adds fields without warning. Nothing here may be assumed
 * present, because a payload that throws while being read is answered with a 500, and Meta
 * responds to repeated failures by retrying for days and eventually disabling the webhook.
 */

export type WhatsappProfile = {
    name?: string
    /** The user's `@handle`. Only present once they have enabled the username feature. */
    username?: string
}

export type WhatsappContact = {
    /**
     * The user's phone number.
     *
     * Omitted when the user has a WhatsApp username and the business has no recent interaction
     * history with them, so this cannot be treated as the user's identity.
     */
    wa_id?: string
    /**
     * Business-scoped user id: stable, always present, and scoped to the business portfolio.
     *
     * The identity to key a conversation on. A phone number can be hidden or changed; this
     * cannot.
     */
    user_id?: string
    /**
     * Business-scoped id at the level of a group of portfolios, for businesses that have them.
     *
     * Not what a conversation is keyed on: `user_id` is the identity within the portfolio this
     * channel's number belongs to.
     */
    parent_user_id?: string
    /** The number as the sender typed it, which can differ from `wa_id`. */
    input?: string
    profile?: WhatsappProfile
}

export type WhatsappMediaPayload = {
    id?: string
    mime_type?: string
    sha256?: string
    caption?: string
    filename?: string
    /** Only set on stickers. */
    animated?: boolean
}

export type WhatsappInteractiveReply = {
    type?: 'button_reply' | 'list_reply' | 'nfm_reply' | string
    button_reply?: { id?: string; title?: string }
    list_reply?: { id?: string; title?: string; description?: string }
    /** A WhatsApp Flow completion. `response_json` is a JSON document as a string. */
    nfm_reply?: { name?: string; body?: string; response_json?: string }
}

export type WhatsappMessage = {
    id?: string
    /** The sender's phone number. Omitted when they keep it to themselves. */
    from?: string
    /** The sender's business-scoped user id, which is always there. */
    from_user_id?: string
    timestamp?: string
    type?: string
    text?: { body?: string }
    image?: WhatsappMediaPayload
    audio?: WhatsappMediaPayload
    video?: WhatsappMediaPayload
    document?: WhatsappMediaPayload
    sticker?: WhatsappMediaPayload
    location?: { latitude?: number; longitude?: number; name?: string; address?: string }
    contacts?: unknown[]
    reaction?: { emoji?: string; message_id?: string }
    interactive?: WhatsappInteractiveReply
    /** A quick reply on a template message, which is not an `interactive` reply. */
    button?: { text?: string; payload?: string }
    order?: unknown
    system?: {
        body?: string
        type?: string
        /** Set on `user_changed_number`: the id the user moved to. */
        wa_id?: string
        new_wa_id?: string
        customer?: string
    }
    /** Present when the message is a reply to, or forward of, another one. */
    context?: { id?: string; from?: string; forwarded?: boolean; frequently_forwarded?: boolean }
    /** Present when the conversation started from a Click-to-WhatsApp ad. */
    referral?: { source_url?: string; source_type?: string; source_id?: string; headline?: string }
    errors?: WhatsappError[]
}

export type WhatsappStatus = {
    id?: string
    status?: 'sent' | 'delivered' | 'read' | 'failed' | string
    timestamp?: string
    /** The recipient's phone number, when it is known. */
    recipient_id?: string
    /** The recipient's business-scoped id, which is always set however the message was sent. */
    recipient_user_id?: string
    conversation?: { id?: string; origin?: { type?: string } }
    pricing?: Record<string, unknown>
    errors?: WhatsappError[]
}

export type WhatsappError = {
    code?: number
    title?: string
    message?: string
    details?: string
    error_data?: { details?: string }
}

export type WhatsappValue = {
    messaging_product?: string
    metadata?: { display_phone_number?: string; phone_number_id?: string }
    contacts?: WhatsappContact[]
    messages?: WhatsappMessage[]
    statuses?: WhatsappStatus[]
    errors?: WhatsappError[]
}

export type WhatsappChange = {
    /** `'messages'` for everything this channel acts on. */
    field?: string
    value?: WhatsappValue
}

export type WhatsappWebhook = {
    object?: string
    entry?: { id?: string; changes?: WhatsappChange[] }[]
}

export type WhatsappSendResult = {
    messages?: { id?: string; message_status?: string }[]
    error?: WhatsappError
}
