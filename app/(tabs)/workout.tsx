import { getApp } from '@react-native-firebase/app'
import { addDoc, collection, doc, getDoc, getFirestore, increment, setDoc } from '@react-native-firebase/firestore'
import { useKeepAwake } from 'expo-keep-awake'
import { useEffect, useRef, useState } from 'react'
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Camera, useCameraDevice, useCameraPermission, useFrameProcessor } from 'react-native-vision-camera'
import { useWallet } from '../../context/WalletContext'
import { updateChallengeProgress } from '../../hooks/challengeProgress'
import { ALL_BADGES } from '../../hooks/useBadges'
import { calcAngle, usePoseLandmarker } from '../../hooks/usePoseLandmarker'

const C = {
  bg: '#FAFAF9', bg2: '#F5F4F1', bg3: '#EDECEA',
  dark: '#2D2926', amber: '#D97706', amber2: '#F59E0B',
  text: '#1C1917', muted: '#A8A29E', line: '#E7E5E4',
}

const POINTS_PER_REP = 5
const TARGET = 30

type CameraMode = 'front' | 'side'

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

// Side mode: use the side with higher visibility for more accurate angle
function calcSideAngle(landmarks: any): number {
  const leftVis = (landmarks.leftHip?.visibility ?? 0) +
                  (landmarks.leftKnee?.visibility ?? 0) +
                  (landmarks.leftAnkle?.visibility ?? 0)
  const rightVis = (landmarks.rightHip?.visibility ?? 0) +
                   (landmarks.rightKnee?.visibility ?? 0) +
                   (landmarks.rightAnkle?.visibility ?? 0)

  if (leftVis >= rightVis) {
    return Math.round(calcAngle(landmarks.leftHip, landmarks.leftKnee, landmarks.leftAnkle))
  } else {
    return Math.round(calcAngle(landmarks.rightHip, landmarks.rightKnee, landmarks.rightAnkle))
  }
}

// Front mode: average of both sides
function calcFrontAngle(landmarks: any): number {
  return Math.round((
    calcAngle(landmarks.leftHip, landmarks.leftKnee, landmarks.leftAnkle) +
    calcAngle(landmarks.rightHip, landmarks.rightKnee, landmarks.rightAnkle)
  ) / 2)
}

export default function WorkoutScreen() {
  // Keep screen awake during workout
  useKeepAwake()

  const { hasPermission, requestPermission } = useCameraPermission()
  const device = useCameraDevice('front')
  const [cameraMode, setCameraMode] = useState<CameraMode>('side')
  const [isActive, setIsActive] = useState(false)
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
  const cameraModeRef = useRef<CameraMode>('side')

  const { publicKey } = useWallet()
  const address = publicKey?.toBase58() ?? null
  const { initialized: poseReady, detect } = usePoseLandmarker()

  useEffect(() => {
    isActiveRef.current = isActive
  }, [isActive])

  useEffect(() => {
    cameraModeRef.current = cameraMode
  }, [cameraMode])

  const stopSession = async () => {
    isActiveRef.current = false
    setIsActive(false)
    clearInterval(timerRef.current!)
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

  // Pose detection loop using camera snapshots
  useEffect(() => {
    if (!isActive || !poseReady) return

    const interval = setInterval(async () => {
      if (detectingRef.current || !cameraRef.current) return
      detectingRef.current = true
      try {
        const photo = await cameraRef.current.takeSnapshot({ quality: 30 })
        if (!photo?.path) return
        const landmarks = await detect('file://' + photo.path)
        if (!landmarks) return

        // Calculate angle based on selected camera mode
        const kneeAngle = cameraModeRef.current === 'side'
          ? calcSideAngle(landmarks)
          : calcFrontAngle(landmarks)

        setAngle(kneeAngle)

        if (phaseRef.current === 'up' && kneeAngle < 110) {
          phaseRef.current = 'down'; setPhase('down')
        } else if (phaseRef.current === 'down' && kneeAngle > (cameraModeRef.current === 'side' ? 150 : 160)) {
          phaseRef.current = 'up'; setPhase('up')
          repsRef.current += 1; setReps(repsRef.current)
          if (repsRef.current >= TARGET) stopSession()
        }
      } catch (e) {
        // Ignore snapshot errors
      } finally {
        detectingRef.current = false
      }
    }, 100)

    return () => clearInterval(interval)
  }, [isActive, poseReady])

  const startSession = () => {
    repsRef.current = 0; elapsedRef.current = 0; phaseRef.current = 'up'
    setIsActive(true); setReps(0); setElapsed(0); setPhase('up'); setAngle(180)
    timerRef.current = setInterval(() => { elapsedRef.current += 1; setElapsed(s => s + 1) }, 1000)
  }

  const resetSession = () => {
    isActiveRef.current = false
    setIsActive(false)
    clearInterval(timerRef.current!)
    repsRef.current = 0; elapsedRef.current = 0; phaseRef.current = 'up'
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
            <Text style={s.phaseText}>{phase === 'down' ? '⬆  Come up slowly' : '⬇  Go down to 110° or below'}</Text>
          </View>
        )}

        {/* Camera mode toggle - hidden during active session */}
        {!isActive && (
          <View style={s.modeSelector}>
            <Text style={s.modeSelectorLabel}>CAMERA POSITION</Text>
            <View style={s.modeRow}>
              <TouchableOpacity
                style={[s.modeBtn, cameraMode === 'side' && s.modeBtnActive]}
                onPress={() => setCameraMode('side')}
              >
                <Text style={s.modeBtnIcon}>↔</Text>
                <Text style={[s.modeBtnText, cameraMode === 'side' && s.modeBtnTextActive]}>Side</Text>
                {cameraMode === 'side' && (
                  <View style={s.modeBtnBadge}><Text style={s.modeBtnBadgeText}>Recommended</Text></View>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.modeBtn, cameraMode === 'front' && s.modeBtnActive]}
                onPress={() => setCameraMode('front')}
              >
                <Text style={s.modeBtnIcon}>↕</Text>
                <Text style={[s.modeBtnText, cameraMode === 'front' && s.modeBtnTextActive]}>Front</Text>
              </TouchableOpacity>
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

  modeSelector:      { position: 'absolute', top: 56, left: 16, right: 16, alignItems: 'center' },
  modeSelectorLabel: { fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 1.5, marginBottom: 8 },
  modeRow:           { flexDirection: 'row', gap: 10 },
  modeBtn:           { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', borderRadius: 14, paddingVertical: 10, alignItems: 'center', gap: 4 },
  modeBtnActive:     { backgroundColor: 'rgba(217,119,6,0.25)', borderColor: 'rgba(217,119,6,0.7)' },
  modeBtnIcon:       { fontSize: 18, color: 'rgba(255,255,255,0.7)' },
  modeBtnText:       { fontSize: 12, fontWeight: '700', color: 'rgba(255,255,255,0.6)' },
  modeBtnTextActive: { color: C.amber2 },
  modeBtnBadge:      { backgroundColor: C.amber2, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 100, marginTop: 2 },
  modeBtnBadgeText:  { fontSize: 8, fontWeight: '800', color: C.dark },

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
