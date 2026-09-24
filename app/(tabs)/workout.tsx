import { getApp } from '@react-native-firebase/app'
import { addDoc, collection, doc, getDoc, getFirestore, increment, setDoc } from '@react-native-firebase/firestore'
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

  await addDoc(collection(db, 'users', address, 'workouts'), {
    exercise: 'squat', reps: effectiveReps, elapsed, createdAt: now,
  })

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

  await setDoc(doc(db, 'users', address, 'goals', 'daily'), {
    current: Math.min(newDailyReps, TARGET), total: TARGET,
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

// --- POSE DEBUG BEGIN (calibration only — remove this whole block, see plan Phase 3) ---
// Explicit constant rather than __DEV__: these numbers have to be read off a release APK.
const POSE_DEBUG = true
// Frame capture is OFF by design, not merely unused: the workout screen tells the user
// "This video is not recorded or saved", and writing per-rep JPEGs to the device would
// contradict that. It stays behind this flag so calibration can turn it back on
// deliberately, on a build that is not shipped. Logging above is unaffected.
const POSE_DEBUG_FRAMES = false
// MediaPipe RunningMode.VIDEO (tracking between frames) vs IMAGE (stateless per frame).
// Flip to compare cadence; the session summary reports the stage breakdown either way.
const POSE_VIDEO_MODE = true

type RejectReason = 'nopose' | 'lowvis' | 'order'

type PoseStats = {
  frames: number; ok: number; nopose: number; lowvis: number; order: number
  dts: number[]; snaps: number[]; decodes: number[]; infers: number[]
  repLatencies: number[]; hipDrops: number[]
  img: string | null
}
const emptyPoseStats = (): PoseStats => ({
  frames: 0, ok: 0, nopose: 0, lowvis: 0, order: 0,
  dts: [], snaps: [], decodes: [], infers: [], repLatencies: [], hipDrops: [], img: null,
})

type StageTimes = { snap: number; decode?: number; infer?: number }

function logPoseFrame(
  stats: PoseStats,
  dt: number,
  t: StageTimes,
  m: SideMeasurement | null,
  phase: 'up' | 'down',
  hipDrop?: number | null,
  torso?: number | null,
  reject?: RejectReason | null,
) {
  if (!POSE_DEBUG) return
  stats.frames += 1
  if (dt > 0) stats.dts.push(dt)
  stats.snaps.push(t.snap)
  if (t.decode !== undefined) stats.decodes.push(t.decode)
  if (t.infer !== undefined) stats.infers.push(t.infer)
  // Whatever dt is not accounted for by these three is bridge + file I/O + JS overhead.
  const stage =
    `snap=${Math.round(t.snap)} dec=${t.decode !== undefined ? Math.round(t.decode) : '-'} ` +
    `inf=${t.infer !== undefined ? Math.round(t.infer) : '-'}`
  if (reject === 'nopose' || !m) {
    stats.nopose += 1
    console.log(`[POSE] dt=${dt} ${stage} REJECT=nopose`)
  } else if (reject === 'lowvis') {
    stats.lowvis += 1
    console.log(`[POSE] dt=${dt} ${stage} REJECT=lowvis vis=${m.minVis.toFixed(2)} leg=${m.leg}`)
  } else if (reject === 'order') {
    stats.order += 1
    const f3 = (n: number) => n.toFixed(3)
    console.log(
      `[POSE] dt=${dt} ${stage} REJECT=order leg=${m.leg} vis=${m.minVis.toFixed(2)} ` +
      `sh=${m.shoulder ? f3(m.shoulder.y) : 'n/a'} hip=${f3(m.hip.y)} knee=${f3(m.knee.y)} ankle=${f3(m.ankle.y)}`
    )
  } else {
    stats.ok += 1
    // hipdrop is the whole point of the next calibration pass: read the MINIMUM across
    // real squats and the MAXIMUM across knee raises to settle HIP_DROP_RATIO.
    const hd = hipDrop === null || hipDrop === undefined ? 'n/a' : `${(hipDrop * 100).toFixed(0)}%`
    const tl = torso === null || torso === undefined ? 'n/a' : torso.toFixed(3)
    if (hipDrop !== null && hipDrop !== undefined) stats.hipDrops.push(hipDrop)
    console.log(
      `[POSE] dt=${dt} ${stage} raw=${m.angle} hipdrop=${hd} torso=${tl} ` +
      `vis=${m.minVis.toFixed(2)} leg=${m.leg} phase=${phase}`
    )
  }
}

function logPoseSession(stats: PoseStats, reps: number) {
  if (!POSE_DEBUG) return
  const d = [...stats.dts].sort((a, b) => a - b)
  const at = (q: number) => (d.length ? d[Math.min(d.length - 1, Math.floor(d.length * q))] : 0)
  const avg = d.length ? Math.round(d.reduce((sum, v) => sum + v, 0) / d.length) : 0
  const lowvisPct = stats.frames ? ((stats.lowvis / stats.frames) * 100).toFixed(1) : '0.0'
  const mean = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0)
  const snap = mean(stats.snaps), dec = mean(stats.decodes), inf = mean(stats.infers)
  console.log(
    `[POSE] session frames=${stats.frames} ok=${stats.ok} nopose=${stats.nopose} ` +
    `lowvis=${stats.lowvis} (${lowvisPct}%) order=${stats.order} dt avg=${avg} p50=${at(0.5)} p95=${at(0.95)} ` +
    `max=${d.length ? d[d.length - 1] : 0} reps=${reps}`
  )
  console.log(
    `[POSE] session stages mode=${POSE_VIDEO_MODE ? 'VIDEO' : 'IMAGE'} ` +
    `snap=${snap} decode=${dec} infer=${inf} other=${Math.max(0, avg - snap - dec - inf)} ` +
    `(avg ms of dt=${avg}) img=${stats.img ?? 'n/a'}`
  )
  const hd = [...stats.hipDrops].sort((a, b) => a - b)
  const pc = (v: number) => `${(v * 100).toFixed(0)}%`
  console.log(
    `[POSE] session hipdrop n=${hd.length} ` +
    `min=${hd.length ? pc(hd[0]) : 'n/a'} ` +
    `p50=${hd.length ? pc(hd[Math.floor(hd.length / 2)]) : 'n/a'} ` +
    `max=${hd.length ? pc(hd[hd.length - 1]) : 'n/a'} (gate=${pc(HIP_DROP_RATIO)})`
  )
  const rl = [...stats.repLatencies].sort((a, b) => a - b)
  console.log(
    `[POSE] session stood-up->counted n=${rl.length} ` +
    `median=${rl.length ? rl[Math.floor(rl.length / 2)] : 0} ` +
    `min=${rl.length ? rl[0] : 0} max=${rl.length ? rl[rl.length - 1] : 0} ms`
  )
}
// --- POSE DEBUG END ---

export default function WorkoutScreen() {
  // Keep screen awake during workout
  useKeepAwake()

  const { hasPermission, requestPermission } = useCameraPermission()
  const device = useCameraDevice('front')
  const [isActive, setIsActive] = useState(false)
  const [trackingLost, setTrackingLost] = useState(false)
  const [reps, setReps] = useState(0)
  const [phase, setPhase] = useState<'up' | 'down'>('up')
  const [angle, setAngle] = useState(180)
  const [elapsed, setElapsed] = useState(0)
  const [saving, setSaving] = useState(false)
  const [workoutResult, setWorkoutResult] = useState<{ type: 'success' | 'already' | 'error'; reps?: number; pts?: number } | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const repsRef = useRef(0)
  const elapsedRef = useRef(0)
  const phaseRef = useRef<'up' | 'down'>('up')
  const isActiveRef = useRef(false)

  // Judgement state that must not be lost to a re-render between frames.
  const lostSinceRef = useRef<number | null>(null)
  // Standing samples inside STAND_WINDOW_MS. The baseline is the HIGHEST hip among
  // them (smallest y), so a slouched moment while getting set cannot become the
  // reference. Torso length is taken from that same frame — the most upright one.
  const standSamplesRef = useRef<{ t: number; hipY: number; torso: number | null }[]>([])
  const baselineRef = useRef<{ hipY: number; torso: number | null } | null>(null)
  const lastFrameAtRef = useRef<number | null>(null)
  const roseAtRef = useRef<number | null>(null)
  const poseStatsRef = useRef(emptyPoseStats())
  const deepestRef = useRef<{ path: string | null; m: SideMeasurement; drop: number | null } | null>(null)
  const attemptDeepestRef = useRef<number | null>(null)
  const skipCountRef = useRef(0)
  const debugDirRef = useRef<string | null>(null)

  const { publicKey } = useWallet()
  const address = publicKey?.toBase58() ?? null
  const { initialized: poseReady, detect, getDebugDir, saveDebugFrame } = usePoseLandmarker(POSE_VIDEO_MODE)

  useEffect(() => {
    isActiveRef.current = isActive
  }, [isActive])

  const stopSession = async () => {
    isActiveRef.current = false
    setIsActive(false)
    setTrackingLost(false)
    clearInterval(timerRef.current!)
    logPoseSession(poseStatsRef.current, repsRef.current)
    // Leak check: the loop deletes every snapshot in its finally block, so this should
    // read 0. Internal cache is unreadable over adb on a release build, so the app has
    // to report it. Counted on a delay because a detection is usually still awaiting
    // when Stop is pressed, and its finally has not run yet — counting immediately
    // always finds that one in-flight frame and looks like a leak. Goes away with the
    // POSE DEBUG block.
    if (POSE_DEBUG) {
      setTimeout(() => {
        try {
          const sd = new Directory(Paths.cache, SNAPSHOT_DIR)
          console.log(`[POSE] session snapshot cache: ${sd.exists ? sd.list().length : 0} file(s) left`)
        } catch (e) {
          console.log('[POSE] snapshot cache check failed:', String(e))
        }
      }, 1500)
    }
    const completedReps = repsRef.current
    const completedElapsed = elapsedRef.current
    if (completedReps > 0 && address) {
      setSaving(true)
      try {
        const result = await saveWorkout(address, completedReps, completedElapsed)
        if (result.effectiveReps > 0) {
          setWorkoutResult({ type: 'success', reps: result.effectiveReps, pts: result.effectiveReps * POINTS_PER_REP })
        } else {
          setWorkoutResult({ type: 'already' })
        }
      } catch (e) {
        console.error('Save error:', e)
        setWorkoutResult({ type: 'error' })
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
    // --- POSE DEBUG (calibration only - remove with the debug block) ---
    if (POSE_DEBUG && POSE_DEBUG_FRAMES) {
      getDebugDir().then(d => {
        debugDirRef.current = d
        console.log(`[POSE] debug frame dir: ${d ?? 'unavailable'}`)
      })
    }
    // --- END POSE DEBUG ---
    // Mount-only on purpose: the snapshot dir is resolved once per screen, and
    // getDebugDir is debug-only (it goes away with the POSE DEBUG block).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Pose detection loop using camera snapshots
  useEffect(() => {
    if (!isActive || !poseReady) return

    const interval = setInterval(async () => {
      if (detectingRef.current || !cameraRef.current) return
      detectingRef.current = true

      // Measured tick-to-tick, because snapshot + inference latency makes the real
      // cadence longer and less regular than this interval's nominal 100 ms.
      const now = Date.now()
      const dt = lastFrameAtRef.current === null ? 0 : now - lastFrameAtRef.current
      lastFrameAtRef.current = now

      let snapshotPath: string | null = null
      let keepSnapshot = false
      try {
        const dir = snapshotDirRef.current
        const tSnapStart = Date.now()
        const photo = await cameraRef.current.takeSnapshot(
          dir ? { quality: 30, path: dir } : { quality: 30 }
        )
        const tSnap = Date.now() - tSnapStart
        if (!photo?.path) return
        snapshotPath = photo.path

        const landmarks = await detect('file://' + photo.path)
        const measured = landmarks ? measureSide(landmarks) : null
        const stages = { snap: tSnap, decode: landmarks?.decodeMs, infer: landmarks?.inferMs }
        if (landmarks?.imgW && poseStatsRef.current.img === null) {
          poseStatsRef.current.img = `${landmarks.imgW}x${landmarks.imgH}/s${landmarks.sample}`
        }

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
          if (now - lostSinceRef.current >= TRACKING_WARN_MS) setTrackingLost(true)
          // setAngle is not called, so the readout holds its last measured value.
          logPoseFrame(poseStatsRef.current, dt, stages, measured, phaseRef.current, null, null, reject)
          return
        }

        lostSinceRef.current = null
        setTrackingLost(false)

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

        // Keep the deepest frame of the current rep so its landmarks can be checked
        // against the photo. Only frames already near the bottom are considered.
        if (POSE_DEBUG && measured!.angle <= 130) {
          const cur = deepestRef.current
          if (cur === null || measured!.angle < cur.m.angle) {
            if (cur?.path) { try { new File('file://' + cur.path).delete() } catch {} }
            // Without frame capture we still track the measurement for the log line,
            // but the snapshot is left to the normal per-frame delete.
            deepestRef.current = {
              path: POSE_DEBUG_FRAMES ? snapshotPath : null,
              m: measured!, drop: hipDropRatio,
            }
            if (POSE_DEBUG_FRAMES) keepSnapshot = true
          }
        }
        // An attempt that never became a rep is released once the knee straightens
        // again, so a rejected knee raise still leaves a photo to inspect.
        if (POSE_DEBUG && val > 130 && phaseRef.current === 'up' && deepestRef.current) {
          releaseAttempt('skip')
        }

        if (phaseRef.current === 'up') {
          // Knee angle alone cannot tell a squat from a knee raise. When torso length
          // is unavailable the hip term is skipped rather than blocking the rep —
          // missing a real rep is the worse error (see CLAUDE.md judgement principle).
          const hipOk = hipDropRatio === null || hipDropRatio >= HIP_DROP_RATIO
          if (val <= KNEE_DOWN && hipOk) {
            phaseRef.current = 'down'; setPhase('down')
            roseAtRef.current = null
          } else if (val <= KNEE_DOWN && POSE_DEBUG) {
            // Rejected purely by the hip term — the case this gate exists for.
            releaseAttempt('skip')
          }
        } else {
          if (val >= KNEE_UP) {
            // Stamped and consumed on the same frame, so this reads ~0 by construction.
            // It stays in the summary as the measured cost of the judgement itself.
            roseAtRef.current = now
            phaseRef.current = 'up'; setPhase('up')
            repsRef.current += 1; setReps(repsRef.current)
            poseStatsRef.current.repLatencies.push(now - roseAtRef.current)
            roseAtRef.current = null
            if (POSE_DEBUG) releaseAttempt('rep', repsRef.current)
            if (repsRef.current >= TARGET) stopSession()
          }
        }

        logPoseFrame(poseStatsRef.current, dt, stages, measured, phaseRef.current, hipDropRatio, base?.torso ?? null, null)
      } catch (e) {
        // Ignore snapshot errors
      } finally {
        if (snapshotPath && !keepSnapshot) {
          try { new File('file://' + snapshotPath).delete() } catch {}
        }
        detectingRef.current = false
      }
    }, 100)

    return () => clearInterval(interval)
  }, [isActive, poseReady])

  // --- POSE DEBUG (calibration only - remove with the debug block) ---
  // Moves the deepest frame of the rep just counted into the external debug dir and
  // logs the landmarks that produced its angle, so the number can be checked against
  // the actual photo. adb pull the directory printed on session start.
  // kind 'rep'  — the attempt was counted
  // kind 'skip' — the knee reached 110 but the hip did not drop far enough, or the
  //               descent was abandoned. Both are saved: verifying that a knee raise
  //               is rejected needs the rejected frame, not just the accepted ones.
  const releaseAttempt = (kind: 'rep' | 'skip', repNo?: number) => {
    const d = deepestRef.current
    deepestRef.current = null
    if (!d) return
    const { m } = d
    const f2 = (n: number) => n.toFixed(4)
    const seq = kind === 'rep' ? (repNo ?? 0) : (skipCountRef.current += 1)
    const drop = d.drop === null ? 'n/a' : `${(d.drop * 100).toFixed(0)}%`
    console.log(
      `[POSE] ${kind}=${seq} deepest angle=${m.angle} leg=${m.leg} hipdrop=${drop} ` +
      `hip=(${f2(m.hip.x)},${f2(m.hip.y)},v${m.hip.visibility.toFixed(2)}) ` +
      `knee=(${f2(m.knee.x)},${f2(m.knee.y)},v${m.knee.visibility.toFixed(2)}) ` +
      `ankle=(${f2(m.ankle.x)},${f2(m.ankle.y)},v${m.ankle.visibility.toFixed(2)}) ` +
      `shoulder=${m.shoulder ? `(${f2(m.shoulder.x)},${f2(m.shoulder.y)},v${m.shoulder.visibility.toFixed(2)})` : 'not visible'}`
    )
    if (!d.path) return
    const name = `${kind}${String(seq).padStart(2, '0')}_${m.angle}deg_drop${d.drop === null ? 'na' : Math.round(d.drop * 100)}.jpg`
    const src = d.path
    saveDebugFrame(src, name).then(saved => {
      if (!saved) {
        console.log('[POSE] frame save failed for', name)
        try { new File('file://' + src).delete() } catch {}
      }
    })
  }
  // --- END POSE DEBUG ---

  const resetJudgement = () => {
    lostSinceRef.current = null
    standSamplesRef.current = []
    baselineRef.current = null
    attemptDeepestRef.current = null
    lastFrameAtRef.current = null
    roseAtRef.current = null
    poseStatsRef.current = emptyPoseStats()
    if (deepestRef.current?.path) {
      try { new File('file://' + deepestRef.current.path).delete() } catch {}
    }
    deepestRef.current = null
    setTrackingLost(false)
  }

  const startSession = () => {
    repsRef.current = 0; elapsedRef.current = 0; phaseRef.current = 'up'
    resetJudgement()
    setIsActive(true); setReps(0); setElapsed(0); setPhase('up'); setAngle(180)
    timerRef.current = setInterval(() => { elapsedRef.current += 1; setElapsed(s => s + 1) }, 1000)
  }

  const resetSession = () => {
    isActiveRef.current = false
    setIsActive(false)
    clearInterval(timerRef.current!)
    repsRef.current = 0; elapsedRef.current = 0; phaseRef.current = 'up'
    resetJudgement()
    setReps(0); setElapsed(0); setAngle(180); setPhase('up')
  }

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

        {/* Live indicator */}
        {isActive && (
          <View style={s.liveBadge}><View style={s.liveDot}/><Text style={s.liveText}>LIVE</Text></View>
        )}

        {/* Phase guidance */}
        {isActive && (
          <View style={s.phaseBadge}>
            <Text style={s.phaseText}>
              {trackingLost
                ? '⚠  Step back so your full body is in frame'
                : phase === 'down' ? '⬆  Come up slowly' : '⬇  Go down to 110° or below'}
            </Text>
          </View>
        )}

        {/* Side view is required, not a choice - hidden during active session */}
        {!isActive && (
          <View style={s.modeHint}>
            <Text style={s.modeHintLabel}>CAMERA POSITION</Text>
            <View style={s.modeHintBox}>
              <Text style={s.modeHintIcon}>↔</Text>
              <Text style={s.modeHintText}>Stand sideways to the camera</Text>
            </View>
          </View>
        )}

        {/* Knee angle display */}
        <View style={s.angleBadge}>
          <Text style={s.angleLabel}>KNEE ANGLE</Text>
          <Text style={s.angleValue}>{angle}°</Text>
          <Text style={s.angleTarget}>TARGET ≤ 110°</Text>
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
            onPress={isActive ? stopSession : startSession}
            disabled={saving}
          >
            <Text style={s.btnPrimaryText}>{saving ? 'Saving...' : isActive ? '⏸  Pause' : '▶  Start'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.btnSecondary}>
            <Text style={s.btnSecondaryText}>Goal</Text>
          </TouchableOpacity>
        </View>

        {!address && <Text style={s.noWalletNote}>⚠ Connect wallet to save workouts</Text>}
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

  liveBadge: { position: 'absolute', top: 56, left: 16, flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 100 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#EF4444', marginRight: 6 },
  liveText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 1.5 },

  phaseBadge: { position: 'absolute', top: 56, left: '15%', right: '15%', backgroundColor: 'rgba(217,119,6,0.2)', borderWidth: 1, borderColor: 'rgba(217,119,6,0.5)', paddingVertical: 7, borderRadius: 100, alignItems: 'center' },
  phaseText: { color: C.amber2, fontSize: 16, fontWeight: '700' },

  modeHint:      { position: 'absolute', top: 56, left: 16, right: 16, alignItems: 'center' },
  modeHintLabel: { fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1.5, marginBottom: 8 },
  modeHintBox:   { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(0,0,0,0.45)', borderWidth: 1, borderColor: 'rgba(217,119,6,0.5)', borderRadius: 14, paddingVertical: 10, paddingHorizontal: 16 },
  modeHintIcon:  { fontSize: 18, color: C.amber2 },
  modeHintText:  { fontSize: 13, fontWeight: '700', color: 'rgba(255,255,255,0.85)' },

  angleBadge:  { position: 'absolute', bottom: 20, right: 16, backgroundColor: 'rgba(0,0,0,0.65)', borderWidth: 1, borderColor: 'rgba(217,119,6,0.35)', borderRadius: 14, padding: 12, alignItems: 'center' },
  angleLabel:  { color: 'rgba(255,255,255,0.35)', fontSize: 8, letterSpacing: 1, marginBottom: 2 },
  angleValue:  { color: C.amber2, fontSize: 28, fontWeight: '900', lineHeight: 30 },
  angleTarget: { color: 'rgba(255,255,255,0.25)', fontSize: 8, marginTop: 2 },

  panel:        { backgroundColor: C.bg, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 32 },
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
  btnSecondary:    { flex: 1, backgroundColor: C.bg2, borderRadius: 14, paddingVertical: 14, alignItems: 'center', borderWidth: 1.5, borderColor: C.line },
  btnSecondaryText:{ color: C.text, fontSize: 14, fontWeight: '600' },

  noWalletNote: { textAlign: 'center', color: C.muted, fontSize: 11, marginTop: 12 },
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
