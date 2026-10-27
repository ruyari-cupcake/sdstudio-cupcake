package io.sunho.SDStudio

import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.security.KeyPairGeneratorSpec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.util.Calendar
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.Cipher
import javax.security.auth.x500.X500Principal

@CapacitorPlugin(name = "AppUpdates")
class AppUpdatesPlugin : Plugin() {
  companion object {
    private val startupClaimed = AtomicBoolean(false)
    private const val KEY_ALIAS = "sdstudio-release-token"
    private const val SNOOZE_MS = 7L * 24 * 60 * 60 * 1000
  }
  private class UpdateFailure(message: String) : Exception(message)
  private data class Release(
    val version: String, val assetId: Long, val name: String,
    val size: Long, val sha256: String, val publicValue: JSObject
  )
  private val worker = Executors.newSingleThreadExecutor()
  private val client = OkHttpClient.Builder()
    .followRedirects(false)
    .retryOnConnectionFailure(false)
    .readTimeout(0, TimeUnit.MILLISECONDS)
    .build()
  private val downloading = AtomicBoolean(false)
  private val canceled = AtomicBoolean(false)
  @Volatile private var downloadCall: Call? = null
  private var checked: Release? = null
  private var ready: Pair<Release, File>? = null

  private val channel get() = BuildConfig.UPDATE_CHANNEL
  private val isPrivate get() = channel == "private"
  private val repository get() = BuildConfig.UPDATE_OWNER + "/" + BuildConfig.UPDATE_REPO
  private val api get() = "https://api.github.com/repos/" + repository
  private val prefs get() = context.getSharedPreferences("app-updates-" + channel, 0)

  private fun result(vararg fields: Pair<String, Any?>): JSObject {
    val value = JSObject()
    fields.forEach { value.put(it.first, it.second ?: JSONObject.NULL) }
    return value
  }
  private fun work(call: PluginCall, body: () -> JSObject?) {
    worker.execute {
      try {
        val value = body()
        if (value == null) call.resolve() else call.resolve(value)
      } catch (error: Exception) {
        call.reject(if (error is UpdateFailure) error.message else "업데이트를 완료하지 못했습니다. 다시 시도해 주세요.")
      }
    }
  }
  private fun commit(editor: android.content.SharedPreferences.Editor) {
    if (!editor.commit()) throw UpdateFailure("업데이트 설정을 저장하지 못했습니다.")
  }

  private fun keyStore(): KeyStore {
    val store = KeyStore.getInstance("AndroidKeyStore")
    store.load(null)
    if (!store.containsAlias(KEY_ALIAS)) {
      val generator = KeyPairGenerator.getInstance("RSA", "AndroidKeyStore")
      if (Build.VERSION.SDK_INT >= 23) {
        generator.initialize(KeyGenParameterSpec.Builder(
          KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        ).setKeySize(2048).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_PKCS1).build())
      } else {
        val start = Calendar.getInstance()
        val end = Calendar.getInstance().apply { add(Calendar.YEAR, 100) }
        @Suppress("DEPRECATION")
        val spec = KeyPairGeneratorSpec.Builder(context).setAlias(KEY_ALIAS)
          .setSubject(X500Principal("CN=SDStudio Updates")).setSerialNumber(BigInteger.ONE)
          .setStartDate(start.time).setEndDate(end.time).setKeySize(2048).build()
        generator.initialize(spec)
      }
      generator.generateKeyPair()
    }
    return store
  }
  private fun encrypt(token: String): String {
    val cipher = Cipher.getInstance("RSA/ECB/PKCS1Padding")
    cipher.init(Cipher.ENCRYPT_MODE, keyStore().getCertificate(KEY_ALIAS).publicKey)
    return Base64.encodeToString(cipher.doFinal(token.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
  }
  private fun token(): String? {
    if (!isPrivate) return null
    val encrypted = prefs.getString("token", null) ?: return null
    try {
      val cipher = Cipher.getInstance("RSA/ECB/PKCS1Padding")
      cipher.init(Cipher.DECRYPT_MODE, keyStore().getKey(KEY_ALIAS, null) as PrivateKey)
      return String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), Charsets.UTF_8)
    } catch (_: Exception) {
      throw UpdateFailure("비공개 업데이트를 다시 연결해 주세요.")
    }
  }

  private fun request(url: String, credential: String?, binary: Boolean = false): Request {
    val builder = Request.Builder().url(url)
      .header("Accept", if (binary) "application/octet-stream" else "application/vnd.github+json")
      .header("X-GitHub-Api-Version", "2022-11-28")
    if (isPrivate && credential != null) builder.header("Authorization", "Bearer " + credential)
    return builder.build()
  }
  private fun failure(code: Int): UpdateFailure {
    return if (code == 401 || code == 403 || code == 404)
      UpdateFailure(if (isPrivate) "비공개 업데이트 연결을 확인해 주세요." else "업데이트를 확인할 수 없습니다. 잠시 후 다시 눌러 주세요.")
    else UpdateFailure("업데이트 서버에 연결할 수 없습니다. (" + code + ")")
  }
  private fun verifyAccess(credential: String?) {
    if (isPrivate && credential.isNullOrEmpty()) throw UpdateFailure("비공개 업데이트를 먼저 연결해 주세요.")
    client.newCall(request(api, credential)).execute().use {
      if (!it.isSuccessful) throw failure(it.code)
      val json = JSONObject(readSmall(it, 1024 * 1024).toString(Charsets.UTF_8))
      if (!json.getString("full_name").equals(repository, true))
        throw UpdateFailure("업데이트 저장소가 일치하지 않습니다.")
    }
  }
  private fun readSmall(response: Response, limit: Int): ByteArray {
    val stream = response.body?.byteStream() ?: throw UpdateFailure("업데이트 정보를 받지 못했습니다.")
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    while (true) {
      val count = stream.read(buffer)
      if (count < 0) break
      if (output.size() + count > limit) throw UpdateFailure("업데이트 정보가 올바르지 않습니다.")
      output.write(buffer, 0, count)
    }
    return output.toByteArray()
  }
  private fun assetResponse(id: Long, credential: String?, forDownload: Boolean = false): Response {
    var call = client.newCall(request(api + "/releases/assets/" + id, credential, true))
    if (forDownload) {
      downloadCall = call
      if (canceled.get()) { call.cancel(); throw UpdateFailure("다운로드를 취소했습니다.") }
    }
    val initial = call.execute()
    if (initial.code != 302) {
      if (!initial.isSuccessful) { val code = initial.code; initial.close(); throw failure(code) }
      return initial
    }
    val location = initial.header("Location")
    initial.close()
    val uri = if (location != null) Uri.parse(location) else null
    val host = uri?.host ?: ""
    if (uri?.scheme != "https" || uri.userInfo != null ||
      !(host == "githubusercontent.com" || host.endsWith(".githubusercontent.com")))
      throw UpdateFailure("업데이트 다운로드 주소를 확인할 수 없습니다.")
    // The signed CDN request never receives a repository credential.
    call = client.newCall(Request.Builder().url(location!!).build())
    if (forDownload) {
      downloadCall = call
      if (canceled.get()) { call.cancel(); throw UpdateFailure("다운로드를 취소했습니다.") }
    }
    val response = call.execute()
    if (!response.isSuccessful) { val code = response.code; response.close(); throw failure(code) }
    return response
  }
  private fun versionCode(version: String): Long {
    val match = Regex("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)-cupcake\\.(0|[1-9][0-9]*)$").matchEntire(version)
      ?: throw UpdateFailure("업데이트 버전 정보를 읽을 수 없습니다.")
    val parts = match.groupValues.drop(1).map { it.toLongOrNull() ?: throw UpdateFailure("업데이트 버전 정보를 읽을 수 없습니다.") }
    if (parts.drop(1).any { it >= 100 } || parts[0] > 2100) throw UpdateFailure("업데이트 버전 정보를 읽을 수 없습니다.")
    return parts[0] * 1000000 + parts[1] * 10000 + parts[2] * 100 + parts[3]
  }
  private fun digest(file: File): String {
    val hash = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        hash.update(buffer, 0, count)
      }
    }
    return hash.digest().joinToString("") { "%02x".format(it) }
  }
  private fun progress(release: Release, phase: String, received: Long) {
    notifyListeners("progress", result("phase" to phase, "received" to received, "total" to release.size, "version" to release.version))
  }

  @PluginMethod fun state(call: PluginCall) = work(call) {
    result("channel" to channel, "connected" to (!isPrivate || prefs.contains("token")),
      "supported" to true, "version" to BuildConfig.VERSION_NAME,
      "snoozedUntil" to prefs.getLong("snoozedUntil", 0L))
  }
  @PluginMethod fun claimStartup(call: PluginCall) {
    call.resolve(result("claimed" to startupClaimed.compareAndSet(false, true)))
  }
  @PluginMethod fun snooze(call: PluginCall) = work(call) {
    commit(prefs.edit().putLong("snoozedUntil", System.currentTimeMillis() + SNOOZE_MS))
    null
  }
  @PluginMethod fun connect(call: PluginCall) = work(call) {
    if (!isPrivate) throw UpdateFailure("공개판은 연결 없이 업데이트할 수 있습니다.")
    val value = call.getString("token")?.trim() ?: ""
    if (value.isEmpty() || value.contains('\r') || value.contains('\n')) throw UpdateFailure("GitHub 토큰을 넣어 주세요.")
    verifyAccess(value)
    commit(prefs.edit().putString("token", encrypt(value)))
    checked = null
    null
  }
  @PluginMethod fun disconnect(call: PluginCall) = work(call) {
    commit(prefs.edit().remove("token"))
    checked = null
    null
  }
  @PluginMethod fun check(call: PluginCall) = work(call) {
    val credential = token()
    if (isPrivate && credential.isNullOrEmpty()) throw UpdateFailure("비공개 업데이트를 먼저 연결해 주세요.")
    val response = client.newCall(request(api + "/releases/latest", credential)).execute()
    val releaseJson = response.use {
      if (it.code == 404) {
        verifyAccess(credential)
        checked = null
        return@work result("release" to null)
      }
      if (!it.isSuccessful) throw failure(it.code)
      JSONObject(readSmall(it, 1024 * 1024).toString(Charsets.UTF_8))
    }
    if (releaseJson.getBoolean("draft") || releaseJson.getBoolean("prerelease")) throw UpdateFailure("게시된 업데이트 정보를 읽을 수 없습니다.")
    val tag = releaseJson.getString("tag_name")
    val version = tag.removePrefix("v")
    if (versionCode(version) <= BuildConfig.VERSION_CODE) {
      checked = null
      return@work result("release" to null)
    }
    val files = releaseJson.getJSONArray("assets")
    val allFiles = (0 until files.length()).map { files.getJSONObject(it) }
    val manifests = allFiles.filter { it.getString("name") == "update-manifest.json" }
    if (manifests.size != 1 || manifests[0].getLong("size") !in 1..1024L * 1024)
      throw UpdateFailure("업데이트 파일 목록이 없거나 올바르지 않습니다.")
    val manifestBytes = assetResponse(manifests[0].getLong("id"), credential).use { readSmall(it, 1024 * 1024) }
    if (manifestBytes.size.toLong() != manifests[0].getLong("size")) throw UpdateFailure("업데이트 파일 목록을 끝까지 받지 못했습니다.")
    val manifestDigest = "sha256:" + MessageDigest.getInstance("SHA-256").digest(manifestBytes).joinToString("") { "%02x".format(it) }
    if (!manifests[0].isNull("digest") && manifests[0].getString("digest") != manifestDigest)
      throw UpdateFailure("게시된 업데이트 파일 목록과 받은 내용이 일치하지 않습니다.")
    val manifest = JSONObject(manifestBytes.toString(Charsets.UTF_8))
    if (manifest.getInt("schema") != 1 || manifest.getString("channel") != channel ||
      manifest.getString("appId") != BuildConfig.APPLICATION_ID || manifest.getString("version") != version)
      throw UpdateFailure("이 프로그램에 맞는 업데이트가 아닙니다.")
    val entries = manifest.getJSONArray("assets")
    val kinds = mutableSetOf<String>()
    val names = mutableSetOf<String>()
    var selected: JSONObject? = null
    val extensions = mapOf("windows-portable" to ".exe", "windows-folder" to ".zip", "android-apk" to ".apk")
    if (entries.length() != 3) throw UpdateFailure("업데이트 파일 정보가 올바르지 않습니다.")
    for (index in 0 until entries.length()) {
      val item = entries.getJSONObject(index)
      val kind = item.getString("kind")
      val name = item.getString("name")
      if (!extensions.containsKey(kind) || !kinds.add(kind) || !names.add(name.lowercase()) ||
        name.any { it == '/' || it == '\\' || it == ':' || it.code < 32 } ||
        !name.lowercase().endsWith(extensions[kind]!!) || item.getLong("size") <= 0 ||
        !Regex("^[a-fA-F0-9]{64}$").matches(item.getString("sha256")))
        throw UpdateFailure("업데이트 파일 정보가 올바르지 않습니다.")
      if (kind == "android-apk") selected = item
    }
    val asset = selected ?: throw UpdateFailure("이 기기에 맞는 업데이트 파일이 없습니다.")
    val matches = allFiles.filter { it.getString("name") == asset.getString("name") }
    val expectedHash = asset.getString("sha256").lowercase()
    if (matches.size != 1 || matches[0].getLong("size") != asset.getLong("size") ||
      (!matches[0].isNull("digest") && matches[0].getString("digest") != "sha256:" + expectedHash))
      throw UpdateFailure("게시된 업데이트 파일과 목록이 일치하지 않습니다.")
    val value = result("channel" to channel, "version" to version,
      "releaseUrl" to "https://github.com/" + repository + "/releases/tag/" + Uri.encode(tag),
      "publishedAt" to releaseJson.optString("published_at", ""),
      "notes" to releaseJson.optString("body", ""), "asset" to asset)
    checked = Release(version, matches[0].getLong("id"), asset.getString("name"),
      asset.getLong("size"), expectedHash, value)
    result("release" to value)
  }

  @PluginMethod fun download(call: PluginCall) {
    if (!downloading.compareAndSet(false, true)) { call.reject("업데이트 파일을 받고 있습니다."); return }
    canceled.set(false)
    work(call) {
      var directory: File? = null
      try {
        val release = checked ?: throw UpdateFailure("업데이트를 다시 확인해 주세요.")
        if (call.getString("version") != release.version) throw UpdateFailure("업데이트를 다시 확인해 주세요.")
        ready = null
        val dataName = if (isPrivate) ".SDStudio" else ".SDStudio-Cupcake-Public"
        @Suppress("DEPRECATION")
        val documents = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS)
        directory = File(File(documents, dataName), ".updates/" + channel + "/download")
        val target = File(directory, release.name)
        if (target.isFile && target.length() == release.size && digest(target) == release.sha256) {
          ready = Pair(release, target)
          progress(release, "ready", release.size)
          return@work null
        }
        if (directory.exists() && !directory.deleteRecursively()) throw UpdateFailure("이전 업데이트 파일을 정리하지 못했습니다.")
        if (!directory.mkdirs() && !directory.isDirectory) throw UpdateFailure("업데이트 파일을 저장할 수 없습니다.")
        val temporary = File(directory, release.name + ".part")
        var received = 0L
        var percent = -1L
        val hash = MessageDigest.getInstance("SHA-256")
        progress(release, "downloading", 0)
        assetResponse(release.assetId, token(), true).use { response ->
          val body = response.body ?: throw UpdateFailure("업데이트 파일을 받지 못했습니다.")
          if (body.contentLength() >= 0 && body.contentLength() != release.size) throw UpdateFailure("업데이트 파일 크기가 일치하지 않습니다.")
          body.byteStream().use { input ->
            FileOutputStream(temporary).use { output ->
              val buffer = ByteArray(64 * 1024)
              while (true) {
                if (canceled.get()) throw UpdateFailure("다운로드를 취소했습니다.")
                val count = input.read(buffer)
                if (count < 0) break
                received += count
                if (received > release.size) throw UpdateFailure("업데이트 파일 크기가 일치하지 않습니다.")
                hash.update(buffer, 0, count)
                output.write(buffer, 0, count)
                val next = received * 100 / release.size
                if (next != percent) { percent = next; progress(release, "downloading", received) }
              }
              output.fd.sync()
            }
          }
        }
        if (received != release.size || hash.digest().joinToString("") { "%02x".format(it) } != release.sha256)
          throw UpdateFailure("다운로드가 온전하지 않습니다. 다시 받아 주세요.")
        if (canceled.get()) throw UpdateFailure("다운로드를 취소했습니다.")
        if (!temporary.renameTo(target)) throw UpdateFailure("업데이트 파일을 저장하지 못했습니다.")
        ready = Pair(release, target)
        progress(release, "ready", received)
        null
      } catch (error: Exception) {
        ready = null
        directory?.deleteRecursively()
        if (canceled.get()) throw UpdateFailure("다운로드를 취소했습니다.")
        throw error
      } finally {
        downloadCall = null
        downloading.set(false)
      }
    }
  }
  @PluginMethod fun cancelDownload(call: PluginCall) {
    canceled.set(true)
    downloadCall?.cancel()
    // Resolve after the serial download worker has removed its partial file.
    worker.execute { call.resolve() }
  }
  private fun signers(info: PackageInfo): Set<String> {
    @Suppress("DEPRECATION")
    val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
    return signatures?.map { signature ->
      MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString("") { "%02x".format(it) }
    }?.toSet() ?: emptySet()
  }
  @PluginMethod fun install(call: PluginCall) = work(call) {
    val (release, file) = ready ?: throw UpdateFailure("업데이트 파일을 먼저 받아 주세요.")
    if (file.length() != release.size || digest(file) != release.sha256)
      throw UpdateFailure("다운로드가 온전하지 않습니다. 다시 받아 주세요.")
    val manager = context.packageManager
    @Suppress("DEPRECATION")
    val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
    @Suppress("DEPRECATION")
    val current = manager.getPackageInfo(BuildConfig.APPLICATION_ID, flags)
    val candidate = manager.getPackageArchiveInfo(file.absolutePath, flags)
      ?: throw UpdateFailure("설치 파일을 읽을 수 없습니다.")
    @Suppress("DEPRECATION")
    val candidateCode = if (Build.VERSION.SDK_INT >= 28) candidate.longVersionCode else candidate.versionCode.toLong()
    if (!UpdatePackageIdentity.accepts(BuildConfig.APPLICATION_ID, BuildConfig.VERSION_CODE.toLong(),
      signers(current), release.version, versionCode(release.version), candidate.packageName,
      candidate.versionName, candidateCode, signers(candidate)))
      throw UpdateFailure("이 프로그램에 맞는 설치 파일이 아닙니다.")
    if (Build.VERSION.SDK_INT >= 26 && !manager.canRequestPackageInstalls()) {
      activity.runOnUiThread {
        activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + BuildConfig.APPLICATION_ID)))
      }
      throw UpdateFailure("이 앱의 설치를 허용한 뒤 업데이트를 다시 눌러 주세요.")
    }
    val uri = FileProvider.getUriForFile(context, BuildConfig.APPLICATION_ID + ".fileprovider", file)
    activity.runOnUiThread {
      try {
        activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
      } catch (_: Exception) {
        notifyListeners("installError", result("message" to "설치 화면을 열지 못했습니다. 다시 눌러 주세요."))
      }
    }
    null
  }
  @PluginMethod fun cancelInstall(call: PluginCall) { call.resolve() }

  override fun handleOnDestroy() {
    canceled.set(true)
    downloadCall?.cancel()
    client.dispatcher.cancelAll()
    worker.shutdownNow()
    super.handleOnDestroy()
  }
}
