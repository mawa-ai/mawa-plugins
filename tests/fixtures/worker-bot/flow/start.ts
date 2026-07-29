import { mawa } from '../../../../deps.ts'

export default async function (context: mawa.Context): Promise<mawa.StateResult> {
    await context.send(`${context.config.greeting}, who are you?`)
    return { input: true, next: 'start.name' }
}

export const name = async (context: mawa.Context): Promise<mawa.StateResult> => {
    await context.mergeUser({ name: String(context.message.content) })
    return { input: false, next: 'farewell' }
}
