import CoreGraphics
import CoreText
import Foundation
import Metal
import MetalPerformanceShaders

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

struct MarkUniforms {
  var sizeA: SIMD2<Float>
  var sizeB: SIMD2<Float>
  var centre: SIMD2<Float>
  var scale: Float
  var levelMix: Float
  var relief: Float
  var bend: Float
  var shade: Float
  var shine: Float
  var shadow: Float
}

struct WaterLook {
  var shade: Float
  var sheen: Float
  var sheenPower: Float
  var rim: Float
  var plane: Float
  var planeDarkness: Float
}

struct LightUniforms {
  var rect: SIMD4<Float>
  var hot: SIMD4<Float>
  var warm: SIMD4<Float>
  var far: SIMD4<Float>
  var light: SIMD2<Float>
  var near: Float
  var span: Float
  var intensity: Float
  var spread: Float
  var reach: Float
  var shafts: Float
  var glow: Float
  var source: Float
  var falloff: Float
  var bloom: Float
  var shaftFalloff: Float
  var shaftWarmth: Float
  var exposure: Float
}

/// The @ blurred by one amount, in a box centred on the glyph and padded so
/// the blur never clips. `size` is in surfaced device pixels; the texture may
/// be smaller, since a wide blur needs few texels.
struct MarkLevel {
  let sigma: Double
  let size: SIMD2<Float>
  let texture: MTLTexture
}

struct DrawnElement {
  var rect: SIMD4<Float>
  var fill: SIMD4<Float>
  var radius: Float
  var kind: Float
}

struct DrawUniforms {
  var line: SIMD4<Float>
  var print: SIMD4<Float>
  var lineWidth: Float
  var count: Float
  var trail: Float
  var glowOpacity: Float
}

extension ScanLine {
  /// For the shaders' `isPrinted`: finite, since the shaders build with fast
  /// maths.
  var printUniform: SIMD4<Float> {
    func finite(_ v: Double) -> Float { Float(min(1e9, max(-1e9, v))) }
    return [finite(top), finite(y), finite(head), fromLeft ? 1 : -1]
  }
}

struct WordUniforms {
  var rect: SIMD4<Float>
  var color: SIMD4<Float>
  var target: SIMD2<Float>
  var sigma: Float
  var opacity: Float
  var shown: SIMD4<Float>
  var covered: SIMD4<Float>
}

struct ScanUniforms {
  var y: Float
  var left: Float
  var right: Float
  var head: Float
  var opacity: Float
  var width: Float
}

struct DiscUniforms {
  var resolution: SIMD2<Float>
  var time: Float
  var bloomStart: Float
  var bloomDuration: Float
  var columns: Float
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

  /// The window the intro ends by drawing (version 2), in device pixels;
  /// nil ends it as before. Set it before `drawing.start`.
  public var drawing: WindowDrawing?

  /// The last frame: later when a window is drawn.
  public var end: Double { drawing?.end ?? config.end }

  private let ripplePipeline: MTLRenderPipelineState
  private let surfacePipeline: MTLRenderPipelineState
  private let waterV2Pipeline: MTLRenderPipelineState
  private let backlightPipeline: MTLRenderPipelineState
  private let blurPipeline: MTLRenderPipelineState
  private let textPipeline: MTLRenderPipelineState
  private let copyPipeline: MTLRenderPipelineState
  private let drawingPipeline: MTLRenderPipelineState
  private let wordPipeline: MTLRenderPipelineState
  private let scanPipeline: MTLRenderPipelineState
  /// The carousel's words, "Run" first, each drawn once at full size: its
  /// mask, its advance, and the padding round it, in device pixels.
  private var words: [(mask: MTLTexture, width: Double, pad: Double)] = []
  /// The name's letters, and its four brand icons (RGBA, premultiplied).
  private var letters: [(mask: MTLTexture, width: Double, pad: Double)] = []
  private var brandIcons: [MTLTexture] = []
  private let imagePipeline: MTLRenderPipelineState
  private let discsPipeline: MTLRenderPipelineState
  private let emptyTexture: MTLTexture
  private var text: (mask: MTLTexture, blurred: MTLTexture, rect: SIMD4<Float>)?
  /// Padding around the line's ink inside `text.rect`, in device pixels.
  private var textPad: Double = 0
  /// The line softened, for the backlit ending's beams and bloom.
  private var softText: MTLTexture?
  /// Sharp first, each later level blurred twice as much as the one before.
  private var markLevels: [MarkLevel] = []

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
    surfacePipeline = try pipeline("fullscreen_vertex", "surface_fragment", Self.pixelFormat, blended: true)
    waterV2Pipeline = try pipeline("fullscreen_vertex", "water_v2_fragment", Self.pixelFormat, blended: true)
    backlightPipeline = try pipeline("fullscreen_vertex", "backlight_fragment", Self.pixelFormat, blended: true)
    blurPipeline = try pipeline("fullscreen_vertex", "text_blur_horizontal", .r16Float, blended: false)
    textPipeline = try pipeline("text_vertex", "text_fragment", Self.pixelFormat, blended: true)
    copyPipeline = try pipeline("fullscreen_vertex", "copy_fragment", Self.pixelFormat, blended: false)
    drawingPipeline = try pipeline("fullscreen_vertex", "drawing_fragment", Self.pixelFormat, blended: true)
    wordPipeline = try pipeline("text_vertex", "word_fragment", Self.pixelFormat, blended: true)
    scanPipeline = try pipeline("fullscreen_vertex", "scan_fragment", Self.pixelFormat, blended: true)
    imagePipeline = try pipeline("text_vertex", "image_fragment", Self.pixelFormat, blended: true)
    discsPipeline = try pipeline("fullscreen_vertex", "discs_fragment", Self.pixelFormat, blended: true)

    let empty = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: 1, height: 1, mipmapped: false)
    guard let emptyTexture = device.makeTexture(descriptor: empty) else { throw IntroRendererError.resource("texture") }
    self.emptyTexture = emptyTexture
    try layoutText()
    try layoutMark()
    try layoutWords()
  }

  public func resize(width: Int, height: Int) throws {
    guard Double(width) != geometry.width || Double(height) != geometry.height else { return }
    geometry = IntroGeometry(width: Double(width), height: Double(height), config: config)
    try layoutText()
    try layoutMark()
    try layoutWords()
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
    let surfacing = markFrame(time: time)
    var mark = surfacing?.0 ?? MarkUniforms(
      sizeA: [1, 1], sizeB: [1, 1], centre: .zero, scale: 1, levelMix: 0, relief: 0, bend: 0, shade: 0, shine: 0, shadow: 0
    )
    let levels = surfacing?.1
    var look = WaterLook(
      shade: Float(config.waterShade), sheen: Float(config.waterSheen),
      sheenPower: Float(config.waterSheenPower), rim: Float(config.waterRim),
      plane: config.ending == .backlit ? Float(surfaceFrame(time: time, config: config).presence) : 0,
      planeDarkness: Float(config.planeDarkness)
    )
    if config.opening == .bloom {
      var discs = DiscUniforms(
        resolution: [Float(geometry.width), Float(geometry.height)], time: Float(time),
        bloomStart: Float(config.bloomStart), bloomDuration: Float(config.bloomDuration),
        columns: Float(config.discColumns)
      )
      encoder.setRenderPipelineState(discsPipeline)
      encoder.setFragmentBytes(&discs, length: MemoryLayout<DiscUniforms>.stride, index: 0)
      encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    } else {
    switch config.version {
    case .one: encoder.setRenderPipelineState(time > config.surfaceStart ? surfacePipeline : ripplePipeline)
    case .two, .three: encoder.setRenderPipelineState(waterV2Pipeline)
    }
    encoder.setFragmentBytes(&look, length: MemoryLayout<WaterLook>.stride, index: 2)
    encoder.setFragmentBytes(&uniforms, length: MemoryLayout<RippleUniforms>.stride, index: 0)
    encoder.setFragmentBytes(&mark, length: MemoryLayout<MarkUniforms>.stride, index: 1)
    encoder.setFragmentTexture(backdrop ?? emptyTexture, index: 0)
    encoder.setFragmentTexture(levels?.a ?? emptyTexture, index: 1)
    encoder.setFragmentTexture(levels?.b ?? emptyTexture, index: 2)
    encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    }

    if var light = lightUniforms(time: time), let text {
      encoder.setRenderPipelineState(backlightPipeline)
      encoder.setFragmentBytes(&light, length: MemoryLayout<LightUniforms>.stride, index: 0)
      encoder.setFragmentTexture(text.mask, index: 0)
      encoder.setFragmentTexture(softText ?? text.mask, index: 1)
      encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    }

    let windowPrint = drawing?.scan(time: time) ?? .blank
    if let drawing, time > drawing.start {
      var elements = drawing.shapes.prefix(WindowDrawing.maxShapes).map { shape -> DrawnElement in
        let fill = shape.fill ?? .zero
        return DrawnElement(
          rect: [Float(shape.rect.minX), Float(shape.rect.minY), Float(shape.rect.width), Float(shape.rect.height)],
          fill: [Float(fill.x), Float(fill.y), Float(fill.z), Float(fill.w)],
          radius: Float(shape.radius), kind: shape.kind == .text ? 1 : 0
        )
      }
      var uniforms = DrawUniforms(
        line: [0.92, 0.92, 0.95, 0.55],
        print: windowPrint.printUniform,
        lineWidth: Float(max(1, 1.25 * geometry.q)),
        count: Float(elements.count),
        trail: Float(WindowDrawing.trail * Double(drawing.shapes[0].rect.height)),
        glowOpacity: Float(windowPrint.top.isInfinite && windowPrint.top > 0 ? windowPrint.opacity : 1)
      )
      encoder.setRenderPipelineState(drawingPipeline)
      encoder.setFragmentBytes(&uniforms, length: MemoryLayout<DrawUniforms>.stride, index: 0)
      encoder.setFragmentBytes(&elements, length: MemoryLayout<DrawnElement>.stride * elements.count, index: 1)
      encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    }

    // The name: brand tiles popping in and out, letters popping in. Gone
    // where the window has been printed over it.
    let brand = brandFrames(time: time, config: config, geometry: geometry, letterWidths: letters.map(\.width))
    if !brand.isEmpty, brandIcons.count == BrandIcons.count, letters.count == brand.count {
      func quad(_ texture: MTLTexture, centre: SIMD2<Double>, size: CGSize, opacity: Double, color: SIMD4<Float>) {
        var uniforms = WordUniforms(
          rect: [
            Float(centre.x - Double(size.width) / 2), Float(centre.y - Double(size.height) / 2),
            Float(size.width), Float(size.height),
          ],
          color: color, target: [Float(geometry.width), Float(geometry.height)],
          sigma: 0, opacity: Float(opacity), shown: ScanLine.done.printUniform, covered: windowPrint.printUniform
        )
        encoder.setVertexBytes(&uniforms, length: MemoryLayout<WordUniforms>.stride, index: 0)
        encoder.setFragmentBytes(&uniforms, length: MemoryLayout<WordUniforms>.stride, index: 0)
        encoder.setFragmentTexture(texture, index: 0)
        encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
      }
      encoder.setRenderPipelineState(wordPipeline)
      for (i, frame) in brand.enumerated() where frame.letterScale > 0.001 {
        let letter = letters[i]
        let size = CGSize(
          width: Double(letter.mask.width) * frame.letterScale, height: Double(letter.mask.height) * frame.letterScale
        )
        quad(letter.mask, centre: frame.letterCentre, size: size, opacity: 1, color: config.textColor)
      }
      encoder.setRenderPipelineState(imagePipeline)
      for frame in brand where frame.tileScale > 0.001 {
        let size = CGSize(
          width: Double(frame.tileSize.width) * frame.tileScale, height: Double(frame.tileSize.height) * frame.tileScale
        )
        quad(brandIcons[frame.icon], centre: frame.centre, size: size, opacity: 1, color: [1, 1, 1, 1])
      }
    }

    var scans: [ScanLine] = []
    if windowPrint.opacity > 0 { scans.append(windowPrint) }
    if !words.isEmpty {
      encoder.setRenderPipelineState(wordPipeline)
      // Words the window has been printed over are gone.
      func draw(_ word: (mask: MTLTexture, width: Double, pad: Double), rect: CGRect, opacity: Double, shown: ScanLine) {
        var uniforms = WordUniforms(
          rect: [Float(rect.minX), Float(rect.minY), Float(rect.width), Float(rect.height)],
          color: config.textColor,
          target: [Float(geometry.width), Float(geometry.height)],
          sigma: 0, opacity: Float(opacity),
          shown: shown.printUniform, covered: windowPrint.printUniform
        )
        encoder.setVertexBytes(&uniforms, length: MemoryLayout<WordUniforms>.stride, index: 0)
        encoder.setFragmentBytes(&uniforms, length: MemoryLayout<WordUniforms>.stride, index: 0)
        encoder.setFragmentTexture(word.mask, index: 0)
        encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
      }
      if config.carousel != nil {
        let heading = drawing.flatMap { drawing in drawing.heading.map { drawing.shapes[$0].rect } }
        let placements = carouselPlacements(
          time: time, config: config, geometry: geometry, widths: words.map(\.width), heading: heading
        )
        for placement in placements {
          let word = words[placement.index]
          let width = Double(word.mask.width) * placement.scale
          let height = Double(word.mask.height) * placement.scale
          let rect = CGRect(
            x: placement.origin.x - word.pad * placement.scale, y: placement.origin.y - height / 2,
            width: width, height: height
          )
          draw(word, rect: rect, opacity: placement.opacity, shown: .done)
        }
      } else if let phrase = config.phrase, time > phrase.appear {
        // The line, printed in by the laser above its scan line.
        let word = words[0]
        let size = (width: Double(word.mask.width), height: Double(word.mask.height))
        let scan = phraseScan(time: time, config: config, geometry: geometry, width: size.width, height: size.height)
          ?? .done
        if scan.opacity > 0 { scans.append(scan) }
        draw(word, rect: phraseBox(config: config, geometry: geometry, width: size.width, height: size.height),
             opacity: 1, shown: scan)
      }
    }

    if !scans.isEmpty {
      encoder.setRenderPipelineState(scanPipeline)
      for scan in scans {
        var uniforms = ScanUniforms(
          y: Float(scan.y), left: Float(scan.left), right: Float(scan.right), head: Float(scan.head),
          opacity: Float(scan.opacity), width: Float(max(1, 1.2 * geometry.q))
        )
        encoder.setFragmentBytes(&uniforms, length: MemoryLayout<ScanUniforms>.stride, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
      }
    }

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
    // Once the line is sharp the water settles: easing every ripple's strength
    // to 0 stills its shading, rims and shove together, but not its darkness.
    let calm = surfaceFrame(time: time, config: c).calm
    let strengths = calm < 1 ? c.rippleStrengths.map { Double($0) * calm } : c.rippleStrengths.map(Double.init)
    return RippleUniforms(
      resolution: [Float(g.width), Float(g.height)],
      stone: [Float(g.stone.x), Float(g.stone.y)],
      rippleStart: lane(c.rippleStarts, .infinity),
      rippleStrength: lane(strengths, 0),
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

  /// The backlit ending at `time`, or nil when nothing is lit.
  private func lightUniforms(time: Double) -> LightUniforms? {
    let c = config
    guard c.ending == .backlit, time > c.surfaceStart, let text else { return nil }
    let frame = surfaceFrame(time: time, config: c)
    guard frame.presence > 0, let light = lightPosition() else { return nil }
    let intensity = frame.presence
    let focus = frame.focus
    let inkLeft = Double(text.rect.x) + textPad
    let middle = Double(text.rect.y + text.rect.w / 2)
    let inkRight = Double(text.rect.x + text.rect.z) - textPad
    let near = simd_distance_d(light, [inkLeft, middle])
    let far = simd_distance_d(light, [inkRight, middle])
    return LightUniforms(
      rect: text.rect,
      hot: SIMD4(c.lightHot, 1), warm: SIMD4(c.lightWarm, 1), far: SIMD4(c.lightFar, 1),
      light: [Float(light.x), Float(light.y)],
      near: Float(near), span: Float(far - near),
      intensity: Float(intensity), spread: Float(frame.rise),
      reach: Float(c.shaftLength * geometry.height * focus), shafts: Float(c.shaftStrength),
      glow: Float(c.letterGlow), source: Float(c.sourceGlow), falloff: Float(c.lightFalloff),
      bloom: Float(c.letterBloom), shaftFalloff: Float(c.shaftFalloff),
      shaftWarmth: Float(c.shaftWarmth), exposure: Float(c.lightExposure)
    )
  }

  /// Where the backlit line's light sits: up and to the left of the first
  /// letter. Device pixels, y down.
  private func lightPosition() -> SIMD2<Double>? {
    guard let text else { return nil }
    let q = geometry.q
    let inkLeft = Double(text.rect.x) + textPad
    let middle = Double(text.rect.y + text.rect.w / 2)
    return SIMD2(inkLeft + config.lightOffset.x * q, middle - config.lightOffset.y * q)
  }

  /// The carousel's words, each drawn once at full size with mipmaps, so it
  /// stays sharp as it shrinks to the heading.
  private func layoutWords() throws {
    words = []
    letters = []
    brandIcons = []
    var strings: [String] = []
    var weights: [Double] = []
    if let carousel = config.carousel {
      strings = [carousel.lead] + carousel.all
      weights = [carousel.leadWeight] + carousel.all.map { _ in carousel.wordWeight }
    } else if let phrase = config.phrase {
      strings = [phrase.text]
      weights = [phrase.weight]
    }
    guard !strings.isEmpty || config.brand != nil else { return }
    guard let commandBuffer = queue.makeCommandBuffer(), let blit = commandBuffer.makeBlitCommandEncoder() else {
      throw IntroRendererError.resource("word commands")
    }
    let size = config.fontSize * geometry.q
    for (index, string) in strings.enumerated() {
      words.append(try wordMask(string, size: size, weight: weights[index], blit: blit))
    }
    if let brand = config.brand {
      for letter in brand.name {
        letters.append(try wordMask(String(letter), size: brand.letterSize * geometry.q, weight: 0.4, blit: blit))
      }
      // Drawn larger than they show, so the swell as they pop out stays sharp.
      let height = Int(ceil(brand.tileHeight * geometry.q * 1.3))
      let width = Int(ceil(Double(height) * BrandIcons.tileAspect))
      for index in 0 ..< BrandIcons.count {
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        try pixels.withUnsafeMutableBytes { buffer in
          guard let context = CGContext(
            data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
          ) else { throw IntroRendererError.resource("brand bitmap") }
          context.setShouldAntialias(true)
          BrandIcons.draw(index, in: context, size: CGSize(width: width, height: height))
        }
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
          pixelFormat: .rgba8Unorm, width: width, height: height, mipmapped: true
        )
        guard let texture = device.makeTexture(descriptor: descriptor) else { throw IntroRendererError.resource("brand icon") }
        texture.replace(region: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0, withBytes: pixels, bytesPerRow: width * 4)
        blit.generateMipmaps(for: texture)
        brandIcons.append(texture)
      }
    }
    blit.endEncoding()
    commandBuffer.commit()
    commandBuffer.waitUntilCompleted()
  }

  /// One word drawn once at full size with mipmaps, so it stays sharp as it
  /// is scaled: its mask, its advance, and the padding round it.
  private func wordMask(
    _ string: String, size: Double, weight: Double, blit: MTLBlitCommandEncoder
  ) throws -> (mask: MTLTexture, width: Double, pad: Double) {
    let pad = 2.0
    let font = systemFont(size: size, weight: weight)
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: string, attributes: [
      NSAttributedString.Key(kCTFontAttributeName as String): font,
      NSAttributedString.Key(kCTForegroundColorFromContextAttributeName as String): true,
    ]))
    var ascent: CGFloat = 0
    var descent: CGFloat = 0
    let advance = CTLineGetTypographicBounds(line, &ascent, &descent, nil)
    let width = Int(ceil(advance + pad * 2))
    let height = Int(ceil(ascent + descent + pad * 2))
    var pixels = [UInt8](repeating: 0, count: width * height)
    try pixels.withUnsafeMutableBytes { buffer in
      guard let context = CGContext(
        data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
      ) else { throw IntroRendererError.resource("word bitmap") }
      context.setFillColor(gray: 1, alpha: 1)
      context.setAllowsFontSmoothing(false)
      context.setShouldAntialias(true)
      context.textPosition = CGPoint(x: pad, y: pad + descent)
      CTLineDraw(line, context)
    }
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: .r8Unorm, width: width, height: height, mipmapped: true
    )
    guard let mask = device.makeTexture(descriptor: descriptor) else { throw IntroRendererError.resource("word mask") }
    mask.replace(region: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0, withBytes: pixels, bytesPerRow: width)
    blit.generateMipmaps(for: mask)
    return (mask, advance, pad)
  }

  /// The surfacing's uniforms, and the two blur levels either side of how
  /// rounded the @'s body is at `time`. Nil until the line is sharp.
  private func markFrame(time: Double) -> (MarkUniforms, (a: MTLTexture, b: MTLTexture))? {
    let g = geometry
    let c = config
    guard time > c.surfaceStart, let first = markLevels.first, let last = markLevels.last else { return nil }
    let frame = surfaceFrame(time: time, config: c)
    let scale = frame.scale(c)
    let blur = frame.blur(g, c)
    // The levels are blurred at surfaced size; a smaller @ needs more of it.
    let sigma = blur / scale
    var lower = first
    var upper = first
    var mix = 0.0
    if sigma >= last.sigma {
      lower = last
      upper = last
    } else if let index = markLevels.firstIndex(where: { $0.sigma > sigma }), index > 0 {
      lower = markLevels[index - 1]
      upper = markLevels[index]
      // Between sharp and the first blur, linear; above it, by doublings.
      mix = lower.sigma == 0
        ? sigma / upper.sigma
        : log2(sigma / lower.sigma) / log2(upper.sigma / lower.sigma)
    }
    let centre = frame.centre(g)
    // A blurred edge is steepest at 1 / (σ√2π); raise the form so that slope
    // is the relief it has reached, whatever its depth.
    let relief = c.markRelief * frame.presence * blur * (2 * Double.pi).squareRoot()
    let uniforms = MarkUniforms(
      sizeA: lower.size, sizeB: upper.size,
      centre: [Float(centre.x), Float(centre.y)],
      scale: Float(scale), levelMix: Float(min(1, max(0, mix))),
      relief: Float(relief), bend: Float(c.markBend * g.height),
      shade: Float(c.markShade), shine: Float(c.markShine),
      shadow: Float(c.markShadow * frame.presence)
    )
    return (uniforms, (lower.texture, upper.texture))
  }

  /// Rasterises the @ once per display size at every blur level the
  /// surfacing passes through, doubling from its surfaced roundness to its
  /// depth blur. Each is drawn small and blurred by a few texels, so every
  /// level is cheap to make and to sample.
  private func layoutMark() throws {
    markLevels = []
    guard let drawing = markDrawing() else { return }
    let bounds = drawing.bounds
    let glyph = SIMD2(Double(bounds.width), Double(bounds.height))

    let surfaced = max(1, config.markSurfacedBlur * geometry.height)
    let deepest = max(surfaced, config.markDepthBlur * geometry.height) / config.markDepthScale
    var sigmas = [pow(2, floor(log2(surfaced)))]
    while sigmas.last! < deepest {
      sigmas.append(sigmas.last! * 2)
    }

    guard let commandBuffer = queue.makeCommandBuffer() else { throw IntroRendererError.resource("mark commands") }
    var levels: [MarkLevel] = []
    for sigma in sigmas {
      // Texels per surfaced pixel: full detail up to a 4 px blur, then four
      // texels of blur at most.
      let texel = max(1, sigma / 4)
      let pad = ceil(sigma * 3) + 2
      let size = glyph + 2 * pad
      let width = max(4, Int(ceil(size.x / texel)))
      let height = max(4, Int(ceil(size.y / texel)))
      let mask = try rasterise(drawing, texel: texel, width: width, height: height)
      let texture: MTLTexture
      if sigma == 0 {
        texture = mask
      } else {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
          pixelFormat: .r16Float, width: width, height: height, mipmapped: false
        )
        descriptor.usage = [.shaderRead, .shaderWrite]
        descriptor.storageMode = .private
        guard let blurred = device.makeTexture(descriptor: descriptor) else { throw IntroRendererError.resource("mark blur") }
        let blur = MPSImageGaussianBlur(device: device, sigma: Float(sigma / texel))
        blur.edgeMode = .zero
        blur.encode(commandBuffer: commandBuffer, sourceTexture: mask, destinationTexture: blurred)
        texture = blurred
      }
      levels.append(MarkLevel(
        sigma: sigma,
        size: [Float(Double(width) * texel), Float(Double(height) * texel)],
        texture: texture
      ))
    }
    commandBuffer.commit()
    commandBuffer.waitUntilCompleted()
    if let error = commandBuffer.error { throw error }
    markLevels = levels
  }

  /// The mark at its surfaced size: its outline's bounds in device pixels,
  /// and how to draw it `1 / texel` that size with its outline centred on a
  /// point.
  private struct MarkDrawing {
    let bounds: CGRect
    let draw: (_ context: CGContext, _ texel: Double, _ centre: CGPoint) -> Void
  }

  private func markDrawing() -> MarkDrawing? {
    let targetHeight = config.markHeight * geometry.height
    guard !config.mark.isEmpty else { return nil }
    let probeBounds = glyphBounds(config.mark, font: markFont(size: 100))
    guard probeBounds.height > 0 else { return nil }
    let fontSize = 100 * targetHeight / probeBounds.height
    let bounds = glyphBounds(config.mark, font: markFont(size: fontSize))
    return MarkDrawing(bounds: bounds) { context, texel, centre in
      // Centre the outline, not the line box.
      context.textPosition = CGPoint(x: centre.x - bounds.midX / texel, y: centre.y - bounds.midY / texel)
      CTLineDraw(self.markLine(self.config.mark, font: self.markFont(size: fontSize / texel)), context)
    }
  }

  private func markFont(size: Double) -> CTFont { systemFont(size: size, weight: config.markWeight) }

  /// The system font at a weight trait, −1 to 1.
  private func systemFont(size: Double, weight: Double) -> CTFont {
    let base = CTFontCreateUIFontForLanguage(.system, CGFloat(size), nil)
      ?? CTFontCreateWithName("Helvetica Neue" as CFString, CGFloat(size), nil)
    let traits = [kCTFontWeightTrait: weight] as CFDictionary
    let descriptor = CTFontDescriptorCreateCopyWithAttributes(
      CTFontCopyFontDescriptor(base), [kCTFontTraitsAttribute: traits] as CFDictionary
    )
    return CTFontCreateWithFontDescriptor(descriptor, CGFloat(size), nil)
  }

  private func glyphBounds(_ string: String, font: CTFont) -> CGRect {
    let line = markLine(string, font: font)
    return CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
  }

  private func markLine(_ string: String, font: CTFont) -> CTLine {
    CTLineCreateWithAttributedString(NSAttributedString(string: string, attributes: [
      NSAttributedString.Key(kCTFontAttributeName as String): font,
      NSAttributedString.Key(kCTForegroundColorFromContextAttributeName as String): true,
    ]))
  }

  /// The glyph's coverage with its outline centred in a `width × height`
  /// texture, `texel` surfaced pixels per texel.
  private func rasterise(_ drawing: MarkDrawing, texel: Double, width: Int, height: Int) throws -> MTLTexture {
    var pixels = [UInt8](repeating: 0, count: width * height)
    try pixels.withUnsafeMutableBytes { buffer in
      guard let context = CGContext(
        data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
      ) else { throw IntroRendererError.resource("mark bitmap") }
      context.setFillColor(gray: 1, alpha: 1)
      context.setAllowsFontSmoothing(false)
      context.setShouldAntialias(true)
      drawing.draw(context, texel, CGPoint(x: Double(width) / 2, y: Double(height) / 2))
    }
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .r8Unorm, width: width, height: height, mipmapped: false)
    descriptor.usage = [.shaderRead]
    guard let mask = device.makeTexture(descriptor: descriptor) else { throw IntroRendererError.resource("mark mask") }
    mask.replace(region: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0, withBytes: pixels, bytesPerRow: width)
    return mask
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
    textPad = pad
    softText = nil
    if config.ending == .backlit {
      let soft = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .r16Float, width: width, height: height, mipmapped: false)
      soft.usage = [.shaderRead, .shaderWrite]
      soft.storageMode = .private
      guard let texture = device.makeTexture(descriptor: soft), let commandBuffer = queue.makeCommandBuffer() else {
        throw IntroRendererError.resource("soft text")
      }
      let blur = MPSImageGaussianBlur(device: device, sigma: Float(config.beamSoftness * q))
      blur.edgeMode = .zero
      blur.encode(commandBuffer: commandBuffer, sourceTexture: mask, destinationTexture: texture)
      commandBuffer.commit()
      commandBuffer.waitUntilCompleted()
      softText = texture
    }
  }
}
