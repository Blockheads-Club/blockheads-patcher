package com.blockheadspatcher.apktools

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.annotation.ActivityCallback
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class PackageArgs {
    var packageName: String = ""
}

@InvokeArg
class PathArgs {
    var path: String = ""
}

@TauriPlugin
class ApkToolsPlugin(private val activity: Activity) : Plugin(activity) {

    private val workDir: File
        get() = File(activity.cacheDir, "bhp").apply { mkdirs() }

    @Suppress("DEPRECATION")
    private fun packageInfo(pkg: String) = try {
        activity.packageManager.getPackageInfo(pkg, 0)
    } catch (e: PackageManager.NameNotFoundException) {
        null
    }

    @Command
    fun get_installed_package(invoke: Invoke) {
        val args = invoke.parseArgs(PackageArgs::class.java)
        val res = JSObject()
        val info = packageInfo(args.packageName)
        if (info == null) {
            res.put("installed", false)
            invoke.resolve(res)
            return
        }
        val app = info.applicationInfo
        res.put("installed", true)
        res.put("packageName", info.packageName)
        info.versionName?.let { res.put("versionName", it) }
        val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
        res.put("versionCode", code)
        res.put("sourceDir", app?.sourceDir ?: "")
        val splits = JSArray()
        app?.splitSourceDirs?.forEach { splits.put(it) }
        res.put("splitSourceDirs", splits)
        invoke.resolve(res)
    }

    @Command
    fun read_installed_apk(invoke: Invoke) {
        val args = invoke.parseArgs(PackageArgs::class.java)
        val app = packageInfo(args.packageName)?.applicationInfo
        if (app == null) {
            invoke.reject("not_installed")
            return
        }
        Thread {
            try {
                val out = File(workDir, "${args.packageName}-base.apk")
                File(app.sourceDir).inputStream().use { i -> out.outputStream().use { o -> i.copyTo(o, 1 shl 16) } }
                val res = JSObject()
                res.put("path", out.absolutePath)
                res.put("size", out.length())
                val splits = JSArray()
                app.splitSourceDirs?.forEach { splits.put(it) }
                res.put("splitSourceDirs", splits)
                invoke.resolve(res)
            } catch (e: Exception) {
                invoke.reject("io_error: ${e.message}")
            }
        }.start()
    }

    @Command
    fun request_uninstall(invoke: Invoke) {
        val args = invoke.parseArgs(PackageArgs::class.java)
        if (packageInfo(args.packageName) == null) {
            invoke.reject("not_installed")
            return
        }
        @Suppress("DEPRECATION")
        val intent = Intent(Intent.ACTION_DELETE, Uri.parse("package:${args.packageName}"))
            .putExtra(Intent.EXTRA_RETURN_RESULT, true)
        startActivityForResult(invoke, intent, "uninstallResult")
    }

    @ActivityCallback
    fun uninstallResult(invoke: Invoke, result: ActivityResult) {
        val res = JSObject()
        // RESULT_OK = uninstalled; RESULT_CANCELED = user declined. In both cases the dialog was shown.
        res.put("started", true)
        res.put("completed", result.resultCode == Activity.RESULT_OK)
        invoke.resolve(res)
    }

    @Command
    fun can_request_installs(invoke: Invoke) {
        val res = JSObject()
        res.put("allowed", Build.VERSION.SDK_INT < 26 || activity.packageManager.canRequestPackageInstalls())
        invoke.resolve(res)
    }

    @Command
    fun open_install_settings(invoke: Invoke) {
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.startActivity(intent)
        invoke.resolve(JSObject())
    }

    @Command
    fun install_apk(invoke: Invoke) {
        val args = invoke.parseArgs(PathArgs::class.java)
        val file = try { File(args.path).canonicalFile } catch (e: Exception) { null }
        val base = workDir.canonicalFile
        if (file == null || !file.path.startsWith(base.path + File.separator) || !file.isFile) {
            invoke.reject("invalid_path")
            return
        }
        if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
            invoke.reject("permission_denied")
            return
        }
        Thread {
            try {
                // Resolves/rejects `invoke` from the receiver once the installer reports a final status.
                installWithSession(file, invoke)
            } catch (e: Exception) {
                // Session setup failed before commit; fall back to FileProvider + ACTION_VIEW (no final status available).
                try {
                    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.apkfileprovider", file)
                    val view = Intent(Intent.ACTION_VIEW)
                        .setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                    activity.startActivity(view)
                    val res = JSObject()
                    res.put("started", true)
                    res.put("status", "pending")
                    invoke.resolve(res)
                } catch (e2: Exception) {
                    invoke.reject("io_error: ${e2.message}")
                }
            }
        }.start()
    }

    private fun failureCode(status: Int): String = when (status) {
        PackageInstaller.STATUS_FAILURE_CONFLICT,
        PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "install_conflict"
        PackageInstaller.STATUS_FAILURE_ABORTED -> "install_aborted"
        PackageInstaller.STATUS_FAILURE_STORAGE -> "install_storage"
        else -> "install_failed"
    }

    private fun installWithSession(file: File, invoke: Invoke) {
        val installer = activity.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setSize(file.length())
        val sessionId = installer.createSession(params)
        var receiver: BroadcastReceiver? = null
        try {
            installer.openSession(sessionId).use { session ->
                file.inputStream().use { i ->
                    session.openWrite("base.apk", 0, file.length()).use { o ->
                        i.copyTo(o, 1 shl 16)
                        session.fsync(o)
                    }
                }
                val action = "${activity.packageName}.APK_TOOLS_INSTALL_RESULT.$sessionId"
                val r = object : BroadcastReceiver() {
                    override fun onReceive(context: Context, intent: Intent) {
                        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
                        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                            @Suppress("DEPRECATION")
                            val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                            confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            if (confirm != null) context.startActivity(confirm)
                            return
                        }
                        try { context.unregisterReceiver(this) } catch (_: Exception) {}
                        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: ""
                        if (status == PackageInstaller.STATUS_SUCCESS) {
                            val res = JSObject()
                            res.put("started", true)
                            res.put("status", "success")
                            invoke.resolve(res)
                        } else {
                            invoke.reject("${failureCode(status)}: $message")
                        }
                    }
                }
                receiver = r
                val filter = IntentFilter(action)
                if (Build.VERSION.SDK_INT >= 33) {
                    activity.registerReceiver(r, filter, Context.RECEIVER_NOT_EXPORTED)
                } else {
                    @Suppress("UnspecifiedRegisterReceiverFlag")
                    activity.registerReceiver(r, filter)
                }
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                val pi = PendingIntent.getBroadcast(
                    activity, sessionId,
                    Intent(action).setPackage(activity.packageName), flags
                )
                session.commit(pi.intentSender)
            }
        } catch (e: Exception) {
            receiver?.let { try { activity.unregisterReceiver(it) } catch (_: Exception) {} }
            try { installer.abandonSession(sessionId) } catch (_: Exception) {}
            throw e
        }
    }
}
