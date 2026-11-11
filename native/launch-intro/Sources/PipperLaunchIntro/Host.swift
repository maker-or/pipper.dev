import Foundation

/// The helper talks to Electron in JSON lines: events on stdout, commands on
/// stdin. `electron/launch-intro.ts` is the other end.
func emit(_ type: String, _ fields: [String: Any] = [:]) {
  var payload = fields
  payload["type"] = type
  guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
        let line = String(data: data, encoding: .utf8)
  else { return }
  FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

/// Reads commands until stdin closes. A closed stdin means the host is gone,
/// and the overlay must never outlive it.
func listenForCommands(_ handler: @escaping @MainActor (String) -> Void, onClose: @escaping @MainActor () -> Void) {
  let input = FileHandle.standardInput
  var pending = Data()
  input.readabilityHandler = { handle in
    let chunk = handle.availableData
    if chunk.isEmpty {
      handle.readabilityHandler = nil
      DispatchQueue.main.async { MainActor.assumeIsolated { onClose() } }
      return
    }
    pending.append(chunk)
    while let newline = pending.firstIndex(of: 0x0A) {
      let line = String(decoding: pending[..<newline], as: UTF8.self).trimmingCharacters(in: .whitespaces)
      pending.removeSubrange(...newline)
      if line.isEmpty { continue }
      DispatchQueue.main.async { MainActor.assumeIsolated { handler(line) } }
    }
  }
}
