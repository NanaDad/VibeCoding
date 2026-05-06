import Foundation
import CoreAudio

@available(macOS 14.2, *)
final class TapSession {
    private var tapID: AudioObjectID = kAudioObjectUnknown
    private var aggregateDeviceID: AudioObjectID = kAudioObjectUnknown
    private let sessionUUID = UUID().uuidString.lowercased()
    private let outputName: String
    private let outputUID: String
    private let aggregateName: String
    private let aggregateUID: String

    init(outputName: String, outputUID: String) {
        self.outputName = outputName
        self.outputUID = outputUID
        self.aggregateName = "JP-KO Translator System Audio \(sessionUUID.prefix(8))"
        self.aggregateUID = "com.mingu.jpkotranslator.system-audio.\(sessionUUID)"
    }

    func start() throws {
        let description = CATapDescription(__excludingProcesses: [], andDeviceUID: outputUID, withStream: 0)
        description.name = aggregateName
        description.isPrivate = false
        description.muteBehavior = CATapMuteBehavior(rawValue: 0)!

        try check(AudioHardwareCreateProcessTap(description, &tapID), context: "AudioHardwareCreateProcessTap")

        let tapDictionary: [String: Any] = [
            kAudioSubTapUIDKey: description.uuid.uuidString,
            kAudioSubTapDriftCompensationKey: false
        ]
        let aggregateDictionary: [String: Any] = [
            kAudioAggregateDeviceNameKey: aggregateName,
            kAudioAggregateDeviceUIDKey: aggregateUID,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: false,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [tapDictionary]
        ]

        do {
            try check(AudioHardwareCreateAggregateDevice(aggregateDictionary as CFDictionary, &aggregateDeviceID), context: "AudioHardwareCreateAggregateDevice")
        } catch {
            _ = AudioHardwareDestroyProcessTap(tapID)
            tapID = kAudioObjectUnknown
            throw error
        }

        emit([
            "event": "ready",
            "backend": "macos-coreaudio-tap",
            "backendLabel": "macOS CoreAudio Tap",
            "deviceLabel": aggregateName,
            "aggregateDeviceUID": aggregateUID,
            "aggregateDeviceName": aggregateName,
            "outputDeviceUID": outputUID,
            "outputDeviceName": outputName
        ])
    }

    func stop() {
        if aggregateDeviceID != kAudioObjectUnknown {
            _ = AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            aggregateDeviceID = kAudioObjectUnknown
        }
        if tapID != kAudioObjectUnknown {
            _ = AudioHardwareDestroyProcessTap(tapID)
            tapID = kAudioObjectUnknown
        }
    }
}

struct HelperError: Error {
    let message: String
}

@available(macOS 14.2, *)
func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else {
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func emitError(_ message: String) {
    let payload: [String: Any] = [
        "event": "error",
        "message": message
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else {
        fputs(message + "\n", stderr)
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func check(_ status: OSStatus, context: String) throws {
    guard status == noErr else {
        throw HelperError(message: "\(context) failed with OSStatus \(status)")
    }
}

func readStringProperty(deviceID: AudioObjectID, selector: AudioObjectPropertySelector) throws -> String {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var cfValue: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    try check(AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &cfValue), context: "AudioObjectGetPropertyData(\(selector))")
    return cfValue as String
}

func defaultOutputDevice() throws -> AudioObjectID {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var deviceID = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID), context: "kAudioHardwarePropertyDefaultOutputDevice")
    guard deviceID != kAudioObjectUnknown else {
        throw HelperError(message: "No default output device is available")
    }
    return deviceID
}

if #available(macOS 14.2, *) {
    do {
        let outputDeviceID = try defaultOutputDevice()
        let outputUID = try readStringProperty(deviceID: outputDeviceID, selector: kAudioDevicePropertyDeviceUID)
        let outputName = try readStringProperty(deviceID: outputDeviceID, selector: kAudioObjectPropertyName)
        let session = TapSession(outputName: outputName, outputUID: outputUID)
        try session.start()

        signal(SIGINT, SIG_IGN)
        signal(SIGTERM, SIG_IGN)

        let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        sigint.setEventHandler {
            session.stop()
            exit(0)
        }
        sigint.resume()

        let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        sigterm.setEventHandler {
            session.stop()
            exit(0)
        }
        sigterm.resume()

        RunLoop.main.run()
    } catch let error as HelperError {
        emitError(error.message)
        exit(1)
    } catch {
        emitError(error.localizedDescription)
        exit(1)
    }
} else {
    emitError("macOS 14.2 or newer is required for CoreAudio process taps")
    exit(1)
}
