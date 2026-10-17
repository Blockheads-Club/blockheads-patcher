package com.blockheadspatcher.apktools

import androidx.core.content.FileProvider

/** Dedicated FileProvider subclass so it does not clash with the app's own provider. */
class ApkFileProvider : FileProvider()
