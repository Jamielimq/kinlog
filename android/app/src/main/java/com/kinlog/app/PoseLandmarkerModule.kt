package com.kinlog.app

import android.graphics.BitmapFactory
import com.facebook.react.bridge.*
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarker
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarkerResult

class PoseLandmarkerModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private var poseLandmarker: PoseLandmarker? = null

    override fun getName(): String = "PoseLandmarker"

    @ReactMethod
    fun initialize(promise: Promise) {
        try {
            val baseOptions = BaseOptions.builder()
                .setModelAssetPath("pose_landmarker_lite.task")
                .build()

            val options = PoseLandmarker.PoseLandmarkerOptions.builder()
                .setBaseOptions(baseOptions)
                .setRunningMode(RunningMode.IMAGE)
                .setNumPoses(1)
                .build()

            poseLandmarker = PoseLandmarker.createFromOptions(reactContext, options)
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
            val bitmap = BitmapFactory.decodeFile(path)
                ?: run {
                    promise.reject("DECODE_ERROR", "Failed to decode image")
                    return
                }

            val mpImage = BitmapImageBuilder(bitmap).build()
            val result: PoseLandmarkerResult = lm.detect(mpImage)

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
