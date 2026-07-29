import { createFetchListener } from '../../../hosting/cloudflare/mod.ts'

export default {
    fetch: createFetchListener(),
}
