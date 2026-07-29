/**
 * Integration tests for {@link MongoDbStorage}.
 *
 * These need a real MongoDB, so they are skipped unless `MONGODB_TEST_URL` is set.
 * The `metadata` merge in particular cannot be verified without a server, since it relies
 * on the server evaluating an aggregation pipeline update.
 *
 * ```sh
 * docker run --rm -d -p 27017:27017 --name mawa-mongo mongo:8
 * MONGODB_TEST_URL=mongodb://localhost:27017 deno task test
 * docker rm -f mawa-mongo
 * ```
 */

import { assertEquals, assertNotEquals } from '@std/assert'
import type { Db } from 'mongodb'
import { MongoDbStorage } from '../storage/mongodb/mod.ts'

const url = Deno.env.get('MONGODB_TEST_URL')
const ignore = !url

/**
 * Reaches past the public API to the underlying database.
 *
 * Deliberate: several of these tests assert on the documents that actually landed in
 * Mongo, not merely on what the storage returned.
 */
const rawDb = (storage: MongoDbStorage): Promise<Db> => (storage as unknown as { connect: () => Promise<Db> }).connect()

const findUser = async (storage: MongoDbStorage, id: string) =>
    await (await rawDb(storage)).collection('users').findOne({ id })

/**
 * Declares a test that gets its own database, dropped afterwards so tests cannot interfere.
 *
 * Skipped entirely unless `MONGODB_TEST_URL` is set.
 */
const mongoTest = (name: string, run: (storage: MongoDbStorage) => Promise<void>) =>
    Deno.test({
        name,
        ignore,
        fn: async () => {
            const database = `mawa_test_${name.replace(/[^a-z0-9]+/gi, '_')}`
            const storage = new MongoDbStorage(url!, database)

            try {
                await run(storage)
            } finally {
                await rawDb(storage).then((db) => db.dropDatabase()).catch(() => {})
                await storage.close()
            }
        },
    })

mongoTest('creates a user on first merge', async (storage) => {
    const user = await storage.mergeUser('whatsapp:1', { name: 'Gabriel' })

    assertEquals(user.id, 'whatsapp:1')
    assertEquals(user.name, 'Gabriel')
    assertEquals(await storage.getUser('whatsapp:1').then((u) => u?.name), 'Gabriel')
})

mongoTest('merges metadata across calls instead of replacing it', async (storage) => {
    await storage.mergeUser('whatsapp:1', { name: 'Gabriel', metadata: { plan: 'pro' } })
    const user = await storage.mergeUser('whatsapp:1', { metadata: { region: 'br' } })

    // This is the behaviour the previous $set-based implementation could not deliver.
    assertEquals(user.metadata, { plan: 'pro', region: 'br' })
    assertEquals(user.name, 'Gabriel')
})

mongoTest('overwrites metadata keys that are set again', async (storage) => {
    await storage.mergeUser('whatsapp:1', { metadata: { plan: 'free' } })
    const user = await storage.mergeUser('whatsapp:1', { metadata: { plan: 'pro' } })

    assertEquals(user.metadata, { plan: 'pro' })
})

mongoTest('never stores a field literally named $mergeObjects', async (storage) => {
    await storage.mergeUser('whatsapp:1', { metadata: { plan: 'pro' } })

    const raw = await findUser(storage, 'whatsapp:1')

    assertEquals(Object.keys(raw!.metadata), ['plan'])
})

mongoTest('keeps createdAt from the first write and moves updatedAt', async (storage) => {
    await storage.mergeUser('whatsapp:1', { name: 'Gabriel' })

    const first = await findUser(storage, 'whatsapp:1')
    await new Promise((resolve) => setTimeout(resolve, 10))
    await storage.mergeUser('whatsapp:1', { name: 'Gabriel Silva' })
    const second = await findUser(storage, 'whatsapp:1')

    assertEquals(first!.createdAt.getTime(), second!.createdAt.getTime())
    assertNotEquals(first!.updatedAt.getTime(), second!.updatedAt.getTime())
})

mongoTest('returns undefined for an unknown user', async (storage) => {
    assertEquals(await storage.getUser('whatsapp:missing'), undefined)
})

mongoTest('round-trips kv values of several shapes', async (storage) => {
    await storage.setKv('whatsapp:1', 'string', 'value')
    await storage.setKv('whatsapp:1', 'number', 42)
    await storage.setKv('whatsapp:1', 'object', { nested: { ok: true } })
    await storage.setKv('whatsapp:1', 'array', [1, 2, 3])

    assertEquals(await storage.getKv('whatsapp:1', 'string'), 'value')
    assertEquals(await storage.getKv('whatsapp:1', 'number'), 42)
    assertEquals(await storage.getKv('whatsapp:1', 'object'), { nested: { ok: true } })
    assertEquals(await storage.getKv('whatsapp:1', 'array'), [1, 2, 3])
})

mongoTest('treats an undefined kv value as absent', async (storage) => {
    await storage.setKv('whatsapp:1', 'k', 'value')
    await storage.setKv('whatsapp:1', 'k', undefined)

    // The SDK relies on this: clearing '#state' must read back as undefined.
    assertEquals(await storage.getKv('whatsapp:1', 'k'), undefined)
})

mongoTest('scopes kv values per user', async (storage) => {
    await storage.setKv('whatsapp:1', 'k', 'one')
    await storage.setKv('whatsapp:2', 'k', 'two')

    assertEquals(await storage.getKv('whatsapp:1', 'k'), 'one')
    assertEquals(await storage.getKv('whatsapp:2', 'k'), 'two')
})

mongoTest('records tracked events', async (storage) => {
    await storage.track('whatsapp:1', 'purchase', { amount: 10 })

    const db = await rawDb(storage)
    const event = await db.collection('events').findOne({ userId: 'whatsapp:1' })

    assertEquals(event!.event, 'purchase')
    assertEquals(event!.properties, { amount: 10 })
})

mongoTest('shares one connection across concurrent first calls', async (storage) => {
    await Promise.all([
        storage.setKv('whatsapp:1', 'a', 1),
        storage.setKv('whatsapp:1', 'b', 2),
        storage.mergeUser('whatsapp:1', { name: 'Gabriel' }),
    ])

    assertEquals(await storage.getKv('whatsapp:1', 'a'), 1)
    assertEquals(await storage.getKv('whatsapp:1', 'b'), 2)
})

Deno.test('closing a storage that never connected is safe', async () => {
    await new MongoDbStorage('mongodb://localhost:27017').close()
})
