// Apple's on-device translation exposed as a pipe: reads a JSON object on stdin,
// writes a JSON object on stdout. No API key, no network at translate time, no UI.
//
//   build: swiftc -O tools/apple-translate.swift -o tools/bin/apple-translate
//   use:   echo '{"from":"en","to":"fr","texts":["hello"]}' | tools/bin/apple-translate
//
// WHY A PIPE AND NOT A LIBRARY: Translation.framework is Swift-only and its session
// type is async and actor-isolated. A pipe keeps the TypeScript and Python callers
// identical and costs one process spawn per BATCH, not per string.
//
// THE MODEL MUST ALREADY BE INSTALLED. TranslationSession(installedSource:target:)
// deliberately refuses to download — it throws .notInstalled instead. Apple exposes
// the download only through SwiftUI's .translationTask consent sheet, so a CLI cannot
// trigger it. `--status` reports which pairs are ready so a caller can degrade rather
// than fail: query expansion that cannot expand should still search.
import Foundation
import Translation

struct Request: Decodable {
    let from: String
    let to: String
    let texts: [String]
}

struct Response: Encodable {
    let from: String
    let to: String
    let translations: [String]
    let ms: Int
}

struct StatusLine: Encodable {
    let pair: String
    let status: String
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

@available(macOS 15.0, *)
func statusName(_ s: LanguageAvailability.Status) -> String {
    switch s {
    case .installed:   return "installed"
    case .supported:   return "supported"     // needs a one-time download
    case .unsupported: return "unsupported"
    @unknown default:  return "unknown"
    }
}

@available(macOS 15.0, *)
func reportStatus() async {
    let a = LanguageAvailability()
    let langs = await a.supportedLanguages
    var out: [StatusLine] = []
    // Every supported language paired with English, both directions — that is the
    // shape a query expander actually asks about.
    for l in langs {
        guard let code = l.languageCode?.identifier, code != "en" else { continue }
        let toEn = await a.status(from: l, to: .init(identifier: "en"))
        let fromEn = await a.status(from: .init(identifier: "en"), to: l)
        out.append(StatusLine(pair: "\(code)->en", status: statusName(toEn)))
        out.append(StatusLine(pair: "en->\(code)", status: statusName(fromEn)))
    }
    let uniq = Dictionary(grouping: out, by: { $0.pair }).compactMapValues { $0.first }
    let sorted = uniq.values.sorted { $0.pair < $1.pair }
    let data = try! JSONEncoder().encode(sorted)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

@available(macOS 15.0, *)
func translate() async {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let req = try? JSONDecoder().decode(Request.self, from: input) else {
        fail("stdin must be {\"from\":\"en\",\"to\":\"fr\",\"texts\":[...]}")
    }
    let session = TranslationSession(
        installedSource: .init(identifier: req.from),
        target: .init(identifier: req.to))

    let t0 = Date()
    var out: [String] = []
    do {
        // translations(from:) is one round trip for the whole batch — per-string calls
        // pay the session handshake every time.
        let reqs = req.texts.enumerated().map {
            TranslationSession.Request(sourceText: $1, clientIdentifier: String($0))
        }
        let responses = try await session.translations(from: reqs)
        // Responses are NOT guaranteed to arrive in request order; the client
        // identifier is the only thing that puts them back.
        var byId: [Int: String] = [:]
        for r in responses {
            byId[Int(r.clientIdentifier ?? "") ?? 0] = r.targetText
        }
        out = (0 ..< req.texts.count).map { byId[$0] ?? "" }
    } catch {
        fail("translate failed (model not installed?): \(error)")
    }
    let ms = Int(Date().timeIntervalSince(t0) * 1000)
    let data = try! JSONEncoder().encode(
        Response(from: req.from, to: req.to, translations: out, ms: ms))
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

if #available(macOS 15.0, *) {
    if CommandLine.arguments.contains("--status") {
        await reportStatus()
    } else {
        await translate()
    }
} else {
    fail("Translation requires macOS 15 or later")
}
