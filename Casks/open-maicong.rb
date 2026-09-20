cask "open-maicong" do
  version "0.1.0"
  sha256 "8fd71c3d6a5d5d4ef737f0442be652fce84f0aa3ca5ca77b49e29041da9ef0e0"

  url "https://github.com/jpeng11/open-maicong/releases/download/v#{version}/Open-Maicong-#{version}-arm64.dmg"
  name "Open Maicong"
  desc "Unofficial offline hub for the MCHOSE G75 V2 mechanical keyboard"
  homepage "https://github.com/jpeng11/open-maicong"

  livecheck do
    url :homepage
    strategy :github_latest
  end

  depends_on arch: :arm64
  depends_on macos: :ventura

  app "Open Maicong.app"

  postflight_steps do
    run "/usr/bin/xattr",
        args:         ["-dr", "com.apple.quarantine", "{{appdir}}/Open Maicong.app"],
        must_succeed: false
  end

  uninstall quit: "dev.openmaicong.studio"

  zap trash: [
    "~/Library/Application Support/Open Maicong",
    "~/Library/Application Support/open-maicong",
    "~/Library/Logs/open-maicong",
    "~/Library/Preferences/dev.openmaicong.studio.plist",
    "~/Library/Saved Application State/dev.openmaicong.studio.savedState",
  ]

  caveats <<~EOS
    Ad-hoc signed Apple Silicon build (no Apple Developer ID). The cask clears
    com.apple.quarantine on install — see the tap README before installing.
    If Gatekeeper still blocks it: System Settings → Privacy & Security → Open Anyway.

    Ad-hoc 签名构建（无 Apple Developer ID）。cask 安装时会去掉隔离属性，安装前请阅读 tap README。
    若仍拦截：系统设置 → 隐私与安全性 → 仍要打开。
  EOS
end
