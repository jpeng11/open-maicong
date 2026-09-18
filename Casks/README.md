# Homebrew cask

Canonical tap: [`jpeng11/homebrew-open-maicong`](https://github.com/jpeng11/homebrew-open-maicong)

```bash
brew install --cask jpeng11/open-maicong/maicong-studio
```

## Gatekeeper quarantine — read before installing

Maicong Studio is not signed with an Apple Developer ID certificate. The
bundle is ad-hoc signed, which gives tamper-evidence (macOS refuses to run the
app if its contents are modified after install) but does not satisfy
Gatekeeper's notarization check. On Apple Silicon there is no "Open Anyway"
override for a quarantined app that was never notarized — the app just reports
itself as "damaged" — so this cask's `postflight_steps` runs:

```bash
/usr/bin/xattr -dr com.apple.quarantine "/Applications/Maicong Studio.app"
```

That removes the quarantine attribute from the installed app so it can launch.
It is the same command users otherwise copy from forums, but scoped to the
correct bundle path and run with `must_succeed: false`, so if the attribute is
absent the install still succeeds. It does not touch Gatekeeper itself or any
other app.

If you would rather make that decision explicitly, install with Homebrew's own
flag instead:

```bash
brew install --cask --no-quarantine jpeng11/open-maicong/maicong-studio
```

With `--no-quarantine` Homebrew never sets the attribute, and the postflight
step becomes a no-op. The tradeoff is identical either way: an app without a
Developer ID signature needs the quarantine flag gone to launch on Apple
Silicon.

Keep `maicong-studio.rb` identical to the tap when cutting a release. See [developer notes](../docs/DEVELOPER.md).
