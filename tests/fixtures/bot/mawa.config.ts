import { mawa } from '../../../deps.ts'
import { channel } from './recorder.ts'

const config: mawa.Configuration = {
    logLevel: 'CRITICAL',
    channels: [channel],
    storage: new mawa.MemoryStorage(),
}

export default config
