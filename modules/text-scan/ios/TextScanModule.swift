import ExpoModulesCore
import UIKit
import Vision
import VisionKit

// On-device text recognition for Invoice Maker (V1.5 P1, DECISIONS D95). Adapted from warranty-wallet's
// modules/receipt-ocr (its D17/D39). AsyncFunctions run on the module's background queue: Vision never blocks the UI.
// Nothing leaves the phone: Vision runs locally, there is no network code.
public class TextScanModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TextScan")

    AsyncFunction("documentScannerStatus") { () -> String in
      return VNDocumentCameraViewController.isSupported ? "ready" : "unavailable"
    }

    // Lines in reading order (y, then x), boxes normalised 0..1 with the origin at the TOP-left. `correct`: Vision's
    // language correction (useful for sentences; it can "correct" names, e-mail addresses and numbers on a card).
    AsyncFunction("recognize") { (uri: String, correct: Bool) -> [String: Any] in
      guard let image = UIImage(contentsOfFile: Self.fileUrl(uri).path), let cgImage = image.cgImage else {
        throw ImageOpenException(uri)
      }
      let orientation = Self.cgOrientation(image.imageOrientation)
      let rotated = [.left, .right, .leftMirrored, .rightMirrored].contains(orientation)
      let width = rotated ? cgImage.height : cgImage.width
      let height = rotated ? cgImage.width : cgImage.height

      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .accurate
      request.usesLanguageCorrection = correct
      request.recognitionLanguages = ["de-DE", "en-US", "fr-FR", "it-IT", "es-ES"]
      let handler = VNImageRequestHandler(cgImage: cgImage, orientation: orientation, options: [:])
      try handler.perform([request])

      var found: [(text: String, x: Double, y: Double, w: Double, h: Double, confidence: Double)] = []
      for observation in request.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { continue }
        let b = observation.boundingBox
        found.append((text, Double(b.minX), Double(1 - b.maxY), Double(b.width), Double(b.height), Double(candidate.confidence)))
      }
      found.sort { $0.y != $1.y ? $0.y < $1.y : $0.x < $1.x }
      let lines: [[String: Any]] = found.map { line in
        [
          "text": line.text,
          "box": ["x": line.x, "y": line.y, "w": line.w, "h": line.h],
          "confidence": line.confidence,
        ]
      }
      return ["width": width, "height": height, "lines": lines]
    }
  }

  static func cgOrientation(_ orientation: UIImage.Orientation) -> CGImagePropertyOrientation {
    switch orientation {
    case .up: return .up
    case .down: return .down
    case .left: return .left
    case .right: return .right
    case .upMirrored: return .upMirrored
    case .downMirrored: return .downMirrored
    case .leftMirrored: return .leftMirrored
    case .rightMirrored: return .rightMirrored
    @unknown default: return .up
    }
  }

  static func fileUrl(_ uri: String) -> URL {
    if let url = URL(string: uri), url.scheme != nil {
      return url
    }
    return URL(fileURLWithPath: uri)
  }
}

final class ImageOpenException: GenericException<String> {
  override var reason: String { "Could not open the image at \(param)" }
}
