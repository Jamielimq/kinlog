import { getApp } from '@react-native-firebase/app'
import { addDoc, collection, doc, getDoc, getFirestore, increment, setDoc } from '@react-native-firebase/firestore'
import { useIsFocused } from '@react-navigation/native'
import { Directory, File, Paths } from 'expo-file-system'
import { useKeepAwake } from 'expo-keep-awake'
import { useEffect, useRef, useState } from 'react'
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Camera, useCameraDevice, useCameraPermission, useFrameProcessor } from 'react-native-vision-camera'
import { useWallet } from '../../context/WalletContext'
import { updateChallengeProgress } from '../../hooks/challengeProgress'
import { ALL_BADGES } from '../../hooks/useBadges'
import { calcAngle, usePoseLandmarker, type PoseLandmarks } from '../../hooks/usePoseLandmarker'

const C = {
  bg: '#FAFAF9', bg2: '#F5F4F1', bg3: '#EDECEA',
  dark: '#2D2926', amber: '#D97706', amber2: '#F59E0B',
  text: '#1C1917', muted: '#A8A29E', line: '#E7E5E4',
  green: '#10B981', red: '#EF4444',
}

const POINTS_PER_REP = 5
const TARGET = 30

// Squat judgement (clinical PT calibration — see CLAUDE.md "Product Decisions").
const KNEE_DOWN = 110        // seated: raw knee angle <= 110
const KNEE_UP = 150          // standing: raw knee angle >= 150
// No smoothing, no multi-frame confirmation: one qualifying frame flips the phase.
// Every filter tried made things worse at this cadence. An EMA at 0.4 attenuated a
// real 66..178 deg swing to 89..155, so the 150 deg standing threshold was barely
// reachable. A median-3 preserved amplitude but discarded single-frame peaks, merging
// two reps into one whenever the top of a rep was held for only one frame. Both traded
// missed reps for noise rejection the confidence gate already provides.
// The confidence gate (below) is now the ONLY defence against a phantom rep, which is
// why it must not be loosened without re-testing the standing-still case.
const MIN_VISIBILITY = 0.5   // per-joint confidence floor; below this the frame is excluded
const TRACKING_WARN_MS = 1000 // only warn after tracking has been lost this long

// Hip-descent gate. A knee raise bends the knee past 110 deg without the hip moving,
// which is how standing still produced 8 phantom reps on device. Measured there:
// a real squat drops the hip by ~0.19 in normalized y, a knee raise by ~0.00.
const HIP_DROP_RATIO = 0.20  // required hip descent, as a fraction of torso length
const STAND_WINDOW_MS = 5000 // how far back a standing frame stays eligible as the baseline
// A standing sample whose torso measures shorter than this is a landmark error, not a
// short person: across four clean sets the baseline torso never fell below 0.210, while
// the bad frames measured 0.030-0.141. Such a sample is barred from becoming the
// baseline — if it did, the too-small denominator would inflate every hip-drop ratio.
const TORSO_MIN = 0.15
// Anatomical ordering check. y grows downward, so a shoulder below the hip, or a hip or
// knee below the ankle, means the landmarks are scrambled. Measured slack at the bottom
// of a real squat: the tightest was knee 0.068 above ankle, while the scrambled frames
// sat 0.045-0.209 the wrong way. 0.03 separates them with room on both sides.
const ORDER_TOLERANCE = 0.03

// Snapshots go in a directory of our own so the sweep can never touch other cache files.
const SNAPSHOT_DIR = 'kinlog-snapshots'
// Before a session, how often to check whether a body is in frame (the Live / Not detected badge
// and auto start). Slower than the session loop: nothing is counted here.
const PREVIEW_INTERVAL_MS = 400
// Auto start: how long a standing posture (knee at KNEE_UP or above) must hold in frame before a
// session starts on its own. 0 starts on the first standing frame.
const AUTO_START_HOLD_MS = 0

function getTodayStart() {
  const d = new Date(); d.setHours(0,0,0,0); return d.getTime()
}
function getWeekStart() {
  const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime()
}
function getMonthStart() {
  const d = new Date(); d.setHours(0,0,0,0); d.setDate(1); return d.getTime()
}
function getDaysInMonth() {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
}

async function checkAndAwardBadges(address: string, totalSquats: number, currentStreak: number) {
  const db = getFirestore(getApp())
  const now = Date.now()
  for (const badge of ALL_BADGES) {
    if (badge.category === 'squats') {
      const threshold = parseInt(badge.id.split('_')[1])
      if (totalSquats >= threshold) {
        await setDoc(doc(db, 'users', address, 'badges', badge.id), { earned: true, earnedAt: now }, { merge: true })
      }
    }
    if (badge.category === 'streak') {
      const threshold = parseInt(badge.id.split('_')[1])
      if (currentStreak >= threshold) {
        await setDoc(doc(db, 'users', address, 'badges', badge.id), { earned: true, earnedAt: now }, { merge: true })
      }
    }
    if (badge.id === 'first_rep' && totalSquats >= 1) {
      await setDoc(doc(db, 'users', address, 'badges', badge.id), { earned: true, earnedAt: now }, { merge: true })
    }
    // perfect_month: check if monthly goal current == total
    // (handled separately when month ends)
  }
}

async function saveWorkout(address: string, reps: number, elapsed: number) {
  const db = getFirestore(getApp())
  const now = Date.now()
  const todayStart = getTodayStart()
  const weekStart = getWeekStart()
  const monthStart = getMonthStart()
  const daysInMonth = getDaysInMonth()

  const userRef = doc(db, 'users', address)
  const userSnap = await getDoc(userRef)
  const userData = userSnap.data() ?? {}

  const lastWorkoutDate = userData.lastWorkoutDate ?? 0
  const alreadyWorkedOutToday = lastWorkoutDate >= todayStart
  const dailyReps = alreadyWorkedOutToday ? (userData.dailyReps ?? 0) : 0
  const remainingToday = Math.max(TARGET - dailyReps, 0)
  const effectiveReps = Math.min(reps, remainingToday)

  const yesterday = todayStart - 86400000
  let newStreak = userData.currentStreak ?? 0
  if (alreadyWorkedOutToday) {
    // Keep current streak
  } else if (lastWorkoutDate >= yesterday) {
    newStreak += 1
  } else {
    newStreak = 1
  }

  const newBestStreak = Math.max(userData.bestStreak ?? 0, newStreak)
  const newTotalSquats = (userData.totalSquats ?? 0) + effectiveReps
  const newDailyReps = dailyReps + effectiveReps
  const newTotalWorkouts = (userData.totalWorkouts ?? 0) + (alreadyWorkedOutToday ? 0 : 1)
  const pts = effectiveReps * POINTS_PER_REP

  // The workout is the source of truth and the only record Locked In counts, so it is written
  // first: if the rules refuse it, nothing else changes. `uid` marks it as written with this
  // wallet's own sign-in; `rawReps` is the count shown on screen, before the daily points cap
  // that produced effectiveReps. elapsed is whole seconds (the rules require >= rawReps).
  await addDoc(collection(db, 'users', address, 'workouts'), {
    exercise: 'squat', reps: effectiveReps, rawReps: reps, elapsed, createdAt: now, uid: address,
  })

  await setDoc(userRef, {
    totalSquats: newTotalSquats,
    totalWorkouts: newTotalWorkouts,
    currentStreak: newStreak,
    bestStreak: newBestStreak,
    lastWorkoutDate: todayStart,
    dailyReps: newDailyReps,
    points: increment(pts),
    updatedAt: now,
  }, { merge: true })

  if (effectiveReps > 0) {
    await addDoc(collection(db, 'users', address, 'points_history'), {
      reason: `Completed ${effectiveReps} squats`,
      amount: pts,
      createdAt: now,
    })
  }

  if (!alreadyWorkedOutToday) {
    const weeklySnap = await getDoc(doc(db, 'users', address, 'goals', 'weekly'))
    const weeklyData = weeklySnap.data() ?? {}
    const weeklySessions = (weeklyData.lastResetDate ?? 0) >= weekStart ? (weeklyData.current ?? 0) : 0
    await setDoc(doc(db, 'users', address, 'goals', 'weekly'), {
      current: Math.min(weeklySessions + 1, 7), total: 7, lastResetDate: weekStart,
    }, { merge: true })

    const monthlySnap = await getDoc(doc(db, 'users', address, 'goals', 'monthly'))
    const monthlyData = monthlySnap.data() ?? {}
    const monthlyCount = (monthlyData.lastResetDate ?? 0) >= monthStart ? (monthlyData.current ?? 0) : 0
    await setDoc(doc(db, 'users', address, 'goals', 'monthly'), {
      current: monthlyCount + 1, total: daysInMonth, lastResetDate: monthStart,
    }, { merge: true })
  }

  // Dated with today, so opening the app later today doesn't take this for an earlier day's count
  // and reset it (hooks/useGoals.ts resets a document dated before today).
  await setDoc(doc(db, 'users', address, 'goals', 'daily'), {
    current: Math.min(newDailyReps, TARGET), total: TARGET, lastResetDate: todayStart,
  }, { merge: true })

  await checkAndAwardBadges(address, newTotalSquats, newStreak)

  // Challenge progress is best-effort — its failure must not fail the workout save.
  try {
    await updateChallengeProgress(address, newDailyReps, now)
  } catch (e) {
    console.error('Challenge progress error:', e)
  }

  return { effectiveReps }
}

type Joint = { x: number; y: number; visibility: number }
type SideMeasurement = {
  angle: number; leg: 'L' | 'R'; minVis: number
  hip: Joint; knee: Joint; ankle: Joint
  shoulder: Joint | null   // null when that shoulder is not confidently visible
}

// Side view only. Measures the leg the camera can see better, and reports the weakest
// of its three joint confidences so the caller can decide whether to trust the frame.
function measureSide(landmarks: PoseLandmarks): SideMeasurement {
  const leftVis = (landmarks.leftHip?.visibility ?? 0) +
                  (landmarks.leftKnee?.visibility ?? 0) +
                  (landmarks.leftAnkle?.visibility ?? 0)
  const rightVis = (landmarks.rightHip?.visibility ?? 0) +
                   (landmarks.rightKnee?.visibility ?? 0) +
                   (landmarks.rightAnkle?.visibility ?? 0)

  const useLeft = leftVis >= rightVis
  const hip = useLeft ? landmarks.leftHip : landmarks.rightHip
  const knee = useLeft ? landmarks.leftKnee : landmarks.rightKnee
  const ankle = useLeft ? landmarks.leftAnkle : landmarks.rightAnkle
  // Same side as the measured leg, so torso length matches the limb being judged.
  const rawShoulder = useLeft ? landmarks.leftShoulder : landmarks.rightShoulder
  const shoulder = (rawShoulder?.visibility ?? 0) >= MIN_VISIBILITY ? rawShoulder : null

  return {
    angle: calcAngle(hip, knee, ankle),
    leg: useLeft ? 'L' : 'R',
    minVis: Math.min(hip?.visibility ?? 0, knee?.visibility ?? 0, ankle?.visibility ?? 0),
    hip, knee, ankle, shoulder,
  }
}

// Rejects frames whose joints are ordered impossibly. This runs alongside the
// confidence gate, and matters most right after Start: there is no baseline yet, so
// the hip condition is still off and a scrambled frame would otherwise be judged on
// knee angle alone. Hip-below-knee is NOT checked — that is a legitimate deep squat.
function jointsPlausible(m: SideMeasurement): boolean {
  if (m.hip.y > m.ankle.y + ORDER_TOLERANCE) return false
  if (m.knee.y > m.ankle.y + ORDER_TOLERANCE) return false
  if (m.shoulder && m.shoulder.y > m.hip.y + ORDER_TOLERANCE) return false
  return true
}

// MediaPipe RunningMode.VIDEO: tracking carries over between frames, so the person detector
// re-runs only when tracking is lost (IMAGE runs it on every frame).
const POSE_VIDEO_MODE = true

// Why a frame is excluded from judgement.
type RejectReason = 'nopose' | 'lowvis' | 'order'

export default function WorkoutScreen() {
  // Keep screen awake during workout
  useKeepAwake()

  const { hasPermission, requestPermission } = useCameraPermission()
  const device = useCameraDevice('front')
  const [isActive, setIsActive] = useState(false)
  const [trackingLost, setTrackingLost] = useState(false)
  // For the Live / Not detected badge only, never for judgement: whether the session's frames show a
  // body, set at the same moments as trackingLost. null until the session's first verdict, when the
  // badge keeps what it showed before Start (so an empty frame reads Not detected from the start).
  const [sessionDetected, setSessionDetected] = useState<boolean | null>(null)
  const [reps, setReps] = useState(0)
  const [phase, setPhase] = useState<'up' | 'down'>('up')
  const [angle, setAngle] = useState(180)
  const [elapsed, setElapsed] = useState(0)
  const [saving, setSaving] = useState(false)
  const [workoutResult, setWorkoutResult] = useState<{
    type: 'success' | 'already' | 'refused' | 'error'; reps?: number; pts?: number; elapsed?: number
  } | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const repsRef = useRef(0)
  const elapsedRef = useRef(0)
  // Wall-clock start of the session. The 1 s interval only refreshes the display: it runs late
  // while the detection loop keeps JS busy, and a saved elapsed below the rep count is refused.
  const startedAtRef = useRef(0)
  const phaseRef = useRef<'up' | 'down'>('up')
  const isActiveRef = useRef(false)

  // Judgement state that must not be lost to a re-render between frames.
  const lostSinceRef = useRef<number | null>(null)
  // Standing samples inside STAND_WINDOW_MS. The baseline is the HIGHEST hip among
  // them (smallest y), so a slouched moment while getting set cannot become the
  // reference. Torso length is taken from that same frame — the most upright one.
  const standSamplesRef = useRef<{ t: number; hipY: number; torso: number | null }[]>([])
  const baselineRef = useRef<{ hipY: number; torso: number | null } | null>(null)

  const { publicKey, dataAddress, session, signIn, signInError, awaitingSignIn } = useWallet()
  // Workouts are saved only with the wallet's own sign-in, so a connected wallet without one signs
  // in before it can start (a session with no wallet at all is still allowed, unsaved).
  const address = dataAddress
  const needsSignIn = publicKey !== null && address === null
  const { initialized: poseReady, detect } = usePoseLandmarker(POSE_VIDEO_MODE)

  useEffect(() => {
    isActiveRef.current = isActive
  }, [isActive])

  const stopSession = async () => {
    isActiveRef.current = false
    setIsActive(false)
    setTrackingLost(false)
    clearInterval(timerRef.current!)
    const completedReps = repsRef.current
    const completedElapsed = Math.round((Date.now() - startedAtRef.current) / 1000)
    if (completedReps > 0 && address) {
      setSaving(true)
      try {
        const result = await saveWorkout(address, completedReps, completedElapsed)
        if (result.effectiveReps > 0) {
          setWorkoutResult({ type: 'success', reps: result.effectiveReps, pts: result.effectiveReps * POINTS_PER_REP })
        } else {
          setWorkoutResult({ type: 'already' })
        }
      } catch (e: any) {
        console.error('Save error:', e)
        // The rules refused the workout (for example faster than 1 rep per second): say so with
        // the numbers, so the reps don't just disappear behind a generic error.
        const refused = e?.code === 'firestore/permission-denied'
        setWorkoutResult({ type: refused ? 'refused' : 'error', reps: completedReps, elapsed: completedElapsed })
      } finally {
        setSaving(false)
      }
    }
  }

  const frameProcessor = useFrameProcessor((frame) => {
    'worklet'
  }, [])

  const detectingRef = useRef(false)
  const cameraRef = useRef<Camera>(null)

  // Snapshot scratch directory. vision-camera drops a JPEG per frame and never cleans up,
  // so we own a directory: every frame deletes its own file, and entering the screen sweeps
  // anything a crashed or force-closed session left behind. Nothing outside it is touched.
  const snapshotDirRef = useRef<string | null>(null)

  useEffect(() => {
    try {
      const dir = new Directory(Paths.cache, SNAPSHOT_DIR)
      if (!dir.exists) dir.create({ intermediates: true, idempotent: true })
      for (const entry of dir.list()) {
        if (entry instanceof File) {
          try { entry.delete() } catch {}
        }
      }
      // takeSnapshot wants a plain directory path, not a file:// URI.
      snapshotDirRef.current = dir.uri.replace(/^file:\/\//, '')
    } catch {
      // Fall back to the camera's default cache dir; per-frame deletion still runs.
      snapshotDirRef.current = null
    }
    // Mount-only: the snapshot dir is resolved once per screen.
  }, [])

  // Pose detection loop using camera snapshots
  useEffect(() => {
    if (!isActive || !poseReady) return

    const interval = setInterval(async () => {
      if (detectingRef.current || !cameraRef.current) return
      detectingRef.current = true

      const now = Date.now()

      let snapshotPath: string | null = null
      try {
        const dir = snapshotDirRef.current
        const photo = await cameraRef.current.takeSnapshot(
          dir ? { quality: 30, path: dir } : { quality: 30 }
        )
        if (!photo?.path) return
        snapshotPath = photo.path

        const landmarks = await detect('file://' + photo.path)
        const measured = landmarks ? measureSide(landmarks) : null

        // Frame excluded: no pose at all, or the measured leg's weakest joint is
        // below the confidence floor. Drop it rather than let it move the state machine.
        const reject: RejectReason | null =
          !measured ? 'nopose'
          : measured.minVis < MIN_VISIBILITY ? 'lowvis'
          : !jointsPlausible(measured) ? 'order'
          : null

        if (reject) {
          // Phase is deliberately preserved — tracking can drop mid-squat. There is no
          // filter buffer or streak left to invalidate, so a gap simply skips a frame.
          if (lostSinceRef.current === null) lostSinceRef.current = now
          if (now - lostSinceRef.current >= TRACKING_WARN_MS) {
            setTrackingLost(true)
            setSessionDetected(false)
          }
          // setAngle is not called, so the readout holds its last measured value.
          return
        }

        lostSinceRef.current = null
        setTrackingLost(false)
        setSessionDetected(true)

        const val = measured!.angle
        setAngle(val)

        // Refresh the standing reference. Only frames where the knee is straight count,
        // so nothing updates during a descent — the baseline freezes on its own.
        if (val >= KNEE_UP) {
          const torso = measured!.shoulder
            ? Math.abs(measured!.shoulder!.y - measured!.hip.y)
            : null
          const samples = standSamplesRef.current
          // Only a sample with a believable torso may become the baseline. Skipping the
          // hip condition instead would let a scrambled frame through on knee angle alone.
          if (torso !== null && torso >= TORSO_MIN) {
            samples.push({ t: now, hipY: measured!.hip.y, torso })
          }
          while (samples.length && now - samples[0].t > STAND_WINDOW_MS) samples.shift()
          if (samples.length) {
            let best = samples[0]
            for (const smp of samples) if (smp.hipY < best.hipY) best = smp
            // Keep the last known baseline if the window ever empties mid-squat.
            baselineRef.current = { hipY: best.hipY, torso: best.torso }
          }
        }

        // Hip descent as a fraction of torso length. null when it cannot be measured
        // (no standing frame seen yet, or the shoulder was never confidently visible).
        const base = baselineRef.current
        const hipDropRatio =
          base && base.torso && base.torso > 0
            ? (measured!.hip.y - base.hipY) / base.torso
            : null

        if (phaseRef.current === 'up') {
          // Knee angle alone cannot tell a squat from a knee raise. When torso length
          // is unavailable the hip term is skipped rather than blocking the rep —
          // missing a real rep is the worse error (see CLAUDE.md judgement principle).
          const hipOk = hipDropRatio === null || hipDropRatio >= HIP_DROP_RATIO
          if (val <= KNEE_DOWN && hipOk) {
            phaseRef.current = 'down'; setPhase('down')
          }
        } else {
          if (val >= KNEE_UP) {
            phaseRef.current = 'up'; setPhase('up')
            repsRef.current += 1; setReps(repsRef.current)
            if (repsRef.current >= TARGET) stopSession()
          }
        }
      } catch (e) {
        // Ignore snapshot errors
      } finally {
        if (snapshotPath) {
          try { new File('file://' + snapshotPath).delete() } catch {}
        }
        detectingRef.current = false
      }
    }, 100)

    return () => clearInterval(interval)
  }, [isActive, poseReady])

  // Before a session: is a body in frame? Feeds the Live / Not detected badge and auto start. It
  // uses the session's acceptance test (a pose, every measured joint at MIN_VISIBILITY or above,
  // joints in a plausible order) and its 1 s grace before calling tracking lost, but touches none
  // of the counting or judgement state, and shares detectingRef so it never overlaps a session frame.
  const isFocused = useIsFocused()
  const [previewDetected, setPreviewDetected] = useState(false)
  // Auto start runs whenever Start itself would start a session now: no sign-in pending, and no
  // save under way or result window open. So a finished session doesn't restart while its result is
  // showing, and does as soon as the window is closed (straight away when there is none, as at 0
  // reps). Start always works by hand.
  const canAutoStart = !needsSignIn && !saving && !workoutResult
  const canAutoStartRef = useRef(canAutoStart)
  useEffect(() => {
    canAutoStartRef.current = canAutoStart
  }, [canAutoStart])
  // Kept current after every render (below), so auto start always calls this render's startSession.
  const startSessionRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (isActive || !poseReady || !isFocused) return
    let lostSince: number | null = null
    let standingSince: number | null = null
    let started = false

    const interval = setInterval(async () => {
      if (started || detectingRef.current || isActiveRef.current || !cameraRef.current) return
      detectingRef.current = true
      let snapshotPath: string | null = null
      try {
        const dir = snapshotDirRef.current
        const photo = await cameraRef.current.takeSnapshot(dir ? { quality: 30, path: dir } : { quality: 30 })
        if (!photo?.path) return
        snapshotPath = photo.path
        const landmarks = await detect('file://' + photo.path)
        const measured = landmarks ? measureSide(landmarks) : null
        const now = Date.now()
        if (measured && measured.minVis >= MIN_VISIBILITY && jointsPlausible(measured)) {
          lostSince = null
          setPreviewDetected(true)
          if (measured.angle >= KNEE_UP) {
            if (standingSince === null) standingSince = now
            if (canAutoStartRef.current && now - standingSince >= AUTO_START_HOLD_MS) {
              started = true
              // The latest startSession, not the one from when this loop began.
              startSessionRef.current()
            }
          } else {
            standingSince = null
          }
        } else {
          standingSince = null
          if (lostSince === null) lostSince = now
          if (now - lostSince >= TRACKING_WARN_MS) setPreviewDetected(false)
        }
      } catch {
        // A failed snapshot only skips this check.
      } finally {
        if (snapshotPath) {
          try { new File('file://' + snapshotPath).delete() } catch {}
        }
        detectingRef.current = false
      }
    }, PREVIEW_INTERVAL_MS)

    return () => clearInterval(interval)
    // detect only changes when the landmarker's initialization changes, which poseReady tracks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, poseReady, isFocused])

  const resetJudgement = () => {
    lostSinceRef.current = null
    standSamplesRef.current = []
    baselineRef.current = null
    setTrackingLost(false)
  }

  const startSession = () => {
    repsRef.current = 0; elapsedRef.current = 0; phaseRef.current = 'up'
    resetJudgement()
    setIsActive(true); setReps(0); setElapsed(0); setPhase('up'); setAngle(180)
    setSessionDetected(null)
    startedAtRef.current = Date.now()
    timerRef.current = setInterval(() => {
      elapsedRef.current = Math.floor((Date.now() - startedAtRef.current) / 1000)
      setElapsed(elapsedRef.current)
    }, 1000)
  }

  // Nothing is saved: the count is dropped, and a standing user starts a fresh session.
  const resetSession = () => {
    isActiveRef.current = false
    setIsActive(false)
    clearInterval(timerRef.current!)
    repsRef.current = 0; elapsedRef.current = 0; phaseRef.current = 'up'
    resetJudgement()
    setReps(0); setElapsed(0); setAngle(180); setPhase('up')
  }

  useEffect(() => {
    startSessionRef.current = startSession
  })

  const formatTime = (sec: number) =>
    `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`

  if (!hasPermission) {
    return (
      <SafeAreaView style={s.permSafe}>
        <Text style={s.permTitle}>Camera Required</Text>
        <Text style={s.permDesc}>Camera access is needed to analyze your workout movements.</Text>
        <TouchableOpacity style={s.permBtn} onPress={requestPermission}>
          <Text style={s.permBtnText}>Allow Camera</Text>
        </TouchableOpacity>
      </SafeAreaView>
    )
  }

  if (!device) {
    return (
      <SafeAreaView style={s.permSafe}>
        <Text style={s.permTitle}>No Camera Found</Text>
      </SafeAreaView>
    )
  }

  const progress = reps / TARGET
  // During a session the badge follows the session's frames (lost after 1 s of excluded frames, the
  // same moment the Step back hint appears); until the first verdict it keeps the pre-start value.
  const detected = isActive ? (sessionDetected ?? previewDetected) : previewDetected
  // Text arrows and a text-style warning sign (U+FE0E), so the icon takes the pill's amber color
  // like the side-view arrow instead of rendering as a color emoji.
  const guide =
    !isActive ? { icon: '↔', text: 'Stand sideways to the camera' }
    : trackingLost ? { icon: '⚠︎', text: 'Step back so your full body is in frame' }
    : phase === 'down' ? { icon: '↑', text: 'Come up slowly' }
    : { icon: '↓', text: 'Go down to 110° or below' }

  return (
    <View style={s.container}>
      <View style={s.cameraContainer}>
        <Camera
          ref={cameraRef}
          style={s.camera}
          device={device}
          isActive={true} androidPreviewViewType="surface-view"
          photo={true}
        />

        {/* One guidance pill: side view before a session (required, not a choice), then what to do
            during one. Kept to one line; a long hint shrinks its text slightly rather than wrap. */}
        <View style={s.modeHint}>
          <View style={s.modeHintBox}>
            <Text style={s.modeHintIcon}>{guide.icon}</Text>
            <Text style={s.modeHintText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
              {guide.text}
            </Text>
          </View>
        </View>

        {/* Bottom row: whether a body is in frame on the left, the knee angle on the right, bottom
            edges aligned */}
        <View style={s.bottomRow}>
          <View style={s.detectBadge}>
            <View style={[s.detectDot, { backgroundColor: detected ? C.green : C.red }]}/>
            <Text style={s.detectText}>{detected ? 'Live' : 'Not detected'}</Text>
          </View>
          <View style={s.angleBadge}>
            <Text style={s.angleLabel}>KNEE ANGLE</Text>
            <Text style={s.angleValue}>{angle}°</Text>
            <Text style={s.angleTarget}>TARGET ≤ 110°</Text>
          </View>
        </View>
      </View>

      <View style={s.panel}>
        <View style={s.repRow}>
          <View>
            <Text style={s.repCount}>{reps}</Text>
            <Text style={s.repLabel}>REPS</Text>
          </View>
          <View style={s.repStats}>
            <View style={s.repStat}><Text style={s.repStatValue}>{TARGET}</Text><Text style={s.repStatLabel}>GOAL</Text></View>
            <View style={s.repStat}><Text style={s.repStatValue}>{formatTime(elapsed)}</Text><Text style={s.repStatLabel}>TIME</Text></View>
            <View style={s.repStat}><Text style={[s.repStatValue, { color: C.amber2 }]}>+{reps * POINTS_PER_REP}</Text><Text style={s.repStatLabel}>PTS</Text></View>
          </View>
        </View>

        <View style={s.progressTrack}>
          <View style={[s.progressFill, { width: `${Math.min(progress * 100, 100)}%` }]}/>
        </View>

        <View style={s.btnRow}>
          <TouchableOpacity style={s.btnSecondary} onPress={resetSession}>
            <Text style={s.btnSecondaryText}>Reset</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.btnPrimary, isActive && s.btnStop]}
            onPress={isActive ? stopSession : needsSignIn ? signIn : startSession}
            disabled={saving || (!isActive && needsSignIn && !(awaitingSignIn && session === 'needed'))}
          >
            <Text style={[s.btnPrimaryText, isActive && s.btnStopText]}>
              {saving ? 'Saving...'
                : isActive ? 'Finish'
                : !needsSignIn ? '▶  Start'
                : session === 'checking' ? 'Checking...'
                : !awaitingSignIn ? 'Connecting...'
                : session === 'signingIn' ? 'Signing in...'
                : 'Sign in'}
            </Text>
          </TouchableOpacity>
        </View>
        {!isActive && canAutoStart && <Text style={s.autoHint}>Starts when you stand in frame</Text>}

        {!publicKey && <Text style={s.noWalletNote}>⚠ Connect wallet to save workouts</Text>}
        {awaitingSignIn && !isActive && (
          <Text style={s.noWalletNote}>{signInError ?? '⚠ Sign in to save workouts'}</Text>
        )}
        <Text style={s.videoNote}>📵 This video is not recorded or saved</Text>
        {!poseReady && isActive && <Text style={s.noWalletNote}>⏳ Initializing pose detection...</Text>}
      </View>

      {/* Workout Result Modal */}
      <Modal visible={!!workoutResult} transparent animationType="fade">
        <View style={s.modalOverlay}>
          <View style={s.modalBox}>
            <View style={s.modalHandle}/>
            {workoutResult?.type === 'success' && (<>
              <Text style={{ fontSize: 40, marginBottom: 12 }}>🎉</Text>
              <Text style={s.modalTitle}>Workout Saved!</Text>
              <View style={s.modalStatRow}>
                <View style={s.modalStat}>
                  <Text style={s.modalStatVal}>{workoutResult.reps}</Text>
                  <Text style={s.modalStatLbl}>SQUATS</Text>
                </View>
                <View style={s.modalStatDivider}/>
                <View style={s.modalStat}>
                  <Text style={[s.modalStatVal, { color: C.amber2 }]}>+{workoutResult.pts}</Text>
                  <Text style={s.modalStatLbl}>POINTS</Text>
                </View>
              </View>
            </>)}
            {workoutResult?.type === 'already' && (<>
              <Text style={{ fontSize: 40, marginBottom: 12 }}>💪</Text>
              <Text style={s.modalTitle}>Daily Goal Reached!</Text>
              <Text style={s.modalDesc}>You've already completed today's 30 squats. Come back tomorrow!</Text>
            </>)}
            {workoutResult?.type === 'refused' && (<>
              <Text style={{ fontSize: 40, marginBottom: 12 }}>⚠️</Text>
              <Text style={s.modalTitle}>Workout not saved</Text>
              <Text style={s.modalDesc}>
                {(workoutResult.elapsed ?? 0) < (workoutResult.reps ?? 0)
                  ? `${workoutResult.reps} squats were counted in ${workoutResult.elapsed} seconds. Workouts are saved at up to 1 squat per second, so this one was not accepted.`
                  : `The server did not accept this workout (${workoutResult.reps} squats). Please sign in again before your next workout.`}
              </Text>
            </>)}
            {workoutResult?.type === 'error' && (<>
              <Text style={{ fontSize: 40, marginBottom: 12 }}>⚠️</Text>
              <Text style={s.modalTitle}>Something went wrong</Text>
              <Text style={s.modalDesc}>Failed to save workout. Please try again.</Text>
            </>)}
            <TouchableOpacity style={s.modalBtn} onPress={() => setWorkoutResult(null)}>
              <Text style={s.modalBtnText}>{workoutResult?.type === 'success' ? 'Keep it up! 🔥' : 'OK'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  )
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.dark },
  cameraContainer: { flex: 1, position: 'relative' },
  camera: { flex: 1 },

  // The camera's bottom corners: detection badge left, knee angle box right, bottom edges aligned.
  bottomRow:   { position: 'absolute', left: 16, right: 16, bottom: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  detectBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 100 },
  detectDot:   { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  detectText:  { color: '#fff', fontSize: 12, fontWeight: '800' },


  modeHint:      { position: 'absolute', top: 56, left: 16, right: 16, alignItems: 'center' },
  modeHintBox:   { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(0,0,0,0.45)', borderWidth: 1, borderColor: 'rgba(217,119,6,0.5)', borderRadius: 14, paddingVertical: 10, paddingHorizontal: 16 },
  modeHintIcon:  { fontSize: 18, color: C.amber2 },
  // flexShrink lets a long hint fit the screen width (and shrink its text) instead of overflowing.
  modeHintText:  { fontSize: 13, fontWeight: '700', color: 'rgba(255,255,255,0.85)', flexShrink: 1 },

  angleBadge:  { backgroundColor: 'rgba(0,0,0,0.65)', borderWidth: 1, borderColor: 'rgba(217,119,6,0.35)', borderRadius: 14, padding: 12, alignItems: 'center' },
  angleLabel:  { color: 'rgba(255,255,255,0.35)', fontSize: 8, letterSpacing: 1, marginBottom: 2 },
  angleValue:  { color: C.amber2, fontSize: 28, fontWeight: '900', lineHeight: 30 },
  angleTarget: { color: 'rgba(255,255,255,0.25)', fontSize: 8, marginTop: 2 },

  // A small bottom padding: the camera above (flex: 1) takes the rest of the height.
  panel:        { backgroundColor: C.bg, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 22 },
  repRow:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  repCount:     { fontSize: 64, fontWeight: '900', color: C.text, lineHeight: 64 },
  repLabel:     { fontSize: 10, color: C.muted, letterSpacing: 2, marginTop: 2 },
  repStats:     { flexDirection: 'row', gap: 20 },
  repStat:      { alignItems: 'center' },
  repStatValue: { fontSize: 20, fontWeight: '800', color: C.text },
  repStatLabel: { fontSize: 8, color: C.muted, letterSpacing: 1, marginTop: 2 },

  progressTrack: { height: 5, backgroundColor: C.bg3, borderRadius: 100, marginBottom: 16, overflow: 'hidden' },
  progressFill:  { height: 5, backgroundColor: C.amber2, borderRadius: 100 },

  btnRow:          { flexDirection: 'row', gap: 10 },
  btnPrimary:      { flex: 1.4, backgroundColor: C.dark, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  btnStop:         { backgroundColor: '#EF4444' },
  btnPrimaryText:  { color: C.amber2, fontSize: 15, fontWeight: '700' },
  // White on the red Finish button, which amber didn't read well against.
  btnStopText:     { color: '#fff' },
  btnSecondary:    { flex: 1, backgroundColor: C.bg2, borderRadius: 14, paddingVertical: 14, alignItems: 'center', borderWidth: 1.5, borderColor: C.line },
  btnSecondaryText:{ color: C.text, fontSize: 14, fontWeight: '600' },

  noWalletNote: { textAlign: 'center', color: C.muted, fontSize: 11, marginTop: 12 },
  autoHint:     { textAlign: 'center', color: C.text, fontSize: 13, fontWeight: '600', marginTop: 10 },
  videoNote:    { textAlign: 'center', color: C.muted, fontSize: 14, marginTop: 8 },

  permSafe:    { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg, padding: 32 },
  permTitle:   { fontSize: 22, fontWeight: '800', color: C.text, marginBottom: 12 },
  permDesc:    { fontSize: 14, color: C.muted, textAlign: 'center', marginBottom: 32, lineHeight: 22 },
  permBtn:     { backgroundColor: C.amber2, paddingHorizontal: 32, paddingVertical: 14, borderRadius: 100 },
  permBtnText: { color: C.dark, fontSize: 15, fontWeight: '800' },

  modalOverlay:     { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalBox:         { backgroundColor: '#FAFAF9', borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 28, paddingBottom: 40, alignItems: 'center' },
  modalHandle:      { width: 36, height: 4, backgroundColor: '#E7E5E4', borderRadius: 100, marginBottom: 24 },
  modalTitle:       { fontSize: 22, fontWeight: '900', color: '#1C1917', marginBottom: 20 },
  modalDesc:        { fontSize: 14, color: '#78716C', textAlign: 'center', lineHeight: 22, marginBottom: 24 },
  modalStatRow:     { flexDirection: 'row', gap: 32, marginBottom: 28, alignItems: 'center' },
  modalStat:        { alignItems: 'center' },
  modalStatVal:     { fontSize: 40, fontWeight: '900', color: '#1C1917' },
  modalStatLbl:     { fontSize: 10, color: '#A8A29E', letterSpacing: 1, marginTop: 4 },
  modalStatDivider: { width: 1, height: 48, backgroundColor: '#E7E5E4' },
  modalBtn:         { width: '100%', backgroundColor: '#2D2926', borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  modalBtnText:     { color: '#F59E0B', fontSize: 15, fontWeight: '800' },
})
