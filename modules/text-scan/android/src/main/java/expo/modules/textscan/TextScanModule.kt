package expo.modules.textscan

import android.net.Uri
import com.google.android.gms.common.moduleinstall.ModuleInstall
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// On-device text recognition for Invoice Maker (V1.5 P1, DECISIONS D95). Adapted from warranty-wallet's
// modules/receipt-ocr (its D17/D33/D39). Nothing leaves the phone: the ML Kit Latin model is bundled in the APK.
class TextScanModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TextScan")

    // Is the ML Kit document scanner (delivered by Google Play services) installed? "ready" | "downloading" |
    // "unavailable". Missing → Play services is asked to fetch it in the background for next time, and the caller
    // uses the camera now (otherwise Play services shows "Something went wrong" and the user ends up nowhere).
    AsyncFunction("documentScannerStatus") { promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.resolve("unavailable")
        return@AsyncFunction
      }
      try {
        val scanner = GmsDocumentScanning.getClient(GmsDocumentScannerOptions.Builder().build())
        val client = ModuleInstall.getClient(context)
        client.areModulesAvailable(scanner)
          .addOnSuccessListener { response ->
            if (response.areModulesAvailable()) {
              promise.resolve("ready")
            } else {
              client.deferredInstall(scanner)
              promise.resolve("downloading")
            }
          }
          .addOnFailureListener { promise.resolve("unavailable") }
      } catch (e: Exception) {
        promise.resolve("unavailable")
      }
    }

    // Boxes normalised 0..1, origin top-left, reading order. `correct` is iOS-only (Vision language correction).
    AsyncFunction("recognize") { uri: String, _: Boolean, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject(RecognizeException("No context"))
        return@AsyncFunction
      }
      val image = try {
        InputImage.fromFilePath(context, Uri.parse(if (uri.startsWith("/")) "file://$uri" else uri))
      } catch (e: Exception) {
        promise.reject(RecognizeException("Could not open the image: ${e.message}"))
        return@AsyncFunction
      }
      val rotated = image.rotationDegrees % 180 != 0
      val width = if (rotated) image.height else image.width
      val height = if (rotated) image.width else image.height
      recognizer.process(image)
        .addOnSuccessListener { result ->
          val lines = mutableListOf<Map<String, Any>>()
          for (block in result.textBlocks) {
            for (line in block.lines) {
              val text = line.text.trim()
              val box = line.boundingBox ?: continue
              if (text.isEmpty()) continue
              lines.add(
                mapOf(
                  "text" to text,
                  "box" to mapOf(
                    "x" to box.left.toDouble() / width,
                    "y" to box.top.toDouble() / height,
                    "w" to box.width().toDouble() / width,
                    "h" to box.height().toDouble() / height
                  ),
                  "confidence" to line.confidence.toDouble()
                )
              )
            }
          }
          lines.sortWith(compareBy({ (it["box"] as Map<*, *>)["y"] as Double }, { (it["box"] as Map<*, *>)["x"] as Double }))
          promise.resolve(mapOf("width" to width, "height" to height, "lines" to lines))
        }
        .addOnFailureListener { e -> promise.reject(RecognizeException("Recognition failed: ${e.message}")) }
    }

    OnDestroy {
      recognizerInstance?.close()
      recognizerInstance = null
    }
  }

  private var recognizerInstance: TextRecognizer? = null
  private val recognizer: TextRecognizer
    get() = recognizerInstance ?: TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS).also { recognizerInstance = it }
}

class RecognizeException(message: String) : CodedException("ERR_RECOGNIZE", message, null)
