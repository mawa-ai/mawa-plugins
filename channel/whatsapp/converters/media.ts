import { mawa } from '../../../deps.ts'
import { Converter } from '../../converter.ts'
import type { WhatsappConversion } from '../options.ts'
import { LIMITS, truncate, truncateOptional } from '../limits.ts'
import type { WhatsappMediaPayload, WhatsappMessage } from '../types.ts'

/** WhatsApp message types that carry a file, mapped to the kind the SDK calls them. */
const KINDS: Record<string, mawa.MediaKind> = {
    image: 'image',
    audio: 'audio',
    video: 'video',
    document: 'document',
    sticker: 'sticker',
}

/** Kinds WhatsApp renders without room for a caption, where sending one is an error. */
const CAPTIONABLE: mawa.MediaKind[] = ['image', 'video', 'document']

export const whatsappMediaConverter: Converter<'media', WhatsappConversion> = {
    type: 'media',
    convertToSourceMessage: (content) => {
        if (!content.url && !content.id) {
            throw new Error('A media message needs either a url or an id')
        }

        const payload: WhatsappMediaPayload & { link?: string } = content.id
            ? { id: content.id }
            : { link: content.url }

        if (content.caption && CAPTIONABLE.includes(content.kind)) {
            payload.caption = truncate(content.caption, LIMITS.caption)
        }

        if (content.kind === 'document' && content.filename) {
            payload.filename = truncate(content.filename, LIMITS.filename)
        }

        return {
            type: content.kind,
            [content.kind]: payload,
        }
    },
    convertFromSourceMessage: (message: WhatsappMessage) => {
        const kind = KINDS[message.type ?? '']
        if (!kind) {
            return undefined
        }

        const payload = message[kind] as WhatsappMediaPayload | undefined
        if (!payload?.id) {
            // Media is only ever addressed by id inbound. Without one there is nothing a flow
            // could do with it, so it is left to be reported as an event.
            return undefined
        }

        return {
            kind,
            id: payload.id,
            mimeType: payload.mime_type,
            caption: truncateOptional(payload.caption, LIMITS.caption),
            filename: payload.filename,
        }
    },
    isSourceConverter: ({ type }: WhatsappMessage) => Boolean(KINDS[type ?? '']),
}
