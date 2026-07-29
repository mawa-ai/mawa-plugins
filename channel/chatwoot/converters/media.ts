import { Converter } from '../../converter.ts'
import { chatwootText } from './text.ts'

/**
 * Media as a message with its link, which is as far as an agent bot can go.
 *
 * Chatwoot only accepts a real attachment as multipart form data, and only for a file the
 * caller holds the bytes of — not for a URL, and not for an id issued by another provider.
 * A link the agent can open keeps the conversation readable, which is the point of mirroring
 * it into Chatwoot at all.
 */
export const chatwootMediaConverter: Converter<'media'> = {
    type: 'media',
    convertToSourceMessage: (content) => {
        const reference = content.url ?? (content.id ? `${content.kind} ${content.id}` : undefined)
        if (!reference) {
            throw new Error('A media message needs either a url or an id')
        }

        return chatwootText(content.caption, reference)
    },
}
