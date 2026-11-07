import AppKit
import ImageIO
import LaunchIntroCore
import ScreenCaptureKit

/// The stage the first ripple lays over the screen, gathered just before the
/// overlay appears.
struct Backdrop {
  enum Source: String {
    case screen
    case wallpaper
  }

  let source: Source
  let image: CGImage
}

/// The whole screen when Screen Recording is already granted; otherwise the
/// desktop picture. Never prompts: a permission dialog must not be the first
/// thing a new user sees.
///
/// The wallpaper needn't match the screen exactly: the first front washes the
/// screen over to it, so an aerial's still or a dynamic picture's frame reads
/// as a fresh desktop rather than a seam.
func loadBackdrop(screen: NSScreen, displayID: CGDirectDisplayID, pixelWidth: Int, pixelHeight: Int) async -> Backdrop? {
  if let capture = await captureDisplay(displayID, pixelWidth: pixelWidth, pixelHeight: pixelHeight) {
    return Backdrop(source: .screen, image: capture)
  }
  guard let wallpaper = wallpaperImage(screen: screen, pixelWidth: pixelWidth, pixelHeight: pixelHeight) else {
    emit("no-stage", ["message": "Desktop picture unavailable"])
    return nil
  }
  return Backdrop(source: .wallpaper, image: wallpaper)
}

private func captureDisplay(_ displayID: CGDirectDisplayID, pixelWidth: Int, pixelHeight: Int) async -> CGImage? {
  guard CGPreflightScreenCaptureAccess() else { return nil }
  guard #available(macOS 14.0, *) else { return nil }
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { $0.displayID == displayID }) else { return nil }
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let configuration = SCStreamConfiguration()
    configuration.width = pixelWidth
    configuration.height = pixelHeight
    // The live cursor stays on top of the overlay; a captured one would double it.
    configuration.showsCursor = false
    configuration.colorSpaceName = CGColorSpace.sRGB
    return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
  } catch {
    emit("capture-failed", ["message": String(describing: error)])
    return nil
  }
}

private func wallpaperImage(screen: NSScreen, pixelWidth: Int, pixelHeight: Int) -> CGImage? {
  let workspace = NSWorkspace.shared
  guard let url = workspace.desktopImageURL(for: screen),
        let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        CGImageSourceGetCount(source) > 0,
        let image = CGImageSourceCreateImageAtIndex(source, wallpaperFrame(source), nil)
  else { return nil }
  let options = workspace.desktopImageOptions(for: screen) ?? [:]
  let scaling = (options[.imageScaling] as? NSNumber).flatMap { WallpaperScaling(rawValue: $0.intValue) }
    ?? .proportionallyUpOrDown
  let allowClipping = (options[.allowClipping] as? NSNumber)?.boolValue ?? true
  let fill = (options[.fillColor] as? NSColor)?.usingColorSpace(.sRGB)?.cgColor ?? CGColor(gray: 0, alpha: 1)
  return composeWallpaper(
    image, width: pixelWidth, height: pixelHeight, scaling: scaling, allowClipping: allowClipping, fill: fill
  )
}

/// Which frame of a desktop picture to show. Light/dark pictures name a frame
/// for each appearance; anything else (time-of-day pictures included) uses its
/// primary frame.
private func wallpaperFrame(_ source: CGImageSource) -> Int {
  let primary = CGImageSourceGetPrimaryImageIndex(source)
  guard CGImageSourceGetCount(source) > 1,
        let metadata = CGImageSourceCopyMetadataAtIndex(source, primary, nil),
        let tag = CGImageMetadataCopyTagWithPath(metadata, nil, "apple_desktop:apr" as CFString),
        let encoded = CGImageMetadataTagCopyValue(tag) as? String,
        let data = Data(base64Encoded: encoded),
        let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
  else { return primary }
  let dark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
  let index = (plist[dark ? "d" : "l"] as? NSNumber)?.intValue ?? primary
  return index < CGImageSourceGetCount(source) ? index : primary
}
