package com.blockheadspatcher.apktools

import android.os.Looper
import app.tauri.plugin.Invoke
import com.fasterxml.jackson.databind.ObjectMapper
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArrayList

/** The plugin's update commands (they run on Robolectric because the plugin needs an Activity). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class UpdateCommandsTest {
    private lateinit var http: LocalHttp
    private val name = "blockheads-patcher-0.4.0-android-arm64.apk"
    private val body = ByteArray(50_000) { (it % 251).toByte() }
    private val responses = CopyOnWriteArrayList<Pair<Long, String>>()
    private val defaultPrefix = UpdateDownloader.prefix

    @Before
    fun setUp() {
        http = LocalHttp()
        UpdateDownloader.prefix = http.base
    }

    @After
    fun tearDown() {
        UpdateDownloader.await()
        http.close()
        UpdateDownloader.prefix = defaultPrefix
    }

    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
    private fun route(path: String, handler: (java.io.OutputStream) -> Unit) = http.route(path, handler)
    private fun send(out: java.io.OutputStream, code: Int, data: ByteArray) = http.send(out, code, data)
    private val base get() = http.base
    private fun serveApk() = route(name) { send(it, 200, body) }

    // ---- plugin commands ----

    private fun invoke(json: String): Invoke =
        Invoke(1, "cmd", 10L, 20L, { cb, data -> responses.add(cb to data) }, json, ObjectMapper())

    private fun await(n: Int): List<Pair<Long, String>> {
        val deadline = System.currentTimeMillis() + 10_000
        while (responses.size < n && System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(5)
        }
        assertTrue(responses.size >= n)
        return responses.toList()
    }

    @Test
    fun theUpdateCommandsDriveTheDownloader() {
        val activity = Robolectric.buildActivity(TestActivity::class.java).create().get()
        File(activity.cacheDir, "bhp").deleteRecursively()
        val plugin = ApkToolsPlugin(activity)
        serveApk()
        route("SHA256SUMS.txt") { send(it, 200, "${sha(body)}  $name\n".toByteArray()) }
        fun args(url: String, sums: String?) =
            JSONObject().put("url", url).put("name", name).put("size", body.size).apply { if (sums != null) put("sumsUrl", sums) }.toString()

        plugin.update_download(invoke(args("https://evil.example/$name", null)))
        assertEquals(20L, await(1)[0].first)
        assertTrue(responses[0].second.contains("invalid_url"))

        // no list (key omitted), an empty list (the Rust side's "none"), then a real list
        for (sums in listOf(null, "", base + "SHA256SUMS.txt")) {
            plugin.update_download(invoke(args(base + name, sums)))
            UpdateDownloader.await()
        }
        assertEquals(listOf(20L, 10L, 10L, 10L), await(4).map { it.first })

        plugin.update_status(invoke("{}"))
        val status = JSONObject(await(5)[4].second)
        assertEquals("done", status.getString("state"))
        assertTrue(File(status.getString("path")).isFile)

        plugin.update_cancel(invoke("{}"))
        assertEquals(10L, await(6)[5].first)
    }
}
