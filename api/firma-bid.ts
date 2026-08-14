import { proxyFirmaBid } from '../server/firmaBidProxy'

export const config = {
  runtime: 'edge'
}

export default async function handler(request: Request): Promise<Response> {
  return proxyFirmaBid(request)
}
