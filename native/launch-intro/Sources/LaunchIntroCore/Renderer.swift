import CoreGraphics
import CoreText
import Foundation
import Metal

struct RippleUniforms {
  var resolution: SIMD2<Float>
  var stone: SIMD2<Float>
  var rippleStart: SIMD4<Float>
  var rippleStrength: SIMD4<Float>
  var time: Float
  var rippleCount: Float
  var speed: Float
  var wavelength: Float
  var pack: Float
  var soft: Float
  var amplitude: Float
  var decay: Float
  var refraction: Float
  var hasBackdrop: Float
  var darkBottom: Float
  var darkTop: Float
  var push: Float
  var pushOmega: Float
  var pushDecay: Float
  var pushNorm: Float
  var pushOnset: Float
  var stageStart: Float
  var stageWash: Float
}

struct TextUniforms {
  var rect: SIMD4<Float>
  var color: SIMD4<Float>
  var target: SIMD2<Float>
  var sigma: Float
  var opacity: Float
}

public enum IntroRendererError: Error, CustomStringConvertible {
  case noDevice
  case resource(String)

  public var description: String {
    switch self {
    case .noDevice: "No Metal device"
    case let .resource(name): "Could not create \(name)"
    }
  }
}

/// Draws one intro frame for a given time. Holds no clock of its own.
public final class IntroRenderer {
  public static let pixelFormat = MTLPixelFormat.bgra8Unorm

  public let device: MTLDevice
  public let queue: MTLCommandQueue
  public let config: IntroConfig
  public private(set) var geometry: IntroGeometry

  /// The stage the first front lays over the screen, which the ripples then
  /// move: the wallpaper, or the captured screen. Nil leaves the live screen
  /// showing under the darkness, unmoved.
  public var backdrop: MTLTexture?

  private let ripplePipeline: MTLRenderPipelineState
  private let blurPipeline: MTLRenderPipelineState
  private let textPipeline: MTLRenderPipelineState
  private let copyPipeline: MTLRenderPipelineState
  private let emptyTexture: MTLTexture
  private var text: (mask: MTLTexture, blurred: MTLTexture, rect: SIMD4<Float>)?

  public init(device: MTLDevice? = MTLCreateSystemDefaultDevice(), config: IntroConfig, width: Int, height: Int) throws {
    guard let device else { throw IntroRendererError.noDevice }
    guard let queue = device.makeCommandQueue() else { throw IntroRendererError.resource("command queue") }
    self.device = device
    self.queue = queue
    self.config = config
    geometry = IntroGeometry(width: Double(width), height: Double(height), config: config)

    let library = try device.makeLibrary(source: shaderSource, options: nil)
    func pipeline(_ vertex: String, _ fragment: String, _ format: MTLPixelFormat, blended: Bool) throws -> MTLRenderPipelineState {
      let descriptor = MTLRenderPipelineDescriptor()
      descriptor.vertexFunction = library.makeFunction(name: vertex)
      descriptor.fragmentFunction = library.makeFunction(name: fragment)
      let attachment = descriptor.colorAttachments[0]!
      attachment.pixelFormat = format
      if blended {
        // Premultiplied source-over, the same rule the window server applies.
        attachment.isBlendingEnabled = true
        attachment.sourceRGBBlendFactor = .one
        attachment.sourceAlphaBlendFactor = .one
        attachment.destinationRGBBlendFactor = .oneMinusSourceAlpha
        attachment.destinationAlphaBlendFactor = .oneMinusSourceAlpha
      }
      return try device.makeRenderPipelineState(descriptor: descriptor)
    }
    ripplePipeline = try pipeline("fullscreen_vertex", "ripple_fragment", Self.pixelFormat, blended: true)
    blurPipeline = try pipeline("fullscreen_vertex", "text_blur_horizontal", .r16Float, blended: false)
    textPipeline = try pipeline("text_vertex", "text_fragment", Self.pixelFormat, blended: true)
    copyPipeline = try pipeline("fullscreen_vertex", "copy_fragment", Self.pixelFormat, blended: false)

    let empty = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: 1, height: 1, mipmapped: false)
    guard let emptyTexture = device.makeTexture(descriptor: empty) else { throw IntroRendererError.resource("texture") }
    self.emptyTexture = emptyTexture
    try layoutText()
  }

  public func resize(width: Int, height: Int) throws {
    guard Double(width) != geometry.width || Double(height) != geometry.height else { return }
    geometry = IntroGeometry(width: Double(width), height: Double(height), config: config)
    try layoutText()
  }

  /// Encodes the frame at `time` into `target`. With `background`, the frame
  /// is composited over it, which is how previews and tests see the result.
  public func encode(_ commandBuffer: MTLCommandBuffer, target: MTLTexture, time: Double, background: MTLTexture? = nil) {
    let frame = textFrame(time: time, q: geometry.q, config: config)
    var textUniforms = TextUniforms(
      rect: text?.rect ?? .zero,
      color: config.textColor,
      target: [Float(geometry.width), Float(geometry.height)],
      sigma: Float(frame.blur),
      opacity: Float(frame.opacity)
    )
    let drawsText = text != nil && frame.opacity > 0

    if drawsText, let text {
      let pass = MTLRenderPassDescriptor()
      pass.colorAttachments[0].texture = text.blurred
      pass.colorAttachments[0].loadAction = .dontCare
      pass.colorAttachments[0].storeAction = .store
      if let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: pass) {
        encoder.setRenderPipelineState(blurPipeline)
        encoder.setFragmentBytes(&textUniforms, length: MemoryLayout<TextUniforms>.stride, index: 0)
        encoder.setFragmentTexture(text.mask, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
      }
    }

    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = target
    pass.colorAttachments[0].loadAction = .clear
    pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
    pass.colorAttachments[0].storeAction = .store
    guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: pass) else { return }

    if let background {
      encoder.setRenderPipelineState(copyPipeline)
      encoder.setFragmentTexture(background, index: 0)
      encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    }

    var uniforms = rippleUniforms(time: time)
    encoder.setRenderPipelineState(ripplePipeline)
    encoder.setFragmentBytes(&uniforms, length: MemoryLayout<RippleUniforms>.stride, index: 0)
    encoder.setFragmentTexture(backdrop ?? emptyTexture, index: 0)
    encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)

    if drawsText, let text {
      encoder.setRenderPipelineState(textPipeline)
      encoder.setVertexBytes(&textUniforms, length: MemoryLayout<TextUniforms>.stride, index: 0)
      encoder.setFragmentBytes(&textUniforms, length: MemoryLayout<TextUniforms>.stride, index: 0)
      encoder.setFragmentTexture(text.blurred, index: 0)
      encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
    }
    encoder.endEncoding()
  }

  private func rippleUniforms(time: Double) -> RippleUniforms {
    let g = geometry
    let c = config
    let spring = PushSpring(config: c)
    func lane(_ values: [Double], _ fallback: Double) -> SIMD4<Float> {
      var lane = SIMD4<Float>(repeating: Float(fallback))
      for (i, value) in values.prefix(4).enumerated() { lane[i] = Float(value) }
      return lane
    }
    return RippleUniforms(
      resolution: [Float(g.width), Float(g.height)],
      stone: [Float(g.stone.x), Float(g.stone.y)],
      rippleStart: lane(c.rippleStarts, .infinity),
      rippleStrength: lane(c.rippleStrengths.map(Double.init), 0),
      time: Float(time),
      rippleCount: Float(min(4, c.rippleStarts.count)),
      speed: Float(g.speed),
      wavelength: Float(c.wavelength * g.q),
      pack: Float(c.pack * g.q),
      soft: Float(c.soft * g.q),
      amplitude: Float(c.amplitude * g.q),
      decay: Float(c.decay),
      refraction: Float(c.refraction * g.q),
      hasBackdrop: backdrop == nil ? 0 : 1,
      darkBottom: Float(c.darkBottom),
      darkTop: Float(c.darkTop),
      push: Float(c.push * g.q),
      pushOmega: Float(spring.omega),
      pushDecay: Float(spring.decay),
      pushNorm: Float(spring.norm),
      pushOnset: Float(spring.onset),
      stageStart: Float(c.rippleStarts.min() ?? 0),
      stageWash: Float(c.soft * c.stageWash * g.q)
    )
  }

  /// Rasterises the line once per display size as a coverage mask, padded so
  /// the widest blur never clips. The line box is centred on the display, as
  /// CSS centres a single line.
  private func layoutText() throws {
    guard !config.text.isEmpty else {
      text = nil
      return
    }
    let q = geometry.q
    let font = CTFontCreateUIFontForLanguage(.system, CGFloat(config.fontSize * q), nil)
      ?? CTFontCreateWithName("Helvetica Neue" as CFString, CGFloat(config.fontSize * q), nil)
    let attributed = NSAttributedString(string: config.text, attributes: [
      NSAttributedString.Key(kCTFontAttributeName as String): font,
      NSAttributedString.Key(kCTForegroundColorFromContextAttributeName as String): true,
    ])
    let line = CTLineCreateWithAttributedString(attributed)
    var ascent: CGFloat = 0
    var descent: CGFloat = 0
    let advance = CTLineGetTypographicBounds(line, &ascent, &descent, nil)
    let pad = ceil(config.maxTextBlur * q * 3) + 2
    let width = Int(ceil(advance) + pad * 2)
    let height = Int(ceil(ascent + descent) + pad * 2)

    var pixels = [UInt8](repeating: 0, count: width * height)
    try pixels.withUnsafeMutableBytes { buffer in
      guard let context = CGContext(
        data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
      ) else { throw IntroRendererError.resource("text bitmap") }
      context.setFillColor(gray: 1, alpha: 1)
      context.setAllowsFontSmoothing(false)
      context.setShouldAntialias(true)
      context.textPosition = CGPoint(x: pad, y: pad + descent)
      CTLineDraw(line, context)
    }

    let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .r8Unorm, width: width, height: height, mipmapped: false)
    guard let mask = device.makeTexture(descriptor: descriptor) else { throw IntroRendererError.resource("text mask") }
    mask.replace(region: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0, withBytes: pixels, bytesPerRow: width)
    descriptor.pixelFormat = .r16Float
    descriptor.usage = [.renderTarget, .shaderRead]
    descriptor.storageMode = .private
    guard let blurred = device.makeTexture(descriptor: descriptor) else { throw IntroRendererError.resource("text blur") }

    let origin = SIMD2<Float>(
      Float(((geometry.width - Double(width)) / 2).rounded()),
      Float(((geometry.height - Double(height)) / 2).rounded())
    )
    text = (mask, blurred, [origin.x, origin.y, Float(width), Float(height)])
  }
}
