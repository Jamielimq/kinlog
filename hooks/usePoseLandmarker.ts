import { useEffect, useRef, useState } from 'react'
import { NativeModules } from 'react-native'

const { PoseLandmarker } = NativeModules

if (!PoseLandmarker) console.warn("PoseLandmarker native module not found")

export interface PoseLandmarks {
  leftShoulder: { x: number; y: number; z: number; visibility: number }
  rightShoulder: { x: number; y: number; z: number; visibility: number }
  leftHip: { x: number; y: number; z: number; visibility: number }
  rightHip: { x: number; y: number; z: number; visibility: number }
  leftKnee: { x: number; y: number; z: number; visibility: number }
  rightKnee: { x: number; y: number; z: number; visibility: number }
  leftAnkle: { x: number; y: number; z: number; visibility: number }
  rightAnkle: { x: number; y: number; z: number; visibility: number }
  // --- POSE DEBUG (calibration only - removed with the debug block) ---
  decodeMs?: number
  inferMs?: number
  imgW?: number
  imgH?: number
  sample?: number
  // --- END POSE DEBUG ---
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

export function usePoseLandmarker(videoMode: boolean = false) {
  const [initialized, setInitialized] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // videoMode: MediaPipe keeps tracking state between frames and only re-runs the
    // heavy person detector when tracking is lost.
    PoseLandmarker?.initialize(videoMode)
      .then(() => setInitialized(true))
      .catch((e: any) => setError(e.message))

    return () => {
      PoseLandmarker?.release().catch(() => {})
    }
  }, [videoMode])

  const detect = async (imagePath: string): Promise<PoseLandmarks | null> => {
    if (!initialized) return null
    try {
      return await PoseLandmarker?.detectPose(imagePath)
    } catch {
      return null
    }
  }

  // --- POSE DEBUG (calibration only - removed with the debug block) ---
  const getDebugDir = async (): Promise<string | null> => {
    try {
      return await PoseLandmarker?.getDebugDir()
    } catch {
      return null
    }
  }

  const saveDebugFrame = async (srcPath: string, destName: string): Promise<string | null> => {
    try {
      return await PoseLandmarker?.saveDebugFrame(srcPath, destName)
    } catch {
      return null
    }
  }
  // --- END POSE DEBUG ---

  return { initialized, error, detect, getDebugDir, saveDebugFrame }
}
