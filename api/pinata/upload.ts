import { proxyPinataUpload } from '../../server/pinataProxy'

export default async function handler(request: Request): Promise<Response> {
  return proxyPinataUpload(request)
}
