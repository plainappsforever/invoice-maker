// Independent look at PDFs with macOS PDFKit + Core Image (no packages), used by scripts/verify-pdfs.mjs (P5):
// every QR code on every page (the GiroCode decoder) and the geometry of page 1 at 4 px per point — the y
// positions (from the top, in pt) of the short marks in the left margin strip 4–11 mm (DIN 5008 fold/punch marks)
// and the right edge of the ink (proves 1 renderer px = 1 pt). Usage: swift scripts/inspect-pdf.swift a.pdf [b.pdf …]
// Prints one JSON line per file: {"file", "codes": [{"page", "text"}], "marks": [pt…], "inkRight": pt}
import AppKit
import CoreImage
import Foundation
import PDFKit

let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
let scale: CGFloat = 4
let ptPerMm: CGFloat = 72 / 25.4

for path in CommandLine.arguments.dropFirst() {
  var codes: [[String: Any]] = []
  var marks: [Double] = []
  var inkRight: Double = 0
  if let doc = PDFDocument(url: URL(fileURLWithPath: path)) {
    for i in 0..<doc.pageCount {
      guard let page = doc.page(at: i) else { continue }
      let box = page.bounds(for: .mediaBox)
      let w = Int(box.width * scale), h = Int(box.height * scale)
      guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { continue }
      ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
      ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
      ctx.scaleBy(x: scale, y: scale)
      page.draw(with: .mediaBox, to: ctx)
      guard let image = ctx.makeImage() else { continue }
      for f in detector.features(in: CIImage(cgImage: image)) {
        if let q = f as? CIQRCodeFeature, let text = q.messageString { codes.append(["page": i + 1, "text": text]) }
      }
      if i == 0, let data = ctx.data?.assumingMemoryBound(to: UInt8.self) {
        // memory row 0 = top of the page (CGBitmapContext rows run top-down in memory)
        let dark = { (x: Int, y: Int) -> Bool in let o = (y * w + x) * 4; return Int(data[o]) + Int(data[o + 1]) + Int(data[o + 2]) < 3 * 235 }
        let x0 = Int(4 * ptPerMm * scale), x1 = Int(11 * ptPerMm * scale)
        var inMark = false, start = 0
        for y in 0..<h {
          var hit = 0
          for x in x0..<x1 where dark(x, y) { hit += 1 }
          let on = hit > (x1 - x0) / 3
          if on && !inMark { inMark = true; start = y }
          if !on && inMark { inMark = false; marks.append(Double(start + y) / 2 / Double(scale)) }
        }
        var right = 0
        for y in stride(from: 0, to: h, by: 2) { var x = w - 1; while x > right { if dark(x, y) { right = x; break }; x -= 1 } }
        inkRight = Double(right) / Double(scale)
      }
    }
  }
  let data = try! JSONSerialization.data(withJSONObject: ["file": path, "codes": codes, "marks": marks.map { ($0 * 10).rounded() / 10 }, "inkRight": (inkRight * 10).rounded() / 10])
  print(String(data: data, encoding: .utf8)!)
}
