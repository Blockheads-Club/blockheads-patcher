package com.blockheadspatcher.apktools

import android.app.Activity
import android.content.Intent
import android.content.IntentSender
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Looper
import androidx.activity.result.ActivityResult
import app.tauri.plugin.Invoke
import app.tauri.plugin.PluginHandle
import com.fasterxml.jackson.databind.ObjectMapper
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.kotlin.any
import org.mockito.kotlin.argumentCaptor
import org.mockito.kotlin.timeout
import org.mockito.kotlin.doReturn
import org.mockito.kotlin.doThrow
import org.mockito.kotlin.eq
import org.mockito.kotlin.mock
import org.mockito.kotlin.spy
import org.mockito.kotlin.verify
import org.mockito.kotlin.whenever
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

class TestActivity : Activity() {
    var pm: PackageManager? = null
    var failStart = false
    override fun getPackageManager(): PackageManager = pm ?: super.getPackageManager()
    override fun startActivity(intent: Intent) {
        if (failStart) throw android.content.ActivityNotFoundException("no viewer")
        super.startActivity(intent)
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ApkToolsPluginTest {
    private lateinit var activity: TestActivity
    private lateinit var pm: PackageManager
    private lateinit var plugin: ApkToolsPlugin
    private lateinit var handle: PluginHandle
    private val responses = CopyOnWriteArrayList<Pair<Long, String>>()

    @Before
    fun setUp() {
        activity = Robolectric.buildActivity(TestActivity::class.java).create().get()
        pm = spy(activity.packageManager)
        activity.pm = pm
        handle = mock()
        plugin = ApkToolsPlugin(activity)
        plugin.handle = handle
    }

    @After
    fun tearDown() {
        File(activity.cacheDir, "bhp").deleteRecursively()
    }

    private fun invoke(json: String = "{}"): Invoke =
        Invoke(1, "cmd", 10L, 20L, { cb, data -> responses.add(cb to data) }, json, ObjectMapper())

    private fun pkgArgs(name: String) = """{"packageName":"$name"}"""

    /** Waits (idling the main looper) until [n] responses arrived. */
    private fun await(n: Int = 1): List<Pair<Long, String>> {
        val deadline = System.currentTimeMillis() + 10_000
        while (responses.size < n && System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(5)
        }
        assertTrue("expected $n responses, got ${responses.size}", responses.size >= n)
        return responses.toList()
    }

    private fun resolved(i: Int = 0): JSONObject {
        val (cb, data) = responses[i]
        assertEquals(10L, cb)
        return JSONObject(data)
    }

    private fun rejected(i: Int = 0): String {
        val (cb, data) = responses[i]
        assertEquals(20L, cb)
        return JSONObject(data).getString("message")
    }

    private fun installedInfo(
        pkg: String,
        source: String? = "/data/app/base.apk",
        splits: Array<String>? = arrayOf("/data/app/split.apk"),
        versionName: String? = "1.2.3",
        withApp: Boolean = true,
    ): PackageInfo {
        val info = PackageInfo()
        info.packageName = pkg
        info.versionName = versionName
        if (android.os.Build.VERSION.SDK_INT >= 28) info.longVersionCode = 99L
        @Suppress("DEPRECATION")
        info.versionCode = 99
        if (withApp) {
            val app = ApplicationInfo()
            app.sourceDir = source
            app.splitSourceDirs = splits
            info.applicationInfo = app
        }
        return info
    }

    private fun stubInstalled(info: PackageInfo) {
        @Suppress("DEPRECATION")
        doReturn(info).whenever(pm).getPackageInfo(eq(info.packageName), eq(0))
    }

    private fun workFile(name: String, content: String = "apk-bytes"): File {
        val dir = File(activity.cacheDir, "bhp").apply { mkdirs() }
        return File(dir, name).apply { writeText(content) }
    }

    // ---- get_installed_package ----

    @Test
    fun getInstalledPackage_notInstalled() {
        plugin.get_installed_package(invoke(pkgArgs("com.missing")))
        assertFalse(resolved().getBoolean("installed"))
    }

    @Test
    fun getInstalledPackage_full() {
        stubInstalled(installedInfo("com.x"))
        plugin.get_installed_package(invoke(pkgArgs("com.x")))
        val r = resolved()
        assertTrue(r.getBoolean("installed"))
        assertEquals("com.x", r.getString("packageName"))
        assertEquals("1.2.3", r.getString("versionName"))
        assertEquals(99L, r.getLong("versionCode"))
        assertEquals("/data/app/base.apk", r.getString("sourceDir"))
        assertEquals("/data/app/split.apk", r.getJSONArray("splitSourceDirs").getString(0))
    }

    @Test
    fun getInstalledPackage_noVersionNameNoApplicationInfo() {
        stubInstalled(installedInfo("com.x", versionName = null, withApp = false))
        plugin.get_installed_package(invoke(pkgArgs("com.x")))
        val r = resolved()
        assertFalse(r.has("versionName"))
        assertEquals("", r.getString("sourceDir"))
        assertEquals(0, r.getJSONArray("splitSourceDirs").length())
    }

    @Test
    fun getInstalledPackage_nullSourceDir() {
        stubInstalled(installedInfo("com.x", source = null))
        plugin.get_installed_package(invoke(pkgArgs("com.x")))
        assertEquals("", resolved().getString("sourceDir"))
    }

    @Test
    fun getInstalledPackage_noSplits() {
        stubInstalled(installedInfo("com.x", splits = null))
        plugin.get_installed_package(invoke(pkgArgs("com.x")))
        assertEquals(0, resolved().getJSONArray("splitSourceDirs").length())
    }

    @Test
    @Config(sdk = [27])
    fun getInstalledPackage_legacyVersionCode() {
        stubInstalled(installedInfo("com.x"))
        plugin.get_installed_package(invoke(pkgArgs("com.x")))
        assertEquals(99L, resolved().getLong("versionCode"))
    }

    // ---- read_installed_apk ----

    @Test
    fun readInstalledApk_notInstalled() {
        plugin.read_installed_apk(invoke(pkgArgs("com.missing")))
        assertEquals("not_installed", rejected())
    }

    @Test
    fun readInstalledApk_installedWithoutApplicationInfo() {
        stubInstalled(installedInfo("com.x", withApp = false))
        plugin.read_installed_apk(invoke(pkgArgs("com.x")))
        assertEquals("not_installed", rejected())
    }

    @Test
    fun readInstalledApk_copiesBaseApk() {
        val src = File(activity.cacheDir, "src.apk").apply { writeText("hello-apk") }
        stubInstalled(installedInfo("com.x", source = src.absolutePath))
        plugin.read_installed_apk(invoke(pkgArgs("com.x")))
        await()
        val r = resolved()
        assertEquals(9L, r.getLong("size"))
        assertEquals("hello-apk", File(r.getString("path")).readText())
        assertEquals(1, r.getJSONArray("splitSourceDirs").length())
    }

    @Test
    fun readInstalledApk_noSplits() {
        val src = File(activity.cacheDir, "src.apk").apply { writeText("x") }
        stubInstalled(installedInfo("com.x", source = src.absolutePath, splits = null))
        plugin.read_installed_apk(invoke(pkgArgs("com.x")))
        await()
        assertEquals(0, resolved().getJSONArray("splitSourceDirs").length())
    }

    @Test
    fun readInstalledApk_ioError() {
        stubInstalled(installedInfo("com.x", source = "/nonexistent/base.apk"))
        plugin.read_installed_apk(invoke(pkgArgs("com.x")))
        await()
        assertTrue(rejected().startsWith("io_error: "))
    }

    // ---- request_uninstall / uninstallResult ----

    @Test
    fun requestUninstall_notInstalled() {
        plugin.request_uninstall(invoke(pkgArgs("com.missing")))
        assertEquals("not_installed", rejected())
    }

    @Test
    fun requestUninstall_startsDeleteIntent() {
        stubInstalled(installedInfo("com.x"))
        val inv = invoke(pkgArgs("com.x"))
        plugin.request_uninstall(inv)
        val captor = argumentCaptor<Intent>()
        verify(handle).startActivityForResult(eq(inv), captor.capture(), eq("uninstallResult"))
        assertEquals(Intent.ACTION_DELETE, captor.firstValue.action)
        assertEquals("package:com.x", captor.firstValue.dataString)
    }

    @Test
    fun uninstallResult_okAndCancelled() {
        plugin.uninstallResult(invoke(), ActivityResult(Activity.RESULT_OK, null))
        plugin.uninstallResult(invoke(), ActivityResult(Activity.RESULT_CANCELED, null))
        assertTrue(resolved(0).getBoolean("completed"))
        assertTrue(resolved(0).getBoolean("started"))
        assertFalse(resolved(1).getBoolean("completed"))
    }

    // ---- can_request_installs / open_install_settings ----

    @Test
    fun canRequestInstalls_allowedAndDenied() {
        doReturn(true).whenever(pm).canRequestPackageInstalls()
        plugin.can_request_installs(invoke())
        doReturn(false).whenever(pm).canRequestPackageInstalls()
        plugin.can_request_installs(invoke())
        assertTrue(resolved(0).getBoolean("allowed"))
        assertFalse(resolved(1).getBoolean("allowed"))
    }

    @Test
    @Config(sdk = [24])
    fun canRequestInstalls_preOreoAlwaysAllowed() {
        plugin.can_request_installs(invoke())
        assertTrue(resolved().getBoolean("allowed"))
    }

    @Test
    fun openInstallSettings_startsSettingsActivity() {
        plugin.open_install_settings(invoke())
        val started = shadowOf(activity).nextStartedActivity
        assertEquals(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, started.action)
        assertEquals("package:${activity.packageName}", started.dataString)
        assertEquals(10L, responses[0].first)
    }

    // ---- install_apk validation ----

    private fun installArgs(path: String) = JSONObject().put("path", path).toString()

    @Test
    fun installApk_rejectsUnresolvablePath() {
        plugin.install_apk(invoke(installArgs("bad\u0000path")))
        assertEquals("invalid_path", rejected())
    }

    @Test
    fun installApk_rejectsPathOutsideWorkDir() {
        val outside = File(activity.cacheDir, "outside.apk").apply { writeText("x") }
        plugin.install_apk(invoke(installArgs(outside.absolutePath)))
        assertEquals("invalid_path", rejected())
    }

    @Test
    fun installApk_rejectsDirectoryAndMissingFile() {
        val dir = File(activity.cacheDir, "bhp/sub").apply { mkdirs() }
        plugin.install_apk(invoke(installArgs(dir.absolutePath)))
        plugin.install_apk(invoke(installArgs(File(dir.parentFile, "missing.apk").absolutePath)))
        assertEquals("invalid_path", rejected(0))
        assertEquals("invalid_path", rejected(1))
    }

    @Test
    fun installApk_permissionDenied() {
        val f = workFile("a.apk")
        doReturn(false).whenever(pm).canRequestPackageInstalls()
        plugin.install_apk(invoke(installArgs(f.absolutePath)))
        assertEquals("permission_denied", rejected())
    }

    // ---- install_apk session flow ----

    private class SessionFixture(val installer: PackageInstaller, val session: PackageInstaller.Session, val out: ByteArrayOutputStream)

    private fun mockSession(sessionId: Int = 7): SessionFixture {
        val installer: PackageInstaller = mock()
        val session: PackageInstaller.Session = mock()
        val out = ByteArrayOutputStream()
        doReturn(sessionId).whenever(installer).createSession(any())
        doReturn(session).whenever(installer).openSession(eq(sessionId))
        doReturn(out).whenever(session).openWrite(any(), any(), any())
        doReturn(installer).whenever(pm).packageInstaller
        if (android.os.Build.VERSION.SDK_INT >= 26) doReturn(true).whenever(pm).canRequestPackageInstalls()
        return SessionFixture(installer, session, out)
    }

    private fun sendStatus(sessionId: Int, status: Int, message: String? = null, confirm: Intent? = null) {
        val i = Intent("${activity.packageName}.APK_TOOLS_INSTALL_RESULT.$sessionId")
            .setPackage(activity.packageName)
            .putExtra(PackageInstaller.EXTRA_STATUS, status)
        message?.let { i.putExtra(PackageInstaller.EXTRA_STATUS_MESSAGE, it) }
        confirm?.let { i.putExtra(Intent.EXTRA_INTENT, it) }
        activity.sendBroadcast(i)
        shadowOf(Looper.getMainLooper()).idle()
    }

    private fun startInstall(f: File, fx: SessionFixture) {
        plugin.install_apk(invoke(installArgs(f.absolutePath)))
        // the worker thread registers the receiver before committing
        verify(fx.session, timeout(10_000)).commit(any<IntentSender>())
    }

    @Test
    fun installApk_sessionSuccessAfterPendingUserAction() {
        val f = workFile("a.apk", "payload")
        val fx = mockSession()
        startInstall(f, fx)
        assertEquals("payload", fx.out.toString())
        // user action needed: confirm intent forwarded, no response yet
        sendStatus(7, PackageInstaller.STATUS_PENDING_USER_ACTION, confirm = Intent("confirm.me"))
        assertEquals("confirm.me", shadowOf(activity.application).nextStartedActivity.action)
        assertTrue(responses.isEmpty())
        // pending without an intent is ignored
        sendStatus(7, PackageInstaller.STATUS_PENDING_USER_ACTION)
        assertTrue(responses.isEmpty())
        sendStatus(7, PackageInstaller.STATUS_SUCCESS)
        val r = resolved()
        assertEquals("success", r.getString("status"))
        assertTrue(r.getBoolean("started"))
        // receiver unregistered: second broadcast is not delivered
        sendStatus(7, PackageInstaller.STATUS_SUCCESS)
        assertEquals(1, responses.size)
    }

    @Test
    @Config(sdk = [30])
    fun installApk_sessionOnOlderSdk_failureCodes() {
        val cases = listOf(
            PackageInstaller.STATUS_FAILURE_CONFLICT to "install_conflict",
            PackageInstaller.STATUS_FAILURE_INCOMPATIBLE to "install_conflict",
            PackageInstaller.STATUS_FAILURE_ABORTED to "install_aborted",
            PackageInstaller.STATUS_FAILURE_STORAGE to "install_storage",
            PackageInstaller.STATUS_FAILURE to "install_failed",
        )
        cases.forEachIndexed { idx, (status, code) ->
            val f = workFile("a$idx.apk")
            startInstall(f, mockSession(idx + 1))
            // message present for the first case, absent for the rest
            sendStatus(idx + 1, status, message = if (idx == 0) "boom" else null)
            assertEquals(if (idx == 0) "$code: boom" else "$code: ", rejected(idx))
        }
    }

    @Test
    fun installApk_commitFailureCleansUpAndFallsBackToViewIntent() {
        val f = workFile("a.apk")
        activity.failStart = true
        val fx = mockSession()
        doThrow(RuntimeException("commit")).whenever(fx.session).commit(any<IntentSender>())
        doThrow(RuntimeException("abandon")).whenever(fx.installer).abandonSession(any())
        plugin.install_apk(invoke(installArgs(f.absolutePath)))
        await()
        verify(fx.installer).abandonSession(7)
        // the ACTION_VIEW fallback fails too
        assertEquals(20L, responses[0].first)
        assertTrue(rejected().startsWith("io_error: "))
    }

    @Test
    fun installApk_writeFailureBeforeReceiverRegistrationAbandonsSession() {
        val f = workFile("a.apk")
        val fx = mockSession()
        doThrow(java.io.IOException("disk")).whenever(fx.session).openWrite(any(), any(), any())
        plugin.install_apk(invoke(installArgs(f.absolutePath)))
        await()
        verify(fx.installer).abandonSession(7)
    }

    @Test
    fun installApk_sessionCreationFailureThenViewFallbackFails() {
        val f = workFile("a.apk")
        activity.failStart = true
        doReturn(true).whenever(pm).canRequestPackageInstalls()
        val installer: PackageInstaller = mock()
        doThrow(RuntimeException("no session")).whenever(installer).createSession(any())
        doReturn(installer).whenever(pm).packageInstaller
        plugin.install_apk(invoke(installArgs(f.absolutePath)))
        await()
        assertEquals(20L, responses[0].first)
        assertTrue(rejected().startsWith("io_error: "))
    }

    @Test
    fun installApk_fallbackSuccessWithProvider() {
        val f = workFile("a.apk")
        doReturn(true).whenever(pm).canRequestPackageInstalls()
        val installer: PackageInstaller = mock()
        doThrow(RuntimeException("no session")).whenever(installer).createSession(any())
        doReturn(installer).whenever(pm).packageInstaller
        // register the provider so FileProvider.getUriForFile succeeds
        val info = android.content.pm.ProviderInfo().apply {
            authority = "${activity.packageName}.apkfileprovider"
            name = ApkFileProvider::class.java.name
            packageName = activity.packageName
            exported = false
            grantUriPermissions = true
        }
        Robolectric.buildContentProvider(ApkFileProvider::class.java).create(info)
        plugin.install_apk(invoke(installArgs(f.absolutePath)))
        await()
        assertEquals(10L, responses[0].first)
        assertEquals("pending", resolved().getString("status"))
    }

    @Test
    @Config(sdk = [24])
    fun installApk_preOreoSkipsPermissionCheckAndUsesLegacyFlags() {
        val f = workFile("a.apk")
        val fx = mockSession()
        startInstall(f, fx)
        sendStatus(7, PackageInstaller.STATUS_SUCCESS)
        assertEquals("success", resolved().getString("status"))
    }

    @Test
    fun installApk_fileProviderClassIsInstantiable() {
        assertNotNull(ApkFileProvider())
    }

}
