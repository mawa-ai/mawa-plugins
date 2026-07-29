import { Converter } from '../../converter.ts'
import type { WhatsappConversion } from '../options.ts'
import type { WhatsappMessage } from '../types.ts'

export const whatsappLocationConverter: Converter<'location', WhatsappConversion> = {
    type: 'location',
    convertToSourceMessage: (content) => ({
        type: 'location',
        location: {
            latitude: content.latitude,
            longitude: content.longitude,
            ...(content.name ? { name: content.name } : {}),
            ...(content.address ? { address: content.address } : {}),
        },
    }),
    convertFromSourceMessage: ({ location }: WhatsappMessage) => {
        // Zero is a valid coordinate, so the check is for presence rather than truthiness.
        if (typeof location?.latitude !== 'number' || typeof location?.longitude !== 'number') {
            return undefined
        }

        return {
            latitude: location.latitude,
            longitude: location.longitude,
            name: location.name,
            address: location.address,
        }
    },
    isSourceConverter: ({ type }: WhatsappMessage) => type === 'location',
}
