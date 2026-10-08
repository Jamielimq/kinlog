package com.kinlog.app

import android.graphics.BitmapFactory
import android.os.SystemClock
import com.facebook.react.bridge.*
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarker
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarkerResult

class PoseLandmarkerModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private var poseLandmarker: PoseLandmarker? = null
    private var useVideoMode = false
    private var lastTimestampMs = 0L

    // Decoding the full preview-resolution JPEG is wasted work: the pose_landmarker_lite
    // graph resizes to 256x256 internally. Downscale on decode, but keep enough pixels
    // that a person occupying part of the frame still has usable leg detail.
    private val targetMinDim = 480

    override fun getName(): String = "PoseLandmarker"

    @ReactMethod
    fun initialize(videoMode: Boolean, promise: Promise) {
        try {
            val baseOptions = BaseOptions.builder()
                .setModelAssetPath("pose_landmarker_lite.task")
                .build()

            // VIDEO mode carries tracking state between frames, so the heavy person
            // detector only re-runs when tracking is lost. IMAGE mode re-runs it every frame.
            val options = PoseLandmarker.PoseLandmarkerOptions.builder()
                .setBaseOptions(baseOptions)
                .setRunningMode(if (videoMode) RunningMode.VIDEO else RunningMode.IMAGE)
                .setNumPoses(1)
                .build()

            poseLandmarker = PoseLandmarker.createFromOptions(reactContext, options)
            useVideoMode = videoMode
            lastTimestampMs = 0L
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("INIT_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun detectPose(imagePath: String, promise: Promise) {
        try {
            val lm = poseLandmarker ?: run {
                promise.reject("NOT_INITIALIZED", "PoseLandmarker not initialized")
                return
            }

            val path = imagePath.removePrefix("file://")

            // Header-only pass to size the downscale. Cheap: no pixels are decoded.
            val boundsOpts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(path, boundsOpts)
            val minDim = minOf(boundsOpts.outWidth, boundsOpts.outHeight)
            var sample = 1
            while (minDim > 0 && minDim / (sample * 2) >= targetMinDim) sample *= 2

            val decodeOpts = BitmapFactory.Options().apply { inSampleSize = sample }
            val bitmap = BitmapFactory.decodeFile(path, decodeOpts)
                ?: run {
                    promise.reject("DECODE_ERROR", "Failed to decode image")
                    return
                }

            val mpImage = BitmapImageBuilder(bitmap).build()
            val result: PoseLandmarkerResult = if (useVideoMode) {
                // detectForVideo demands strictly increasing timestamps.
                val ts = maxOf(SystemClock.elapsedRealtime(), lastTimestampMs + 1)
                lastTimestampMs = ts
                lm.detectForVideo(mpImage, ts)
            } else {
                lm.detect(mpImage)
            }

            // MediaPipe is done with the frame; release it rather than waiting for GC.
            // A failure here must never fail the detection.
            try { mpImage.close() } catch (e: Exception) {}
            try { bitmap.recycle() } catch (e: Exception) {}

            if (result.landmarks().isEmpty()) {
                promise.resolve(null)
                return
            }

            val landmarks = result.landmarks()[0]

            fun lmMap(idx: Int): WritableMap {
                val landmark = landmarks[idx]
                val map = Arguments.createMap()
                map.putDouble("x", landmark.x().toDouble())
                map.putDouble("y", landmark.y().toDouble())
                map.putDouble("z", 0.0)
                val vis = try {
                    val opt = landmark.visibility()
                    if (opt.isPresent) opt.get().toDouble() else 0.0
                } catch (e: Exception) { 0.0 }
                map.putDouble("visibility", vis)
                return map
            }

            val resultMap = Arguments.createMap()
            // Shoulders are needed for torso length, which scales the hip-descent test.
            resultMap.putMap("leftShoulder",  lmMap(11))
            resultMap.putMap("rightShoulder", lmMap(12))
            resultMap.putMap("leftHip",    lmMap(23))
            resultMap.putMap("rightHip",   lmMap(24))
            resultMap.putMap("leftKnee",   lmMap(25))
            resultMap.putMap("rightKnee",  lmMap(26))
            resultMap.putMap("leftAnkle",  lmMap(27))
            resultMap.putMap("rightAnkle", lmMap(28))

            promise.resolve(resultMap)
        } catch (e: Exception) {
            promise.reject("DETECT_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun release(promise: Promise) {
        poseLandmarker = null
        promise.resolve(true)
    }
}
