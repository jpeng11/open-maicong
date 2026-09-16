cask "maicong-studio" do
  version "0.1.0"
  sha256 "8fd71c3d6a5d5d4ef737f0442be652fce84f0aa3ca5ca77b49e29041da9ef0e0"

  url "https://github.com/jpeng11/open-maicong/releases/download/v#{version}/Maicong-Studio-#{version}-arm64.dmg"
  name "Maicong Studio"
  desc "Unofficial offline macOS hub for the MCHOSE G75 V2 mechanical keyboard"
  homepage "https://github.com/jpeng11/open-maicong"

  livecheck do
    url :homepage
    strategy :github_latest
  end

  depends_on macos: :ventura
  depends_on arch: :arm64

  app "Maicong Studio.app"

  uninstall quit: "dev.openmaicong.studio"

  zap trash: [
    "~/Library/Application Support/open-maicong",
    "~/Library/Logs/open-maicong",
    "~/Library/Preferences/dev.openmaicong.studio.plist",
    "~/Library/Saved Application State/dev.openmaicong.studio.savedState",
  ]

  caveats <<~EOS
    This cask ships an unsigned Apple Silicon build. Install or upgrade with
    --no-quarantine, or allow it in System Settings → Privacy & Security
    after the first open.

    当前包未签名。请加 --no-quarantine，或在「系统设置 → 隐私与安全性」选择仍要打开。
  EOS
end
