# Pulse

A private web app for the WHOOP 5.0 strap. It connects over Web Bluetooth, keeps your history on your
own devices, and works out sleep, recovery, strain, workouts and heart rate recovery locally. Nothing is uploaded unless you turn on sync to your own repository.

- `index.html`: the app (interface and styles)
- `engine.js`: strap protocol, storage and analysis
- `fonts/`: Inter (SIL Open Font License)

History can be kept in step across devices through a private GitHub repository you own (Settings →
Sync between devices). The access key is stored only on the device you enter it on.

Open the published page in a browser with Web Bluetooth (on iPhone, Bluefy), tap Connect and choose
your strap. The strap must be in pairing mode the first time.

Pulse is an independent project and is not affiliated with WHOOP. Scores are estimates, not medical
advice.

Licensed under the PolyForm Noncommercial License 1.0.0, for personal and non-commercial use. The full
terms and credits are in `LICENSE`, `NOTICE` and `ATTRIBUTION.md` on the `main` branch.
