import { mawa } from '../../deps.ts'
import { mergeContact } from '../contact.ts'
import { Converter, convertToSourcePayloads } from '../converter.ts'
import { whatsappLocationConverter } from './converters/location.ts'
import { whatsappMediaConverter } from './converters/media.ts'
import { whatsappMenuConverter } from './converters/menu.ts'
import { whatsappQuickReplyConverter } from './converters/quick-reply.ts'
import { whatsappTemplateConverter } from './converters/template.ts'
import { whatsappTextConverter } from './converters/text.ts'
import { newOptionToken, recallOption, rememberOptions, type WhatsappConversion } from './options.ts'
import { equalStrings, SIGNATURE_HEADER, verifySignature } from './signature.ts'
import type {
    WhatsappChange,
    WhatsappContact,
    WhatsappMessage,
    WhatsappSendResult,
    WhatsappStatus,
    WhatsappValue,
    WhatsappWebhook,
} from './types.ts'

const converters: Converter<keyof mawa.MessageTypes, WhatsappConversion>[] = [
    whatsappTextConverter,
    whatsappQuickReplyConverter,
    whatsappMenuConverter,
    whatsappMediaConverter,
    whatsappLocationConverter,
    whatsappTemplateConverter,
]

export type { WhatsappConversion }

/** Graph API version used when the channel is constructed without one. */
export const DEFAULT_GRAPH_API_VERSION = 'v25.0'

/** `sourceId` of this channel, and so the one a `raw` message has to be addressed to. */
export const WHATSAPP_SOURCE_ID = 'whatsapp'

/**
 * Events the channel reports through the `event` hook, for what does not become a message.
 *
 * Everything WhatsApp can deliver arrives on one webhook, and most of it is not a message a
 * flow can answer. Reporting these as events is what keeps them from vanishing: a bot can
 * tell the user it cannot read an order form, or log a failed delivery, instead of looking
 * unresponsive.
 */
export const WHATSAPP_EVENTS = {
    /** A message whose type has no equivalent in the SDK. `data` holds the raw message. */
    unsupported: 'whatsapp:unsupported',
    /** A reaction to an earlier message. `data` is `{ emoji, messageId }`. */
    reaction: 'whatsapp:reaction',
    /** A WhatsApp Flow was completed. `data` is `{ name, response }`, already parsed. */
    flowReply: 'whatsapp:flow-reply',
    /** Delivery feedback for a message that was sent. Off unless `statusEvents` is set. */
    status: 'whatsapp:status',
} as const

/** Error code Graph answers with when the 24-hour customer service window has closed. */
const OUTSIDE_WINDOW_CODE = 131047

/** HTTP statuses worth another attempt: rate limiting and Graph being briefly unwell. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])

/** Graph error codes that mean "later", not "never". */
const RETRYABLE_CODES = new Set([1, 2, 130429, 131056])

/**
 * User metadata key holding the WhatsApp profile name, as last seen.
 *
 * A user edits their profile name whenever they like, so the channel keeps its own copy here
 * and only claims `User.name` while nothing else has. See {@linkcode mergeContact}.
 */
export const WHATSAPP_PROFILE_NAME_KEY = 'whatsappProfileName'

/**
 * User metadata key holding the user's WhatsApp `@handle`, when they have one.
 *
 * The only name a user who keeps their phone number to themselves goes by, so it is worth
 * having where a flow or an agent can read it.
 */
export const WHATSAPP_USERNAME_KEY = 'whatsappUsername'

/** Where the id of the conversation this user started under is kept, after a number change. */
const CANONICAL_ID_KEY = '#wa-canonical-id'

/**
 * Whether an id is a business-scoped user id rather than a phone number.
 *
 * Meta spells them as an ISO 3166 alpha-2 country code, a period, then up to 128 alphanumeric
 * characters — `US.13491208655302741918`. A phone number cannot match: it has no letters and
 * no period.
 */
export const isBusinessScopedId = (id: string): boolean => /^[a-z]{2}\.[a-z0-9]{1,128}$/i.test(id)

export type WhatsappChannelConfig = {
    numberId: string
    token: string
    verifyToken: string
    /**
     * Meta app secret, used to check the `X-Hub-Signature-256` of every delivery.
     *
     * Required, because a webhook that cannot verify a delivery has no idea who sent it: the
     * author of an inbound message comes from the payload, so anyone who knows the URL could
     * drive any user's conversation. Found under App settings → Basic in the Meta dashboard.
     */
    appSecret: string
    /**
     * Graph API version to call, such as `'v25.0'`.
     *
     * Defaults to {@link DEFAULT_GRAPH_API_VERSION}. Meta retires versions after about two
     * years, so pin this explicitly if you need to control when you move.
     */
    graphApiVersion?: string
    /**
     * What to acknowledge an inbound message with, before the flow runs.
     *
     * - `'typing'`, the default: mark it read and show a typing indicator, so the user can see
     *   the bot is working. One request.
     * - `'read'`: mark it read without the indicator.
     * - `'none'`: neither, saving the round trip before the webhook is answered.
     *
     * One setting rather than two, because WhatsApp only shows a typing indicator as part of
     * marking a message read — there is no way to ask for the indicator alone.
     */
    acknowledge?: 'typing' | 'read' | 'none'
    /**
     * Report delivery statuses (`sent`, `delivered`, `read`, `failed`) as events.
     *
     * Off by default, because it multiplies how often the `event` hook runs — WhatsApp sends
     * several statuses per message. Turn it on to observe failed deliveries.
     */
    statusEvents?: boolean
    /** How hard to try again when Graph rate limits or briefly fails. */
    retry?: {
        /** Total attempts, including the first. Defaults to 3. */
        attempts?: number
        /** Delay before the second attempt, doubled for each one after. Defaults to 500ms. */
        baseDelayMs?: number
    }
}

/**
 * Channel for the WhatsApp Cloud API.
 *
 * Handles the webhook and the Graph `messages` endpoint. Text, quick replies, menus, media,
 * locations and approved templates travel both ways where WhatsApp allows it; anything else
 * WhatsApp delivers is reported through {@linkcode WHATSAPP_EVENTS} rather than dropped.
 */
export class WhatsappChannel implements mawa.Channel {
    public readonly sourceId = WHATSAPP_SOURCE_ID

    constructor(private readonly config: WhatsappChannelConfig) {}

    public async receive(request: Request): Promise<mawa.SourceMessage[] | Response> {
        if (request.method === 'GET') {
            return this.verifyWebhook(request)
        }

        if (request.method !== 'POST') {
            return new Response('Invalid method', { status: 405 })
        }

        // Read as text, not JSON: the signature covers the bytes that arrived, and
        // re-serializing a parsed body produces different ones.
        const rawBody = await request.text()

        const signature = request.headers.get(SIGNATURE_HEADER)
        if (!await verifySignature(rawBody, signature, this.config.appSecret)) {
            mawa.logger.warn('Rejected a whatsapp delivery with an invalid signature')
            return new Response('Invalid signature', { status: 401 })
        }

        let body: WhatsappWebhook
        try {
            body = JSON.parse(rawBody)
        } catch {
            return new Response('Invalid body', { status: 400 })
        }

        mawa.logger.debug('Received request from whatsapp', body)

        return await this.handleWebhook(body)
    }

    public async send(sourceUserId: string, message: mawa.UnknownMessage): Promise<void> {
        // Shared by the payload and by what is remembered about it, so a reply can be matched
        // on its id even after later messages have offered options of their own.
        const context: WhatsappConversion = { optionToken: newOptionToken() }

        const payloads = convertToSourcePayloads(converters, this.sourceId, message, context)
        if (payloads.length === 0) {
            return
        }

        // Started before the first send rather than after the last: the user cannot answer a
        // message that has not gone out yet, and this way it overlaps with the Graph calls.
        const remembering = rememberOptions(
            mawa.User.getIdFromSourceId(sourceUserId, this.sourceId),
            message,
            context.optionToken,
        )

        const replyTo = message.metadata?.replyTo

        for (const [index, payload] of payloads.entries()) {
            const result = await this.post({
                recipient_type: 'individual',
                ...this.addressee(sourceUserId),
                // Only the first piece quotes the message being answered; repeating the quote
                // on each piece of a split reply would be noise.
                ...(replyTo && index === 0 ? { context: { message_id: replyTo } } : {}),
                ...payload as Record<string, unknown>,
            })

            mawa.logger.debug('Sent message to whatsapp', { to: sourceUserId, id: result.messages?.[0]?.id })
        }

        await remembering
    }

    /**
     * Marks a message as read, and optionally shows a typing indicator.
     *
     * The indicator lasts until a message is sent or about 25 seconds pass, so it is only
     * worth showing right before work the user waits on.
     *
     * @param messageId A `wamid` from an inbound message.
     * @param typing Whether to show the indicator as well.
     */
    public async markAsRead(messageId: string, typing = false, retry = this.config.retry): Promise<void> {
        await this.post({
            status: 'read',
            message_id: messageId,
            ...(typing ? { typing_indicator: { type: 'text' } } : {}),
        }, retry)
    }

    /**
     * Resolves the short-lived download URL of an inbound media file.
     *
     * The URL needs the channel's own token to be fetched, so it is of little use on its
     * own; {@linkcode WhatsappChannel.downloadMedia} is usually what a flow wants.
     */
    public async getMediaUrl(mediaId: string): Promise<string> {
        const response = await this.fetchGraph(this.graphUrl(mediaId), { method: 'GET' })
        const body = await response.json() as { url?: string; error?: { message?: string } }

        if (!response.ok || !body.url) {
            throw new Error(`Failed to resolve whatsapp media ${mediaId}: ${body.error?.message ?? response.status}`)
        }

        return body.url
    }

    /**
     * Downloads an inbound media file.
     *
     * Inbound media only ever arrives as an id, because WhatsApp keeps the bytes behind an
     * authenticated endpoint. Media is deleted after 30 days, and the URL in between expires
     * within minutes, so download when the message arrives rather than later.
     */
    public async downloadMedia(mediaId: string): Promise<{ data: ArrayBuffer; mimeType: string | undefined }> {
        const url = await this.getMediaUrl(mediaId)
        const response = await this.fetchGraph(url, { method: 'GET' })

        if (!response.ok) {
            throw new Error(`Failed to download whatsapp media ${mediaId}: ${response.status}`)
        }

        return {
            data: await response.arrayBuffer(),
            mimeType: response.headers.get('Content-Type') ?? undefined,
        }
    }

    /**
     * Uploads a file and returns its media id, for sending something not hosted publicly.
     *
     * Pass the id as `Media.id`. WhatsApp keeps an uploaded file for 30 days.
     */
    public async uploadMedia(file: Blob, filename = 'file'): Promise<string> {
        const form = new FormData()
        form.set('messaging_product', 'whatsapp')
        form.set('file', file, filename)

        const response = await this.fetchGraph(this.graphUrl(this.config.numberId, 'media'), {
            method: 'POST',
            body: form,
        })
        const body = await response.json() as { id?: string; error?: { message?: string } }

        if (!response.ok || !body.id) {
            throw new Error(`Failed to upload whatsapp media: ${body.error?.message ?? response.status}`)
        }

        return body.id
    }

    private verifyWebhook(request: Request): Response {
        const searchParams = new URL(request.url).searchParams
        const challenge = searchParams.get('hub.challenge')
        const mode = searchParams.get('hub.mode')
        const token = searchParams.get('hub.verify_token')

        if (mode !== 'subscribe' || !token || !equalStrings(token, this.config.verifyToken)) {
            // Deliberately without the expected token: a log is not the place for a secret.
            mawa.logger.debug('Received invalid verification request from whatsapp', { mode })
            return new Response('Invalid token', { status: 403 })
        }

        if (!challenge) {
            return new Response('Missing challenge', { status: 400 })
        }

        return new Response(challenge)
    }

    /**
     * Turns a delivery into the messages it carries.
     *
     * Written so that nothing unexpected in the payload can throw. A failure here is a 500,
     * and Meta answers those by retrying for days and eventually disabling the webhook, so a
     * template approval or a field added next quarter has to come out as "nothing to do".
     */
    private async handleWebhook(body: WhatsappWebhook): Promise<mawa.SourceMessage[] | Response> {
        const messages: mawa.SourceMessage[] = []
        let addressedElsewhere = false
        let lastInboundId: string | undefined

        for (const entry of body.entry ?? []) {
            for (const change of entry.changes ?? []) {
                const value = this.messageChangeValue(change)
                if (!value) {
                    continue
                }

                if (value.metadata?.phone_number_id !== this.config.numberId) {
                    mawa.logger.debug('Received message for another number', { metadata: value.metadata })
                    addressedElsewhere = true
                    continue
                }

                for (const error of value.errors ?? []) {
                    mawa.logger.error('Whatsapp reported an error on the webhook', error)
                }

                const statuses = await Promise.all((value.statuses ?? []).map((status) => this.readStatus(status)))
                messages.push(...statuses.filter((status) => status !== undefined))

                for (const waMessage of value.messages ?? []) {
                    lastInboundId = waMessage.id ?? lastInboundId

                    const message = await this.readMessage(waMessage, value.contacts)
                    if (message) {
                        messages.push(message)
                    }
                }
            }
        }

        // Every change was for a different number and nothing came of the delivery. Kept as a
        // 400 so a webhook wired to the wrong number is noticed rather than silently ignored.
        if (messages.length === 0 && addressedElsewhere) {
            return new Response('Invalid message', { status: 400 })
        }

        const acknowledge = this.config.acknowledge ?? 'typing'
        if (lastInboundId && acknowledge !== 'none') {
            // Before the flow runs, so the user sees the message read and the bot typing.
            // Never at the cost of the delivery: a failure here is not the user's problem.
            // One attempt only: this runs before the delivery is answered, and retrying a
            // rate-limited read receipt would hold the webhook open through every backoff.
            await this.markAsRead(lastInboundId, acknowledge === 'typing', { attempts: 1 }).catch((err) =>
                mawa.logger.warn('Failed to mark whatsapp message as read', mawa.toError(err))
            )
        }

        return messages
    }

    /** The value of a change that carries messages, or nothing for every other kind. */
    private messageChangeValue(change: WhatsappChange): WhatsappValue | undefined {
        if (!change?.value) {
            return undefined
        }

        // Template approvals, quality and account updates, message echoes, flows, calls: all
        // arrive on the same subscription, and none of them is a message.
        if (change.field && change.field !== 'messages') {
            mawa.logger.debug('Ignoring whatsapp change', { field: change.field })
            return undefined
        }

        // An older payload may omit `field`. `metadata` is what every messages change has,
        // and its absence is what tells the two apart.
        if (!change.value.metadata) {
            mawa.logger.debug('Ignoring whatsapp change without metadata', { field: change.field })
            return undefined
        }

        return change.value
    }

    /**
     * Reads one inbound message, which is zero or one message for the flow.
     *
     * Zero when it was already handled, when it only announced a number change, or when it
     * carried nothing convertible — in which case an event is produced instead, so that the
     * bot can answer rather than appear to ignore the user.
     */
    private async readMessage(
        waMessage: WhatsappMessage,
        contacts: WhatsappContact[] | undefined,
    ): Promise<mawa.SourceMessage | undefined> {
        const author = await this.resolveAuthor(waMessage, contacts)
        if (!author) {
            mawa.logger.debug('Received whatsapp message without an author', waMessage)
            return undefined
        }

        const { sourceAuthorId, contact, phoneNumber } = author
        const userId = mawa.User.getIdFromSourceId(sourceAuthorId, this.sourceId)

        if (waMessage.type === 'system') {
            await this.applySystemMessage(waMessage)
            return undefined
        }

        await mergeContact(
            userId,
            { name: contact?.profile?.name, key: WHATSAPP_PROFILE_NAME_KEY },
            {
                // Only when a number is actually known: a user with a WhatsApp username may
                // never share one, and filing their business-scoped id under `phoneNumber` would
                // put a value there that is not a phone number.
                ...(phoneNumber ? { phoneNumber } : {}),
                // The handle is how such a user identifies themselves, and often the only thing
                // an agent picking up the conversation has to go on.
                ...(contact?.profile?.username
                    ? { metadata: { [WHATSAPP_USERNAME_KEY]: contact.profile.username } }
                    : {}),
            },
        )

        const converted = this.convertFromWhatsappMessage(waMessage)
        const message = converted ? await this.resolveReply(userId, waMessage, converted) : this.eventFor(waMessage)

        return { sourceAuthorId, id: waMessage.id, message: this.withMetadata(message, waMessage) }
    }

    /**
     * Puts back the option text the flow wrote, in place of the title WhatsApp echoed.
     *
     * A reply carries the title as it was displayed, which is cut to 20 characters on a button
     * and 24 on a row. Matching on that means comparing against text the flow never wrote,
     * and two options that only differ past the cut cannot be told apart. The id is exact, so
     * it is what the reply is resolved through, falling back to the title when the options are
     * no longer known — after a restart, say, or a menu this channel did not send.
     */
    private async resolveReply(
        userId: mawa.UserId,
        waMessage: WhatsappMessage,
        message: mawa.UnknownMessage,
    ): Promise<mawa.UnknownMessage> {
        const id = waMessage.interactive?.button_reply?.id ?? waMessage.interactive?.list_reply?.id
        if (!id || !mawa.isMessageOfType(message, 'text')) {
            return message
        }

        const option = await recallOption(userId, id)
        return option ? { ...message, content: option } : message
    }

    /** Records that a user's new number continues the conversation of their old one. */
    private async applySystemMessage(waMessage: WhatsappMessage): Promise<void> {
        const next = waMessage.system?.new_wa_id ?? waMessage.system?.wa_id
        const previous = waMessage.from

        if (waMessage.system?.type !== 'user_changed_number' || !next || !previous) {
            mawa.logger.debug('Ignoring whatsapp system message', waMessage.system)
            return
        }

        // A conversation keyed on a business-scoped id is unaffected by a number change: the id
        // stays the same, so there is nothing to link. This only matters for a user first seen
        // when a phone number was the only identifier there was.
        if (waMessage.from_user_id) {
            mawa.logger.debug('Whatsapp user changed number, already keyed on a business-scoped id')
            return
        }

        // Resolved first, so a second number change still points at the original conversation
        // instead of chaining through the one in between.
        const canonical = await this.canonicalId(previous)

        mawa.logger.info('Whatsapp user changed number', { from: previous, to: next, canonical })
        await mawa.config().storage.setKv(
            mawa.User.getIdFromSourceId(next, this.sourceId),
            CANONICAL_ID_KEY,
            canonical,
        )
    }

    /**
     * Works out who sent a message, and which conversation it belongs to.
     *
     * The identity is the business-scoped user id, not the phone number. A phone number is
     * optional — a user with a WhatsApp username can withhold it, in which case `from` and
     * `wa_id` are simply absent — and it can change, while the business-scoped id is always
     * sent and never changes. Keying on the number would mean losing the conversation of
     * anyone who hides theirs, and dropping their messages outright.
     */
    private async resolveAuthor(
        waMessage: WhatsappMessage,
        contacts: WhatsappContact[] | undefined,
    ): Promise<{ sourceAuthorId: string; contact?: WhatsappContact; phoneNumber?: string } | undefined> {
        const businessScopedId = waMessage.from_user_id
        const phone = waMessage.from

        // Matched on either identifier, since which one a delivery carries varies. Taking the
        // first of several contacts would file the message under the wrong person, so that only
        // happens when there is exactly one to choose from.
        const contact = contacts?.find((candidate) =>
            (businessScopedId && candidate.user_id === businessScopedId) ||
            (phone && candidate.wa_id === phone)
        ) ?? (contacts?.length === 1 ? contacts[0] : undefined)

        const identity = businessScopedId ?? contact?.user_id ?? phone ?? contact?.wa_id
        if (!identity) {
            return undefined
        }

        const knownPhone = phone ?? contact?.wa_id
        const sourceAuthorId = await this.canonicalId(identity, knownPhone)

        return {
            sourceAuthorId,
            contact,
            // `input` is the number as the user typed it, which is the one they recognize.
            phoneNumber: contact?.input ?? knownPhone,
        }
    }

    /**
     * The id of the conversation an identifier belongs to.
     *
     * Not always the identifier itself: a user who changed their number, or who was first seen
     * before business-scoped ids existed, keeps the conversation they started. The answer is
     * recorded the first time it is worked out, so later messages cost one read.
     *
     * @param identity The identifier to resolve, business-scoped where there is one.
     * @param phone The user's phone number, when the delivery carried one.
     */
    private async canonicalId(identity: string, phone?: string): Promise<string> {
        const storage = mawa.config().storage
        const userId = mawa.User.getIdFromSourceId(identity, this.sourceId)

        const recorded = await storage.getKv<string>(userId, CANONICAL_ID_KEY)
        if (recorded) {
            return recorded
        }

        let canonical = identity

        // Nothing is known about this identifier yet. A user keyed by phone number before
        // WhatsApp started sending business-scoped ids has a conversation under that number,
        // and it should carry on rather than start again under the new identifier.
        if (phone && phone !== identity) {
            const phoneUserId = mawa.User.getIdFromSourceId(phone, this.sourceId)
            if (await storage.getUser(phoneUserId)) {
                canonical = await this.canonicalId(phone)
            }
        }

        await storage.setKv(userId, CANONICAL_ID_KEY, canonical)
        return canonical
    }

    /** Carries what the flow may want to know about the delivery, without widening `content`. */
    private withMetadata(message: mawa.UnknownMessage, waMessage: WhatsappMessage): mawa.UnknownMessage {
        const metadata = Object.fromEntries(
            Object.entries({
                wamid: waMessage.id,
                whatsappType: waMessage.type,
                timestamp: waMessage.timestamp,
                replyTo: waMessage.context?.id,
                referralSourceId: waMessage.referral?.source_id,
            }).filter(([, value]) => Boolean(value)),
        ) as Record<string, string>

        return Object.keys(metadata).length > 0 ? { ...message, metadata } : message
    }

    /** What to tell the flow about a message none of the converters could read. */
    private eventFor(waMessage: WhatsappMessage): mawa.Message<'event'> {
        if (waMessage.type === 'reaction') {
            return {
                type: 'event',
                content: {
                    event: WHATSAPP_EVENTS.reaction,
                    data: { emoji: waMessage.reaction?.emoji, messageId: waMessage.reaction?.message_id },
                },
            }
        }

        if (waMessage.interactive?.nfm_reply) {
            return {
                type: 'event',
                content: {
                    event: WHATSAPP_EVENTS.flowReply,
                    data: {
                        name: waMessage.interactive.nfm_reply.name,
                        response: this.parseJson(waMessage.interactive.nfm_reply.response_json),
                    },
                },
            }
        }

        for (const error of waMessage.errors ?? []) {
            mawa.logger.warn('Whatsapp could not deliver an inbound message', error)
        }

        mawa.logger.debug('Received an unsupported whatsapp message', { type: waMessage.type })
        return {
            type: 'event',
            content: {
                event: WHATSAPP_EVENTS.unsupported,
                data: { type: waMessage.type, message: waMessage },
            },
        }
    }

    private async readStatus(status: WhatsappStatus): Promise<mawa.SourceMessage | undefined> {
        // Logged whether or not statuses are reported as events: a failed delivery is the one
        // thing about an outgoing message nobody else would ever find out about.
        for (const error of status.errors ?? []) {
            mawa.logger.error('Whatsapp failed to deliver a message', { id: status.id, ...error })
        }

        // Preferring the business-scoped id, which is set however the message was addressed.
        // Reading only the phone number would lose every status for a user who hides theirs.
        const recipient = status.recipient_user_id ?? status.recipient_id
        if (!this.config.statusEvents || !recipient) {
            return undefined
        }

        return {
            sourceAuthorId: await this.canonicalId(recipient, status.recipient_id),
            message: {
                type: 'event',
                content: {
                    event: WHATSAPP_EVENTS.status,
                    data: {
                        id: status.id,
                        status: status.status,
                        timestamp: status.timestamp,
                        errors: status.errors,
                    },
                },
            },
        }
    }

    private parseJson(value: string | undefined): unknown {
        if (!value) {
            return undefined
        }

        try {
            return JSON.parse(value)
        } catch {
            // A Flow response that is not JSON is still worth handing over as it came.
            return value
        }
    }

    private convertFromWhatsappMessage(message: WhatsappMessage): mawa.UnknownMessage | undefined {
        for (const converter of converters) {
            if (converter.convertFromSourceMessage && converter.isSourceConverter?.(message)) {
                const content = converter.convertFromSourceMessage(message)

                // A converter that matched the shape but found no content has declined the
                // message. Taking it anyway would hand the flow content of `undefined`.
                if (typeof content !== 'undefined') {
                    return { type: converter.type, content } as mawa.UnknownMessage
                }
            }
        }

        return undefined
    }

    /**
     * Posts to the `messages` endpoint, retrying what is worth retrying.
     *
     * Rate limits and brief Graph failures are transient; treating them like a bad token
     * would fail a message that only needed a moment.
     */
    private async post(
        payload: Record<string, unknown>,
        retry = this.config.retry,
    ): Promise<WhatsappSendResult> {
        const url = this.graphUrl(this.config.numberId, 'messages')
        const attempts = Math.max(1, retry?.attempts ?? 3)
        const baseDelay = retry?.baseDelayMs ?? 500

        const body = JSON.stringify({ messaging_product: 'whatsapp', ...payload })
        mawa.logger.debug('Sending message to whatsapp', payload)

        for (let attempt = 1;; attempt++) {
            const last = attempt >= attempts

            let response: Response
            try {
                response = await this.fetchGraph(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                })
            } catch (err) {
                // A connection that never got an answer is safe to try again.
                if (last) {
                    throw err
                }

                mawa.logger.warn('Whatsapp request failed, retrying', mawa.toError(err))
                await this.delay(baseDelay * 2 ** (attempt - 1))
                continue
            }

            const result = await response.json().catch(() => ({})) as WhatsappSendResult

            if (response.ok) {
                return result
            }

            const retryable = RETRYABLE_STATUSES.has(response.status) ||
                (result.error?.code !== undefined && RETRYABLE_CODES.has(result.error.code))

            if (retryable && !last) {
                const retryAfter = Number(response.headers.get('Retry-After'))
                const delay = Number.isFinite(retryAfter) && retryAfter > 0
                    ? retryAfter * 1000
                    : baseDelay * 2 ** (attempt - 1)

                mawa.logger.warn(`Whatsapp answered ${response.status}, retrying in ${delay}ms`, result.error)
                await this.delay(delay)
                continue
            }

            throw new Error(this.describeFailure(response.status, result))
        }
    }

    private describeFailure(status: number, result: WhatsappSendResult): string {
        if (result.error?.code === OUTSIDE_WINDOW_CODE) {
            return 'Failed to send message to whatsapp: the 24-hour customer service window has closed, ' +
                'so only an approved template can be sent. Send a message of type `template` instead.'
        }

        const detail = result.error?.message ?? result.error?.title
        return `Failed to send message to whatsapp: ${status}` + (detail ? ` (${detail})` : '')
    }

    /**
     * How to address a message: `to` for a phone number, `recipient` for a business-scoped id.
     *
     * Graph rejects a business-scoped id given as `to`, and a user who keeps their number to
     * themselves can only be reached the other way. Which one an id is can be read off its
     * shape, so nothing has to be remembered about the user to know how to write to them.
     */
    private addressee(sourceUserId: string): Record<string, string> {
        return isBusinessScopedId(sourceUserId) ? { recipient: sourceUserId } : { to: sourceUserId }
    }

    private fetchGraph(url: string, init: RequestInit): Promise<Response> {
        const headers = new Headers(init.headers)
        headers.set('Authorization', `Bearer ${this.config.token}`)

        return fetch(url, { ...init, headers })
    }

    private graphUrl(...path: string[]): string {
        const version = this.config.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION
        return `https://graph.facebook.com/${version}/${path.join('/')}`
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms))
    }
}
