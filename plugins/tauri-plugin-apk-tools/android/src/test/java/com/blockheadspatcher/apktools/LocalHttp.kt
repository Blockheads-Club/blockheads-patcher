package com.blockheadspatcher.apktools

import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/** A tiny HTTP/1.1 server on 127.0.0.1 for the update tests (android.jar has no com.sun.net.httpserver). */
class LocalHttp : AutoCloseable {
    private val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    private val routes = ConcurrentHashMap<String, (OutputStream) -> Unit>()
    private val pool = Executors.newCachedThreadPool()
    val base = "http://127.0.0.1:${server.localPort}/dl/"

    init {
        Thread {
            try {
                while (true) {
                    val c = server.accept()
                    pool.execute { try { serve(c) } catch (_: Exception) { /* client went away */ } }
                }
            } catch (_: Exception) { /* closed */ }
        }.apply { isDaemon = true }.start()
    }

    /** Answers GET `<base><path>` with [handler], which writes the whole response to the stream. */
    fun route(path: String, handler: (OutputStream) -> Unit) { routes["/dl/$path"] = handler }

    /** A complete response: status line, Content-Length, [headers], body. */
    fun send(out: OutputStream, code: Int, data: ByteArray, headers: Map<String, String> = emptyMap()) {
        val head = StringBuilder("HTTP/1.1 $code X\r\nContent-Length: ${data.size}\r\nConnection: close\r\n")
        headers.forEach { (k, v) -> head.append("$k: $v\r\n") }
        out.write((head.toString() + "\r\n").toByteArray())
        out.write(data)
        out.flush()
    }

    private fun serve(socket: Socket) = socket.use { s ->
        val lines = s.getInputStream().bufferedReader()
        val path = lines.readLine().split(" ")[1]
        while (lines.readLine().isNotEmpty()) { /* skip the request headers */ }
        val out = s.getOutputStream()
        routes[path]?.invoke(out) ?: send(out, 404, ByteArray(0))
    }

    override fun close() { server.close(); pool.shutdownNow() }
}
