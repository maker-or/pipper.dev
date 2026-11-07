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
  private let startAt: Double
  private var startTime: CFTimeInterval?
  private var completed = false
  private var dismissing = false

  private let backdropSource: Backdrop.Source?

  init(config: IntroConfig, screen: NSScreen, backdrop: Backdrop?, startAt: Double) throws {
    self.config = config
    self.startAt = startAt
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

    view = OverlayView(frame: CGRect(origin: .zero, size: frame.size), device: renderer.device)
    view.colorPixelFormat = IntroRenderer.pixelFormat
    view.framebufferOnly = true
    view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
    view.autoResizeDrawable = false
    view.drawableSize = CGSize(width: pixels.width, height: pixels.height)
    view.preferredFramesPerSecond = max(60, screen.maximumFramesPerSecond)
    view.isPaused = true
    view.enableSetNeedsDisplay = false
    super.init()
    view.delegate = self
    window.contentView = view
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

  func dismiss(duration: TimeInterval = 0.35) {
    guard !dismissing else { return }
    dismissing = true
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

  func draw(in view: MTKView) {
    let now = CACurrentMediaTime()
    let start = startTime ?? now
    startTime = start
    let time = min(startAt + now - start, config.end)
    guard let drawable = view.currentDrawable, let commandBuffer = renderer.queue.makeCommandBuffer() else { return }
    renderer.encode(commandBuffer, target: drawable.texture, time: time)
    commandBuffer.present(drawable)
    commandBuffer.commit()
    if time >= config.end, !completed {
      // Hold the last frame; only the host decides when the overlay goes.
      completed = true
      view.isPaused = true
      emit("complete")
    }
  }
}
