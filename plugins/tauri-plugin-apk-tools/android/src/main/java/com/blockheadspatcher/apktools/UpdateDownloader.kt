package com.blockheadspatcher.apktools

import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Downloads a Patcher release APK for the in-app update into `<cache>/bhp/updates/` on a worker thread. The file is
 * written as `<name>.part`, checked (size, and SHA-256 against the release's SHA256SUMS.txt when it has one) and
 * renamed to `<name>` only when it is complete, so an existing `.apk` there is always verified.
 *
 * Only this repository's release downloads are accepted (the JS side picks the asset from the GitHub release feed;
 * this check keeps the plugin from fetching anything else). GitHub redirects to its storage host, so redirects to
 * other https hosts are followed by hand.
 */
object UpdateDownloader {
    const val SUBDIR = "updates"
    private const val PREFIX = "https://github.com/Blockheads-Club/blockheads-patcher/releases/download/"
    private val NAME = Regex("^blockheads-patcher-[0-9A-Za-z.+-]+-android-[a-z0-9_]+\\.apk$")
    private const val SUMS_NAME = "SHA256SUMS.txt"

    private val cancelled = AtomicBoolean(false)
    @Volatile private var worker: Thread? = null
    @Volatile private var conn: HttpURLConnection? = null
    @Volatile private var state = "idle"
    @Volatile private var received = 0L
    @Volatile private var total = 0L
    @Volatile private var path = ""
    @Volatile private var error = ""

    /** Returns an error code, or null when the download started (or is already running for the same file). */
    @Synchronized
    fun start(workDir: File, url: String, name: String, size: Long, sumsUrl: String?): String? {
        if (!url.startsWith(PREFIX) || !NAME.matches(name) || !url.endsWith("/$name")) return "invalid_url"
        if (sumsUrl != null && !(sumsUrl.startsWith(PREFIX) && sumsUrl.endsWith("/$SUMS_NAME"))) return "invalid_url"
        if (worker?.isAlive == true) {
            if (cancelled.get()) try { worker?.join(1500) } catch (_: InterruptedException) {}
            if (worker?.isAlive == true) return if (path.endsWith("/$name")) null else "busy"
        }
        val dir = File(workDir, SUBDIR).apply { mkdirs() }
        // older update files and stale partial downloads
        dir.listFiles()?.forEach { if (it.name != name && it.name != "$name.part") it.delete() }
        cancelled.set(false)
        state = "running"; received = 0; total = size; error = ""; path = File(dir, name).absolutePath
        val t = Thread({ run(dir, url, name, size, sumsUrl) }, "bhp-update")
        worker = t
        t.start()
        return null
    }

    fun cancel() {
        cancelled.set(true)
        try { conn?.disconnect() } catch (_: Exception) {}
    }

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
            if (code in 300..399) {
                val loc = c.getHeaderField("Location") ?: throw Exception("redirect without Location")
                c.disconnect()
                if (++hops > 8) throw Exception("too many redirects")
                u = URL(u, loc)
                if (u.protocol != "https") throw Exception("redirect to a non-https address")
                continue
            }
            if (code != 200) { c.disconnect(); throw Exception("HTTP $code") }
            return c
        }
    }

    private fun expectedSha(sumsUrl: String, name: String): String {
        val c = open(sumsUrl)
        val text = c.inputStream.use { it.readLimited(256 * 1024).toString(Charsets.UTF_8) }
        // `sha256sum` lines: "<64 hex>  <name>" (a "*" before the name marks binary mode)
        for (line in text.lines()) {
            val m = Regex("^([0-9a-fA-F]{64})\\s+\\*?(.+?)\\s*$").find(line) ?: continue
            if (m.groupValues[2] == name) return m.groupValues[1].lowercase()
        }
        throw Exception("$SUMS_NAME has no entry for $name")
    }

    private fun java.io.InputStream.readLimited(limit: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(8192)
        while (true) {
            val n = read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            if (out.size() > limit) throw Exception("checksum file too large")
        }
        return out.toByteArray()
    }

    private fun run(dir: File, url: String, name: String, size: Long, sumsUrl: String?) {
        val part = File(dir, "$name.part")
        val dest = File(dir, name)
        try {
            part.delete(); dest.delete()
            val want = sumsUrl?.let { expectedSha(it, name) }
            val c = open(url)
            val len = c.contentLengthLong
            if (size > 0 && len > 0 && len != size) throw Exception("size mismatch ($len != $size)")
            val expect = if (size > 0) size else len
            if (len > 0) total = len else if (size > 0) total = size
            val md = MessageDigest.getInstance("SHA-256")
            val buf = ByteArray(64 * 1024)
            var got = 0L
            c.inputStream.use { input ->
                FileOutputStream(part).use { out ->
                    while (true) {
                        if (cancelled.get()) throw InterruptedException()
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        md.update(buf, 0, n)
                        got += n
                        received = got
                    }
                    out.flush()
                    out.fd.sync()
                }
            }
            if (expect > 0 && got != expect) throw Exception("incomplete ($got of $expect bytes)")
            if (want != null) {
                val have = md.digest().joinToString("") { "%02x".format(it) }
                if (have != want) throw Exception("checksum mismatch")
            }
            if (!part.renameTo(dest)) throw Exception("rename failed")
            total = got
            state = "done"
        } catch (_: InterruptedException) {
            part.delete(); received = 0; state = "idle"
        } catch (e: Exception) {
            part.delete()
            if (cancelled.get()) { received = 0; state = "idle" } else { error = e.message ?: e.toString(); state = "error" }
        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
            conn = null
        }
    }
}
