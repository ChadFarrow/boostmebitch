import Foundation
import AVFoundation
import MediaPlayer
import Capacitor

/// Stage 2 of docs/ios.md: a native AVPlayer that owns the iOS Now Playing
/// entry, so the lock screen, Control Center, Dynamic Island, AirPods and
/// CarPlay see a real audio app instead of a WKWebView.
///
/// NOT WIRED YET. The web player (`components/player.tsx`) still plays through
/// its `<audio>` element. `lib/native/native-audio.ts` is the JS side of this
/// plugin; wiring it into the player is the next step, and only if the Stage 1
/// test shows the WKWebView `<audio>` still loses the lock-screen entry.
///
/// The two rules that fix "paused audio disappears from the lock screen":
///   1. Pausing NEVER calls `AVAudioSession.setActive(false)`.
///   2. Pausing NEVER clears `nowPlayingInfo`; it sets the rate to 0 and
///      writes the elapsed time, so iOS keeps the entry and the play button
///      can resume us from the background.
@objc(NativeAudioPlugin)
public class NativeAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeAudioPlugin"
    public let jsName = "NativeAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "loadTrack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateMetadata", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSkipIntervals", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private let player = AVPlayer()
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var statusObservation: NSKeyValueObservation?
    private var rateObservation: NSKeyValueObservation?
    private var info: [String: Any] = [:]
    private var desiredRate: Float = 1.0
    private var artworkTask: URLSessionDataTask?
    private var commandsInstalled = false

    // MARK: - Lifecycle

    override public func load() {
        player.automaticallyWaitsToMinimizeStalling = true
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.5, preferredTimescale: 600),
            queue: .main
        ) { [weak self] _ in
            self?.emitTime()
        }
        rateObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.emitState() }
        }
    }

    deinit {
        if let t = timeObserver { player.removeTimeObserver(t) }
        if let e = endObserver { NotificationCenter.default.removeObserver(e) }
    }

    // MARK: - JS methods

    @objc func loadTrack(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("url is required")
            return
        }
        let startAt = call.getDouble("startAt") ?? 0
        let autoplay = call.getBool("autoplay") ?? true
        desiredRate = Float(call.getDouble("rate") ?? 1.0)

        DispatchQueue.main.async {
            self.activateSession()
            self.installRemoteCommands()

            let item = AVPlayerItem(url: url)
            self.observeEnd(of: item)
            self.statusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    if item.status == .readyToPlay {
                        let duration = item.duration.seconds
                        if duration.isFinite {
                            self.info[MPMediaItemPropertyPlaybackDuration] = duration
                            self.pushInfo()
                        }
                        self.notifyListeners("loaded", data: ["duration": duration.isFinite ? duration : 0])
                    } else if item.status == .failed {
                        self.notifyListeners("error", data: [
                            "message": item.error?.localizedDescription ?? "playback failed",
                        ])
                    }
                }
            }
            self.player.replaceCurrentItem(with: item)
            if startAt > 0 {
                self.player.seek(to: CMTime(seconds: startAt, preferredTimescale: 600))
            }

            self.info = [:]
            self.applyMetadata(call)
            self.info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = startAt
            self.info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
            self.pushInfo()

            if autoplay { self.startPlayback() }
            call.resolve()
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.startPlayback()
            call.resolve()
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.pausePlayback()
            call.resolve()
        }
    }

    @objc func seek(_ call: CAPPluginCall) {
        guard let position = call.getDouble("position") else {
            call.reject("position is required")
            return
        }
        DispatchQueue.main.async {
            self.seek(to: position) { call.resolve() }
        }
    }

    @objc func setRate(_ call: CAPPluginCall) {
        let rate = Float(call.getDouble("rate") ?? 1.0)
        DispatchQueue.main.async {
            self.desiredRate = rate
            if self.player.timeControlStatus != .paused { self.player.rate = rate }
            self.info[MPNowPlayingInfoPropertyDefaultPlaybackRate] = Double(rate)
            self.syncInfo()
            call.resolve()
        }
    }

    @objc func updateMetadata(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.applyMetadata(call)
            self.syncInfo()
            call.resolve()
        }
    }

    /// Podcasts get ±skip buttons, music gets ⏮/⏭ (docs/ui.md, "The
    /// lock-screen buttons"). `skipForward`/`skipBackward` of 0 turns the skip
    /// buttons off and turns track buttons on.
    @objc func setSkipIntervals(_ call: CAPPluginCall) {
        let forward = call.getDouble("skipForward") ?? 30
        let backward = call.getDouble("skipBackward") ?? 15
        DispatchQueue.main.async {
            let cc = MPRemoteCommandCenter.shared()
            let useSkips = forward > 0 || backward > 0
            cc.skipForwardCommand.isEnabled = useSkips
            cc.skipBackwardCommand.isEnabled = useSkips
            cc.skipForwardCommand.preferredIntervals = [NSNumber(value: forward)]
            cc.skipBackwardCommand.preferredIntervals = [NSNumber(value: backward)]
            cc.nextTrackCommand.isEnabled = !useSkips
            cc.previousTrackCommand.isEnabled = !useSkips
            call.resolve()
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(self.stateData())
        }
    }

    /// The ONLY place the Now Playing entry is removed: the user ended the
    /// session (closed the player), not a pause.
    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.player.pause()
            self.player.replaceCurrentItem(with: nil)
            self.info = [:]
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
            call.resolve()
        }
    }

    // MARK: - Playback

    private func activateSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, policy: .longFormAudio)
        try? session.setActive(true)
    }

    private func startPlayback() {
        activateSession()
        player.playImmediately(atRate: desiredRate)
        syncInfo()
    }

    /// Rule 1 and rule 2 from the type comment: no `setActive(false)`, no
    /// `nowPlayingInfo = nil`.
    private func pausePlayback() {
        player.pause()
        syncInfo()
    }

    private func seek(to position: Double, done: (() -> Void)? = nil) {
        player.seek(
            to: CMTime(seconds: max(0, position), preferredTimescale: 600),
            toleranceBefore: .zero,
            toleranceAfter: .zero
        ) { [weak self] _ in
            DispatchQueue.main.async {
                self?.syncInfo()
                self?.emitTime()
                done?()
            }
        }
    }

    private func observeEnd(of item: AVPlayerItem) {
        if let e = endObserver { NotificationCenter.default.removeObserver(e) }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] _ in
            self?.syncInfo()
            self?.notifyListeners("ended", data: [:])
        }
    }

    // MARK: - Now Playing

    private func applyMetadata(_ call: CAPPluginCall) {
        if let title = call.getString("title") { info[MPMediaItemPropertyTitle] = title }
        if let artist = call.getString("artist") { info[MPMediaItemPropertyArtist] = artist }
        if let album = call.getString("album") { info[MPMediaItemPropertyAlbumTitle] = album }
        if let artwork = call.getString("artworkUrl"), let url = URL(string: artwork) {
            loadArtwork(url)
        }
    }

    private func loadArtwork(_ url: URL) {
        artworkTask?.cancel()
        artworkTask = URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data = data, let image = UIImage(data: data) else { return }
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                self.pushInfo()
            }
        }
        artworkTask?.resume()
    }

    /// Writes the position and rate iOS uses to draw the scrubber. Called on
    /// every play, pause, seek and rate change — never on a timer.
    private func syncInfo() {
        let position = player.currentTime().seconds
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position.isFinite ? position : 0
        info[MPNowPlayingInfoPropertyPlaybackRate] = player.timeControlStatus == .paused ? 0.0 : Double(desiredRate)
        if let duration = player.currentItem?.duration.seconds, duration.isFinite {
            info[MPMediaItemPropertyPlaybackDuration] = duration
        }
        pushInfo()
    }

    private func pushInfo() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    /// Play, pause and seek act NATIVELY first, then tell JS. iOS can wake a
    /// suspended app for a remote command, but the WKWebView JS may not run
    /// in time, so the audio must not wait for it. Next/previous only go to
    /// JS: the queue lives there.
    private func installRemoteCommands() {
        guard !commandsInstalled else { return }
        commandsInstalled = true
        let cc = MPRemoteCommandCenter.shared()

        cc.playCommand.isEnabled = true
        cc.playCommand.addTarget { [weak self] _ in
            self?.startPlayback()
            self?.emitRemote("play")
            return .success
        }
        cc.pauseCommand.isEnabled = true
        cc.pauseCommand.addTarget { [weak self] _ in
            self?.pausePlayback()
            self?.emitRemote("pause")
            return .success
        }
        cc.togglePlayPauseCommand.isEnabled = true
        cc.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            if self.player.timeControlStatus == .paused {
                self.startPlayback()
                self.emitRemote("play")
            } else {
                self.pausePlayback()
                self.emitRemote("pause")
            }
            return .success
        }
        cc.skipForwardCommand.isEnabled = true
        cc.skipForwardCommand.preferredIntervals = [30]
        cc.skipForwardCommand.addTarget { [weak self] event in
            guard let self = self else { return .commandFailed }
            let interval = (event as? MPSkipIntervalCommandEvent)?.interval ?? 30
            self.seek(to: self.player.currentTime().seconds + interval)
            self.emitRemote("skipForward")
            return .success
        }
        cc.skipBackwardCommand.isEnabled = true
        cc.skipBackwardCommand.preferredIntervals = [15]
        cc.skipBackwardCommand.addTarget { [weak self] event in
            guard let self = self else { return .commandFailed }
            let interval = (event as? MPSkipIntervalCommandEvent)?.interval ?? 15
            self.seek(to: self.player.currentTime().seconds - interval)
            self.emitRemote("skipBackward")
            return .success
        }
        cc.changePlaybackPositionCommand.isEnabled = true
        cc.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.seek(to: e.positionTime)
            self?.emitRemote("seek", extra: ["position": e.positionTime])
            return .success
        }
        cc.nextTrackCommand.isEnabled = false
        cc.nextTrackCommand.addTarget { [weak self] _ in
            self?.emitRemote("next")
            return .success
        }
        cc.previousTrackCommand.isEnabled = false
        cc.previousTrackCommand.addTarget { [weak self] _ in
            self?.emitRemote("previous")
            return .success
        }
    }

    // MARK: - Events to JS

    private func stateData() -> [String: Any] {
        let position = player.currentTime().seconds
        let duration = player.currentItem?.duration.seconds ?? 0
        return [
            "playing": player.timeControlStatus != .paused,
            "buffering": player.timeControlStatus == .waitingToPlayAtSpecifiedRate,
            "position": position.isFinite ? position : 0,
            "duration": duration.isFinite ? duration : 0,
            "rate": Double(desiredRate),
        ]
    }

    private func emitTime() {
        notifyListeners("timeupdate", data: stateData())
    }

    private func emitState() {
        notifyListeners("state", data: stateData())
    }

    private func emitRemote(_ command: String, extra: [String: Any] = [:]) {
        var data: [String: Any] = ["command": command]
        for (k, v) in extra { data[k] = v }
        notifyListeners("remote", data: data, retainUntilConsumed: true)
    }
}

/// Registers the local plugin. `SceneDelegate` uses this instead of a bare
/// `CAPBridgeViewController`.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeAudioPlugin())
    }
}
