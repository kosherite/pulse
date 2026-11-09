# Pulse

**Your strap. Your data. Your device.** Pulse is an offline companion for WHOOP straps. It pairs with
the strap over Bluetooth, keeps everything on your own device, and works out recovery, strain, HRV and
sleep locally, with no account and no cloud.

## What's in this repository

| Branch | Contents |
|---|---|
| `main` | The native apps: iPhone and Mac (`Strand/`, `StrandiOS/`), Apple Watch (`PulseWatch/`), Android (`android/`) and the shared Swift packages (`Packages/`). |
| `pulse-web` | The Pulse web app, published with GitHub Pages. It runs in any browser with Web Bluetooth (on iPhone, Bluefy). |
| `pulse-v2-design` | An alternative design for the web app, kept for reference. |

## Building

- **iPhone, Mac, Watch:** generate the Xcode project with `xcodegen generate`, then build the `PulseiOS`
  or `Strand` scheme. See [`docs/BUILD.md`](docs/BUILD.md) and [`docs/IOS.md`](docs/IOS.md).
- **Android:** open `android/` in Android Studio, or run `./gradlew assembleDebug`. See
  [`docs/ANDROID.md`](docs/ANDROID.md).
- **Web app:** no build step. Open `index.html` from the `pulse-web` branch.

The iPhone app is distributed unsigned. Install it with AltStore or SideStore using
`altstore-source.json`, or sign the `.ipa` from Releases with your own Apple ID.

## Documentation

Protocol notes, the data model, analytics and privacy are covered in [`docs/`](docs/), starting with
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Disclaimer

Pulse is an independent, unofficial project. It is not affiliated with, endorsed by, or connected to
WHOOP, Inc.; "WHOOP" is used only to identify the hardware Pulse talks to. Pulse is not a medical
device, and every derived metric is an estimate. See [`DISCLAIMER.md`](DISCLAIMER.md).

## License

PolyForm Noncommercial License 1.0.0: personal and non-commercial use only. See [`LICENSE`](LICENSE),
[`NOTICE`](NOTICE) and [`ATTRIBUTION.md`](ATTRIBUTION.md) for the full terms and the credits for the
work this project builds on.
