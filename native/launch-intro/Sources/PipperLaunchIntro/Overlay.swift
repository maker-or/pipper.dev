import AppKit
import LaunchIntroCore
import MetalKit

/// Borderless and transparent, so the only visible thing is what the shader
/// draws. It must be key to hear Escape.
final class OverlayWindow: NSWindow {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
}

final class OverlayView: MTKView {
  var onEscape: (() -> Void)?

  override var acceptsFirstResponder: Bool { true }
  override func acceptsFirstMouse(for _: NSEvent?) -> Bool { true }

  override func keyDown(with event: NSEvent) {
    if event.keyCode == 53 { onEscape?() } else { super.keyDown(with: event) }
  }

  // Clicks land on the darkness, not on whatever app sits behind it.
  override func mouseDown(with _: NSEvent) {}
  override func rightMouseDown(with _: NSEvent) {}
}

/// Owns the one clock. Each frame is `renderer.encode(time:)` for the seconds
/// since the first frame, so dropped frames skip ahead instead of slowing down.
final class OverlayController: NSObject, MTKViewDelegate {
  private let config: IntroConfig
  private let renderer: IntroRenderer
  private let window: OverlayWindow
  private let view: OverlayView
  /// Holds the picture; masked to the window's shape as the dark closes in.
  private let container: NSView
  /// The window's background, faded in over the picture as the dark closes.
  private let fill: NSView
  private let startAt: Double
  private var startTime: CFTimeInterval?
  private var completed = false
  private var dismissing = false

  private let backdropSource: Backdrop.Source?
  private let sound: IntroSound?
  private let haptics: Bool
  private var lastTime: Double?

  init(
    config: IntroConfig, screen: NSScreen, backdrop: Backdrop?, score: StereoAudio?, haptics: Bool, startAt: Double
  ) throws {
    self.config = config
    self.startAt = startAt
    self.haptics = haptics
    sound = score.flatMap(IntroSound.init)
    let frame = screen.frame
    let pixels = Self.pixelSize(of: screen)
    renderer = try IntroRenderer(config: config, width: pixels.width, height: pixels.height)
    backdropSource = backdrop?.source
    if let backdrop {
      renderer.backdrop = try renderer.makeTexture(from: backdrop.image)
    }

    // The full display, menu bar and Dock included; never visibleFrame.
    window = OverlayWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.setFrame(frame, display: false)
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.level = .screenSaver
    window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
    window.isReleasedWhenClosed = false
    window.animationBehavior = .none

    let bounds = CGRect(origin: .zero, size: frame.size)
    view = OverlayView(frame: bounds, device: renderer.device)
    view.colorPixelFormat = IntroRenderer.pixelFormat
    view.framebufferOnly = true
    view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
    view.autoResizeDrawable = false
    view.drawableSize = CGSize(width: pixels.width, height: pixels.height)
    view.preferredFramesPerSecond = max(60, screen.maximumFramesPerSecond)
    view.isPaused = true
    view.enableSetNeedsDisplay = false
    container = NSView(frame: bounds)
    container.wantsLayer = true
    container.autoresizesSubviews = true
    view.autoresizingMask = [.width, .height]
    container.addSubview(view)
    fill = NSView(frame: bounds)
    fill.wantsLayer = true
    fill.autoresizingMask = [.width, .height]
    fill.alphaValue = 0
    container.addSubview(fill)
    super.init()
    view.delegate = self
    window.contentView = container
    configureLayer()
    view.onEscape = { [weak self] in self?.skip() }
  }

  private static func pixelSize(of screen: NSScreen) -> (width: Int, height: Int) {
    let scale = screen.backingScaleFactor
    return (Int((screen.frame.width * scale).rounded()), Int((screen.frame.height * scale).rounded()))
  }

  private func configureLayer() {
    guard let layer = view.layer as? CAMetalLayer else { return }
    layer.isOpaque = false
    layer.backgroundColor = .clear
    // Shader maths and the capture are both sRGB-encoded, as in the prototype.
    layer.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
  }

  func start() {
    window.makeKeyAndOrderFront(nil)
    window.makeFirstResponder(view)
    NSApp.activate(ignoringOtherApps: true)
    // One start time for picture and sound, a little ahead so the audio
    // engine can be scheduled for it. Frames before it draw time 0.
    let start = CACurrentMediaTime() + 0.1
    startTime = start
    sound?.play(atSeconds: start, offset: startAt)
    view.isPaused = false
    emit("started", ["stage": renderer.backdrop == nil ? "none" : backdropSource?.rawValue ?? "none"])
  }

  /// Follows the display if its resolution changes mid-intro.
  func fit(to screen: NSScreen) {
    window.setFrame(screen.frame, display: false)
    let pixels = Self.pixelSize(of: screen)
    view.drawableSize = CGSize(width: pixels.width, height: pixels.height)
    // The stage is sampled in normalised coordinates, so it still fills the
    // display at the new size.
    try? renderer.resize(width: pixels.width, height: pixels.height)
    if view.isPaused { view.draw() }
  }

  func skip() {
    guard !completed else { return }
    emit("skipped")
  }

  /// Draws the dark in to `target`'s frame while the desktop comes back
  /// around it, takes on the window's background, then hands over to the
  /// real window, which the host has already shown underneath.
  func close(into target: CloseTarget, duration: TimeInterval = 1.1, handover: TimeInterval = 0.3) {
    guard !dismissing, let layer = container.layer,
          let rect = target.frame(in: container.bounds.size)
    else { return dismiss() }
    dismissing = true
    // A drawn window is already the window in all but its text and icons, so
    // the hand-over starts as the dark begins to close and runs through it,
    // easing in and out, rather than waiting for it.
    let drawn = renderer.drawing != nil
    let closing = drawn ? 1.4 : duration
    sound?.fadeOut(over: drawn ? 1.7 : duration + handover)

    let mask = CALayer()
    mask.backgroundColor = .black
    mask.cornerCurve = .continuous
    mask.frame = container.bounds
    layer.mask = mask

    // A drawn window already wears its colours; otherwise the dark takes on
    // the window's background as it closes.
    if let color = target.color {
      fill.layer?.backgroundColor = CGColor(srgbRed: color.x, green: color.y, blue: color.z, alpha: 1)
    } else {
      fill.layer?.backgroundColor = CGColor(srgbRed: 5 / 255, green: 5 / 255, blue: 7 / 255, alpha: 1)
    }

    // Slow to leave the edges, soft as it lands on the window.
    let draw = CAMediaTimingFunction(controlPoints: 0.45, 0, 0.12, 1)
    CATransaction.begin()
    CATransaction.setAnimationDuration(closing)
    CATransaction.setAnimationTimingFunction(draw)
    if !drawn {
      CATransaction.setCompletionBlock { [weak self] in self?.handOver(after: handover) }
    }
    for (key, from, to) in [
      ("bounds", NSValue(rect: container.bounds), NSValue(rect: CGRect(origin: .zero, size: rect.size))),
      ("position", NSValue(point: CGPoint(x: container.bounds.midX, y: container.bounds.midY)),
       NSValue(point: CGPoint(x: rect.midX, y: rect.midY))),
      ("cornerRadius", NSNumber(value: 0), NSNumber(value: target.cornerRadius)),
    ] {
      let animation = CABasicAnimation(keyPath: key)
      animation.fromValue = from
      animation.toValue = to
      mask.add(animation, forKey: key)
    }
    mask.bounds = CGRect(origin: .zero, size: rect.size)
    mask.position = CGPoint(x: rect.midX, y: rect.midY)
    mask.cornerRadius = target.cornerRadius
    CATransaction.commit()

    if drawn {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
        self?.handOver(after: 1.5, timing: CAMediaTimingFunction(name: .easeInEaseOut))
      }
      return
    }
    // The line and the dark give way to the window's own colour a little
    // ahead of the shape, so it lands as the window, not as a dark card.
    NSAnimationContext.runAnimationGroup { context in
      context.duration = duration * 0.85
      context.timingFunction = CAMediaTimingFunction(controlPoints: 0.3, 0, 0.2, 1)
      fill.animator().alphaValue = 1
    }
  }

  /// The window to draw, measured by the host: first its frame alone, then
  /// with its elements. Anything that comes after the carousel's phrase has
  /// set off for the heading is ignored: it needs to know where it is going.
  func draw(layout command: String) {
    guard !completed, let screen = window.screen else { return }
    let primaryHeight = NSScreen.screens.first?.frame.height ?? screen.frame.height
    // Points from the top left of the menu-bar display, as the host measures.
    let origin = CGPoint(x: screen.frame.minX, y: primaryHeight - screen.frame.maxY)
    guard let drawing = WindowDrawing(
      command: command, origin: origin, scale: screen.backingScaleFactor, config: config
    ) else { return emit("layout-ignored", ["message": "Unreadable layout"]) }
    let now = startTime.map { startAt + max(0, CACurrentMediaTime() - $0) } ?? 0
    let deadline = drawing.start
    guard now < deadline else { return emit("layout-ignored", ["message": "Layout arrived too late"]) }
    renderer.drawing = drawing
    emit("layout", ["shapes": drawing.shapes.count])
  }

  /// The real window is under the overlay and the same shape and colour, so
  /// fading the overlay reveals its content in place.
  private func handOver(
    after duration: TimeInterval, timing: CAMediaTimingFunction = CAMediaTimingFunction(name: .easeOut)
  ) {
    NSAnimationContext.runAnimationGroup({ context in
      context.duration = duration
      context.timingFunction = timing
      window.animator().alphaValue = 0
    }, completionHandler: {
      emit("dismissed")
      exit(0)
    })
  }

  func dismiss(duration: TimeInterval = 0.35) {
    guard !dismissing else { return }
    dismissing = true
    sound?.fadeOut(over: duration)
    NSAnimationContext.runAnimationGroup({ context in
      context.duration = duration
      context.timingFunction = CAMediaTimingFunction(name: .easeOut)
      window.animator().alphaValue = 0
    }, completionHandler: {
      emit("dismissed")
      exit(0)
    })
  }

  func mtkView(_: MTKView, drawableSizeWillChange _: CGSize) {}

  /// Pulses for any front that reached the pointer since the last frame.
  private func feelFronts(until time: Double) {
    defer { lastTime = time }
    guard let last = lastTime, let screen = window.screen else { return }
    let mouse = NSEvent.mouseLocation
    let scale = screen.backingScaleFactor
    let pointer = SIMD2((mouse.x - screen.frame.minX) * scale, (mouse.y - screen.frame.minY) * scale)
    for pulse in hapticPulses(at: pointer, from: last, to: time, geometry: renderer.geometry, config: config) {
      IntroHaptics.perform(pulse)
    }
  }

  func draw(in view: MTKView) {
    let now = CACurrentMediaTime()
    let start = startTime ?? now
    startTime = start
    let time = min(startAt + max(0, now - start), renderer.end)
    if haptics { feelFronts(until: time) }
    guard let drawable = view.currentDrawable, let commandBuffer = renderer.queue.makeCommandBuffer() else { return }
    renderer.encode(commandBuffer, target: drawable.texture, time: time)
    commandBuffer.present(drawable)
    commandBuffer.commit()
    if time >= renderer.end, !completed {
      // Hold the last frame; only the host decides when the overlay goes.
      completed = true
      view.isPaused = true
      emit("complete")
    }
  }
}
