import { mawa } from '../../../deps.ts'

export const usermessage: mawa.UserMessageHook = (context) => {
    if (context.message.content === 'blocked') {
        return Promise.resolve(true as const)
    }
    return Promise.resolve()
}
