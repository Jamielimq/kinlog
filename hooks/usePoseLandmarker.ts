import { useEffect, useRef, useState } from 'react'
import { NativeModules } from 'react-native'

const { PoseLandmarker } = NativeModules

if (!PoseLandmarker) console.warn("PoseLandmarker native module not found")

export interface PoseLandmarks {
  leftHip: { x: number; y: number; z: number; visibility: number }
  rightHip: { x: number; y: number; z: number; visibility: number }
  leftKnee: { x: number; y: number; z: number; visibility: number }
  rightKnee: { x: number; y: number; z: number; visibility: number }
  leftAnkle: { x: number; y: number; z: number; visibility: number }
  rightAnkle: { x: number; y: number; z: number; visibility: number }
}

// Calculate angle between 3 points
export function calcAngle(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number }
): number {
  const radians = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x)
  let angle = Math.abs((radians * 180.0) / Math.PI)
  if (angle > 180) angle = 360 - angle
  return Math.round(angle)
}

export function usePoseLandmarker() {
  const [initialized, setInitialized] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    PoseLandmarker?.initialize()
      .then(() => setInitialized(true))
      .catch((e: any) => setError(e.message))

    return () => {
      PoseLandmarker?.release().catch(() => {})
    }
  }, [])

  const detect = async (base64Image: string): Promise<PoseLandmarks | null> => {
    if (!initialized) return null
    try {
      return await PoseLandmarker?.detectPose(base64Image)
    } catch {
      return null
    }
  }

  return { initialized, error, detect }
}
