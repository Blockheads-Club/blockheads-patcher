package com.blockheadspatcher.app

import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.ViewTreeObserver
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    val until = SystemClock.uptimeMillis() + SPLASH_MIN_MS
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    holdSplash(findViewById(android.R.id.content), until)
  }

  /**
   * Keeps the system splash (Android 12+) or the splash window background (older versions) up until [until], so it
   * is seen rather than flashed: the first frame is not drawn before then.
   */
  private fun holdSplash(content: View, until: Long) {
    content.viewTreeObserver.addOnPreDrawListener(object : ViewTreeObserver.OnPreDrawListener {
      override fun onPreDraw(): Boolean {
        val left = until - SystemClock.uptimeMillis()
        if (left > 0) {
          content.postDelayed({ content.invalidate() }, left)
          return false
        }
        content.viewTreeObserver.removeOnPreDrawListener(this)
        return true
      }
    })
  }

  companion object {
    const val SPLASH_MIN_MS = 700L
  }
}
