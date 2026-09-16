cask "maicong-studio" do
  version "0.1.0"
  sha256 "8fd71c3d6a5d5d4ef737f0442be652fce84f0aa3ca5ca77b49e29041da9ef0e0"

  url "https://github.com/jpeng11/open-maicong/releases/download/v#{version}/Maicong-Studio-#{version}-arm64.dmg"
  name "Maicong Studio"
  desc "Unofficial offline hub for the MCHOSE G75 V2 mechanical keyboard"
  homepage "https://github.com/jpeng11/open-maicong"

  livecheck do
    url :homepage
    strategy :github_latest
  end

  depends_on arch: :arm64
  depends_on macos: :ventura

  app "Maicong Studio.app"

  # Homebrew 7 dropped --no-quarantine. Clear Gatekeeper isolation on this
  # unsigned Apple Silicon build so the first launch is not blocked.
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Maicong Studio.app"],
                   sudo: false,
                   must_succeed: false
  end

  uninstall quit: "dev.openmaicong.studio"

  zap trash: [
    "~/Library/Application Support/open-maicong",
    "~/Library/Logs/open-maicong",
    "~/Library/Preferences/dev.openmaicong.studio.plist",
    "~/Library/Saved Application State/dev.openmaicong.studio.savedState",
  ]

  caveats <<~EOS
    Unsigned Apple Silicon build. The cask clears com.apple.quarantine on
    install. If Gatekeeper still blocks it: System Settings → Privacy &
    Security → Open Anyway.

    未签名构建。cask 安装时会去掉隔离属性。若仍拦截：系统设置 → 隐私与安全性 → 仍要打开。
  EOS
end
