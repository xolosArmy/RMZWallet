import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { captureTonalliIntentFromLocation } from '../services/tonalliIntent'

export default function TonalliIntentCapture() {
  const { search } = useLocation()

  useEffect(() => {
    captureTonalliIntentFromLocation(search)
  }, [search])

  return null
}
