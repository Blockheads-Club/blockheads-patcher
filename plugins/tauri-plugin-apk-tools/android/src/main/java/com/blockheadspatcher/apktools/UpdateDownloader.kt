package com.blockheadspatcher.apktools

import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

/**
 * Downloads a Patcher release APK for the in-app update into `<cache>/bhp/updates/` on a worker thread. The file is
 * written as `<name>.part`, checked (size, and SHA-256 against the release's SHA256SUMS.txt when one is given) and
 * moved to `<name>` only when it is complete, so an existing `.apk` there is always verified.
 *
 * Only this repository's release downloads are accepted (the JS side picks the asset from the GitHub release feed;
 * this check keeps the plugin from fetching anything else). GitHub redirects to its storage host, so redirects are
 * followed by hand, to https addresses only.
 */
object UpdateDownloader {
    const val SUBDIR = "updates"
    private const val SUMS = "SHA256SUMS.txt"
    private val NAME = Regex("^blockheads-patcher-[0-9A-Za-z.+-]+-android-[a-z0-9_]+\\.apk$")
    private val SUMS_LINE = Regex("^([0-9a-fA-F]{64})\\s+\\*?(.+?)\\s*$")

    /** Where release files live; tests point it at a local server. */
    internal var prefix = "https://github.com/Blockheads-Club/blockheads-patcher/releases/download/"
    /** Whether a redirect target is acceptable; tests allow plain http on localhost. */
    internal var redirectOk: (URL) -> Boolean = { it.protocol == "https" }

    @Volatile private var cancelled = false
    // Never null: a thread / connection that does nothing until the first download replaces them.
    @Volatile private var worker: Thread = Thread()
    @Volatile private var conn: HttpURLConnection = URL("http://localhost/").openConnection() as HttpURLConnection
    @Volatile private var state = "idle"
    @Volatile private var received = 0L
    @Volatile private var total = 0L
    @Volatile private var path = ""
    @Volatile private var error = ""

    private fun fits(url: String, file: String) = url.startsWith(prefix) && url.endsWith("/$file")

    /** Returns an error code ("invalid_url", "busy"), or null when the download started. */
    @Synchronized
    fun start(workDir: File, url: String, name: String, size: Long, sumsUrl: String?): String? {
        if (size <= 0 || !NAME.matches(name) || !fits(url, name) || (sumsUrl != null && !fits(sumsUrl, SUMS))) return "invalid_url"
        if (worker.isAlive) return "busy"
        val dir = File(workDir, SUBDIR).apply { mkdirs() }
        // older update files and stale partial downloads
        dir.walkTopDown().filter { it.isFile }.forEach { it.delete() }
        cancelled = false
        state = "running"; received = 0; total = size; error = ""; path = File(dir, name).absolutePath
        worker = Thread({ run(dir, url, name, size, sumsUrl) }, "bhp-update").also { it.start() }
        return null
    }

    fun cancel() {
        cancelled = true
        conn.disconnect()
    }

    /** Waits for the running download (tests). */
    internal fun await() = worker.join()

    /** `{state: idle|running|done|error, received, total, path, error}` for the UI to poll. */
    fun status(): Map<String, Any> =
        mapOf("state" to state, "received" to received, "total" to total, "path" to path, "error" to error)

    private fun open(first: String): HttpURLConnection {
        var u = URL(first)
        var hops = 0
        while (true) {
            val c = u.openConnection() as HttpURLConnection
            conn = c
            c.instanceFollowRedirects = false
            c.connectTimeout = 15000
            c.readTimeout = 30000
            c.setRequestProperty("User-Agent", "Blockheads-Patcher-Android")
            val code = c.responseCode
            if (code !in 300..399) {
                check(code == 200) { "HTTP $code" }
                return c
            }
            val location = c.getHeaderField("Location")
            c.disconnect()
            check(location != null && ++hops <= 8) { "bad redirect" }
            u = URL(u, location)
            check(redirectOk(u)) { "redirect to a non-https address" }
        }
    }

    private fun expectedSha(sumsUrl: String, name: String): String {
        val text = open(sumsUrl).inputStream.use { it.readBytes() }.toString(Charsets.UTF_8)
        // `sha256sum` lines: "<64 hex>  <name>" (a "*" before the name marks binary mode)
        val hit = text.lines().mapNotNull { SUMS_LINE.find(it) }.firstOrNull { it.groupValues[2] == name }
        return checkNotNull(hit) { "$SUMS has no entry for $name" }.groupValues[1].lowercase()
    }

    private fun run(dir: File, url: String, name: String, size: Long, sumsUrl: String?) {
        val part = File(dir, "$name.part")
        val dest = File(dir, name)
        try {
            val want = sumsUrl?.let { expectedSha(it, name) }
            val md = MessageDigest.getInstance("SHA-256")
            val buf = ByteArray(64 * 1024)
            var got = 0L
            open(url).inputStream.use { input ->
                FileOutputStream(part).use { out ->
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        md.update(buf, 0, n)
                        got += n
                        received = got
                    }
                    out.fd.sync()
                }
            }
            check(got == size) { "incomplete ($got of $size bytes)" }
            check(want == null || md.digest().joinToString("") { "%02x".format(it) } == want) { "checksum mismatch" }
            Files.move(part.toPath(), dest.toPath(), StandardCopyOption.REPLACE_EXISTING)
            state = "done"
        } catch (e: Exception) {
            part.delete()
            received = 0
            if (cancelled) state = "idle" else { error = e.toString(); state = "error" }
        } finally {
            conn.disconnect()
        }
    }
}
