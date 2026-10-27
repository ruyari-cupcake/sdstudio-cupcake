package io.sunho.SDStudio

import android.util.Base64
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

// NovelAI paid-request transport. Generation waits for its actual response or
// explicit requestId cancellation. Only connection establishment retains its
// existing bound; read/write/call duration does not impose a generation deadline.
@CapacitorPlugin(name = "FetchService")
class FetchService : Plugin() {
  companion object {
    private const val CONNECT_TIMEOUT_SEC = 30L
  }

  // Share the connection pool. A paid operation has no automatic elapsed-time cutoff.
  private val client = OkHttpClient.
    Builder()
    .connectTimeout(CONNECT_TIMEOUT_SEC, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.MILLISECONDS)
    .writeTimeout(0, TimeUnit.MILLISECONDS)
    .callTimeout(0, TimeUnit.MILLISECONDS)
    .build()

  private val inFlight = ConcurrentHashMap<String, Call>()
  // ConcurrentHashMap.newKeySet() 은 API 24+ 전용이라 minSdk 22 기기에서 NoSuchMethodError 로 죽는다.
  private val canceledByJs: MutableSet<String> =
    java.util.Collections.newSetFromMap(ConcurrentHashMap<String, Boolean>())

  @PluginMethod
  fun fetchData(pluginCall: PluginCall) {
    val url = pluginCall.getString("url") ?: return pluginCall.reject("Must provide URL")
    val serializedBody = pluginCall.getString("body") ?: "{}"
    val headers = pluginCall.getString("headers") ?: "{}"
    val requestId = pluginCall.getString("requestId")
    val headersMap = JSONObject(headers)
    val mediaType = headersMap.optString("Content-Type", "application/json; charset=utf-8").toMediaType()
    val body = if (pluginCall.getString("bodyEncoding") == "base64") {
      Base64.decode(serializedBody, Base64.DEFAULT).toRequestBody(mediaType)
    } else {
      serializedBody.toRequestBody(mediaType)
    }
    val requestBuilder = Request.Builder().url(url).post(body)

    // Preserve the multipart boundary supplied by the common request encoder.
    headersMap.keys().forEach {
      requestBuilder.addHeader(it, headersMap.getString(it))
    }

    val request = requestBuilder.build()

    val httpCall = client.newCall(request)
    if (requestId != null) inFlight[requestId] = httpCall

    httpCall.enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) {
        rejectFailure(pluginCall, requestId, e)
      }

      override fun onResponse(call: Call, response: Response) {
        response.use {
          // 본문 읽기 중 시간 초과·취소도 JS 로 알린다(놓치면 JS 가 응답을 영영 기다린다).
          val responseData = try {
            response.body?.bytes()
          } catch (e: IOException) {
            rejectFailure(pluginCall, requestId, e)
            return
          }
          if (requestId != null) {
            inFlight.remove(requestId)
            canceledByJs.remove(requestId)
          }
          val blobData = responseData?.let { Base64.encodeToString(it, Base64.DEFAULT) }
          val result = JSObject()
          result.put("data", blobData)
          result.put("status", response.code)
          val correlationId = response.header("x-correlation-id")
            ?: response.header("x-request-id")
            ?: response.header("cf-ray")
          if (correlationId != null) result.put("correlationId", correlationId)
          pluginCall.resolve(result)
        }
      }
    })
  }

  private fun rejectFailure(call: PluginCall, requestId: String?, e: IOException) {
    if (requestId != null) inFlight.remove(requestId)
    when {
      requestId != null && canceledByJs.remove(requestId) ->
        call.reject("Request canceled", "CANCELED")
      else ->
        call.reject("Network request failed: ${e.message}")
    }
  }

  @PluginMethod
  fun cancel(call: PluginCall) {
    val requestId = call.getString("requestId") ?: return call.reject("Must provide requestId")
    val httpCall = inFlight.remove(requestId)
    if (httpCall != null) {
      canceledByJs.add(requestId)
      httpCall.cancel()
    }
    call.resolve()
  }
}
