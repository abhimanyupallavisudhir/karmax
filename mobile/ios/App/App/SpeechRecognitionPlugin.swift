// iOS implementation of `SpeechRecognition`, ported from
// @capacitor-community/speech-recognition 7.0.1 (ios/Plugin/Plugin.swift,
// MIT licence, https://github.com/capacitor-community/speech-recognition).
//
// Why it lives here: Capacitor 8 projects use Swift Package Manager, and that
// package ships only a CocoaPods podspec plus an Objective-C CAP_PLUGIN
// registration file, so `cap sync` cannot add it to CapApp-SPM. This copy
// conforms to CAPBridgedPlugin instead and is registered by
// TavyaBridgeViewController. It keeps the same JS name, methods, events and
// results as the npm package (which still provides the Android side), so
// `Capacitor.Plugins.SpeechRecognition` behaves the same on both platforms.
// Changes from upstream: no force-unwraps of the audio engine, and the audio
// session is released when recognition stops.
// Drop this file (and ios.includePlugins in capacitor.config.ts) once the
// package ships a Package.swift.

import AVFoundation
import Capacitor
import Foundation
import Speech

@objc(SpeechRecognitionPlugin)
public class SpeechRecognitionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SpeechRecognitionPlugin"
    public let jsName = "SpeechRecognition"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSupportedLanguages", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isListening", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise)
    ]

    let defaultMatches = 5
    let messageMissingPermission = "Missing permission"
    let messageAccessDeniedMicrophone = "User denied access to microphone"
    let messageOngoing = "Ongoing speech recognition"
    let messageUnknown = "Unknown error occured"

    private var speechRecognizer: SFSpeechRecognizer?
    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?

    @objc func available(_ call: CAPPluginCall) {
        guard let recognizer = SFSpeechRecognizer() else {
            call.resolve(["available": false])
            return
        }
        call.resolve(["available": recognizer.isAvailable])
    }

    @objc func start(_ call: CAPPluginCall) {
        if let engine = audioEngine, engine.isRunning {
            call.reject(messageOngoing)
            return
        }
        if SFSpeechRecognizer.authorizationStatus() != .authorized {
            call.reject(messageMissingPermission)
            return
        }

        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            guard granted else {
                call.reject(self.messageAccessDeniedMicrophone)
                return
            }
            DispatchQueue.main.async {
                self.startRecognition(call)
            }
        }
    }

    private func startRecognition(_ call: CAPPluginCall) {
        let language = call.getString("language") ?? "en-US"
        let maxResults = call.getInt("maxResults") ?? defaultMatches
        let partialResults = call.getBool("partialResults") ?? false

        recognitionTask?.cancel()
        recognitionTask = nil

        let engine = AVAudioEngine()
        audioEngine = engine
        speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: language))

        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.playAndRecord, options: .defaultToSpeaker)
            try audioSession.setMode(.default)
        } catch {
            // Upstream ignores category errors too; activation below is what matters.
        }
        do {
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            call.reject("Microphone is already in use by another application.")
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = partialResults
        recognitionRequest = request

        let inputNode = engine.inputNode
        let format = inputNode.outputFormat(forBus: 0)

        recognitionTask = speechRecognizer?.recognitionTask(with: request) { result, error in
            if let result = result {
                var matches: [String] = []
                for (index, transcription) in result.transcriptions.enumerated() where maxResults > 0 && index < maxResults {
                    matches.append(transcription.formattedString)
                }
                if partialResults {
                    self.notifyListeners("partialResults", data: ["matches": matches])
                } else {
                    call.resolve(["matches": matches])
                }
                if result.isFinal {
                    self.finishRecognition()
                }
            }
            if let error = error {
                self.finishRecognition()
                call.reject(error.localizedDescription)
            }
        }

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            self.recognitionRequest?.append(buffer)
        }

        engine.prepare()
        do {
            try engine.start()
            notifyListeners("listeningState", data: ["status": "started"])
            if partialResults {
                call.resolve()
            }
        } catch {
            finishRecognition()
            call.reject(messageUnknown)
        }
    }

    private func finishRecognition() {
        guard let engine = audioEngine else { return }
        audioEngine = nil
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        recognitionRequest = nil
        recognitionTask = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        notifyListeners("listeningState", data: ["status": "stopped"])
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let engine = self.audioEngine, engine.isRunning {
                engine.stop()
                self.recognitionRequest?.endAudio()
                self.notifyListeners("listeningState", data: ["status": "stopped"])
            }
            call.resolve()
        }
    }

    @objc func isListening(_ call: CAPPluginCall) {
        call.resolve(["listening": audioEngine?.isRunning ?? false])
    }

    @objc func getSupportedLanguages(_ call: CAPPluginCall) {
        let languages = SFSpeechRecognizer.supportedLocales().map { $0.identifier }
        call.resolve(["languages": languages])
    }

    @objc override public func checkPermissions(_ call: CAPPluginCall) {
        let permission: String
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            permission = "granted"
        case .denied, .restricted:
            permission = "denied"
        case .notDetermined:
            permission = "prompt"
        @unknown default:
            permission = "prompt"
        }
        call.resolve(["speechRecognition": permission])
    }

    @objc override public func requestPermissions(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard status == .authorized else {
                    self.checkPermissions(call)
                    return
                }
                AVAudioSession.sharedInstance().requestRecordPermission { granted in
                    call.resolve(["speechRecognition": granted ? "granted" : "denied"])
                }
            }
        }
    }
}
