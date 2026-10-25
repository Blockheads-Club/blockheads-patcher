package com.blockheadspatcher.apktools

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.net.URL
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** UpdateDownloader against a local HTTP server (plain JVM test). */
class UpdateDownloaderTest {
    private lateinit var http: LocalHttp
    private lateinit var dir: File
    private lateinit var base: String
    private val name = "blockheads-patcher-0.4.0-android-arm64.apk"
    private val body = ByteArray(200_000) { (it % 251).toByte() }
    private val defaultRedirectOk = UpdateDownloader.redirectOk
    private val defaultPrefix = UpdateDownloader.prefix

    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
    private fun send(out: java.io.OutputStream, code: Int, data: ByteArray, headers: Map<String, String> = emptyMap()) = http.send(out, code, data, headers)
    private fun route(path: String, handler: (java.io.OutputStream) -> Unit) = http.route(path, handler)

    @Before
    fun setUp() {
        http = LocalHttp()
        base = http.base
        UpdateDownloader.prefix = base
        UpdateDownloader.redirectOk = { true }
        dir = Files.createTempDirectory("bhp-update").toFile()
    }

    @After
    fun tearDown() {
        UpdateDownloader.cancel()
        UpdateDownloader.await()
        http.close()
        UpdateDownloader.prefix = defaultPrefix
        UpdateDownloader.redirectOk = defaultRedirectOk
        dir.deleteRecursively()
    }

    private fun state() = UpdateDownloader.status()["state"] as String
    private fun error() = UpdateDownloader.status()["error"] as String
    private fun run(url: String = base + name, size: Long = body.size.toLong(), sums: String? = null, file: String = name): String? {
        val r = UpdateDownloader.start(dir, url, file, size, sums)
        UpdateDownloader.await()
        return r
    }
    private fun serveApk() = route(name) { send(it, 200, body) }

    @Test
    fun downloadsAndVerifiesAgainstTheChecksumList() {
        serveApk()
        val sums = "# release sums\n" +
            "${"0".repeat(64)}  other-file.zip\n" +
            "not a checksum line\n" +
            "${sha(body).uppercase()} *$name\n"
        route("SHA256SUMS.txt") { send(it, 200, sums.toByteArray()) }
        assertNull(run(sums = base + "SHA256SUMS.txt"))
        val s = UpdateDownloader.status()
        assertEquals("done", s["state"])
        assertEquals(body.size.toLong(), s["received"])
        assertEquals(body.size.toLong(), s["total"])
        assertEquals("", s["error"])
        val f = File(s["path"] as String)
        assertEquals(File(dir, "${UpdateDownloader.SUBDIR}/$name").absolutePath, f.absolutePath)
        assertTrue(f.readBytes().contentEquals(body))
        assertFalse(File(f.path + ".part").exists())
    }

    @Test
    fun downloadsWithoutAChecksumListAndFollowsRedirects() {
        route(name) { send(it, 302, ByteArray(0), mapOf("Location" to "${base}real.bin")) }
        route("real.bin") { send(it, 200, body) }
        // leftovers of an earlier update are removed
        File(dir, "${UpdateDownloader.SUBDIR}").mkdirs()
        val stale = File(dir, "${UpdateDownloader.SUBDIR}/blockheads-patcher-0.3.0-android-arm64.apk").apply { writeText("old") }
        assertNull(run())
        assertEquals("done", state())
        assertFalse(stale.exists())
    }

    @Test
    fun refusesUrlsAndNamesThatAreNotThisRepositorysAndroidRelease() {
        val sums = base + "SHA256SUMS.txt"
        val size = 10L
        assertEquals("invalid_url", UpdateDownloader.start(dir, base + name, name, 0, null))
        assertEquals("invalid_url", UpdateDownloader.start(dir, base + "evil.apk", "evil.apk", size, null))
        assertEquals("invalid_url", UpdateDownloader.start(dir, "https://evil.example/" + name, name, size, null))
        assertEquals("invalid_url", UpdateDownloader.start(dir, base + "other-" + name, name, size, null))
        assertEquals("invalid_url", UpdateDownloader.start(dir, base + name, name, size, "https://evil.example/SHA256SUMS.txt"))
        assertEquals("invalid_url", UpdateDownloader.start(dir, base + name, name, size, base + "SHA256SUMS.bad"))
        assertNull(run(sums = sums)) // a valid start whose list is missing fails later
        assertEquals("error", state())
    }

    @Test
    fun aSecondStartWhileDownloadingIsBusy() {
        val release = CountDownLatch(1)
        val started = CountDownLatch(1)
        route(name) { started.countDown(); release.await(10, TimeUnit.SECONDS); send(it, 200, body) }
        assertNull(UpdateDownloader.start(dir, base + name, name, body.size.toLong(), null))
        assertTrue(started.await(10, TimeUnit.SECONDS))
        assertEquals("running", state())
        assertEquals("busy", UpdateDownloader.start(dir, base + name, name, body.size.toLong(), null))
        release.countDown()
        UpdateDownloader.await()
        assertEquals("done", state())
    }

    @Test
    fun reportsDownloadFailures() {
        route(name) { send(it, 404, ByteArray(0)) }
        run(); assertEquals("error", state()); assertTrue(error(), error().contains("HTTP 404"))

        // redirect without a Location header, and a redirect loop
        route(name) { send(it, 302, ByteArray(0)) }
        run(); assertTrue(error(), error().contains("bad redirect"))
        route(name) { send(it, 302, ByteArray(0), mapOf("Location" to base + name)) }
        run(); assertTrue(error(), error().contains("bad redirect"))

        // a redirect to a non-https address is refused by default
        UpdateDownloader.redirectOk = defaultRedirectOk
        route(name) { send(it, 302, ByteArray(0), mapOf("Location" to "http://127.0.0.1:1/x")) }
        run(); assertTrue(error(), error().contains("non-https"))
        UpdateDownloader.redirectOk = { true }

        // fewer bytes than the release says
        serveApk()
        run(size = body.size + 1L); assertTrue(error(), error().contains("incomplete"))
        assertFalse(File(dir, "${UpdateDownloader.SUBDIR}/$name.part").exists())
    }

    @Test
    fun rejectsABadChecksumOrAListWithoutTheFile() {
        serveApk()
        route("SHA256SUMS.txt") { send(it, 200, "${"0".repeat(64)}  $name\n".toByteArray()) }
        run(sums = base + "SHA256SUMS.txt"); assertTrue(error(), error().contains("checksum mismatch"))
        assertFalse(File(dir, "${UpdateDownloader.SUBDIR}/$name").exists())

        route("SHA256SUMS.txt") { send(it, 200, "${"0".repeat(64)}  something-else.apk\n".toByteArray()) }
        run(sums = base + "SHA256SUMS.txt"); assertTrue(error(), error().contains("has no entry"))

        route("SHA256SUMS.txt") { send(it, 404, ByteArray(0)) }
        run(sums = base + "SHA256SUMS.txt"); assertTrue(error(), error().contains("HTTP 404"))
    }

    @Test
    fun cancelStopsTheDownloadAndLeavesNothingBehind() {
        UpdateDownloader.cancel() // nothing running: harmless
        val stall = CountDownLatch(1)
        route(name) { out ->
            out.write("HTTP/1.1 200 OK\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray())
            out.write(body, 0, 70_000)
            out.flush()
            stall.await(10, TimeUnit.SECONDS)
        }
        assertNull(UpdateDownloader.start(dir, base + name, name, body.size.toLong(), null))
        val deadline = System.currentTimeMillis() + 10_000
        while ((UpdateDownloader.status()["received"] as Long) == 0L && System.currentTimeMillis() < deadline) Thread.sleep(10)
        UpdateDownloader.cancel()
        UpdateDownloader.await()
        stall.countDown()
        assertEquals("idle", state())
        assertEquals("", error())
        assertEquals(0L, UpdateDownloader.status()["received"])
        assertFalse(File(dir, "${UpdateDownloader.SUBDIR}/$name.part").exists())
    }

    @Test
    fun theDefaultRedirectPolicyOnlyAcceptsHttps() {
        assertTrue(defaultRedirectOk(URL("https://objects.githubusercontent.com/x")))
        assertFalse(defaultRedirectOk(URL("http://objects.githubusercontent.com/x")))
        assertTrue(defaultPrefix.startsWith("https://github.com/Blockheads-Club/blockheads-patcher/releases/download/"))
    }
}
