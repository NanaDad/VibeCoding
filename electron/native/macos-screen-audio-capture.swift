import Foundation
import AVFoundation
import CoreMedia
import ScreenCaptureKit

struct HelperError: Error {
    let message: String
}

func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else {
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

final class SegmentWriter: @unchecked Sendable {
    let fileURL: URL
    let startedAt: CMTime
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private var sessionStarted = false
    private var finishContinuation: CheckedContinuation<Void, Never>?

    init(fileURL: URL, startedAt: CMTime, formatDescription: CMAudioFormatDescription) throws {
        self.fileURL = fileURL
        self.startedAt = startedAt
        self.writer = try AVAssetWriter(outputURL: fileURL, fileType: .m4a)
        self.input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVNumberOfChannelsKey: 1,
            AVSampleRateKey: 16_000,
            AVEncoderBitRateKey: 64_000
        ], sourceFormatHint: formatDescription)
        self.input.expectsMediaDataInRealTime = true

        guard self.writer.canAdd(self.input) else {
            throw HelperError(message: "AVAssetWriter cannot add audio input")
        }

        self.writer.add(self.input)
        guard self.writer.startWriting() else {
            throw HelperError(message: self.writer.error?.localizedDescription ?? "AVAssetWriter failed to start")
        }
    }

    func append(_ sampleBuffer: CMSampleBuffer) throws {
        if !sessionStarted {
            writer.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
            sessionStarted = true
        }

        guard input.isReadyForMoreMediaData else {
            return
        }

        guard input.append(sampleBuffer) else {
            throw HelperError(message: writer.error?.localizedDescription ?? "Failed to append audio sample")
        }
    }

    func finish() async {
        input.markAsFinished()
        await withCheckedContinuation { continuation in
            finishContinuation = continuation
            writer.finishWriting { [weak self] in
                guard let self else {
                    continuation.resume()
                    return
                }
                self.finishContinuation?.resume()
                self.finishContinuation = nil
            }
        }
    }
}

final class ScreenAudioCapture: NSObject, SCStreamOutput {
    private let outputDirectory: URL
    private let segmentDuration: Double
    private var stream: SCStream?
    private var writer: SegmentWriter?
    private let queue = DispatchQueue(label: "com.mingu.jpkotranslator.screen-audio")
    private var segmentIndex = 0

    init(outputDirectory: URL, segmentDuration: Double) {
        self.outputDirectory = outputDirectory
        self.segmentDuration = segmentDuration
        super.init()
    }

    func start() async throws {
        if #available(macOS 13.0, *) {
            let shareable = try await SCShareableContent.current
            guard let display = shareable.displays.first else {
                throw HelperError(message: "No display available for ScreenCaptureKit")
            }

            let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
            let configuration = SCStreamConfiguration()
            configuration.width = 2
            configuration.height = 2
            configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            configuration.queueDepth = 3
            configuration.capturesAudio = true
            configuration.captureMicrophone = false
            configuration.excludesCurrentProcessAudio = false
            configuration.sampleRate = 16_000
            configuration.channelCount = 1

            let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
            self.stream = stream
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
            try await stream.startCapture()

            emit([
                "event": "ready",
                "backend": "macos-screencapturekit-native",
                "backendLabel": "macOS ScreenCaptureKit Native",
                "deviceLabel": "Display \(display.displayID)",
                "outputDirectory": outputDirectory.path
            ])
        } else {
            throw HelperError(message: "macOS 13.0 or newer is required for ScreenCaptureKit audio capture")
        }
    }

    func stop() async {
        if let stream {
            try? await stream.stopCapture()
        }
        if let writer {
            await writer.finish()
            self.writer = nil
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .audio, CMSampleBufferIsValid(sampleBuffer), CMSampleBufferDataIsReady(sampleBuffer) else {
            return
        }

        do {
            try rotateWriterIfNeeded(for: sampleBuffer)
            try writer?.append(sampleBuffer)
        } catch {
            emit([
                "event": "error",
                "message": error.localizedDescription
            ])
        }
    }

    private func rotateWriterIfNeeded(for sampleBuffer: CMSampleBuffer) throws {
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if let writer, CMTimeGetSeconds(pts - writer.startedAt) < segmentDuration {
            return
        }

        let previousWriter = writer
        writer = nil
        if let previousWriter {
            Task {
                await previousWriter.finish()
            }
        }

        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer) else {
            throw HelperError(message: "Missing audio format description")
        }

        let fileURL = outputDirectory.appendingPathComponent(String(format: "chunk-%05d.m4a", segmentIndex))
        segmentIndex += 1
        writer = try SegmentWriter(fileURL: fileURL, startedAt: pts, formatDescription: formatDescription)
    }
}

func parseArguments() throws -> (URL, Double) {
    let arguments = Array(CommandLine.arguments.dropFirst())
    var outputDirectory: String?
    var segmentDuration = 4.0
    var index = 0

    while index < arguments.count {
        let argument = arguments[index]
        switch argument {
        case "--output-dir":
            index += 1
            guard index < arguments.count else {
                throw HelperError(message: "Missing value for --output-dir")
            }
            outputDirectory = arguments[index]
        case "--segment-seconds":
            index += 1
            guard index < arguments.count, let value = Double(arguments[index]), value > 0 else {
                throw HelperError(message: "Invalid value for --segment-seconds")
            }
            segmentDuration = value
        default:
            throw HelperError(message: "Unknown argument: \(argument)")
        }
        index += 1
    }

    guard let outputDirectory else {
        throw HelperError(message: "--output-dir is required")
    }

    return (URL(fileURLWithPath: outputDirectory, isDirectory: true), segmentDuration)
}

Task {
    do {
        let (outputDirectory, segmentDuration) = try parseArguments()
        try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
        let capture = ScreenAudioCapture(outputDirectory: outputDirectory, segmentDuration: segmentDuration)
        try await capture.start()

        signal(SIGINT, SIG_IGN)
        signal(SIGTERM, SIG_IGN)

        let signalStream = AsyncStream<Void> { continuation in
            let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
            sigint.setEventHandler { continuation.yield(()) }
            sigint.resume()

            let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
            sigterm.setEventHandler { continuation.yield(()) }
            sigterm.resume()

            continuation.onTermination = { _ in
                sigint.cancel()
                sigterm.cancel()
            }
        }

        _ = await signalStream.first(where: { _ in true })
        await capture.stop()
        exit(0)
    } catch let error as HelperError {
        emit(["event": "error", "message": error.message])
        exit(1)
    } catch {
        emit(["event": "error", "message": error.localizedDescription])
        exit(1)
    }
}

RunLoop.main.run()
