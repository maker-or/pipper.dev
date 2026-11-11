import CoreGraphics
import Foundation
import ImageIO
import Metal
import UniformTypeIdentifiers

/// One rendered frame read back as BGRA8, premultiplied, top row first.
public struct FramePixels {
  public let width: Int
  public let height: Int
  public let bytes: [UInt8]

  /// Channels at a pixel, measured with y up as in the spec.
  public func pixel(x: Int, yUp: Int) -> (b: UInt8, g: UInt8, r: UInt8, a: UInt8) {
    let i = ((height - 1 - yUp) * width + x) * 4
    return (bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3])
  }
}

extension IntroRenderer {
  /// Renders the frame at `time` offscreen. Without a background the result is
  /// exactly what the overlay window hands the window server.
  public func renderFrame(time: Double, background: MTLTexture? = nil) throws -> FramePixels {
    let width = Int(geometry.width)
    let height = Int(geometry.height)
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: Self.pixelFormat, width: width, height: height, mipmapped: false
    )
    descriptor.usage = [.renderTarget, .shaderRead]
    descriptor.storageMode = .shared
    guard let target = device.makeTexture(descriptor: descriptor),
          let commandBuffer = queue.makeCommandBuffer()
    else { throw IntroRendererError.resource("offscreen target") }
    encode(commandBuffer, target: target, time: time, background: background)
    commandBuffer.commit()
    commandBuffer.waitUntilCompleted()
    if let error = commandBuffer.error { throw error }
    var bytes = [UInt8](repeating: 0, count: width * height * 4)
    target.getBytes(&bytes, bytesPerRow: width * 4, from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0)
    return FramePixels(width: width, height: height, bytes: bytes)
  }

  public func makeTexture(from image: CGImage) throws -> MTLTexture {
    let width = Int(geometry.width)
    let height = Int(geometry.height)
    var bytes = [UInt8](repeating: 0, count: width * height * 4)
    try bytes.withUnsafeMutableBytes { buffer in
      let info = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
      guard let context = CGContext(
        data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: info
      ) else { throw IntroRendererError.resource("backdrop bitmap") }
      context.interpolationQuality = .high
      context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    }
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: Self.pixelFormat, width: width, height: height, mipmapped: false
    )
    guard let texture = device.makeTexture(descriptor: descriptor) else { throw IntroRendererError.resource("backdrop") }
    texture.replace(region: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0, withBytes: bytes, bytesPerRow: width * 4)
    return texture
  }
}

public func writePNG(_ frame: FramePixels, to url: URL) throws {
  let info = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
  guard let provider = CGDataProvider(data: Data(frame.bytes) as CFData),
        let image = CGImage(
          width: frame.width, height: frame.height, bitsPerComponent: 8, bitsPerPixel: 32,
          bytesPerRow: frame.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
          bitmapInfo: CGBitmapInfo(rawValue: info), provider: provider, decode: nil,
          shouldInterpolate: false, intent: .defaultIntent
        ),
        let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
  else { throw IntroRendererError.resource("PNG \(url.path)") }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else { throw IntroRendererError.resource("PNG \(url.path)") }
}
