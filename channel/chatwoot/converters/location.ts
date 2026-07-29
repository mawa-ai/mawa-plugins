import { Converter } from '../../converter.ts'
import { chatwootText } from './text.ts'

/** A location as its name and coordinates, since Chatwoot has no location message. */
export const chatwootLocationConverter: Converter<'location'> = {
    type: 'location',
    convertToSourceMessage: (content) =>
        chatwootText(content.name, content.address, `${content.latitude}, ${content.longitude}`),
}
