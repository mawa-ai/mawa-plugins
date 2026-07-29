import { mawa } from '../../../../deps.ts'

/**
 * Counts the messages it has seen, reading and writing the same key.
 *
 * The read and the write are deliberately far apart: two messages handled at the same time
 * would both read the same value and the second write would overwrite the first, which is
 * exactly what per-user serialization prevents.
 */
export default async function (context: mawa.Context): Promise<mawa.StateResult> {
    const count = await context.getKv<number>('count') ?? 0

    await context.send(`count: ${count + 1}`)
    await context.setKv('count', count + 1)

    return { input: true }
}
