import { mawa } from '../deps.ts'

export interface Converter<Type extends keyof mawa.MessageTypes> {
    type: Type
    // deno-lint-ignore no-explicit-any
    isSourceConverter?: (sourceMessage: any) => boolean
    // deno-lint-ignore no-explicit-any
    convertFromSourceMessage?(sourceMessage: any): mawa.MessageTypes[Type]
    convertToSourceMessage?(content: mawa.MessageTypes[Type]): unknown
}
