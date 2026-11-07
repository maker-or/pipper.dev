import AppKit
import Foundation
import ImageIO
import LaunchIntroCore

/// pipper-launch-intro [--text <line>] [--font-size <units>] [--start-at <s>]
///   Plays the intro over the main display and reports on stdout.
///
/// pipper-launch-intro --render-frames <dir> --times 0,1.5,3 [--size 2880x1800]
///                     [--background <image>] [--screen <image>]
///   Writes frames as PNGs. --background is the stage (the wallpaper); the
///   frames are composited over --screen, what was on screen before the first
///   ripple, which defaults to the background itself.
struct Options {
  var config = IntroConfig()
  var startAt: Double = 0
  var renderDirectory: String?
  var times: [Double] = []
  var size: (Int, Int) = (2880, 1800)
  var background: String?
  var screen: String?

  init(_ arguments: [String]) {
    var iterator = arguments.dropFirst().makeIterator()
    while let flag = iterator.next() {
      let value = iterator.next() ?? ""
      switch flag {
      case "--text": config.text = value
      case "--font-size": config.fontSize = Double(value) ?? config.fontSize
      case "--start-at": startAt = Double(value) ?? 0
      case "--render-frames": renderDirectory = value
      case "--times": times = value.split(separator: ",").compactMap { Double($0) }
      case "--background": background = value
      case "--screen": screen = value
      case "--size":
        let parts = value.split(separator: "x").compactMap { Int($0) }
        if parts.count == 2 { size = (parts[0], parts[1]) }
      default: break
      }
    }
  }
}

func loadImage(_ path: String) -> CGImage? {
  guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
  return CGImageSourceCreateImageAtIndex(source, CGImageSourceGetPrimaryImageIndex(source), nil)
}

func renderFrames(_ options: Options, to directory: String) -> Int32 {
  do {
    let (width, height) = options.size
    let renderer = try IntroRenderer(config: options.config, width: width, height: height)
    func texture(_ path: String?) throws -> MTLTexture? {
      guard let path, let image = loadImage(path),
            let fitted = composeWallpaper(
              image, width: width, height: height, scaling: .proportionallyUpOrDown,
              allowClipping: true, fill: CGColor(gray: 0, alpha: 1)
            )
      else { return nil }
      return try renderer.makeTexture(from: fitted)
    }
    renderer.backdrop = try texture(options.background)
    let screen = try texture(options.screen) ?? renderer.backdrop
    try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
    for time in options.times {
      let frame = try renderer.renderFrame(time: time, background: screen)
      let url = URL(fileURLWithPath: directory).appendingPathComponent(String(format: "frame-%06.3f.png", time))
      try writePNG(frame, to: url)
      print(url.path)
    }
    return 0
  } catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    return 1
  }
}

let options = Options(CommandLine.arguments)
if let directory = options.renderDirectory {
  exit(renderFrames(options, to: directory))
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
var controller: OverlayController?

listenForCommands({ command in
  if command == "dismiss" { controller?.dismiss() }
}, onClose: { exit(0) })

// Never outlive a host that stopped talking to us.
DispatchQueue.main.asyncAfter(deadline: .now() + options.config.end + 30) {
  if let controller { controller.dismiss() } else { exit(0) }
}

NotificationCenter.default.addObserver(
  forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
) { _ in
  if let screen = NSScreen.screens.first { controller?.fit(to: screen) }
}

Task { @MainActor in
  // The menu bar display: where Pipper's first window opens.
  guard let screen = NSScreen.screens.first,
        let displayID = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID
  else {
    emit("error", ["message": "No display"])
    exit(1)
  }
  let scale = screen.backingScaleFactor
  let backdrop = await loadBackdrop(
    screen: screen,
    displayID: displayID,
    pixelWidth: Int((screen.frame.width * scale).rounded()),
    pixelHeight: Int((screen.frame.height * scale).rounded())
  )
  do {
    let overlay = try OverlayController(
      config: options.config, screen: screen, backdrop: backdrop, startAt: options.startAt
    )
    controller = overlay
    overlay.start()
  } catch {
    emit("error", ["message": String(describing: error)])
    exit(1)
  }
}

app.run()
