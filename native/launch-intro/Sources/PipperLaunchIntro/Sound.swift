import AppKit
import AVFoundation
import LaunchIntroCore

/// Plays the pre-rendered score, started on the same host time as the
/// overlay's clock so each sound lands on its frame.
final class IntroSound {
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let buffer: AVAudioPCMBuffer

  /// Nil when there is no output device; the intro then plays silently.
  init?(_ audio: StereoAudio) {
    guard let format = AVAudioFormat(standardFormatWithSampleRate: audio.sampleRate, channels: 2),
          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(audio.left.count)),
          let channels = buffer.floatChannelData
    else { return nil }
    buffer.frameLength = buffer.frameCapacity
    audio.left.withUnsafeBufferPointer { channels[0].update(from: $0.baseAddress!, count: audio.left.count) }
    audio.right.withUnsafeBufferPointer { channels[1].update(from: $0.baseAddress!, count: audio.right.count) }
    self.buffer = buffer
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: format)
    engine.prepare()
    do {
      try engine.start()
    } catch {
      emit("sound-failed", ["message": String(describing: error)])
      return nil
    }
  }

  /// Starts so that score time `offset` is heard at `seconds` (CACurrentMediaTime).
  func play(atSeconds seconds: CFTimeInterval, offset: Double) {
    let startFrame = AVAudioFramePosition(max(0, offset) * buffer.format.sampleRate)
    guard startFrame < AVAudioFramePosition(buffer.frameLength) else { return }
    if startFrame == 0 {
      player.scheduleBuffer(buffer)
    } else if let tail = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength - AVAudioFrameCount(startFrame)),
              let source = buffer.floatChannelData, let target = tail.floatChannelData {
      tail.frameLength = tail.frameCapacity
      for channel in 0 ..< 2 {
        target[channel].update(from: source[channel] + Int(startFrame), count: Int(tail.frameLength))
      }
      player.scheduleBuffer(tail)
    }
    // Output latency is the time from render to speaker; start that much early.
    let latency = engine.outputNode.presentationLatency
    player.play(at: AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: seconds - latency)))
  }

  func fadeOut(over duration: TimeInterval) {
    let steps = 20
    let mixer = engine.mainMixerNode
    let initial = mixer.outputVolume
    for step in 1 ... steps {
      DispatchQueue.main.asyncAfter(deadline: .now() + duration * Double(step) / Double(steps)) {
        mixer.outputVolume = initial * Float(1 - Double(step) / Double(steps))
      }
    }
  }
}

/// Trackpad haptics. macOS only plays them on a Force Touch trackpad while a
/// finger rests on it, and only for the active app.
enum IntroHaptics {
  static func perform(_ pulse: HapticPulse) {
    let performer = NSHapticFeedbackManager.defaultPerformer
    let pattern: NSHapticFeedbackManager.FeedbackPattern = pulse.firm ? .levelChange : .alignment
    for tap in 0 ..< pulse.taps {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.055 * Double(tap)) {
        performer.perform(pattern, performanceTime: .now)
      }
    }
  }
}
