import { handlePinataUpload } from '../../server/pinataProxy'

export const config = {
  runtime: 'edge'
}

export default async function handler(request: Request): Promise<Response> {
  return handlePinataUpload(request)
}
